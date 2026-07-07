import { describe, expect, it } from 'vitest';
import { computeAlignment } from '../takes/alignment';
import { AlignmentArtifactSchema, TAKES_CONSTANTS } from '../takes/schema';
import { makeManifest, makeTrack, makeClip, makeVideoAsset, makeWords } from './takes-fixtures';

const GEN_AT = '2026-01-01T00:00:00.000Z';

function scenario(clips: Array<{ clipId: string; assetId: string; text: string; dur: number }>, reference?: { kind: 'take'; clipId: string }) {
  const staging = makeTrack({ trackId: 'track_takes', kind: 'video', role: 'staging', clips: clips.map((c) => makeClip(c.clipId, c.assetId, c.dur)) });
  const manifest = makeManifest({
    assets: clips.map((c) => makeVideoAsset(c.assetId, c.dur)),
    tracks: [staging],
    takeGroups: [{ groupId: 'main', label: 'main', clipIds: clips.map((c) => c.clipId), reference }]
  });
  const transcripts = new Map(clips.map((c) => [c.clipId, makeWords(c.text, { clipId: c.clipId })]));
  return computeAlignment({ manifest, groupId: 'main', transcripts, generatedAt: GEN_AT });
}

const SENTENCE = 'Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu.';

describe('computeAlignment', () => {
  it('produces a schema-valid artifact', () => {
    const artifact = scenario([
      { clipId: 'clip_take_01', assetId: 'a1', text: SENTENCE, dur: 30 },
      { clipId: 'clip_take_02', assetId: 'a2', text: SENTENCE, dur: 31 }
    ]);
    expect(AlignmentArtifactSchema.parse(artifact)).toBeTruthy();
    expect(artifact.spans.length).toBe(3);
  });

  it('identical takes -> coverage 1 for every span on every take', () => {
    const artifact = scenario([
      { clipId: 'clip_take_01', assetId: 'a1', text: SENTENCE, dur: 30 },
      { clipId: 'clip_take_02', assetId: 'a2', text: SENTENCE, dur: 31 }
    ]);
    expect(artifact.candidates.length).toBe(6); // 3 spans x 2 takes
    expect(artifact.candidates.every((c) => c.coverage === 1)).toBe(true);
  });

  it('pickup take contributes candidates only for its span', () => {
    const artifact = scenario([
      { clipId: 'clip_take_01', assetId: 'a1', text: SENTENCE, dur: 30 },
      { clipId: 'clip_take_02', assetId: 'a2', text: 'Epsilon zeta eta theta.', dur: 6 }
    ]);
    const take2 = artifact.candidates.filter((c) => c.clipId === 'clip_take_02');
    expect(take2.map((c) => c.spanId)).toEqual(['s002']);
  });

  it('flags low-confidence takes at the 0.3 threshold boundary', () => {
    const artifact = scenario([
      { clipId: 'clip_take_01', assetId: 'a1', text: SENTENCE, dur: 30 },
      { clipId: 'clip_take_02', assetId: 'a2', text: 'totally unrelated words that share nothing at all here folks', dur: 12 }
    ]);
    const take2 = artifact.takes.find((t) => t.clipId === 'clip_take_02')!;
    expect(take2.matchedFraction).toBeLessThan(TAKES_CONSTANTS.LOW_CONFIDENCE_MATCH_FRACTION);
    expect(take2.lowConfidence).toBe(true);
  });

  it('auto-selects the longest transcript as reference, tie-break lowest clipId', () => {
    const artifact = scenario([
      { clipId: 'clip_take_02', assetId: 'a2', text: SENTENCE, dur: 31 },
      { clipId: 'clip_take_01', assetId: 'a1', text: SENTENCE, dur: 30 }
    ]);
    expect(artifact.reference).toEqual({ kind: 'take', clipId: 'clip_take_01' });
  });

  it('is byte-identical across runs', () => {
    const clips = [
      { clipId: 'clip_take_01', assetId: 'a1', text: SENTENCE, dur: 30 },
      { clipId: 'clip_take_02', assetId: 'a2', text: SENTENCE, dur: 31 }
    ];
    expect(JSON.stringify(scenario(clips))).toEqual(JSON.stringify(scenario(clips)));
  });

  it('detects orphan material as a distinct entry', () => {
    const artifact = scenario([
      { clipId: 'clip_take_01', assetId: 'a1', text: SENTENCE, dur: 30 },
      { clipId: 'clip_take_02', assetId: 'a2', text: 'Alpha beta gamma delta. brand new tangent nobody asked for at all here really. Epsilon zeta eta theta. Iota kappa lambda mu.', dur: 40 }
    ], { kind: 'take', clipId: 'clip_take_01' });
    expect(artifact.orphans.length).toBeGreaterThanOrEqual(1);
    expect(artifact.orphans[0].orphanId).toBe('o001');
  });
});
