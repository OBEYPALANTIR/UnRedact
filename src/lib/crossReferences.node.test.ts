import { describe, test } from 'node:test';
import assert from 'node:assert';
import { formatCrossReferencesForPrompt } from './personsApi.ts';
import type { CrossReferenceResult } from './personsApi.ts';

describe('formatCrossReferencesForPrompt', () => {
  test('returns empty string when totalMatches is 0', () => {
    const result: CrossReferenceResult = {
      crossReferences: [],
      namesExtracted: [],
      totalMatches: 0,
      errors: [],
    };
    assert.strictEqual(formatCrossReferencesForPrompt(result), '');
  });

  test('formats a standard response correctly', () => {
    const result: CrossReferenceResult = {
      crossReferences: [
        {
          queryName: 'John Doe',
          matches: [
            {
              id: 1,
              name: 'John Doe',
              aliases: ['Johnny D', 'JD'],
              documents_count: 42,
              connections: ['Jane Doe', 'Bob Smith'],
            },
          ],
        },
      ],
      namesExtracted: ['John Doe'],
      totalMatches: 1,
      errors: [],
    };

    const output = formatCrossReferencesForPrompt(result);

    assert.ok(output.includes('<person_cross_references>'));
    assert.ok(output.includes('Query: "John Doe"'));
    assert.ok(output.includes('  - John Doe (aliases: Johnny D, JD) — 42 documents — connected to: Jane Doe, Bob Smith'));
    assert.ok(output.includes('</person_cross_references>'));
  });

  test('slices connections to max 5', () => {
    const result: CrossReferenceResult = {
      crossReferences: [
        {
          queryName: 'Alice',
          matches: [
            {
              id: 2,
              name: 'Alice',
              connections: ['1', '2', '3', '4', '5', '6', '7'],
            },
          ],
        },
      ],
      namesExtracted: ['Alice'],
      totalMatches: 1,
      errors: [],
    };

    const output = formatCrossReferencesForPrompt(result);

    assert.ok(output.includes('connected to: 1, 2, 3, 4, 5'));
    assert.ok(!output.includes('6'));
    assert.ok(!output.includes('7'));
  });

  test('respects the 2000 character limit', () => {
    // Generate enough data to exceed 2000 characters
    const matches = Array.from({ length: 50 }).map((_, i) => ({
      id: i,
      name: `Person Number ${i} With A Very Long Name Indeed To Take Up Space`,
      aliases: ['Alias 1', 'Alias 2', 'Alias 3'],
      documents_count: 100,
      connections: ['Connection A', 'Connection B', 'Connection C'],
    }));

    const result: CrossReferenceResult = {
      crossReferences: [
        {
          queryName: 'Query Name',
          matches,
        },
      ],
      namesExtracted: ['Query Name'],
      totalMatches: 50,
      errors: [],
    };

    const output = formatCrossReferencesForPrompt(result);

    // The max limit in the function is MAX_CHARS (2000)
    // The logic checks if (charCount + line.length > MAX_CHARS) break;
    // Plus the closing tag `</person_cross_references>` (~26 chars)
    assert.ok(output.length <= 2100, `Output length ${output.length} exceeded expected max length`);
    assert.ok(output.endsWith('</person_cross_references>'), 'Output should close correctly even when truncated');

    // It should contain some matches but not all 50
    assert.ok(output.includes('Person Number 0'));
    assert.ok(!output.includes('Person Number 49'));
  });
});
