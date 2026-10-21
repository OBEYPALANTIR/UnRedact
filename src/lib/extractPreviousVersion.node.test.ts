import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractPreviousVersion } from './pdfForensics';
import type { VersionInfo } from '../types';

describe('extractPreviousVersion', () => {
  test('returns a separate empty slice when the source is empty', () => {
    assert.deepStrictEqual(extractPreviousVersion(new Uint8Array(), { count: 1, eofOffsets: [5], hasMultipleVersions: false }, 0), new Uint8Array());
  });
  const mockData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const mockVersionInfo: VersionInfo = {
    count: 3,
    eofOffsets: [3, 6, 9],
    hasMultipleVersions: true,
  };

  test('returns null for negative versionIndex', () => {
    const result = extractPreviousVersion(mockData, mockVersionInfo, -1);
    assert.strictEqual(result, null);
  });

  test('returns null for versionIndex >= eofOffsets.length', () => {
    const result = extractPreviousVersion(mockData, mockVersionInfo, 3);
    assert.strictEqual(result, null);
  });

  test('returns correctly sliced Uint8Array for valid versionIndex 0', () => {
    const result = extractPreviousVersion(mockData, mockVersionInfo, 0);
    assert.notStrictEqual(result, null);
    assert.deepStrictEqual(result, new Uint8Array([1, 2, 3]));
  });

  test('returns correctly sliced Uint8Array for valid versionIndex 1', () => {
    const result = extractPreviousVersion(mockData, mockVersionInfo, 1);
    assert.notStrictEqual(result, null);
    assert.deepStrictEqual(result, new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  test('returns correctly sliced Uint8Array for valid versionIndex 2', () => {
    const result = extractPreviousVersion(mockData, mockVersionInfo, 2);
    assert.notStrictEqual(result, null);
    assert.deepStrictEqual(result, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });
});
