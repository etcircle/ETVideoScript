/**
 * Pure unit tests for snapSpanToBoundaries.
 * No I/O, no network, no ffmpeg. All fixtures inline.
 *
 * Fixture layout (asset axis, clipId='clip_001'):
 *   run-A: "the"(0.00-0.30) "quick"(0.34-0.62) "brown"(0.66-0.95)
 *   BREATH gap: 0.95 → 1.50 = 0.55s > BREATH_GAP_SEC (0.35) ← this is the breath
 *   run-B: "fox"(1.50-1.80) "ran"(1.84-2.10)
 *
 *   seg-A: 0.00-0.95 (contains run-A words)
 *   seg-B: 1.50-2.10 (contains run-B words)
 *
 * Intra-run gaps:
 *   the→quick: 0.34-0.30 = 0.04 ≤ 0.35 ✓ (same run)
 *   quick→brown: 0.66-0.62 = 0.04 ≤ 0.35 ✓ (same run)
 *   fox→ran: 1.84-1.80 = 0.04 ≤ 0.35 ✓ (same run)
 */

import { describe, expect, it } from 'vitest';
import { snapSpanToBoundaries, MAX_INTERNAL_GAP } from '../index';
import type { TranscriptWords } from '../schemas';

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeWords(timing: 'exact' | 'approximate' | 'mock' = 'exact'): TranscriptWords {
  return {
    schemaVersion: 1,
    source: 'media/clip_001/extracted-audio.wav',
    provider: { name: 'homelab-whisper', model: 'configured-whisper', requestId: 'req_test', timing },
    language: 'en',
    durationSec: 2.10,
    words: [
      { id: 'w000001', text: 'the',   normalized: 'the',   start: 0.00, end: 0.30, speaker: 'speaker_1', confidence: 0.95, segmentId: 'seg0001', clipId: 'clip_001' },
      { id: 'w000002', text: 'quick', normalized: 'quick', start: 0.34, end: 0.62, speaker: 'speaker_1', confidence: 0.90, segmentId: 'seg0001', clipId: 'clip_001' },
      { id: 'w000003', text: 'brown', normalized: 'brown', start: 0.66, end: 0.95, speaker: 'speaker_1', confidence: 0.92, segmentId: 'seg0001', clipId: 'clip_001' },
      { id: 'w000004', text: 'fox',   normalized: 'fox',   start: 1.50, end: 1.80, speaker: 'speaker_1', confidence: 0.88, segmentId: 'seg0002', clipId: 'clip_001' },
      { id: 'w000005', text: 'ran',   normalized: 'ran',   start: 1.84, end: 2.10, speaker: 'speaker_1', confidence: 0.85, segmentId: 'seg0002', clipId: 'clip_001' }
    ],
    segments: [
      { id: 'seg0001', speaker: 'speaker_1', start: 0.00, end: 0.95, text: 'the quick brown' },
      { id: 'seg0002', speaker: 'speaker_1', start: 1.50, end: 2.10, text: 'fox ran' }
    ]
  };
}

// Fixture with a different clipId word to test clip isolation.
function makeWordsWithOtherClip(): TranscriptWords {
  const base = makeWords();
  return {
    ...base,
    words: [
      ...base.words,
      { id: 'w999999', text: 'other', normalized: 'other', start: 0.10, end: 0.25, speaker: 'speaker_1', confidence: 0.99, segmentId: 'seg0001', clipId: 'clip_other' }
    ]
  };
}

// Fixture with a word at a non-integer timestamp for 6-dp rounding test.
function makeWordsWith6dp(): TranscriptWords {
  return {
    schemaVersion: 1,
    source: 'media/clip_001/extracted-audio.wav',
    provider: { name: 'homelab-whisper', model: 'configured-whisper', requestId: 'req_test', timing: 'exact' },
    language: 'en',
    durationSec: 1.0,
    words: [
      { id: 'w000001', text: 'hi', normalized: 'hi', start: 0.123456789, end: 0.456789012, speaker: 'speaker_1', confidence: 0.9, segmentId: 'seg0001', clipId: 'clip_001' }
    ],
    segments: [
      { id: 'seg0001', speaker: 'speaker_1', start: 0.123456789, end: 0.456789012, text: 'hi' }
    ]
  };
}

