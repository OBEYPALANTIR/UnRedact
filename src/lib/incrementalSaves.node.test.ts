import test from 'node:test';
import assert from 'node:assert/strict';
import { detectIncrementalSaves } from './pdfForensics.ts';

test('detectIncrementalSaves', async (t) => {
  const encoder = new TextEncoder();

  await t.test('handles empty array', () => {
    const data = new Uint8Array(0);
    const result = detectIncrementalSaves(data);
    assert.deepEqual(result, {
      count: 0,
      eofOffsets: [],
      hasMultipleVersions: false,
    });
  });

  await t.test('handles array without %%EOF marker', () => {
    const data = encoder.encode('This is just some random PDF content without the marker.');
    const result = detectIncrementalSaves(data);
    assert.deepEqual(result, {
      count: 0,
      eofOffsets: [],
      hasMultipleVersions: false,
    });
  });

  await t.test('handles exactly one %%EOF marker', () => {
    const data = encoder.encode('some content%%EOF');
    const result = detectIncrementalSaves(data);
    assert.deepEqual(result, {
      count: 1,
      eofOffsets: [17],
      hasMultipleVersions: false,
    });
  });

  await t.test('handles multiple %%EOF markers', () => {
    const data = encoder.encode('content 1%%EOFcontent 2%%EOF');
    const result = detectIncrementalSaves(data);
    assert.deepEqual(result, {
      count: 2,
      eofOffsets: [14, 28],
      hasMultipleVersions: true,
    });
  });

  await t.test('handles consecutive %%EOF markers', () => {
    const data = encoder.encode('%%EOF%%EOF%%EOF');
    const result = detectIncrementalSaves(data);
    assert.deepEqual(result, {
      count: 3,
      eofOffsets: [5, 10, 15],
      hasMultipleVersions: true,
    });
  });

  await t.test('handles %%EOF marker at the beginning', () => {
    const data = encoder.encode('%%EOFcontent after');
    const result = detectIncrementalSaves(data);
    assert.deepEqual(result, {
      count: 1,
      eofOffsets: [5],
      hasMultipleVersions: false,
    });
  });

  await t.test('handles overlapping partial matches (does not false positive)', () => {
    const data = encoder.encode('%%EO%%EOF');
    const result = detectIncrementalSaves(data);
    assert.deepEqual(result, {
      count: 1,
      eofOffsets: [9],
      hasMultipleVersions: false,
    });
  });
});
