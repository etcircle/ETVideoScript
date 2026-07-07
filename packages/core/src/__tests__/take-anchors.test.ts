import { describe, expect, it } from 'vitest';
import { findAnchors } from '../takes/anchors';
import { normalizeWords } from '../takes/normalize';
import { makeWords } from './takes-fixtures';

const norm = (text: string) => normalizeWords(makeWords(text));

describe('findAnchors', () => {
  it('finds unique shared 3-word shingles', () => {
    const ref = norm('alpha beta gamma delta epsilon');
    const take = norm('zzz alpha beta gamma delta epsilon');
    const anchors = findAnchors(ref, take);
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors[0]).toEqual({ refIndex: 0, takeIndex: 1 });
  });

  it('ignores shingles that repeat within either sequence', () => {
    const ref = norm('a b c x a b c');
    const take = norm('a b c');
    expect(findAnchors(ref, take)).toEqual([]); // "a b c" occurs twice in ref
  });

  it('drops crossing anchors via LIS', () => {
    // ref: X...Y   take: Y...X -> only one can survive
    const ref = norm('q w e r t y u i o p');
    const take = norm('y u i o p q w e r t');
    const anchors = findAnchors(ref, take);
    for (let i = 1; i < anchors.length; i++) {
      expect(anchors[i].refIndex).toBeGreaterThan(anchors[i - 1].refIndex);
      expect(anchors[i].takeIndex).toBeGreaterThan(anchors[i - 1].takeIndex);
    }
  });

  it('returns [] when nothing is shared', () => {
    expect(findAnchors(norm('a b c d e'), norm('v w x y z'))).toEqual([]);
  });
});
