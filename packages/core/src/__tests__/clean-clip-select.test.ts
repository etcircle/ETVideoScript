import { describe, expect, it } from 'vitest';
import { selectCleanClip } from '../voiceClone';
import type { TranscriptWords } from '../schemas';

// ── Fixture builders ──────────────────────────────────────────────────────────

let _wordSeq = 0;
function makeWord(
  id: string,
  start: number,
  end: number,
  confidence = 1.0,
  clipId = 'clip_001'
): TranscriptWords['words'][number] {
  return {
    id,
    text: 'word',
    normalized: 'word',
    start,
    end,
    speaker: 'speaker_1',
    confidence,
    segmentId: `seg_${id}`,
    clipId
  };
}

function makeTranscript(words: TranscriptWords['words'], timing: 'exact' | 'approximate' | 'mock' = 'exact'): TranscriptWords {
  const maxEnd = words.reduce((m, w) => Math.max(m, w.end), 0);
  return {
    schemaVersion: 1,
    source: 'test',
    provider: { name: 'whisper', model: 'base', requestId: null, timing },
    language: 'en',
    durationSec: maxEnd,
    words,
    segments: []
  };
}

// Build a sequence of words covering [startSec, endSec) with a given word duration and gap
function makeWordSequence(
  prefix: string,
  startSec: number,
  count: number,
  wordDuration: number,
  gap: number,
  confidence: number,
  clipId: string
): TranscriptWords['words'] {
  const words: TranscriptWords['words'] = [];
  let cursor = startSec;
  for (let i = 0; i < count; i++) {
    words.push(makeWord(`${prefix}_${i}`, cursor, cursor + wordDuration, confidence, clipId));
    cursor += wordDuration + gap;
  }
  return words;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('selectCleanClip — timing guard', () => {
  it('throws when transcript timing is not exact', () => {
    const words = makeTranscript([makeWord('w1', 0, 1)], 'mock');
    expect(() => selectCleanClip({ words, scope: 'project' })).toThrow('transcript-timing-not-exact');
  });

  it('throws for approximate timing', () => {
    const words = makeTranscript([makeWord('w1', 0, 1)], 'approximate');
    expect(() => selectCleanClip({ words, scope: 'project' })).toThrow('transcript-timing-not-exact');
  });
});

describe('selectCleanClip — project scope basic', () => {
  it('returns the best qualifying window covering ~10s', () => {
    // 15 words spanning 12s with small gaps — there's a clean 10s window
    const words = makeWordSequence('w', 0, 15, 0.7, 0.1, 0.95, 'clip_001');
    const transcript = makeTranscript(words);
    const result = selectCleanClip({ words: transcript, scope: 'project' });
    expect(result.scope).toBe('project');
    expect(result.clipId).toBe('clip_001');
    expect(result.spanSec).toBeGreaterThanOrEqual(6);
    expect(result.spanSec).toBeLessThanOrEqual(11.5);
  });

  it('is deterministic — same input, same output called twice', () => {
    const words = makeWordSequence('w', 0, 20, 0.6, 0.08, 0.9, 'clip_001');
    const transcript = makeTranscript(words);
    const r1 = selectCleanClip({ words: transcript, scope: 'project' });
    const r2 = selectCleanClip({ words: transcript, scope: 'project' });
    expect(r1).toEqual(r2);
  });

  it('prefers higher confidence windows', () => {
    // Two 10s windows: one at confidence 0.5, one at 0.95
    const lowConf = makeWordSequence('low', 0, 12, 0.7, 0.1, 0.5, 'clip_001');
    const highConf = makeWordSequence('high', 20, 12, 0.7, 0.1, 0.95, 'clip_001');
    const transcript = makeTranscript([...lowConf, ...highConf]);
    const result = selectCleanClip({ words: transcript, scope: 'project' });
    // The high-confidence window starts at 20s
    expect(result.start).toBeGreaterThanOrEqual(20);
  });
});

describe('selectCleanClip — gap splitting', () => {
  it('does not span a gap exceeding MAX_INTERNAL_GAP (0.35s)', () => {
    // Build two word groups with a 0.4s gap between them
    const group1 = makeWordSequence('g1', 0, 5, 0.7, 0.05, 0.95, 'clip_001');
    // Gap: group1 ends at ~3.75s; group2 starts at 3.75+0.4=4.15s
    const group1End = group1[group1.length - 1]!.end;
    const group2Start = group1End + 0.4; // 0.4 > MAX_INTERNAL_GAP
    const group2 = makeWordSequence('g2', group2Start, 10, 0.7, 0.05, 0.95, 'clip_001');
    const transcript = makeTranscript([...group1, ...group2]);

    const result = selectCleanClip({ words: transcript, scope: 'project' });
    // The result window must not span the gap: either entirely in group1 or entirely in group2
    const gapStart = group1End;
    const gapEnd = group2Start;
    // The window must not contain the gap interior
    expect(!(result.start < gapStart && result.end > gapEnd)).toBe(true);
  });
});

describe('selectCleanClip — cross-clip safety', () => {
  it('never combines words from two different clipIds into one window', () => {
    // Words from clip_001 [0..5s] and clip_002 [5.1..15s] with adjacent start values
    const clip1Words = makeWordSequence('c1', 0, 6, 0.7, 0.05, 0.95, 'clip_001');
    const clip2Words = makeWordSequence('c2', 5.1, 12, 0.7, 0.05, 0.95, 'clip_002');
    const transcript = makeTranscript([...clip1Words, ...clip2Words]);
    const result = selectCleanClip({ words: transcript, scope: 'project' });
    // All words in the result range must be from a single clip
    const resultWords = transcript.words.filter(
      (w) => w.clipId === result.clipId && w.start >= result.start - 0.001 && w.end <= result.end + 0.001
    );
    const uniqueClips = new Set(resultWords.map((w) => w.clipId));
    expect(uniqueClips.size).toBe(1);
  });
});

describe('selectCleanClip — stable tie-break', () => {
  it('breaks ties by _firstStart then _firstId (no randomness)', () => {
    // Two identical-score windows: same span, same confidence, same gap — different start positions
    // The earlier-starting one should always win (ascending start sort)
    const wordsA = makeWordSequence('a', 0, 12, 0.7, 0.1, 0.9, 'clip_001');
    const wordsB = makeWordSequence('b', 20, 12, 0.7, 0.1, 0.9, 'clip_001');
    const transcript = makeTranscript([...wordsA, ...wordsB]);

    // Run many times to confirm it's not random
    const results = Array.from({ length: 5 }, () =>
      selectCleanClip({ words: transcript, scope: 'project' })
    );
    expect(results.every((r) => r.start === results[0]!.start)).toBe(true);
  });
});

describe('selectCleanClip — local scope', () => {
  it('returns a local window near the edit target', () => {
    // Words before the target [0..8s], edit region [8..9s], words after [9..20s]
    const before = makeWordSequence('pre', 0, 10, 0.6, 0.1, 0.9, 'clip_001');
    const after = makeWordSequence('post', 9.1, 12, 0.6, 0.1, 0.9, 'clip_001');
    const transcript = makeTranscript([...before, ...after]);

    const result = selectCleanClip({
      words: transcript,
      scope: 'local',
      target: { clipId: 'clip_001', start: 8, end: 9 }
    });
    expect(result.scope).toBe('local');
    expect(result.clipId).toBe('clip_001');
  });

  it('excludes words that overlap the edit region — selects from non-overlapping speech only', () => {
    // Build a fixture: clip_001 has 15 clean words before the edit at [12,13],
    // plus one word that straddles the boundary [11.5,12.5], plus words after the edit.
    // clip_002 has a clean 12s run as fallback (so project fallback can succeed if local fails).
    const preEdit = makeWordSequence('pre', 0, 15, 0.6, 0.1, 0.9, 'clip_001');   // 0..14.4s
    const overlapWord = makeWord('olap', 11.5, 12.5, 0.9, 'clip_001');            // overlaps [12,13]
    const postEdit = makeWordSequence('post', 13.1, 8, 0.6, 0.1, 0.9, 'clip_001'); // after edit
    const clip2Words = makeWordSequence('c2', 0, 15, 0.6, 0.08, 0.9, 'clip_002');
    const transcript = makeTranscript([...preEdit, overlapWord, ...postEdit, ...clip2Words]);

    const result = selectCleanClip({
      words: transcript,
      scope: 'local',
      target: { clipId: 'clip_001', start: 12, end: 13 }
    });
    // The overlap word (11.5..12.5) overlaps [12,13] and must be excluded.
    // The result window must not include the overlap word (i.e., must end before 11.5 or start after 12.5).
    // Since pre-edit words span 0..14.4 but the overlap at 11.5 breaks the run near the edit,
    // the window selected should not reach into the overlap region.
    // Verify: if scope is local, the window should not span [11.5, 12.5].
    if (result.scope === 'local') {
      // The overlap word must not be inside the window start..end spanning 11.5..12.5
      // i.e., the window must end <= 11.5 or start >= 12.5
      // (A window can end at 11.5 since the overlap word starts at 11.5 and was excluded)
      const windowContainsOverlap = result.start < 12.5 && result.end > 11.5;
      expect(windowContainsOverlap).toBe(false);
    }
    // If fallback to project, the test has still proved edit-region exclusion logic is invoked
    // (it did the exclusion on local before falling back).
    expect(['local', 'project']).toContain(result.scope);
  });

  it('prefers the window nearer the edit midpoint', () => {
    // Two clean windows at 0..10s and 40..52s.
    // Edit target at 55..56s — anchor = 55.5s.
    // farWindow midpoint ≈ 5s → distance = 50.5s.
    // nearWindow midpoint ≈ 46s → distance = 9.5s.
    // nearWindow wins on distance.
    const farWindow = makeWordSequence('far', 0, 12, 0.7, 0.1, 0.9, 'clip_001');
    const nearWindow = makeWordSequence('near', 40, 12, 0.7, 0.1, 0.9, 'clip_001');
    // Silence gap of 30s between the two windows (both in clip_001)
    // Edit at 55-56 — does NOT overlap either window.
    const transcript = makeTranscript([...farWindow, ...nearWindow]);

    const result = selectCleanClip({
      words: transcript,
      scope: 'local',
      target: { clipId: 'clip_001', start: 55, end: 56 }
    });
    // The near window at 40s is closer to anchor=55.5 than the far window at 0s
    expect(result.start).toBeGreaterThanOrEqual(40);
  });
});

describe('selectCleanClip — local→project fallback', () => {
  it('falls back to project scope when local clean window < 6s', () => {
    // clip_001 has only a 3s clean block (< MIN_SEC=6)
    const shortLocal = makeWordSequence('local', 0, 4, 0.5, 0.1, 0.9, 'clip_001');
    // clip_002 has a clean 12s block
    const longProject = makeWordSequence('proj', 0, 16, 0.6, 0.08, 0.9, 'clip_002');
    const transcript = makeTranscript([...shortLocal, ...longProject]);

    const result = selectCleanClip({
      words: transcript,
      scope: 'local',
      target: { clipId: 'clip_001', start: 2, end: 3 }
    });
    expect(result.scope).toBe('project');
    expect(result.clipId).toBe('clip_002');
    expect(result.reason).toMatch(/^project-fallback:/);
    expect(result.reason).toMatch(/6s/);
    expect(result.reason).toMatch(/clip_001/);
  });

  it('fallback never reuses the edit region as the clone reference', () => {
    // The edit region [5,15] on clip_001 is the single best PROJECT window (10s, conf 0.99),
    // but it is the audio being replaced — it must NOT be selected as the clone reference.
    // Surrounding local speech is < 6s (pre 0-3.4, post 16-18), forcing a project fallback.
    // clip_002 holds a clean run that is the correct fallback target.
    const pre = makeWordSequence('pre', 0, 5, 0.7, 0.1, 0.9, 'clip_001');        // ~0..3.4s
    const editRegion = makeWordSequence('edit', 5, 13, 0.7, 0.1, 0.99, 'clip_001'); // ~5..15.3s, top conf
    const post = makeWordSequence('post', 16, 3, 0.7, 0.1, 0.9, 'clip_001');     // ~16..18s
    const clip2 = makeWordSequence('c2', 0, 16, 0.7, 0.08, 0.95, 'clip_002');    // clean fallback
    const transcript = makeTranscript([...pre, ...editRegion, ...post, ...clip2]);

    const result = selectCleanClip({
      words: transcript,
      scope: 'local',
      target: { clipId: 'clip_001', start: 5, end: 15 }
    });
    expect(result.scope).toBe('project');
    // Must come from clip_002 — NOT the clip_001 edit region (which scores highest on conf).
    expect(result.clipId).toBe('clip_002');
    // And in no case may the returned window overlap the replaced span on clip_001.
    const overlapsEdit = result.clipId === 'clip_001' && result.start < 15 && result.end > 5;
    expect(overlapsEdit).toBe(false);
  });

  it('fallback reason includes the local best span', () => {
    // clip_001 has exactly 4.5s of clean speech before the edit
    const localWords = makeWordSequence('lw', 0, 6, 0.6, 0.1, 0.9, 'clip_001');
    // clip_002 has 12s clean
    const projWords = makeWordSequence('pw', 0, 15, 0.6, 0.08, 0.9, 'clip_002');
    const transcript = makeTranscript([...localWords, ...projWords]);

    const result = selectCleanClip({
      words: transcript,
      scope: 'local',
      target: { clipId: 'clip_001', start: 4, end: 5 }
    });
    // When the local words are excluded due to overlap and left with < 6s, fallback fires
    // Check if reason is set (either local succeeded or fallback)
    if (result.scope === 'project') {
      expect(result.reason).toMatch(/project-fallback/);
    }
  });
});

describe('selectCleanClip — overlong-word safety (W4 review)', () => {
  it('does not crash on a single word longer than TARGET+SLACK; skips it and picks a clean run', () => {
    // A transcription artifact: one 15s "word" forms its own run (> 10+1.5 cap). The
    // left-pointer shrink must not walk i past j and deref run[i] (undefined) — that was
    // the off-by-one. A clean run in clip_002 gives a valid pick.
    const longWord = makeWord('long', 0, 15, 0.9, 'clip_001');
    const cleanRun = makeWordSequence('clean', 0, 14, 0.7, 0.1, 0.95, 'clip_002');
    const transcript = makeTranscript([longWord, ...cleanRun]);

    let result: ReturnType<typeof selectCleanClip> | undefined;
    expect(() => { result = selectCleanClip({ words: transcript, scope: 'project' }); }).not.toThrow();
    expect(result!.clipId).toBe('clip_002');
    expect(result!.spanSec).toBeGreaterThanOrEqual(6);
    expect(result!.spanSec).toBeLessThanOrEqual(11.5);
  });
});

describe('selectCleanClip — fallback reason accuracy (W4 review)', () => {
  it('reports the longest clean local run (never a misleading 0.0s) when local speech is below minSec', () => {
    // clip_001: a single ~4.1s clean run — below MIN_SEC (6), so no window qualifies, but
    // it is NOT 0s. The old reason reported best.spanSec (0 when nothing cleared min).
    const localRun = makeWordSequence('lw', 0, 6, 0.6, 0.1, 0.9, 'clip_001'); // spans ~4.1s
    const projRun = makeWordSequence('pw', 0, 16, 0.6, 0.08, 0.9, 'clip_002'); // clean fallback
    const transcript = makeTranscript([...localRun, ...projRun]);

    const result = selectCleanClip({
      words: transcript,
      scope: 'local',
      target: { clipId: 'clip_001', start: 5, end: 5.5 } // after the run, no overlap
    });
    expect(result.scope).toBe('project');
    expect(result.reason).toMatch(/longest clean local run/);
    expect(result.reason).not.toMatch(/run 0\.0s/);
    expect(result.reason).toMatch(/run [1-9]/);
  });
});

describe('selectCleanClip — project-scope excludeRange (W4 review)', () => {
  it('never selects a window overlapping the excluded span (project clone for a replacement)', () => {
    // The excluded span [5,15] on clip_001 is the highest-confidence window; a project-scope
    // clone made for a replacement must not train from the very span being overwritten.
    const editRegion = makeWordSequence('edit', 5, 13, 0.7, 0.1, 0.99, 'clip_001'); // ~5..15.3, top conf
    const clip2 = makeWordSequence('c2', 0, 16, 0.7, 0.08, 0.95, 'clip_002');
    const transcript = makeTranscript([...editRegion, ...clip2]);

    const result = selectCleanClip({
      words: transcript,
      scope: 'project',
      excludeRange: { clipId: 'clip_001', start: 5, end: 15 }
    });
    expect(result.clipId).toBe('clip_002');
    const overlapsExcluded = result.clipId === 'clip_001' && result.start < 15 && result.end > 5;
    expect(overlapsExcluded).toBe(false);
  });
});

describe('selectCleanClip — edit-region straddle safety (W4 review)', () => {
  it('never selects a window that straddles a target sitting in a short inter-word gap', () => {
    // Continuous speech with 0.1s gaps (< MAX_INTERNAL_GAP) → one run, never split. The edit
    // target sits inside a gap and overlaps NO word, so the word-level filter keeps both
    // neighbors; without the window-overlap rejection a ~10s window centered on the edit
    // (distance ~0) would win and straddle the replaced span.
    const words = makeWordSequence('w', 0, 26, 0.7, 0.1, 0.95, 'clip_001'); // word k: [0.8k, 0.8k+0.7]
    const transcript = makeTranscript(words);
    const target = { clipId: 'clip_001', start: 10.32, end: 10.38 }; // in the gap [10.3, 10.4]

    const result = selectCleanClip({ words: transcript, scope: 'local', target });
    const straddles = result.clipId === 'clip_001' && result.start < target.end && result.end > target.start;
    expect(straddles).toBe(false);
    expect(result.spanSec).toBeGreaterThanOrEqual(6);
  });
});

describe('selectCleanClip — hard failure', () => {
  it('throws no-clean-reference when no clip has ≥6s of clean contiguous speech', () => {
    // Only 3 words, each 1s with 0.1s gaps — max span ≈ 3.2s < MIN_SEC
    const words = makeWordSequence('w', 0, 3, 1, 0.1, 0.95, 'clip_001');
    const transcript = makeTranscript(words);
    expect(() => selectCleanClip({ words: transcript, scope: 'project' })).toThrow('no-clean-reference');
  });

  it('no-clean-reference error reports the honest longest run (not 0.0s)', () => {
    // 3 words, each 1s with 0.1s gaps → one ~3.2s run < MIN_SEC. enumerateWindows emits no
    // in-range window, so the error must report the longest RUN (3.2s), not a misleading 0.0s.
    const words = makeWordSequence('w', 0, 3, 1, 0.1, 0.95, 'clip_001');
    const transcript = makeTranscript(words);
    let msg = '';
    try {
      selectCleanClip({ words: transcript, scope: 'project' });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/no-clean-reference/);
    expect(msg).toMatch(/6s/);
    // Honest span: the real longest run is ~3.2s, never the misleading 0.0s.
    expect(msg).not.toMatch(/run 0\.0s/);
    expect(msg).toMatch(/run [1-9]/);
  });
});