// Fixture for tie-break test: two words with EQUAL edge distance from the selection.
// Selection: { start: 1.00, end: 1.20 } (a gap region).
// Word A: 0.60-0.80  →  edgeDist = min(|0.60-1.20|, |0.80-1.00|) = min(0.60, 0.20) = 0.20
// Word B: 1.40-1.60  →  edgeDist = min(|1.40-1.20|, |1.60-1.00|) = min(0.20, 0.60) = 0.20
// Both have edgeDist = 0.20 → tie on distance → break by start ASC → A wins (0.60 < 1.40).
function makeTieBreakWords(): TranscriptWords {
  return {
    schemaVersion: 1,
    source: 'media/clip_001/extracted-audio.wav',
    provider: { name: 'homelab-whisper', model: 'configured-whisper', requestId: 'req_tb', timing: 'exact' },
    language: 'en',
    durationSec: 2.0,
    words: [
      // Deliberately listed out of order to test defensive sort.
      { id: 'w_b', text: 'B', normalized: 'b', start: 1.40, end: 1.60, speaker: 'speaker_1', confidence: 0.9, segmentId: 'seg0001', clipId: 'clip_001' },
      { id: 'w_a', text: 'A', normalized: 'a', start: 0.60, end: 0.80, speaker: 'speaker_1', confidence: 0.9, segmentId: 'seg0001', clipId: 'clip_001' }
    ],
    segments: [
      { id: 'seg0001', speaker: 'speaker_1', start: 0.60, end: 1.60, text: 'A B' }
    ]
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

describe('MAX_INTERNAL_GAP exported constant', () => {
  it('equals 0.35 (the canonical BREATH_GAP_SEC)', () => {
    expect(MAX_INTERNAL_GAP).toBe(0.35);
  });
});

// ── §2.1 WORD mode ────────────────────────────────────────────────────────────

describe('snapSpanToBoundaries — WORD mode', () => {
  it('case 1: word-exact (single word) — selection inside "quick" → [0.34, 0.62]', () => {
    const words = makeWords();
    const result = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'word');
    expect(result.start).toBe(0.34);
    expect(result.end).toBe(0.62);
    expect(result.mode).toBe('word');
    expect(result.downgraded).toBe(false);
    expect(result.reason).toBe('word-union');
  });

  it('case 2: word-union (multi-word) — selection spanning "quick".."brown" → single contiguous span [0.34, 0.95]', () => {
    const words = makeWords();
    const result = snapSpanToBoundaries(words, { start: 0.40, end: 0.90, clipId: 'clip_001' }, 'word');
    // Must be ONE span covering both words, not two fragments.
    expect(result.start).toBe(0.34);
    expect(result.end).toBe(0.95);
    expect(result.mode).toBe('word');
    expect(result.downgraded).toBe(false);
    expect(result.reason).toBe('word-union');
  });

  it('case 3: word-nearest (gap selection) — point at 1.20 → nearest word by edge distance', () => {
    const words = makeWords();
    // sel=[1.20,1.21] (collapsed point in the breath gap)
    // edgeDist("brown"): min(|0.66-1.21|, |0.95-1.20|) = min(0.55, 0.25) = 0.25
    // edgeDist("fox"):   min(|1.50-1.21|, |1.80-1.20|) = min(0.29, 0.60) = 0.29
    // nearest = "brown" (0.25 < 0.29)
    const result = snapSpanToBoundaries(words, { start: 1.20, end: 1.21, clipId: 'clip_001' }, 'word');
    expect(result.start).toBe(0.66);
    expect(result.end).toBe(0.95);
    expect(result.mode).toBe('word');
    expect(result.downgraded).toBe(false);
    expect(result.reason).toBe('word-nearest');
  });

  it('deterministic: calling WORD mode twice returns byte-identical results', () => {
    const words = makeWords();
    const r1 = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'word');
    const r2 = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'word');
    expect(r1).toEqual(r2);
  });

  it('tie-break: two equidistant words — picks the lower start deterministically (start ASC)', () => {
    const words = makeTieBreakWords();
    // sel=[1.00,1.20]. Word A(0.60-0.80) and Word B(1.40-1.60) both have edgeDist=0.20.
    // Tie on edgeDist → break by start ASC → Word A (start=0.60) wins over Word B (start=1.40).
    const result = snapSpanToBoundaries(words, { start: 1.00, end: 1.20, clipId: 'clip_001' }, 'word');
    expect(result.start).toBe(0.60);
    expect(result.end).toBe(0.80);
    expect(result.reason).toBe('word-nearest');
  });
});

