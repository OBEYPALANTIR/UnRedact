import * as pdfjsLib from 'pdfjs-dist';
import type { VersionInfo, VersionDiff } from '../types';

/**
 * Scans raw PDF bytes for multiple %%EOF markers, indicating incremental saves.
 * Each %%EOF marks the end of a document version — multiple means the PDF
 * contains recoverable previous versions (potentially before redaction).
 */
export function detectIncrementalSaves(data: Uint8Array): VersionInfo {
  const offsets: number[] = [];
  const len = data.length;
  // %%EOF is [37, 37, 69, 79, 70]

  let i = data.indexOf(37);
  while (i !== -1 && i <= len - 5) {
    if (
      data[i + 1] === 37 &&
      data[i + 2] === 69 &&
      data[i + 3] === 79 &&
      data[i + 4] === 70
    ) {
      offsets.push(i + 5);
      i = data.indexOf(37, i + 5);
    } else {
      i = data.indexOf(37, i + 1);
    }
  }

  return {
    count: offsets.length,
    eofOffsets: offsets,
    hasMultipleVersions: offsets.length > 1,
  };
}

/**
 * Extracts a previous version of the PDF by truncating at an earlier %%EOF marker.
 * Version 0 = original, Version N-1 = latest.
 */
export function extractPreviousVersion(
  data: Uint8Array,
  versionInfo: VersionInfo,
  versionIndex: number
): Uint8Array | null {
  if (versionIndex < 0 || versionIndex >= versionInfo.eofOffsets.length) {
    return null;
  }
  const endOffset = versionInfo.eofOffsets[versionIndex];
  return data.slice(0, endOffset);
}

/**
 * Loads a PDF version (raw bytes) with pdfjs-dist and extracts its full text.
 * Returns the plain-text of that version, or empty string on failure.
 */
export async function extractVersionText(versionBytes: Uint8Array): Promise<string> {
  try {
    const doc = await pdfjsLib.getDocument({ data: versionBytes.slice() }).promise;
    const pages: string[] = [];

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .filter((item) => 'str' in item)
        .map((item) => (item as { str: string }).str)
        .join(' ');
      pages.push(pageText);
    }

    return pages.join('\n');
  } catch {
    // Previous version may be a partial/corrupt PDF — that's expected
    return '';
  }
}

/**
 * Performs word-level diff between old and current text to find content that
 * was present in the old version but is absent in the current one.
 * 
 * This is the highest-impact recovery technique: text present in an earlier
 * version but missing from the latest was almost certainly redacted, yielding
 * near-100% confidence.
 */
export function diffVersionTexts(
  oldText: string,
  currentText: string,
  versionIndex: number
): VersionDiff[] {
  if (!oldText || !currentText) return [];

  const oldWords = oldText.split(/\s+/).filter(Boolean);
  const currentWords = currentText.split(/\s+/).filter(Boolean);

  // Build a set of n-grams from the current text for fast lookup
  const currentNgrams = new Set<string>();
  for (let i = 0; i < currentWords.length; i++) {
    // Single words
    currentNgrams.add(currentWords[i].toLowerCase());
    // Bigrams
    if (i + 1 < currentWords.length) {
      currentNgrams.add(`${currentWords[i]} ${currentWords[i + 1]}`.toLowerCase());
    }
    // Trigrams
    if (i + 2 < currentWords.length) {
      currentNgrams.add(`${currentWords[i]} ${currentWords[i + 1]} ${currentWords[i + 2]}`.toLowerCase());
    }
  }

  const diffs: VersionDiff[] = [];
  let i = 0;

  while (i < oldWords.length) {
    const word = oldWords[i];

    // Check if this word exists in current text
    if (!currentNgrams.has(word.toLowerCase())) {
      // Found a word missing from current — collect the run of missing words
      const start = i;
      while (
        i < oldWords.length &&
        !currentNgrams.has(oldWords[i].toLowerCase())
      ) {
        i++;
      }

      const missingText = oldWords.slice(start, i).join(' ');

      // Only include non-trivial missing text (more than single punctuation, etc.)
      if (missingText.length >= 3 && /[a-zA-Z]/.test(missingText)) {
        const CONTEXT_WORDS = 8;
        const oldContext = oldWords
          .slice(Math.max(0, start - CONTEXT_WORDS), Math.min(oldWords.length, i + CONTEXT_WORDS))
          .join(' ');

        // Find approximate position in current text for context
        const currentContext = findNearestContext(currentWords, oldWords, start, CONTEXT_WORDS);

        diffs.push({
          missingText,
          oldContext,
          currentContext,
          versionIndex,
        });
      }
    } else {
      i++;
    }
  }

  return diffs;
}

