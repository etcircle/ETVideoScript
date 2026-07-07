import { describe, expect, it } from 'vitest';
import { alignWordSequences } from '../takes/align';
import { normalizeWords } from '../takes/normalize';
import { findOrphans, projectSpans, referenceFromScript, referenceFromTranscript, normalizeReference, segmentReference } from '../takes/spans';
import { TAKES_CONSTANTS } from '../takes/schema';
import { makeWords } from './takes-fixtures';

describe('segmentReference', () => {
  it('splits on sentence-terminal punctuation', () => {
    const ref = referenceFromTranscript(makeWords('This is one. And here is two! Is this three? Yes indeed here.'));
    const spans = segmentReference(ref);
    expect(spans.map((s) => s.text)).toEqual(['This is one.', 'And here is two!', 'Is this three?', 'Yes indeed here.']);
    expect(spans.map((s) => s.spanId)).toEqual(['s001', 's002', 's003', 's004']);
  });

  it('splits on silence gaps > 0.8s', () => {
    const words = makeWords('alpha beta gamma delta epsilon zeta', { gapsAfter: { 2: 1.0 } });
    const spans = segmentReference(referenceFromTranscript(words));
    expect(spans.map((s) => s.text)).toEqual(['alpha beta gamma', 'delta epsilon zeta']);
  });

  it('splits spans over 40 words at the largest internal gap', () => {
    const text = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ');
    const words = makeWords(text, { gapsAfter: { 24: 0.5 } }); // largest gap after word 24, still < 0.8 so no sentence split
    const spans = segmentReference(referenceFromTranscript(words));
    expect(spans.length).toBe(2);
    expect(spans[0].refWordEnd).toBe(24);
  });

  it('merges spans under 3 words forward (last merges backward)', () => {
    const spans = segmentReference(referenceFromTranscript(makeWords('Ok. Now the real sentence starts here. So.')));
    expect(spans.map((s) => s.text)).toEqual(['Ok. Now the real sentence starts here. So.'].length === 1 ? spans.map((s) => s.text) : spans.map((s) => s.text));
    // Explicit expectation: "Ok." (1 word) merges into the following sentence; trailing "So." (1 word) merges backward.
    expect(spans.length).toBe(1);
    expect(spans[0].text).toBe('Ok. Now the real sentence starts here. So.');
  });

  it('script mode uses punctuation only', () => {
    const spans = segmentReference(referenceFromScript('First sentence here. Second sentence there.'));
    expect(spans.length).toBe(2);
  });
});

describe('projectSpans', () => {
  function project(refText: string, takeText: string) {
    const refWords = makeWords(refText, { clipId: 'ref' });
    const takeWords = makeWords(takeText, { clipId: 'take' });
    const refNorm = normalizeWords(refWords);
    const takeNorm = normalizeWords(takeWords);
    const spans = segmentReference(referenceFromTranscript(refWords));
    const pairs = alignWordSequences(refNorm, takeNorm);
    return { spans, candidates: projectSpans(spans, refNorm, takeNorm, takeWords, pairs), takeWords, pairs, takeNorm };
  }

  it('full match: coverage and matchQuality are 1', () => {
    const { candidates } = project('Alpha beta gamma delta. Epsilon zeta eta theta.', 'Alpha beta gamma delta. Epsilon zeta eta theta.');
    expect(candidates.length).toBe(2);
    for (const c of candidates) {
      expect(c.coverage).toBe(1);
      expect(c.matchQuality).toBe(1);
      expect(c.truncated).toBe(false);
    }
  });

  it('pickup take covers only its span (others get no candidate)', () => {
    const { candidates } = project('One two three four. Five six seven eight.', 'five six seven eight');
    expect(candidates.map((c) => c.spanId)).toEqual(['s002']);
  });

  it('flubbed words lower matchQuality but not coverage', () => {
    const { candidates } = project('alpha beta gamma delta epsilon zeta', 'alpha beta WRONG delta epsilon zeta');
    expect(candidates[0].coverage).toBe(1);
    expect(candidates[0].matchQuality).toBeCloseTo(5 / 6, 4);
  });

  it('drops candidates under MIN_CANDIDATE_COVERAGE', () => {
    const { candidates } = project('one two three four five six seven eight nine ten', 'one two nothing else matches at all here really folks');
    expect(candidates.length === 0 || candidates.every((c) => c.coverage >= TAKES_CONSTANTS.MIN_CANDIDATE_COVERAGE)).toBe(true);
  });

  it('marks truncation when the take ends mid-span', () => {
    const { candidates } = project('alpha beta gamma delta epsilon zeta eta theta', 'alpha beta gamma delta epsilon');
    expect(candidates[0].truncated).toBe(true);
  });
});

describe('findOrphans', () => {
  it('emits runs of >= MIN_ORPHAN_WORDS unmatched take words', () => {
    const refWords = makeWords('start one two three end');
    const extra = 'completely new material appears here with many extra words indeed';
    const takeWords = makeWords(`start one two three ${extra} end`);
    const refNorm = normalizeWords(refWords);
    const takeNorm = normalizeWords(takeWords);
    const pairs = alignWordSequences(refNorm, takeNorm);
    const orphans = findOrphans(pairs, takeNorm, takeWords);
    expect(orphans.length).toBe(1);
    expect(orphans[0].text).toBe(extra);
  });

  it('ignores runs shorter than MIN_ORPHAN_WORDS', () => {
    const refWords = makeWords('start one two three end');
    const takeWords = makeWords('start one two three tiny aside here end');
    const pairs = alignWordSequences(normalizeWords(refWords), normalizeWords(takeWords));
    expect(findOrphans(pairs, normalizeWords(takeWords), takeWords)).toEqual([]);
  });
});
