/**
 * transcriptSpan — PURE deterministic boundary-snapping primitive.
 *
 * No I/O, no Date, no Math.random, no ffmpeg.
 * All ordering uses cmpStr (locale-independent code-unit order) + numeric ASC.
 * Rounding: 6 decimal places (repo render-precision rule — pattern_ffmpeg_render_precision).
 *
 * Coordinate model:
 *   This function operates entirely in the ASSET axis (same axis as word.start/end).
 *   It does NOT know about clip.sourceStart. The caller (manifestRoutes snapSelection
 *   helper) converts to clip-local by subtracting clip.sourceStart (off). For the
 *   single-import case in production today, clip.sourceStart === 0 so off === 0 and
 *   asset coords equal clip-local — matching existing verbatim route behavior.
 *   See voiceClone.ts:411-424 for the authoritative coordinate model note.
 */

import type { TranscriptWords } from './schemas';
import { cmpStr, MAX_INTERNAL_GAP } from './voiceClone';

// Reuse the breath-gap constant from voiceClone.ts. Do NOT redeclare 0.35.
const BREATH_GAP_SEC = MAX_INTERNAL_GAP;

export type SnapMode = 'word' | 'phrase' | 'sentence';

export interface SnapSelection {
  /** Asset-axis seconds (transcript / word axis). */
  start: number;
  end: number;
  /** Only words on this clip are considered; words on other clips are never crossed. */
  clipId: string;
}

export interface SnapResult {
  /** Snapped boundaries in the SAME axis as the input (asset axis). 6-dp rounded. */
  start: number;
  end: number;
  /**
   * Echoes the REQUESTED mode even when WORD boundaries were actually applied due to
   * downgrade (non-exact timing or FK miss). Check `downgraded` to know whether WORD
   * boundaries were actually applied rather than the requested mode.
   *
   * FIX 6 (doc only — no behavior change): existing tests rely on mode === requested mode.
   */
  mode: SnapMode;
  /**
   * True when phrase/sentence was downgraded to word due to non-exact timing or a
   * corrupt manifest (e.g. FK miss in segment lookup). Never thrown — always degrades.
   */
  downgraded: boolean;
  /** Which boundary concept produced the result — for tests and future UI hints. */
  reason: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

// Half-open overlap predicate: identical to windowOverlaps in voiceClone.ts (private there).
function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && a.end > b.start;
}

type Word = TranscriptWords['words'][number];
type Segment = TranscriptWords['segments'][number];

/**
 * Stable sort by (start ASC, cmpStr(id) ASC).
 * Mirror of voiceClone.ts:227-230 defensive sort — no ties to randomness.
 */
function sortWords(words: Word[]): Word[] {
  return [...words].sort((a, b) => {
    const d = a.start - b.start;
    return d !== 0 ? d : cmpStr(a.id, b.id);
  });
}

/**
 * Nearest-word selection by edge distance (edgeDist ASC → start ASC → cmpStr(id) ASC).
 * edgeDist(w) := min(|w.start - sel.end|, |w.end - sel.start|)
 * No randomness; deterministic for any fixture.
 */
function nearestWord(clipWords: Word[], sel: SnapSelection): Word {
  function edgeDist(w: Word): number {
    return Math.min(Math.abs(w.start - sel.end), Math.abs(w.end - sel.start));
  }
  return clipWords.reduce((best, candidate) => {
    const db = edgeDist(best);
    const dc = edgeDist(candidate);
    if (dc < db) return candidate;
    if (dc > db) return best;
    // tie: start ASC
    if (candidate.start < best.start) return candidate;
    if (candidate.start > best.start) return best;
    // tie: cmpStr(id) ASC
    return cmpStr(candidate.id, best.id) < 0 ? candidate : best;
  });
}