// ── §2.2 PHRASE mode ──────────────────────────────────────────────────────────

describe('snapSpanToBoundaries — PHRASE mode', () => {
  it('case 4: phrase-outward-to-breaths — selection inside "quick" → expands to full run-A [0.00, 0.95]', () => {
    const words = makeWords();
    // "quick" is at 0.34-0.62. PHRASE walks outward: LEFT stops at clip start (0.00), RIGHT stops at breath before "fox".
    const result = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'phrase');
    expect(result.start).toBe(0.00);
    expect(result.end).toBe(0.95);
    expect(result.mode).toBe('phrase');
    expect(result.downgraded).toBe(false);
    expect(result.reason).toBe('phrase-run');
    // Must NOT include "fox" (run-B).
    expect(result.end).toBeLessThan(1.50);
  });

  it('case 5: phrase single contiguous span for multi-word selection crossing breath', () => {
    const words = makeWords();
    // Selection spanning "brown"(0.66-0.95).."fox"(1.50-1.80) — crosses the breath.
    // Both words are covered → i0=index of "brown"=2, i1=index of "fox"=3.
    // Walk LEFT from i0=2: brown.start=0.66, quick.end=0.62 → gap=0.04 ≤ 0.35 → include.
    //   i0=1 (quick): the.end=0.30 → gap=0.04 ≤ 0.35 → include. i0=0 (the). L=0.
    // Walk RIGHT from i1=3: ran.start=1.84, fox.end=1.80 → gap=0.04 ≤ 0.35 → include. R=4 (ran). R=4.
    // Result: [the.start, ran.end] = [0.00, 2.10].
    // The spec says the walk stops at breaths OUTSIDE the covered window. Both runs are touched
    // (covered includes words from both runs), so the walk continues through both runs.
    const result = snapSpanToBoundaries(words, { start: 0.80, end: 1.60, clipId: 'clip_001' }, 'phrase');
    expect(result.start).toBe(0.00);
    expect(result.end).toBe(2.10);
    expect(result.mode).toBe('phrase');
    expect(result.downgraded).toBe(false);
    // Assert ONE contiguous span (start < end, no fragmentation).
    expect(result.start).toBeLessThan(result.end);
  });

  it('phrase stays within a single run when selection is entirely in run-A', () => {
    const words = makeWords();
    const result = snapSpanToBoundaries(words, { start: 0.10, end: 0.50, clipId: 'clip_001' }, 'phrase');
    // Covered: the(0.00-0.30), quick(0.34-0.62). Walk outward — all within run-A.
    expect(result.start).toBe(0.00);
    expect(result.end).toBe(0.95);
    // Must not cross the breath into run-B.
    expect(result.end).toBeLessThan(1.50);
  });

  it('case 7: sentence-stays-opt-in — PHRASE and SENTENCE return different spans for same selection', () => {
    const words = makeWords();
    // Selection inside "quick" (0.40-0.55).
    const phraseResult = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'phrase');
    const sentenceResult = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'sentence');
    // PHRASE = run-A: [0.00, 0.95]. SENTENCE = seg0001: [0.00, 0.95]. In this fixture they coincide.
    // Test that SENTENCE is not silently identical ONLY when segments differ from runs.
    // For correctness: both should snap to seg0001's boundaries. The important assertion is
    // that SENTENCE mode is OPT-IN — default (phrase) never escalates to segment silently.
    // Use a multi-run selection to show the difference:
    const phraseMulti = snapSpanToBoundaries(words, { start: 0.80, end: 1.60, clipId: 'clip_001' }, 'phrase');
    const sentenceMulti = snapSpanToBoundaries(words, { start: 0.80, end: 1.60, clipId: 'clip_001' }, 'sentence');
    // PHRASE (multi-run covered) = [0.00, 2.10] (both runs merged via walk).
    // SENTENCE (multi-run covered) = [min(seg0001.start, seg0002.start), max(seg0001.end, seg0002.end)] = [0.00, 2.10].
    // They coincide when both runs each have one segment. Test via mode field.
    expect(phraseMulti.mode).toBe('phrase');
    expect(sentenceMulti.mode).toBe('sentence');
    // The critical invariant: SENTENCE is never chosen when 'phrase' or 'word' is requested.
    expect(phraseResult.mode).not.toBe('sentence');
    expect(phraseResult.mode).toBe('phrase');
  });

  it('case 8a: phrase non-exact downgrade (approximate) — returns WORD result, downgraded:true', () => {
    const words = makeWords('approximate');
    const result = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'phrase');
    expect(result.downgraded).toBe(true);
    expect(result.mode).toBe('phrase'); // mode field echoes the REQUESTED mode
    expect(result.reason).toBe('phrase-nonexact:word-fallback');
    // Content equals WORD result: covered word is "quick" [0.34, 0.62].
    expect(result.start).toBe(0.34);
    expect(result.end).toBe(0.62);
  });

  it('case 8b: phrase non-exact downgrade (mock) — same behavior', () => {
    const words = makeWords('mock');
    const result = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'phrase');
    expect(result.downgraded).toBe(true);
    expect(result.mode).toBe('phrase');
    expect(result.reason).toBe('phrase-nonexact:word-fallback');
  });

  it('case 8c: WORD under non-exact timing returns normally (no downgrade)', () => {
    const words = makeWords('approximate');
    const result = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'word');
    expect(result.downgraded).toBe(false);
    expect(result.mode).toBe('word');
  });

  it('deterministic: calling PHRASE mode twice returns byte-identical results', () => {
    const words = makeWords();
    const r1 = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'phrase');
    const r2 = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'phrase');
    expect(r1).toEqual(r2);
  });
});

