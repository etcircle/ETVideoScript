import { describe, expect, it } from 'vitest';
import { materializeComposition, validateComposition, COMPOSE_PAD } from '../takes/composition';
import type { AlignmentArtifact, CompositionFile } from '../takes/schema';
import { makeManifest, makeTrack, makeClip, makeVideoAsset, makeWords } from './takes-fixtures';

function metrics(over: Partial<AlignmentArtifact['candidates'][number]['metrics']> = {}) {
  return { fillerCount: 0, falseStartCount: 0, wordsPerSec: 3, silenceRatio: 0.1, durationSec: 4, headBoundaryScore: 0.9, tailBoundaryScore: 0.9, ...over };
}
function candidate(spanId: string, clipId: string, over: Partial<AlignmentArtifact['candidates'][number]> = {}) {
  const { metrics: metricsOverride, ...rest } = over;
  return { spanId, clipId, takeWordStart: 0, takeWordEnd: 3, tStart: 1, tEnd: 5, coverage: 1, matchQuality: 1, truncated: false, ...rest, metrics: metrics(metricsOverride) };
}

const alignment: AlignmentArtifact = {
  schemaVersion: 1, groupId: 'main', generatedAt: '2026-01-01T00:00:00.000Z', reference: { kind: 'take', clipId: 'clip_take_01' },
  takes: [
    { clipId: 'clip_take_01', assetId: 'a1', label: 'take 01', wordCount: 12, matchedFraction: 1, lowConfidence: false },
    { clipId: 'clip_take_02', assetId: 'a2', label: 'take 02', wordCount: 12, matchedFraction: 1, lowConfidence: false }
  ],
  spans: [{ spanId: 's001', ordinal: 1, text: 'span one' }, { spanId: 's002', ordinal: 2, text: 'span two' }],
  candidates: [
    candidate('s001', 'clip_take_01', { tStart: 1, tEnd: 5 }),
    candidate('s001', 'clip_take_02', { tStart: 0.5, tEnd: 4 }),
    candidate('s002', 'clip_take_01', { tStart: 6, tEnd: 9 }),
    candidate('s002', 'clip_take_02', { tStart: 5, tEnd: 8 })
  ],
  orphans: [{ orphanId: 'o001', clipId: 'clip_take_02', takeWordStart: 20, takeWordEnd: 30, tStart: 12, tEnd: 16, text: 'aside material here' }]
};

function manifestWithTakes() {
  const staging = makeTrack({ trackId: 'track_takes', kind: 'video', role: 'staging', clips: [makeClip('clip_take_01', 'a1', 30), makeClip('clip_take_02', 'a2', 31)] });
  const timeline = makeTrack({ trackId: 'track_video', kind: 'video', order: 0, clips: [] });
  return makeManifest({ assets: [makeVideoAsset('a1', 30), makeVideoAsset('a2', 31)], tracks: [timeline, staging], takeGroups: [{ groupId: 'main', label: 'main', clipIds: ['clip_take_01', 'clip_take_02'] }] });
}

const valid: CompositionFile = {
  schemaVersion: 1, groupId: 'main',
  selections: [
    { order: 1, clipId: 'clip_take_01', spanIds: ['s001'], rationale: 'best open' },
    { order: 2, clipId: 'clip_take_02', spanIds: ['s002'], rationale: 'cleaner close' }
  ],
  gaps: []
};