/**
 * containingSegmentByTime — half-open containment first, then deterministic clamp.
 *
 * If no segment contains t: clamp before-first → first, after-last → last; for a gap
 * BETWEEN segments, return the segment whose nearest INTERVAL EDGE is closest to t (NOT
 * the nearest midpoint — a long far segment has a distant midpoint but may start right
 * next to t). Segments are sorted defensively so the first/last clamps are correct.
 * Deterministic: first-wins on an exact-distance tie (stable iteration over sorted).
 */
function containingSegmentByTime(segments: Segment[], t: number): Segment | undefined {
  if (segments.length === 0) return undefined;
  const sorted = [...segments].sort((a, b) => (a.start - b.start) || (a.end - b.end) || cmpStr(a.id, b.id));
  const containing = sorted.find((s) => s.start <= t && t < s.end);
  if (containing) return containing;
  if (t <= sorted[0]!.start) return sorted[0];
  if (t >= sorted[sorted.length - 1]!.end) return sorted[sorted.length - 1];
  // Gap between segments → nearest by interval-edge distance.
  let best = sorted[0]!;
  let bestDist = Infinity;
  for (const s of sorted) {
    const dist = t < s.start ? s.start - t : (t >= s.end ? t - s.end : 0);
    if (dist < bestDist) { best = s; bestDist = dist; }
  }
  return best;
}

// ── WORD mode ─────────────────────────────────────────────────────────────────

function snapWord(clipWords: Word[], sel: SnapSelection): SnapResult {
  const covered = clipWords.filter((w) => overlaps(w, sel));
  if (covered.length >= 1) {
    const lo = covered.reduce((m, w) => (w.start < m ? w.start : m), covered[0]!.start);
    const hi = covered.reduce((m, w) => (w.end > m ? w.end : m), covered[0]!.end);
    return { start: round6(lo), end: round6(hi), mode: 'word', downgraded: false, reason: 'word-union' };
  }
  // Selection collapsed into an inter-word gap — pick the nearest word.
  const nearest = nearestWord(clipWords, sel);
  return { start: round6(nearest.start), end: round6(nearest.end), mode: 'word', downgraded: false, reason: 'word-nearest' };
}

// ── PHRASE mode ───────────────────────────────────────────────────────────────

function snapPhrase(clipWords: Word[], sel: SnapSelection): SnapResult {
  const covered = clipWords.filter((w) => overlaps(w, sel));

  let i0: number;
  let i1: number;

  if (covered.length === 0) {
    // Anchor on the nearest word's index within clipWords.
    const anchor = nearestWord(clipWords, sel);
    const anchorIdx = clipWords.findIndex((w) => w.id === anchor.id);
    i0 = i1 = anchorIdx;
  } else {
    i0 = clipWords.findIndex((w) => w.id === covered[0]!.id);
    i1 = clipWords.findIndex((w) => w.id === covered[covered.length - 1]!.id);
  }

  // Walk LEFT: stop at the first breath gap (> BREATH_GAP_SEC), or clip start.
  let L = i0;
  while (L > 0 && (clipWords[L]!.start - clipWords[L - 1]!.end) <= BREATH_GAP_SEC) {
    L -= 1;
  }
  const leftEdge = clipWords[L]!.start;

  // Walk RIGHT: stop at the first breath gap (> BREATH_GAP_SEC), or clip end.
  let R = i1;
  while (R < clipWords.length - 1 && (clipWords[R + 1]!.start - clipWords[R]!.end) <= BREATH_GAP_SEC) {
    R += 1;
  }
  const rightEdge = clipWords[R]!.end;

  return { start: round6(leftEdge), end: round6(rightEdge), mode: 'phrase', downgraded: false, reason: 'phrase-run' };
}

// ── SENTENCE mode ─────────────────────────────────────────────────────────────
//
// NOTE: segments are merged *paragraph* spans (transcript.ts:166-189 merges whisper
// sentences at PARAGRAPH_MAX_GAP_SEC = 1.5s). So SENTENCE actually snaps to the
// enclosing *paragraph*, not a raw sentence. This is the only segment-level boundary
// the transcript carries — accepted as-is.