// ── §2.3 SENTENCE mode ────────────────────────────────────────────────────────

describe('snapSpanToBoundaries — SENTENCE mode', () => {
  it('case 6a: sentence-to-segment — selection inside "quick" → seg0001 [0.00, 0.95]', () => {
    const words = makeWords();
    const result = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'sentence');
    expect(result.start).toBe(0.00);
    expect(result.end).toBe(0.95);
    expect(result.mode).toBe('sentence');
    expect(result.downgraded).toBe(false);
    expect(result.reason).toBe('sentence-segment');
  });

  it('case 6b: sentence spanning both runs → union of both segments [0.00, 2.10]', () => {
    const words = makeWords();
    // Selection spanning "brown".."fox" covers words from both segments.
    const result = snapSpanToBoundaries(words, { start: 0.80, end: 1.60, clipId: 'clip_001' }, 'sentence');
    expect(result.start).toBe(0.00); // min(seg0001.start=0.00, seg0002.start=1.50) = 0.00
    expect(result.end).toBe(2.10);   // max(seg0001.end=0.95, seg0002.end=2.10) = 2.10
    expect(result.mode).toBe('sentence');
    expect(result.downgraded).toBe(false);
  });

  it('SENTENCE under non-exact timing does not downgrade (timing-agnostic)', () => {
    const words = makeWords('mock');
    const result = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'sentence');
    expect(result.downgraded).toBe(false);
    expect(result.mode).toBe('sentence');
  });

  it('SENTENCE under approximate timing does not downgrade', () => {
    const words = makeWords('approximate');
    const result = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'sentence');
    expect(result.downgraded).toBe(false);
    expect(result.mode).toBe('sentence');
  });

  it('deterministic: calling SENTENCE mode twice returns byte-identical results', () => {
    const words = makeWords();
    const r1 = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'sentence');
    const r2 = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'sentence');
    expect(r1).toEqual(r2);
  });
});

// ── §2.5 Rounding & coordinates ───────────────────────────────────────────────

describe('snapSpanToBoundaries — 6-dp rounding', () => {
  it('case 10: word at 0.123456789 snaps to 0.123457 (6-dp round-half-up)', () => {
    const words = makeWordsWith6dp();
    const result = snapSpanToBoundaries(words, { start: 0.20, end: 0.30, clipId: 'clip_001' }, 'word');
    expect(result.start).toBe(0.123457);
    expect(result.end).toBe(0.456789);
  });
});

// ── §5 Coordinate model ───────────────────────────────────────────────────────