/**
 * Finds context in the current text near where a word at `oldIndex` would appear.
 * Uses the surrounding old-text words to locate the approximate position in current text.
 */
function findNearestContext(
  currentWords: string[],
  oldWords: string[],
  oldIndex: number,
  contextSize: number
): string {
  // Look for anchor words before and after the missing section in the old text
  const before = oldIndex > 0 ? oldWords[oldIndex - 1].toLowerCase() : '';
  const afterIdx = oldIndex + 1;
  const after = afterIdx < oldWords.length ? oldWords[afterIdx].toLowerCase() : '';

  // Search for the "before" anchor in current text
  let anchorPos = -1;
  if (before) {
    for (let i = 0; i < currentWords.length; i++) {
      if (currentWords[i].toLowerCase() === before) {
        anchorPos = i;
        break;
      }
    }
  }

  // If no anchor, search for "after" anchor
  if (anchorPos === -1 && after) {
    for (let i = 0; i < currentWords.length; i++) {
      if (currentWords[i].toLowerCase() === after) {
        anchorPos = i;
        break;
      }
    }
  }

  if (anchorPos === -1) return '';

  return currentWords
    .slice(Math.max(0, anchorPos - contextSize), Math.min(currentWords.length, anchorPos + contextSize))
    .join(' ');
}

/**
 * Scans raw PDF bytes for text strings that may be orphaned (not displayed but
 * still present in the file). Looks for parenthesized strings in content streams.
 * 
 * This is a heuristic approach — it finds strings enclosed in PDF string delimiters
 * that contain readable text content. These may include text that was "removed"
 * by redaction but not actually deleted from the file.
 */
export function findOrphanedStrings(data: Uint8Array): string[] {
  const text = new TextDecoder('latin1').decode(data);
  const results: string[] = [];
  const seen = new Set<string>();

  // Match PDF text strings: (text) preceded by Tj or TJ operators, or in streams
  // Also match hex strings: <hex>
  const stringPattern = /\(([^)]{4,200})\)/g;
  let match: RegExpExecArray | null;

  while ((match = stringPattern.exec(text)) !== null) {
    const str = match[1]
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\')
      .replace(/\\([()])/g, '$1');

    // Filter: must contain mostly printable ASCII/Unicode, min 4 chars
    let printableCount = 0;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code >= 32 && code <= 126) printableCount++;
    }
    const printableRatio = printableCount / str.length;
    const trimmed = str.trim();
    if (printableRatio > 0.7 && trimmed.length >= 4 && !seen.has(trimmed)) {
      seen.add(trimmed);
      results.push(trimmed);
    }
  }

  // Also find hex-encoded strings
  const hexPattern = /<([0-9A-Fa-f]{8,})>/g;
  while ((match = hexPattern.exec(text)) !== null) {
    const hex = match[1];
    let decoded = '';
    for (let i = 0; i < hex.length; i += 2) {
      const code = parseInt(hex.substring(i, i + 2), 16);
      if (code >= 32 && code <= 126) {
        decoded += String.fromCharCode(code);
      }
    }
    if (decoded.length >= 4 && !seen.has(decoded)) {
      seen.add(decoded);
      results.push(decoded);
    }
  }

  return results;
}