describe('validateComposition', () => {
  it('accepts a valid composition and plans clips in order', () => {
    const result = validateComposition(manifestWithTakes(), alignment, valid);
    expect(result.errors).toEqual([]);
    expect(result.plan.map((p) => p.clipId)).toEqual(['clip_comp_001', 'clip_comp_002']);
    expect(result.plan[0].timelineStart).toBe(0);
    expect(result.plan[1].timelineStart).toBeCloseTo(result.plan[0].durationSec, 5);
  });

  it('V1 rejects unknown group', () => {
    const result = validateComposition(manifestWithTakes(), alignment, { ...valid, groupId: 'nope' });
    expect(result.errors.some((e) => e.rule === 'V1')).toBe(true);
  });
  it('V2 rejects unknown spanId', () => {
    const bad = { ...valid, selections: [{ order: 1, clipId: 'clip_take_01', spanIds: ['s999'], rationale: 'x' }] };
    expect(validateComposition(manifestWithTakes(), alignment, bad).errors.some((e) => e.rule === 'V2')).toBe(true);
  });
  it('V3 rejects non-contiguous spans and missing candidate', () => {
    const bad = { ...valid, selections: [{ order: 1, clipId: 'clip_take_01', spanIds: ['s001', 's999'], rationale: 'x' }] };
    expect(validateComposition(manifestWithTakes(), alignment, bad).errors.some((e) => e.rule === 'V2' || e.rule === 'V3')).toBe(true);
  });
  it('V4 rejects non-dense order', () => {
    const bad = { ...valid, selections: [{ order: 1, clipId: 'clip_take_01', spanIds: ['s001'], rationale: 'x' }, { order: 3, clipId: 'clip_take_02', spanIds: ['s002'], rationale: 'y' }] };
    expect(validateComposition(manifestWithTakes(), alignment, bad).errors.some((e) => e.rule === 'V4')).toBe(true);
  });
  it('V5 rejects a span used twice', () => {
    const bad = { ...valid, selections: [{ order: 1, clipId: 'clip_take_01', spanIds: ['s001'], rationale: 'x' }, { order: 2, clipId: 'clip_take_02', spanIds: ['s001'], rationale: 'y' }] };
    expect(validateComposition(manifestWithTakes(), alignment, bad).errors.some((e) => e.rule === 'V5')).toBe(true);
  });
  it('V6 rejects trim that removes all words', () => {
    const bad = { ...valid, selections: [{ order: 1, clipId: 'clip_take_01', spanIds: ['s001'], trim: { headWords: 5, tailWords: 5 }, rationale: 'x' }, valid.selections[1]] };
    expect(validateComposition(manifestWithTakes(), alignment, bad).errors.some((e) => e.rule === 'V6')).toBe(true);
  });

  it('W1 warns on a risky seam', () => {
    const risky: AlignmentArtifact = { ...alignment, candidates: alignment.candidates.map((c) => c.spanId === 's001' && c.clipId === 'clip_take_01' ? { ...c, metrics: { ...c.metrics, tailBoundaryScore: 0.2 } } : c) };
    expect(validateComposition(manifestWithTakes(), risky, valid).warnings.some((w) => w.rule === 'W1')).toBe(true);
  });
  it('W2 warns on a dropped span not declared in gaps', () => {
    const only = { ...valid, selections: [valid.selections[0]] };
    expect(validateComposition(manifestWithTakes(), alignment, only).warnings.some((w) => w.rule === 'W2')).toBe(true);
  });
  it('W4 warns on out-of-order spans', () => {
    const reordered = { ...valid, selections: [{ order: 1, clipId: 'clip_take_02', spanIds: ['s002'], rationale: 'x' }, { order: 2, clipId: 'clip_take_01', spanIds: ['s001'], rationale: 'y' }] };
    expect(validateComposition(manifestWithTakes(), alignment, reordered).warnings.some((w) => w.rule === 'W4')).toBe(true);
  });
  it('W3 warns on a low-coverage or truncated candidate', () => {
    const lowCoverage: AlignmentArtifact = { ...alignment, candidates: alignment.candidates.map((c) => c.spanId === 's001' && c.clipId === 'clip_take_01' ? { ...c, coverage: 0.5 } : c) };
    expect(validateComposition(manifestWithTakes(), lowCoverage, valid).warnings.some((w) => w.rule === 'W3')).toBe(true);
  });
});