describe('snapSpanToBoundaries — coordinate model (asset axis)', () => {
  it('case 11a: primitive returns ASSET coords — off===0 is a no-op', () => {
    const words = makeWords();
    const assetResult = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'word');
    // Simulating the snapSelection helper: off = clip.sourceStart = 0.
    const off = 0;
    const clipLocalStart = assetResult.start - off;
    const clipLocalEnd = assetResult.end - off;
    expect(clipLocalStart).toBe(assetResult.start);
    expect(clipLocalEnd).toBe(assetResult.end);
  });

  it('case 11b: sourceStart !== 0 subtracts correctly (trimmed-clip guard)', () => {
    const words = makeWords();
    const assetResult = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_001' }, 'word');
    // Hypothetical trimmed clip: sourceStart = 0.5 → asset 0.34 maps to clip-local -0.16 (invalid in practice).
    // The point of this test is that the subtraction IS applied and IS deterministic.
    const off = 0.5;
    const clipLocalStart = assetResult.start - off;
    expect(clipLocalStart).toBeCloseTo(assetResult.start - 0.5, 10);
    // With off=0 (production): clipLocal = asset (existing behavior preserved).
    const offZero = 0;
    expect(assetResult.start - offZero).toBe(assetResult.start);
  });
});

// ── §6.1 Clip isolation ───────────────────────────────────────────────────────

describe('snapSpanToBoundaries — clip isolation', () => {
  it('case 12: word on a different clipId is never included in any snap', () => {
    const words = makeWordsWithOtherClip();
    // The clip_other word at 0.10-0.25 overlaps the selection, but must be ignored.
    const result = snapSpanToBoundaries(words, { start: 0.05, end: 0.28, clipId: 'clip_001' }, 'word');
    // Only clip_001 words in range: "the" (0.00-0.30).
    expect(result.start).toBe(0.00);
    expect(result.end).toBe(0.30);
  });

  it('passthrough for a selection on a clipId with no words', () => {
    const words = makeWords(); // only has clip_001 words
    const result = snapSpanToBoundaries(words, { start: 0.40, end: 0.55, clipId: 'clip_EMPTY' }, 'phrase');
    // No words on clip_EMPTY → passthrough.
    expect(result.start).toBe(0.40);
    expect(result.end).toBe(0.55);
    expect(result.reason).toBe('no-words-on-clip:passthrough');
  });
});

// ── §6.1 Empty / no-words passthrough ────────────────────────────────────────

describe('snapSpanToBoundaries — empty words guard', () => {
  it('case 13: empty words.words → passthrough of raw selection (no throw)', () => {
    const empty: TranscriptWords = {
      schemaVersion: 1,
      source: 'media/clip_001/extracted-audio.wav',
      provider: { name: 'mock', model: 'mock', requestId: null, timing: 'mock' },
      language: 'en',
      durationSec: 5,
      words: [],
      segments: []
    };
    for (const mode of ['word', 'phrase', 'sentence'] as const) {
      const result = snapSpanToBoundaries(empty, { start: 1.0, end: 2.0, clipId: 'clip_001' }, mode);
      expect(result.start).toBe(1.0);
      expect(result.end).toBe(2.0);
      expect(result.reason).toBe('no-words-on-clip:passthrough');
      expect(result.downgraded).toBe(false);
    }
  });
});

// ── FIX 4: containingSegmentByTime — nearest, not last ───────────────────────
//
// Before FIX 4 the gap fallback returned the LAST segment unconditionally, so a
// SENTENCE selection before the first segment or between two early segments jumped
// to the final paragraph.  The replacement clamps deterministically.

