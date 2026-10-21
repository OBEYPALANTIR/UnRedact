import { describe, it, expect } from 'vitest';
import { findTextUnderRedactions } from './pdf';
import type { TextItem, RedactionBox } from '../types';

describe('findTextUnderRedactions', () => {
  const item = (str: string, page: number, x = 20): TextItem => ({
    str, page, x, y: 80, width: 40, height: 12, fontName: 'Helvetica',
  });
  const box = (page: number, x = 18, width = 45): RedactionBox => ({
    page, x, y: 78, width, height: 16,
  });

  it('matches only text on the same page and preserves box/text ordering', () => {
    const text = [item('page two', 2), item('first', 1), item('second', 1), item('outside', 1, 200)];
    const boxes = [box(1), box(2), box(3)];
    const result = findTextUnderRedactions(text, boxes);
    expect(result.map((entry) => entry.text)).toEqual(['first', 'second', 'page two']);
    expect(result.map((entry) => entry.overlapPercent)).toEqual([100, 100, 100]);
    expect(result[0].box).toBe(boxes[0]);
    expect(result[2].textItem).toBe(text[0]);
  });

  it('retains the strict overlap threshold and handles empty input', () => {
    expect(findTextUnderRedactions([item('edge', 1)], [box(1, 20, 12)])).toEqual([]);
    expect(findTextUnderRedactions([item('over edge', 1)], [box(1, 20, 13)])[0].overlapPercent).toBe(33);
    expect(findTextUnderRedactions([], [box(1)])).toEqual([]);
    expect(findTextUnderRedactions([item('no boxes', 1)], [])).toEqual([]);
  });
});