describe('validateComposition — neighbour-word pad clamp', () => {
  const smallAlignment: AlignmentArtifact = {
    schemaVersion: 1, groupId: 'main', generatedAt: '2026-01-01T00:00:00.000Z', reference: { kind: 'take', clipId: 'clip_take_01' },
    takes: [{ clipId: 'clip_take_01', assetId: 'a1', label: 'take 01', wordCount: 5, matchedFraction: 1, lowConfidence: false }],
    spans: [{ spanId: 's001', ordinal: 1, text: 'span one' }],
    candidates: [candidate('s001', 'clip_take_01', { takeWordStart: 2, takeWordEnd: 3, tStart: 1, tEnd: 2 })],
    orphans: []
  };
  const comp: CompositionFile = { schemaVersion: 1, groupId: 'main', selections: [{ order: 1, clipId: 'clip_take_01', spanIds: ['s001'], rationale: 'x' }], gaps: [] };

  function manifestOneTake() {
    const staging = makeTrack({ trackId: 'track_takes', kind: 'video', role: 'staging', clips: [makeClip('clip_take_01', 'a1', 30)] });
    const timeline = makeTrack({ trackId: 'track_video', kind: 'video', order: 0, clips: [] });
    return makeManifest({ assets: [makeVideoAsset('a1', 30)], tracks: [timeline, staging], takeGroups: [{ groupId: 'main', label: 'main', clipIds: ['clip_take_01'] }] });
  }

  it('clamps sourceStart to the preceding word when it falls within the pad window', () => {
    const words = makeWords('a b c d e', { clipId: 'clip_take_01', wordSec: 0.3, gapSec: 0.05 });
    const takeTranscripts = new Map([['clip_take_01', words]]);
    const result = validateComposition(manifestOneTake(), smallAlignment, comp, takeTranscripts);
    expect(result.errors).toEqual([]);
    // words[1].end (0.65) is only 0.05s before words[2].start (0.70) — closer than the 0.12s pad, so the pad must clamp to it.
    expect(result.plan[0].sourceStart).toBeCloseTo(words[1].end, 5);
  });

  it('applies the full pad when the preceding word is far away', () => {
    const words = makeWords('a b c d e', { clipId: 'clip_take_01', wordSec: 0.3, gapsAfter: { 1: 1 } });
    const takeTranscripts = new Map([['clip_take_01', words]]);
    const result = validateComposition(manifestOneTake(), smallAlignment, comp, takeTranscripts);
    expect(result.errors).toEqual([]);
    expect(result.plan[0].sourceStart).toBeCloseTo(words[2].start - COMPOSE_PAD.headSec, 5);
  });
});

describe('materializeComposition', () => {
  it('writes clips to the timeline track and leaves staging + groups intact', () => {
    const m = manifestWithTakes();
    const plan = validateComposition(m, alignment, valid).plan;
    const next = materializeComposition(m, plan);
    const timeline = next.tracks.find((t) => t.trackId === 'track_video')!;
    expect(timeline.clips.map((c) => c.clipId)).toEqual(['clip_comp_001', 'clip_comp_002']);
    expect(next.tracks.find((t) => t.role === 'staging')!.clips.length).toBe(2);
    expect(next.takeGroups.length).toBe(1);
    // pad clamps sourceStart >= 0
    expect(timeline.clips[1].sourceStart).toBeGreaterThanOrEqual(0);
  });

  it('is a no-op-safe pure function (does not mutate input manifest)', () => {
    const m = manifestWithTakes();
    const before = JSON.stringify(m);
    materializeComposition(m, validateComposition(m, alignment, valid).plan);
    expect(JSON.stringify(m)).toBe(before);
  });

  it('disables an op targeting a prior composed clip when reapplying, even when the id is reused for different footage', () => {
    const m = manifestWithTakes();
    const firstPlan = validateComposition(m, alignment, valid).plan;
    const composed = materializeComposition(m, firstPlan);
    const withOp = {
      ...composed,
      operations: [{
        id: 'op1',
        type: 'mute' as const,
        status: 'approved' as const,
        target: { kind: 'clip-span' as const, trackId: 'track_video', clipId: 'clip_comp_001', start: 0, end: 1 },
        proposedBy: 'agent' as const,
        createdBy: 'agent' as const,
        createdAt: '2026-01-01T00:00:00.000Z'
      }]
    };
    // Reapply with the same selection count so clip_comp_001/002 ids are reused, but for
    // swapped footage (clip_take_02 now occupies the clip_comp_001 slot).
    const swapped: CompositionFile = {
      ...valid,
      selections: [
        { order: 1, clipId: 'clip_take_02', spanIds: ['s001'], rationale: 'x' },
        { order: 2, clipId: 'clip_take_01', spanIds: ['s002'], rationale: 'y' }
      ]
    };
    const secondPlan = validateComposition(withOp, alignment, swapped).plan;
    const reapplied = materializeComposition(withOp, secondPlan);
    expect(reapplied.operations[0].status).toBe('disabled');
  });
});
