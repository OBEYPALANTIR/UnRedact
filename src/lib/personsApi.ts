/**
 * Epstein Exposed Persons API integration.
 * Cross-references names found in PDF text against the persons database
 * to provide additional context for AI-powered redaction recovery.
 */

export interface EpsteinPerson {
  id: number;
  name: string;
  aliases?: string[];
  description?: string;
  connections?: string[];
  documents_count?: number;
  url?: string;
  [key: string]: unknown;
}

export interface PersonCrossReference {
  queryName: string;
  matches: EpsteinPerson[];
}

export interface CrossReferenceResult {
  crossReferences: PersonCrossReference[];
  namesExtracted: string[];
  totalMatches: number;
  errors: string[];
}

const NAME_STOPLIST = new Set([
  // Months
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
  // Common false positives
  'United States', 'New York', 'Los Angeles', 'San Francisco', 'San Diego',
  'Las Vegas', 'Washington DC', 'District Columbia', 'Puerto Rico',
  'Table Contents', 'Table Of', 'Dear Sir', 'Dear Madam',
  'Supreme Court', 'White House', 'Virgin Islands', 'Palm Beach',
  'Page Number', 'Re Re', 'The The',
]);

/**
 * Extracts potential person names from text using a regex heuristic.
 * Looks for sequences of 2-3 capitalized words.
 */
export function extractNames(text: string, maxNames = 15): string[] {
  const namePattern = /\b([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){1,2})\b/g;
  const counts = new Map<string, number>();

  let match;
  while ((match = namePattern.exec(text)) !== null) {
    const name = match[1];
    if (NAME_STOPLIST.has(name)) continue;
    // Skip single-word names that slipped through
    if (!name.includes(' ')) continue;

    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  // Sort by frequency, take top N
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxNames)
    .map(([name]) => name);
}

const queryCache = new Map<string, { expiresAt: number; result: PersonCrossReference }>();
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 100;

/** Cache completed requests only so each caller owns its cancellation signal. */
async function queryPerson(
  name: string,
  apiBaseUrl: string,
  perPage: number,
  signal?: AbortSignal
): Promise<PersonCrossReference> {
  const url = `${apiBaseUrl}/v2/persons?q=${encodeURIComponent(name)}&per_page=${perPage}`;
  signal?.throwIfAborted();
  const cached = queryCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return structuredClone(cached.result);
  }
  queryCache.delete(url);
  const response = await fetch(url, { signal });

  if (response.status === 429) {
    throw new Error('RATE_LIMITED');
  }

  if (!response.ok) {
    throw new Error(`API returned ${response.status}`);
  }

  const json = await response.json();

  // Handle various response shapes defensively
  const data = Array.isArray(json) ? json : (json.data ?? json.results ?? []);
  const matches: EpsteinPerson[] = data.map((item: any) => ({
    id: item.id ?? 0,
    name: item.name ?? item.full_name ?? 'Unknown',
    aliases: item.aliases ?? [],
    description: item.description ?? item.bio ?? undefined,
    connections: item.connections ?? [],
    documents_count: item.documents_count ?? item.document_count ?? 0,
    url: item.url ?? undefined,
  }));

  signal?.throwIfAborted();
  const result = { queryName: name, matches };
  if (queryCache.size >= CACHE_MAX_ENTRIES) {
    queryCache.delete(queryCache.keys().next().value!);
  }
  queryCache.set(url, { expiresAt: Date.now() + CACHE_TTL_MS, result: structuredClone(result) });
  return result;
}

/**
 * Cross-references names found in PDF text against the Epstein Exposed database.
 * Non-fatal: returns partial results on errors.
 */
export async function crossReferencePersons(
  plainText: string,
  options?: {
    maxNames?: number;
    perPage?: number;
    apiBaseUrl?: string;
    signal?: AbortSignal;
  }
): Promise<CrossReferenceResult> {
  const maxNames = options?.maxNames ?? 15;
  const perPage = options?.perPage ?? 5;
  const apiBaseUrl = options?.apiBaseUrl ?? '/api/epstein';
  const signal = options?.signal;

  const namesExtracted = extractNames(plainText, maxNames);

  if (namesExtracted.length === 0) {
    return { crossReferences: [], namesExtracted: [], totalMatches: 0, errors: [] };
  }

  const crossReferences: PersonCrossReference[] = [];
  const errors: string[] = [];
  let rateLimited = false;

  // Process in batches of 5
  const batchSize = 5;
  for (let i = 0; i < namesExtracted.length && !rateLimited; i += batchSize) {
    if (signal?.aborted) {
      errors.push('Cancelled');
      break;
    }
    const batch = namesExtracted.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((name) => queryPerson(name, apiBaseUrl, perPage, signal))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value.matches.length > 0) {
          crossReferences.push(result.value);
        }
      } else {
        const errMsg = result.reason?.message || 'Unknown error';
        if (errMsg === 'RATE_LIMITED') {
          rateLimited = true;
          errors.push('API rate limited — using partial results');
        } else {
          errors.push(errMsg);
        }
      }
    }
  }

  const totalMatches = crossReferences.reduce((sum, cr) => sum + cr.matches.length, 0);

  return { crossReferences, namesExtracted, totalMatches, errors };
}

/**
 * Formats cross-reference results as an XML-tagged section for the AI prompt.
 * Capped at ~2000 characters to avoid inflating the prompt.
 */
export function formatCrossReferencesForPrompt(result: CrossReferenceResult): string {
  if (result.totalMatches === 0) return '';

  const lines: string[] = [
    '<person_cross_references>',
    'Names found in this document were cross-referenced against the Epstein Exposed persons database.',
    'Use these connections and aliases to improve guesses about redacted person names.',
    '',
  ];

  let charCount = lines.join('\n').length;
  const MAX_CHARS = 2000;

  for (const ref of result.crossReferences) {
    const header = `Query: "${ref.queryName}"`;
    if (charCount + header.length > MAX_CHARS) break;

    lines.push(header);
    charCount += header.length;

    for (const person of ref.matches) {
      const parts: string[] = [`  - ${person.name}`];
      if (person.aliases && person.aliases.length > 0) {
        parts.push(`(aliases: ${person.aliases.join(', ')})`);
      }
      if (person.documents_count) {
        parts.push(`— ${person.documents_count} documents`);
      }
      if (person.connections && person.connections.length > 0) {
        parts.push(`— connected to: ${person.connections.slice(0, 5).join(', ')}`);
      }

      const line = parts.join(' ');
      if (charCount + line.length > MAX_CHARS) break;

      lines.push(line);
      charCount += line.length;
    }

    lines.push('');
    charCount += 1;
  }

  lines.push('</person_cross_references>');
  return lines.join('\n');
}
