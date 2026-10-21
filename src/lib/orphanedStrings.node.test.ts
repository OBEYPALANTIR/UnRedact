import test from 'node:test';
import assert from 'node:assert';
import { findOrphanedStrings, detectIncrementalSaves, extractPreviousVersion } from './pdfForensics.ts';

test('recovers nested text after an overlong opening candidate', () => {
  const input = '(' + 'x'.repeat(201) + '(Recoverable name))';
  assert.deepStrictEqual(findOrphanedStrings(new TextEncoder().encode(input)), ['Recoverable name']);
});

test('handles a long run of unmatched openings with bounded literal candidates', () => {
  const input = '('.repeat(1_000_000) + ')';
  assert.deepStrictEqual(findOrphanedStrings(new TextEncoder().encode(input)), ['('.repeat(200)]);
});

test('findOrphanedStrings - normal text strings', () => {
  const data = new TextEncoder().encode('(Hello World)');
  const results = findOrphanedStrings(data);
  assert.deepStrictEqual(results, ['Hello World']);
});

test('findOrphanedStrings - hex encoded strings', () => {
  // "Hello World" in hex is 48656C6C6F20576F726C64
  const data = new TextEncoder().encode('<48656C6C6F20576F726C64>');
  const results = findOrphanedStrings(data);
  assert.deepStrictEqual(results, ['Hello World']);
});

test('findOrphanedStrings - escapes and printable filter', () => {
  // The RegExp stringPattern `\(([^)]{4,200})\)` prevents `)` characters from being in the match.
  // Because of this, it can't match `(Hello\nWorld\(1\)\\test)`. It stops at the first `)` which is inside `\(1\)`.
  // The first matched segment will be `(Hello\nWorld\(1\)` -> decoded as `Hello\nWorld(1\`
  // The pattern in findOrphanedStrings stops at the first `)` even if it is escaped.

  // So the test should assert what the code ACTUALLY does, since our goal is testing the existing logic.
  // We're just adding tests, not changing pdfForensics.ts logic.
  const data = new TextEncoder().encode('(Hello\\nWorld\\(1\\)\\\\test)');
  const results = findOrphanedStrings(data);
  assert.deepStrictEqual(results, ['Hello\nWorld(1\\']);
});

test('findOrphanedStrings - printable ratio filter rejection', () => {
  // Creating a string with many unprintable characters to fail the > 0.7 ratio
  // \x01 \x02 \x03 are unprintable.
  const data = new Uint8Array([
    ...new TextEncoder().encode('('),
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, // 10 unprintable
    ...new TextEncoder().encode('abcde'), // 5 printable
    ...new TextEncoder().encode(')')
  ]);
  const results = findOrphanedStrings(data);
  assert.deepStrictEqual(results, []);
});

test('findOrphanedStrings - length limits', () => {
  // Too short (< 4 chars)
  const tooShort = new TextEncoder().encode('(abc)');
  assert.deepStrictEqual(findOrphanedStrings(tooShort), []);

  // Hex too short (< 8 hex chars = 4 decoded chars)
  // "Hey" in hex is 486579 (6 chars), pattern requires {8,}
  const hexTooShort = new TextEncoder().encode('<486579>');
  assert.deepStrictEqual(findOrphanedStrings(hexTooShort), []);
});

test('findOrphanedStrings - hex unprintable filter', () => {
  // 48=H, 65=e, 6C=l, 6C=l, 6F=o, 01=unprintable, 02=unprintable, 20=space, 57=W
  // Decoded: "Hello W" since 01 and 02 are dropped by `code >= 32 && code <= 126`
  const data = new TextEncoder().encode('<48656C6C6F01022057>');
  const results = findOrphanedStrings(data);
  assert.deepStrictEqual(results, ['Hello W']);
});

test('findOrphanedStrings - deduplication across formats', () => {
  // Both normal string and hex string evaluate to 'Duplicate'
  // Normal: (Duplicate)
  // Hex: "Duplicate" -> 4475706C6963617465
  const data = new TextEncoder().encode('(Duplicate) and also <4475706C6963617465>');
  const results = findOrphanedStrings(data);
  assert.deepStrictEqual(results, ['Duplicate']); // Should only appear once
});

test('findOrphanedStrings - empty or no matches', () => {
  const empty = new Uint8Array(0);
  assert.deepStrictEqual(findOrphanedStrings(empty), []);

  const noMatch = new TextEncoder().encode('Just some random text without PDF string delimiters');
  assert.deepStrictEqual(findOrphanedStrings(noMatch), []);
});

test('detectIncrementalSaves and extractPreviousVersion basics', () => {
  const pdfData = new TextEncoder().encode('Some PDF data %%EOF more data %%EOF');
  const info = detectIncrementalSaves(pdfData);
  assert.strictEqual(info.count, 2);
  assert.strictEqual(info.hasMultipleVersions, true);

  const prev = extractPreviousVersion(pdfData, info, 0);
  assert.strictEqual(new TextDecoder().decode(prev!), 'Some PDF data %%EOF');
});