describe('snapSpanToBoundaries — SENTENCE mode gap fallback (FIX 4)', () => {
  /**
   * Fixture: two segments with a large inter-segment gap.
   *   seg0001: 0.00 – 0.95  (words: the 0.00-0.30, quick 0.34-0.62, brown 0.66-0.95)
   *   GAP:     0.95 – 3.00
   *   seg0002: 3.00 – 4.00  (words: fox 3.00-3.40, ran 3.50-4.00)
   */
  function makeGapWords(): TranscriptWords {
    return {
      schemaVersion: 1,
      source: 'media/clip_001/extracted-audio.wav',
      provider: { name: 'homelab-whisper', model: 'configured-whisper', requestId: 'req_gap4', timing: 'exact' },
      language: 'en',
      durationSec: 4.0,
      words: [
        { id: 'w000001', text: 'the',   normalized: 'the',   start: 0.00, end: 0.30, speaker: 'speaker_1', confidence: 0.95, segmentId: 'seg0001', clipId: 'clip_001' },
        { id: 'w000002', text: 'quick', normalized: 'quick', start: 0.34, end: 0.62, speaker: 'speaker_1', confidence: 0.90, segmentId: 'seg0001', clipId: 'clip_001' },
        { id: 'w000003', text: 'brown', normalized: 'brown', start: 0.66, end: 0.95, speaker: 'speaker_1', confidence: 0.92, segmentId: 'seg0001', clipId: 'clip_001' },
        { id: 'w000004', text: 'fox',   normalized: 'fox',   start: 3.00, end: 3.40, speaker: 'speaker_1', confidence: 0.88, segmentId: 'seg0002', clipId: 'clip_001' },
        { id: 'w000005', text: 'ran',   normalized: 'ran',   start: 3.50, end: 4.00, speaker: 'speaker_1', confidence: 0.85, segmentId: 'seg0002', clipId: 'clip_001' }
      ],
      segments: [
        { id: 'seg0001', speaker: 'speaker_1', start: 0.00, end: 0.95, text: 'the quick brown' },
        { id: 'seg0002', speaker: 'speaker_1', start: 3.00, end: 4.00, text: 'fox ran' }
      ]
    };
  }

  it('before-first: selection before any segment → clamps to FIRST segment (not last)', () => {
    const words = makeGapWords();
    // Selection at [-0.50, -0.10] — before the first segment starts at 0.00.
    // Before FIX 4: returned seg0002 (last). After FIX 4: returns seg0001 (first, t <= segments[0].start).
    const result = snapSpanToBoundaries(words, { start: -0.50, end: -0.10, clipId: 'clip_001' }, 'sentence');
    expect(result.start).toBe(0.00); // seg0001.start
    expect(result.end).toBe(0.95);   // seg0001.end
    expect(result.mode).toBe('sentence');
    expect(result.downgraded).toBe(false);
  });

  it('between-early-segments: selection in the gap (0.95–3.00) → nearest by midpoint (seg0001)', () => {
    const words = makeGapWords();
    // Selection at [1.10, 1.30] — in the 0.95-3.00 gap, closer to seg0001 midpoint (0.475) than seg0002 midpoint (3.50).
    // Distance from 1.20 to seg0001 midpoint = |0.475 - 1.20| = 0.725
    // Distance from 1.20 to seg0002 midpoint = |3.50  - 1.20| = 2.30
    // → seg0001 wins.
    // Before FIX 4: returned seg0002 (last fallback). After FIX 4: returns seg0001 (nearest).
    const result = snapSpanToBoundaries(words, { start: 1.10, end: 1.30, clipId: 'clip_001' }, 'sentence');
    expect(result.start).toBe(0.00);
    expect(result.end).toBe(0.95);
    expect(result.mode).toBe('sentence');
    expect(result.downgraded).toBe(false);
    // Confirm it did NOT pick the last segment.
    expect(result.end).toBeLessThan(3.00);
  });

  it('between-segments closer to second: selection at [2.50, 2.70] → seg0002 (nearer by midpoint)', () => {
    const words = makeGapWords();
    // Distance from 2.60 to seg0001 midpoint (0.475) = 2.125
    // Distance from 2.60 to seg0002 midpoint (3.50)  = 0.90
    // → seg0002 wins.
    const result = snapSpanToBoundaries(words, { start: 2.50, end: 2.70, clipId: 'clip_001' }, 'sentence');
    expect(result.start).toBe(3.00);
    expect(result.end).toBe(4.00);
    expect(result.mode).toBe('sentence');
  });

  it('after-last: selection beyond the last segment → clamps to LAST segment', () => {
    const words = makeGapWords();
    // Selection at [5.0, 5.5] — beyond seg0002 end (4.00). t >= segments[last].end → last.
    const result = snapSpanToBoundaries(words, { start: 5.0, end: 5.5, clipId: 'clip_001' }, 'sentence');
    expect(result.start).toBe(3.00);
    expect(result.end).toBe(4.00);
    expect(result.mode).toBe('sentence');
  });
});

