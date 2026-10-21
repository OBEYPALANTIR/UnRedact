import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseResult } from './parseResult.ts';
import type { Redaction } from '../types.ts';

describe('parseResult', () => {
  test('handles empty string and empty redactions', () => {
    const result = parseResult('', []);
    assert.deepStrictEqual(result, []);
  });

  test('handles plain text without any redactions', () => {
    const result = parseResult('Just some plain text.', []);
    assert.deepStrictEqual(result, [
      { type: 'text', content: 'Just some plain text.' }
    ]);
  });

  test('parses a single RECOVERED redaction with metadata', () => {
    const text = 'Hello [RECOVERED:95]world[/RECOVERED]!';
    const redactions: Redaction[] = [
      { type: 'RECOVERED', text: 'world', score: 95, explanation: 'Found it', alternatives: ['earth'] }
    ];
    const result = parseResult(text, redactions);

    assert.deepStrictEqual(result, [
      { type: 'text', content: 'Hello ' },
      { type: 'recovered', score: 95, content: 'world', alternatives: ['earth'], explanation: 'Found it' },
      { type: 'text', content: '!' }
    ]);
  });

  test('parses GUESSED and INFERRED redactions with missing metadata fallbacks', () => {
    const text = '[GUESSED:80]foo[/GUESSED] and [INFERRED:60]bar[/INFERRED]';
    // Empty redactions array should cause metadata to fall back to defaults
    const result = parseResult(text, []);

    assert.deepStrictEqual(result, [
      { type: 'guessed', score: 80, content: 'foo', alternatives: [], explanation: '' },
      { type: 'text', content: ' and ' },
      { type: 'inferred', score: 60, content: 'bar', alternatives: [], explanation: '' }
    ]);
  });

  test('parses multiple redactions in succession without spacing', () => {
    const text = '[RECOVERED:99]A[/RECOVERED][GUESSED:50]B[/GUESSED]';
    const result = parseResult(text, []);

    assert.deepStrictEqual(result, [
      { type: 'recovered', score: 99, content: 'A', alternatives: [], explanation: '' },
      { type: 'guessed', score: 50, content: 'B', alternatives: [], explanation: '' }
    ]);
  });
});
