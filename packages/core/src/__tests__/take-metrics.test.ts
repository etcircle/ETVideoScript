import { describe, expect, it } from 'vitest';
import { computeBoundaryScore, computeCandidateMetrics, FILLER_LEXICON } from '../takes/metrics';
import { makeWords } from './takes-fixtures';

describe('metrics', () => {
  it('counts fillers from the shared lexicon', () => {
    expect(FILLER_LEXICON).toContain('um');
    const words = makeWords('um so uh the thing');
    const metrics = computeCandidateMetrics(words, 0, words.length - 1);
    expect(metrics.fillerCount).toBe(2);
  });

  it('counts false starts (single and bigram repeats)', () => {
    const single = makeWords('the the cat sat');
    expect(computeCandidateMetrics(single, 0, single.length - 1).falseStartCount).toBe(1);
    const bigram = makeWords('i want i want this now');
    expect(computeCandidateMetrics(bigram, 0, bigram.length - 1).falseStartCount).toBe(1);
  });

  it('computes wordsPerSec, durationSec and silenceRatio', () => {
    const words = makeWords('one two three four', { wordSec: 0.3, gapSec: 0.2 }); // 4 words, each 0.3 spoken + 0.2 gap
    const metrics = computeCandidateMetrics(words, 0, words.length - 1);
    expect(metrics.durationSec).toBeCloseTo(words[3].end - words[0].start, 5);
    expect(metrics.wordsPerSec).toBeGreaterThan(0);
    expect(metrics.silenceRatio).toBeGreaterThan(0);
    expect(metrics.silenceRatio).toBeLessThan(1);
  });

  it('boundary score rewards gaps and sentence terminals', () => {
    const words = makeWords('done. next word here', { gapsAfter: { 0: 1.5 } });
    // head at word 1 ("next"): preceding word "done." is terminal AND gap 1.5 > cap
    const head = computeBoundaryScore(words, 1, 'head');
    expect(head).toBeCloseTo(1, 3);
    // head at word 0: i === 0 -> gap Infinity treated as full, no preceding terminal -> 0.6
    expect(computeBoundaryScore(words, 0, 'head')).toBeCloseTo(0.6, 3);
  });

  it('tail score at last word uses Infinity gap', () => {
    const words = makeWords('alpha beta gamma.');
    expect(computeBoundaryScore(words, words.length - 1, 'tail')).toBeCloseTo(1, 3); // terminal + full gap
  });
});