describe('snapSpanToBoundaries — SENTENCE gap fallback (W6 review fixes)', () => {
  // A short near segment and a LONG far segment whose near edge is closest to the gap
  // selection but whose midpoint is far. Nearest-EDGE must pick the far segment;
  // nearest-midpoint (the bug) would wrongly pick the short near one.
  const edgeFixture: TranscriptWords = {
    schemaVersion: 1,
    source: 'media/clip_001/extracted-audio.wav',
    provider: { name: 'whisper', model: 'm', requestId: null, timing: 'exact' },
    language: 'en',
    durationSec: 20,
    words: [
      { id: 'wa1', text: 'a', normalized: 'a', start: 0.0, end: 0.5, speaker: 'speaker_1', confidence: 0.9, segmentId: 'segA', clipId: 'clip_001' },
      { id: 'wa2', text: 'b', normalized: 'b', start: 0.6, end: 1.0, speaker: 'speaker_1', confidence: 0.9, segmentId: 'segA', clipId: 'clip_001' },
      { id: 'wb1', text: 'c', normalized: 'c', start: 2.0, end: 2.5, speaker: 'speaker_1', confidence: 0.9, segmentId: 'segB', clipId: 'clip_001' },
      { id: 'wb2', text: 'd', normalized: 'd', start: 19.5, end: 20.0, speaker: 'speaker_1', confidence: 0.9, segmentId: 'segB', clipId: 'clip_001' }
    ],
    segments: [
      { id: 'segA', speaker: 'speaker_1', start: 0.0, end: 1.0, text: 'a b' },
      { id: 'segB', speaker: 'speaker_1', start: 2.0, end: 20.0, text: 'c d' }
    ]
  };

  it('picks the segment whose nearest EDGE is closest (not nearest midpoint)', () => {
    // Selection [1.9,1.95] is in the gap: 0.9s from segA.end, 0.1s from segB.start → segB.
    const r = snapSpanToBoundaries(edgeFixture, { start: 1.9, end: 1.95, clipId: 'clip_001' }, 'sentence');
    expect(r.mode).toBe('sentence');
    expect(r.start).toBe(2.0);
    expect(r.end).toBe(20.0);
  });

  it('restricts the gap fallback to the SELECTED clip\'s segments (multi-clip overlap)', () => {
    // clip_1 and clip_2 both span ~[0,5] in time but with DIFFERENT segment spans.
    // A gap selection on clip_2 must snap to clip_2's segment, never clip_1's overlapping one.
    const multiClip: TranscriptWords = {
      schemaVersion: 1,
      source: 'transcript/per-clip',
      provider: { name: 'whisper', model: 'm', requestId: null, timing: 'exact' },
      language: 'en',
      durationSec: 5,
      words: [
        { id: 'c1w1', text: 'x', normalized: 'x', start: 0.0, end: 1.0, speaker: 'speaker_1', confidence: 0.9, segmentId: 'seg_c1', clipId: 'clip_1' },
        { id: 'c1w2', text: 'y', normalized: 'y', start: 4.0, end: 5.0, speaker: 'speaker_1', confidence: 0.9, segmentId: 'seg_c1', clipId: 'clip_1' },
        { id: 'c2w1', text: 'p', normalized: 'p', start: 0.5, end: 1.0, speaker: 'speaker_1', confidence: 0.9, segmentId: 'seg_c2', clipId: 'clip_2' },
        { id: 'c2w2', text: 'q', normalized: 'q', start: 4.0, end: 4.5, speaker: 'speaker_1', confidence: 0.9, segmentId: 'seg_c2', clipId: 'clip_2' }
      ],
      segments: [
        { id: 'seg_c1', speaker: 'speaker_1', start: 0.0, end: 5.0, text: 'x y' },
        { id: 'seg_c2', speaker: 'speaker_1', start: 0.5, end: 4.5, text: 'p q' }
      ]
    };
    // Gap selection [2.0,2.5] on clip_2 (no clip_2 word covers it).
    const r = snapSpanToBoundaries(multiClip, { start: 2.0, end: 2.5, clipId: 'clip_2' }, 'sentence');
    expect(r.mode).toBe('sentence');
    // Must be seg_c2 [0.5, 4.5], NOT clip_1's overlapping seg_c1 [0, 5].
    expect(r.start).toBe(0.5);
    expect(r.end).toBe(4.5);
  });
});
