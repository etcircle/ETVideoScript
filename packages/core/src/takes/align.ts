import { findAnchors } from './anchors';
import type { NormalizedWord } from './normalize';

export const ALIGN_SCORES = { match: 2, mismatch: -1, gap: -1 } as const;

export type AlignedPair =
  | { kind: 'match' | 'substitution'; refIndex: number; takeIndex: number }
  | { kind: 'refGap'; refIndex: number }
  | { kind: 'takeGap'; takeIndex: number };

const WINDOW_SPLIT_THRESHOLD = 5000;

/**
 * Banded Needleman-Wunsch on one anchor-free window.
 * refOff/takeOff translate window-local indices back to sequence indices.
 */
function nwAlign(ref: NormalizedWord[], take: NormalizedWord[], refOff: number, takeOff: number): AlignedPair[] {
  const n = ref.length;
  const m = take.length;
  if (n === 0) return take.map((_, j) => ({ kind: 'takeGap' as const, takeIndex: takeOff + j }));
  if (m === 0) return ref.map((_, i) => ({ kind: 'refGap' as const, refIndex: refOff + i }));
  if (Math.max(n, m) > WINDOW_SPLIT_THRESHOLD) {
    // Degenerate anchor-free window (synthetic input): co-split proportionally at the midpoint.
    const midRef = n >> 1;
    const midTake = Math.round((m * midRef) / n);
    return [
      ...nwAlign(ref.slice(0, midRef), take.slice(0, midTake), refOff, takeOff),
      ...nwAlign(ref.slice(midRef), take.slice(midTake), refOff + midRef, takeOff + midTake)
    ];
  }

  const band = Math.max(32, Math.ceil(0.2 * Math.max(n, m)));
  const width = 2 * band + 1;
  const NEG = -0x3fffffff;
  const center = (i: number) => n === 0 ? 0 : Math.round((i * m) / n);
  const inBand = (i: number, j: number) => i >= 0 && i <= n && j >= 0 && j <= m && Math.abs(j - center(i)) <= band;
  const idx = (i: number, j: number) => i * width + (j - center(i) + band);

  const score = new Int32Array((n + 1) * width).fill(NEG);
  const dir = new Uint8Array((n + 1) * width); // 0=unset, 1=diag, 2=up(refGap), 3=left(takeGap)
  score[idx(0, 0)] = 0;
  for (let j = 1; inBand(0, j); j++) {
    score[idx(0, j)] = j * ALIGN_SCORES.gap;
    dir[idx(0, j)] = 3;
  }
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(0, center(i) - band);
    const hi = Math.min(m, center(i) + band);
    for (let j = lo; j <= hi; j++) {
      let best = NEG;
      let d = 0;
      if (j > 0 && inBand(i - 1, j - 1) && score[idx(i - 1, j - 1)] > NEG) {
        const diagScore = score[idx(i - 1, j - 1)] + (ref[i - 1].text === take[j - 1].text ? ALIGN_SCORES.match : ALIGN_SCORES.mismatch);
        if (diagScore > best) { best = diagScore; d = 1; }
      }
      if (inBand(i - 1, j) && score[idx(i - 1, j)] > NEG) {
        const upScore = score[idx(i - 1, j)] + ALIGN_SCORES.gap;
        if (upScore > best) { best = upScore; d = 2; }
      }
      if (j > 0 && inBand(i, j - 1) && score[idx(i, j - 1)] > NEG) {
        const leftScore = score[idx(i, j - 1)] + ALIGN_SCORES.gap;
        if (leftScore > best) { best = leftScore; d = 3; }
      }
      if (d !== 0) {
        score[idx(i, j)] = best;
        dir[idx(i, j)] = d;
      }
    }
  }

  const out: AlignedPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const d = inBand(i, j) ? dir[idx(i, j)] : 0;
    if (d === 1) {
      i -= 1; j -= 1;
      out.push({ kind: ref[i].text === take[j].text ? 'match' : 'substitution', refIndex: refOff + i, takeIndex: takeOff + j });
    } else if (d === 2 || (d === 0 && i > 0)) {
      i -= 1;
      out.push({ kind: 'refGap', refIndex: refOff + i });
    } else {
      j -= 1;
      out.push({ kind: 'takeGap', takeIndex: takeOff + j });
    }
  }
  return out.reverse();
}

export function alignWordSequences(ref: NormalizedWord[], take: NormalizedWord[]): AlignedPair[] {
  const anchors = findAnchors(ref, take);

  // Merge overlapping/touching same-diagonal anchors into runs of exact matches (each run covers >= 3 words).
  const runs: Array<{ refStart: number; takeStart: number; length: number }> = [];
  for (const anchor of anchors) {
    const last = runs[runs.length - 1];
    const sameDiagonal = last && anchor.takeIndex - anchor.refIndex === last.takeStart - last.refStart;
    if (last && sameDiagonal && anchor.refIndex <= last.refStart + last.length) {
      last.length = Math.max(last.length, anchor.refIndex + 3 - last.refStart);
    } else {
      runs.push({ refStart: anchor.refIndex, takeStart: anchor.takeIndex, length: 3 });
    }
  }

  const pairs: AlignedPair[] = [];
  let refPos = 0;
  let takePos = 0;
  for (const run of [...runs, null]) {
    const refEnd = run ? run.refStart : ref.length;
    const takeEnd = run ? run.takeStart : take.length;
    if (run && (run.refStart < refPos || run.takeStart < takePos)) continue; // overlapping non-mergeable run: skip
    pairs.push(...nwAlign(ref.slice(refPos, refEnd), take.slice(takePos, takeEnd), refPos, takePos));
    if (run) {
      for (let k = 0; k < run.length; k++) {
        pairs.push({ kind: 'match', refIndex: run.refStart + k, takeIndex: run.takeStart + k });
      }
      refPos = run.refStart + run.length;
      takePos = run.takeStart + run.length;
    }
  }
  return pairs;
}
