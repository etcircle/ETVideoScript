import type { TranscriptWord } from '../schemas';
import type { AlignedPair } from './align';
import { normalizeToken, type NormalizedWord } from './normalize';
import { TAKES_CONSTANTS } from './schema';

export interface ReferenceWord { text: string; start?: number; end?: number }

export function referenceFromTranscript(words: TranscriptWord[]): ReferenceWord[] {
  return words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
}

export function referenceFromScript(text: string): ReferenceWord[] {
  return text.split(/\s+/).filter(Boolean).map((token) => ({ text: token }));
}

export function normalizeReference(words: ReferenceWord[]): NormalizedWord[] {
  const out: NormalizedWord[] = [];
  words.forEach((word, index) => {
    const text = normalizeToken(word.text);
    if (text) out.push({ text, index });
  });
  return out;
}

export interface ReferenceSpan {
  spanId: string;
  ordinal: number;
  refWordStart: number;
  refWordEnd: number;
  text: string;
}

const SENTENCE_END = /[.!?…]["')\]]*$/;

export function segmentReference(words: ReferenceWord[]): ReferenceSpan[] {
  if (words.length === 0) return [];
  const hasTimings = words.every((w) => typeof w.start === 'number' && typeof w.end === 'number');

  // 1. initial boundaries
  let ranges: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    const isLast = i === words.length - 1;
    const sentenceEnd = SENTENCE_END.test(words[i].text);
    const gapBreak = hasTimings && !isLast && (words[i + 1].start! - words[i].end!) > TAKES_CONSTANTS.SENTENCE_GAP_SEC;
    if (isLast || sentenceEnd || gapBreak) {
      ranges.push([start, i]);
      start = i + 1;
    }
  }

  // 2. split ranges longer than SPAN_MAX_WORDS at the largest internal gap (midpoint without timings)
  const split: Array<[number, number]> = [];
  const splitRange = (lo: number, hi: number): void => {
    if (hi - lo + 1 <= TAKES_CONSTANTS.SPAN_MAX_WORDS) { split.push([lo, hi]); return; }
    let cut = lo + ((hi - lo) >> 1); // default midpoint; cut = last index of the left part
    if (hasTimings) {
      let bestGap = -1;
      for (let i = lo; i < hi; i++) {
        const gap = words[i + 1].start! - words[i].end!;
        if (gap > bestGap) { bestGap = gap; cut = i; }
      }
    }
    splitRange(lo, cut);
    splitRange(cut + 1, hi);
  };
  for (const [lo, hi] of ranges) splitRange(lo, hi);
  ranges = split;

  // 3. merge ranges shorter than SPAN_MIN_WORDS into the FOLLOWING range (last merges backward)
  const merged: Array<[number, number]> = [];
  for (let i = 0; i < ranges.length; i++) {
    const [lo, hi] = ranges[i];
    if (hi - lo + 1 < TAKES_CONSTANTS.SPAN_MIN_WORDS) {
      if (i + 1 < ranges.length) { ranges[i + 1] = [lo, ranges[i + 1][1]]; continue; }
      if (merged.length > 0) { merged[merged.length - 1] = [merged[merged.length - 1][0], hi]; continue; }
    }
    merged.push([lo, hi]);
  }

  return merged.map(([lo, hi], i) => ({
    spanId: `s${String(i + 1).padStart(3, '0')}`,
    ordinal: i + 1,
    refWordStart: lo,
    refWordEnd: hi,
    text: words.slice(lo, hi + 1).map((w) => w.text).join(' ')
  }));
}

export interface RawCandidate {
  spanId: string;
  takeWordStart: number;
  takeWordEnd: number;
  tStart: number;
  tEnd: number;
  coverage: number;
  matchQuality: number;
  truncated: boolean;
}

