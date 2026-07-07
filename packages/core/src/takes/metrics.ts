import type { TranscriptWord } from '../schemas';
import { normalizeToken } from './normalize';

export const FILLER_LEXICON: readonly string[] = ['um', 'uh', 'erm', 'uhm', 'hmm', 'mmm', 'mhm', 'ah', 'eh', 'like', "y'know", 'yknow'];
const FILLER_SET = new Set<string>(FILLER_LEXICON);

export interface CandidateMetrics {
  fillerCount: number;
  falseStartCount: number;
  wordsPerSec: number;
  silenceRatio: number;
  durationSec: number;
  headBoundaryScore: number;
  tailBoundaryScore: number;
}

const SENTENCE_END = /[.!?…]["')\]]*$/;
const BOUNDARY_GAP_CAP = 2;
const BOUNDARY_GAP_RAMP = 0.6;

export function computeBoundaryScore(takeWords: TranscriptWord[], wordIndex: number, edge: 'head' | 'tail'): number {
  let gap: number;
  let terminal: boolean;
  if (edge === 'head') {
    gap = wordIndex === 0 ? Infinity : takeWords[wordIndex].start - takeWords[wordIndex - 1].end;
    terminal = wordIndex > 0 && SENTENCE_END.test(takeWords[wordIndex - 1].text);
  } else {
    gap = wordIndex === takeWords.length - 1 ? Infinity : takeWords[wordIndex + 1].start - takeWords[wordIndex].end;
    terminal = SENTENCE_END.test(takeWords[wordIndex].text);
  }
  const gapTerm = Math.min(1, Math.min(gap, BOUNDARY_GAP_CAP) / BOUNDARY_GAP_RAMP) * 0.6;
  const score = gapTerm + (terminal ? 0.4 : 0);
  return Number(score.toFixed(3));
}

export function computeCandidateMetrics(takeWords: TranscriptWord[], startIndex: number, endIndex: number): CandidateMetrics {
  const slice = takeWords.slice(startIndex, endIndex + 1);
  const normalized = slice.map((w) => normalizeToken(w.normalized || w.text));
  const fillerCount = normalized.filter((text) => FILLER_SET.has(text)).length;

  let falseStartCount = 0;
  for (let i = 0; i + 1 < normalized.length; i++) if (normalized[i] && normalized[i] === normalized[i + 1]) falseStartCount += 1;
  for (let i = 0; i + 3 < normalized.length; i++) if (normalized[i] && normalized[i] === normalized[i + 2] && normalized[i + 1] === normalized[i + 3]) falseStartCount += 1;

  const tStart = slice[0].start;
  const tEnd = slice[slice.length - 1].end;
  const durationSec = tEnd - tStart;
  const spoken = slice.reduce((sum, w) => sum + (w.end - w.start), 0);
  const wordsPerSec = durationSec > 0 ? Number((slice.length / durationSec).toFixed(4)) : 0;
  const silenceRatio = durationSec > 0 ? Number(Math.min(1, Math.max(0, 1 - spoken / durationSec)).toFixed(4)) : 0;

  return {
    fillerCount,
    falseStartCount,
    wordsPerSec,
    silenceRatio,
    durationSec: Number(durationSec.toFixed(4)),
    headBoundaryScore: computeBoundaryScore(takeWords, startIndex, 'head'),
    tailBoundaryScore: computeBoundaryScore(takeWords, endIndex, 'tail')
  };
}
