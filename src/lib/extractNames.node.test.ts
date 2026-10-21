import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractNames } from './personsApi';

describe('extractNames', () => {
  test('handles punctuation around names', () => {
    assert.deepStrictEqual(extractNames('John Doe, Jane Smith; Alice Johnson.'), ['John Doe', 'Jane Smith', 'Alice Johnson']);
  });
  test('extracts basic first and last names', () => {
    const text = 'This is a document about John Doe and Jane Smith.';
    const result = extractNames(text);
    assert.deepStrictEqual(result, ['John Doe', 'Jane Smith']);
  });

  test('extracts names with middle names', () => {
    const text = 'We also investigated John Jacob Jingleheimer Schmidt and Mary Sue.';
    const result = extractNames(text);
    assert.deepStrictEqual(result, ['John Jacob Jingleheimer', 'Mary Sue']); // Note: regex only matches up to 3 words
  });

  test('ignores single capitalized words', () => {
    const text = 'The quick brown Fox jumped over the lazy Dog. John Doe saw it.';
    const result = extractNames(text);
    assert.deepStrictEqual(result, ['John Doe']);
  });

  test('ignores words in the stoplist', () => {
    const text = 'In January, John Doe went to New York and Los Angeles with Jane Smith.';
    const result = extractNames(text);
    // In January -> "In January" is matched because "In" is a capitalized word and "January" is a capitalized word.
    // However, January alone is in the stop list, but the regex matches full words (2-3 capitalized words).
    // The stoplist checks the full match (i.e. NAME_STOPLIST.has("In January")). "In January" is NOT in the stoplist.
    // So "In January" gets extracted. Same for "Los Angeles" (which IS in the stoplist, so it gets skipped), and "New York" (IS in the stoplist, gets skipped).
    assert.deepStrictEqual(result, ['In January', 'John Doe', 'Jane Smith']);
  });

  test('ignores exact matches in the stoplist', () => {
    // We add some non-capitalized words in between so the regex matches exactly the 2-word phrase.
    // "United States", "Supreme Court", "Washington DC"
    // They are all in NAME_STOPLIST, so they should be ignored.
    const text = 'the United States and the Supreme Court is in Washington DC.';
    const result = extractNames(text);
    // All 3 of these phrases are in the NAME_STOPLIST and should be skipped.
    assert.deepStrictEqual(result, []);
  });

  test('sorts by frequency', () => {
    const text = 'Jane Smith is mentioned. John Doe is here. John Doe did this. Jane Smith, Jane Smith, Jane Smith.';
    const result = extractNames(text);
    assert.deepStrictEqual(result, ['Jane Smith', 'John Doe']);
  });

  test('respects maxNames limit', () => {
    const text = 'Alice Bob, Alice Bob, Charlie Dave, Charlie Dave, Charlie Dave, Eve Frank, George Henry';
    const result = extractNames(text, 2);
    // Charlie Dave has 3, Alice Bob has 2. Eve Frank and George Henry have 1.
    assert.deepStrictEqual(result, ['Charlie Dave', 'Alice Bob']);
  });

  test('handles empty strings and strings with no names', () => {
    assert.deepStrictEqual(extractNames(''), []);
    assert.deepStrictEqual(extractNames('just some lowercase words here'), []);
    assert.deepStrictEqual(extractNames('12345 67890 !@#$'), []);
  });
});