export function projectSpans(
  spans: ReferenceSpan[],
  refNorm: NormalizedWord[],
  takeNorm: NormalizedWord[],
  takeWords: TranscriptWord[],
  pairs: AlignedPair[]
): RawCandidate[] {
  // Map normalized ref position -> span index
  const spanOfOriginalRefIndex = new Map<number, number>();
  spans.forEach((span, spanIdx) => {
    for (let i = span.refWordStart; i <= span.refWordEnd; i++) spanOfOriginalRefIndex.set(i, spanIdx);
  });
  const spanRefNormCounts = new Array<number>(spans.length).fill(0);
  const spanOfRefNormIndex = new Map<number, number>();
  refNorm.forEach((word, normIdx) => {
    const spanIdx = spanOfOriginalRefIndex.get(word.index);
    if (spanIdx !== undefined) {
      spanOfRefNormIndex.set(normIdx, spanIdx);
      spanRefNormCounts[spanIdx] += 1;
    }
  });

  const perSpan = spans.map(() => ({ covered: 0, matched: 0, minTake: Infinity, maxTake: -Infinity }));
  for (const pair of pairs) {
    if (pair.kind !== 'match' && pair.kind !== 'substitution') continue;
    const spanIdx = spanOfRefNormIndex.get(pair.refIndex);
    if (spanIdx === undefined) continue;
    const acc = perSpan[spanIdx];
    acc.covered += 1;
    if (pair.kind === 'match') acc.matched += 1;
    acc.minTake = Math.min(acc.minTake, pair.takeIndex);
    acc.maxTake = Math.max(acc.maxTake, pair.takeIndex);
  }

  const out: RawCandidate[] = [];
  spans.forEach((span, spanIdx) => {
    const acc = perSpan[spanIdx];
    const denom = spanRefNormCounts[spanIdx];
    if (denom === 0 || acc.covered === 0) return;
    const coverage = acc.covered / denom;
    if (coverage < TAKES_CONSTANTS.MIN_CANDIDATE_COVERAGE) return;
    const firstTakeWord = takeNorm[acc.minTake];
    const lastTakeWord = takeNorm[acc.maxTake];
    const touchesTakeEdge = acc.minTake === 0 || acc.maxTake === takeNorm.length - 1;
    out.push({
      spanId: span.spanId,
      takeWordStart: firstTakeWord.index,
      takeWordEnd: lastTakeWord.index,
      tStart: takeWords[firstTakeWord.index].start,
      tEnd: takeWords[lastTakeWord.index].end,
      coverage: Number(coverage.toFixed(4)),
      matchQuality: Number((acc.matched / denom).toFixed(4)),
      truncated: touchesTakeEdge && coverage < 1
    });
  });
  return out;
}

export interface RawOrphan {
  takeWordStart: number;
  takeWordEnd: number;
  tStart: number;
  tEnd: number;
  text: string;
}

export function findOrphans(pairs: AlignedPair[], takeNorm: NormalizedWord[], takeWords: TranscriptWord[]): RawOrphan[] {
  const gapTakeIndices = pairs
    .flatMap((p) => p.kind === 'takeGap' ? [p.takeIndex] : [])
    .sort((a, b) => a - b);
  const orphans: RawOrphan[] = [];
  let runStart = -1;
  let prev = -2;
  const flush = (endIdx: number) => {
    if (runStart === -1) return;
    const length = endIdx - runStart + 1;
    if (length >= TAKES_CONSTANTS.MIN_ORPHAN_WORDS) {
      const startWord = takeNorm[runStart].index;
      const endWord = takeNorm[endIdx].index;
      orphans.push({
        takeWordStart: startWord,
        takeWordEnd: endWord,
        tStart: takeWords[startWord].start,
        tEnd: takeWords[endWord].end,
        text: takeWords.slice(startWord, endWord + 1).map((w) => w.text).join(' ')
      });
    }
    runStart = -1;
  };
  for (const takeIdx of gapTakeIndices) {
    if (takeIdx !== prev + 1) { flush(prev); runStart = takeIdx; }
    else if (runStart === -1) runStart = takeIdx;
    prev = takeIdx;
  }
  flush(prev);
  return orphans;
}