function snapSentence(clipWords: Word[], sel: SnapSelection, words: TranscriptWords): SnapResult {
  const covered = clipWords.filter((w) => overlaps(w, sel));

  let segs: Segment[];

  if (covered.length >= 1) {
    const segIds = new Set(covered.map((w) => w.segmentId));
    segs = words.segments.filter((s) => segIds.has(s.id));
  } else {
    // Time-containment fallback: selection landed in an inter-word gap. Restrict to THIS
    // clip's segments — segments carry no clipId, so in a multi-clip transcript another
    // clip's segment could overlap this clip's time range and be picked by mistake.
    const clipSegIds = new Set(clipWords.map((w) => w.segmentId));
    const clipSegments = words.segments.filter((s) => clipSegIds.has(s.id));
    const seg = containingSegmentByTime(clipSegments, sel.start);
    segs = seg ? [seg] : [];
  }

  if (segs.length === 0) {
    // FK miss (corrupt manifest): degrade to WORD rather than throw.
    const wordResult = snapWord(clipWords, sel);
    return { ...wordResult, mode: 'sentence', downgraded: true, reason: 'sentence-no-segment:word-fallback' };
  }

  const lo = segs.reduce((m, s) => (s.start < m ? s.start : m), segs[0]!.start);
  const hi = segs.reduce((m, s) => (s.end > m ? s.end : m), segs[0]!.end);
  return { start: round6(lo), end: round6(hi), mode: 'sentence', downgraded: false, reason: 'sentence-segment' };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Snap a selection to word/phrase/sentence boundaries in the ASSET axis.
 *
 * - WORD: always safe (no gap reads); snaps to union of overlapped words or nearest word.
 * - PHRASE (default): expands outward to the nearest breath gaps (> 0.35s = MAX_INTERNAL_GAP).
 *   Degrades to WORD with downgraded:true if timing !== 'exact' (gaps are synthetic).
 * - SENTENCE: expands to the enclosing transcript segment(s) (merged paragraph spans).
 *   Timing-agnostic — never downgrades.
 *
 * Never throws. Always returns a valid span.
 * All returned coordinates are ASSET-axis, 6-decimal-place rounded.
 * The caller converts to clip-local via: clipLocal = assetCoord - clip.sourceStart
 * (for single-import projects, clip.sourceStart === 0 so this is a no-op).
 *
 * NOTE on SnapResult.mode: mode echoes the REQUESTED mode; check `downgraded` to know
 * whether WORD boundaries were actually applied instead of the requested mode.
 */
export function snapSpanToBoundaries(
  words: TranscriptWords,
  sel: SnapSelection,
  mode: SnapMode
): SnapResult {
  // 1. Restrict to the selection's clip and sort defensively.
  const clipWords = sortWords(words.words.filter((w) => w.clipId === sel.clipId));

  // 2. Empty-clip guard.
  if (clipWords.length === 0) {
    return {
      start: round6(sel.start),
      end: round6(sel.end),
      mode,
      downgraded: false,
      reason: 'no-words-on-clip:passthrough'
    };
  }

  // 3. Non-exact timing guard for PHRASE (gaps are meaningless under synthetic spacing).
  //    Mirror selectCleanClip's stance (voiceClone.ts:214-218) but soften to a downgrade
  //    here so op-creation stays robust under mock/approximate transcripts.
  if (mode === 'phrase' && words.provider.timing !== 'exact') {
    const wordResult = snapWord(clipWords, sel);
    return { ...wordResult, mode: 'phrase', downgraded: true, reason: 'phrase-nonexact:word-fallback' };
  }

  switch (mode) {
    case 'word':
      return snapWord(clipWords, sel);
    case 'phrase':
      return snapPhrase(clipWords, sel);
    case 'sentence':
      return snapSentence(clipWords, sel, words);
  }
}
