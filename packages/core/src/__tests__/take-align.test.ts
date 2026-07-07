import { describe, expect, it } from 'vitest';
import { alignWordSequences, type AlignedPair } from '../takes/align';
import { normalizeWords } from '../takes/normalize';
import { makeWords } from './takes-fixtures';

const norm = (text: string) => normalizeWords(makeWords(text));

function kinds(pairs: AlignedPair[]): string[] { return pairs.map((p) => p.kind); }

function coversAll(pairs: AlignedPair[], refLen: number, takeLen: number): void {
  const refSeen = pairs.flatMap((p) => 'refIndex' in p ? [p.refIndex] : []);
  const takeSeen = pairs.flatMap((p) => 'takeIndex' in p ? [p.takeIndex] : []);
  expect([...new Set(refSeen)].sort((a, b) => a - b)).toEqual(Array.from({ length: refLen }, (_, i) => i));
  expect([...new Set(takeSeen)].sort((a, b) => a - b)).toEqual(Array.from({ length: takeLen }, (_, i) => i));
  expect(refSeen.length).toBe(refLen);
  expect(takeSeen.length).toBe(takeLen);
}

describe('alignWordSequences', () => {
  it('aligns identical sequences as all matches', () => {
    const a = norm('the quick brown fox jumps over the lazy dog again today friends');
    const pairs = alignWordSequences(a, a);
    expect(new Set(kinds(pairs))).toEqual(new Set(['match']));
    coversAll(pairs, a.length, a.length);
  });

  it('places a single substitution correctly', () => {
    const ref = norm('one two three four five six seven eight');
    const take = norm('one two three WRONG five six seven eight');
    const pairs = alignWordSequences(ref, take);
    const sub = pairs.find((p) => p.kind === 'substitution');
    expect(sub && 'refIndex' in sub && sub.refIndex).toBe(3);
    coversAll(pairs, ref.length, take.length);
  });

  it('handles insertion (takeGap) and deletion (refGap)', () => {
    const ref = norm('a b c d e f g h');
    const takeIns = norm('a b c EXTRA d e f g h');
    expect(kinds(alignWordSequences(ref, takeIns))).toContain('takeGap');
    const takeDel = norm('a b c e f g h');
    expect(kinds(alignWordSequences(ref, takeDel))).toContain('refGap');
    coversAll(alignWordSequences(ref, takeIns), ref.length, takeIns.length);
    coversAll(alignWordSequences(ref, takeDel), ref.length, takeDel.length);
  });

  it('handles empty sides', () => {
    const a = norm('x y z');
    expect(kinds(alignWordSequences(a, []))).toEqual(['refGap', 'refGap', 'refGap']);
    expect(kinds(alignWordSequences([], a))).toEqual(['takeGap', 'takeGap', 'takeGap']);
  });

  it('is deterministic and fast on 10k words with 1% mutations', () => {
    const vocabulary = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike'];
    // seeded LCG so the fixture is deterministic (no Math.random in tests either)
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const refTokens = Array.from({ length: 10000 }, (_, i) => `${vocabulary[Math.floor(rand() * vocabulary.length)]}${i % 97}`);
    const takeTokens = refTokens.map((t) => rand() < 0.01 ? 'MUTATED' : t);
    const ref = refTokens.map((text, index) => ({ text, index }));
    const take = takeTokens.map((text, index) => ({ text, index }));
    const started = performance.now();
    const pairs = alignWordSequences(ref, take);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2000);
    const matches = pairs.filter((p) => p.kind === 'match').length;
    expect(matches / ref.length).toBeGreaterThan(0.95);
    expect(alignWordSequences(ref, take)).toEqual(pairs); // determinism
  });
});
