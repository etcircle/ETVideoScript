import { describe, expect, it } from 'vitest';
import { computeAlignment, validateComposition, materializeComposition, buildRenderPlanV3, deriveChapters } from '@etvideoscript/core';
import type { ManifestV3, TranscriptWord } from '@etvideoscript/core';
import type { CompositionFile } from '../../../packages/core/src/takes/schema';

// Self-contained fixture helpers, mirroring packages/core/src/__tests__/takes-fixtures.ts so this
// e2e test does not couple to @etvideoscript/core's internal test-only exports.
function makeWords(text: string, opts: { clipId: string; wordSec?: number; gapSec?: number }): TranscriptWord[] {
  const { clipId, wordSec = 0.3, gapSec = 0.05 } = opts;
  let t = 0;
  return text.split(/\s+/).filter(Boolean).map((token, i) => {
    const start = t;
    const end = start + wordSec;
    t = end + gapSec;
    return { id: `${clipId}_w${i}`, text: token, normalized: '', start, end, speaker: 'speaker_1', confidence: 1, segmentId: `${clipId}_s1`, clipId };
  });
}

function makeVideoAsset(assetId: string, durationSec: number) {
  return { assetId, kind: 'video' as const, path: `input/takes/${assetId}.mp4`, durationSec, provenance: 'imported' as const, video: { width: 1920, height: 1080, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } };
}

function makeManifest(clips: Array<{ clipId: string; assetId: string; durationSec: number }>): ManifestV3 {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    manifestVersion: 3, projectId: 'proj_takes_e2e', createdAt: now, updatedAt: now,
    assets: clips.map((c) => makeVideoAsset(c.assetId, c.durationSec)),
    tracks: [
      { trackId: 'track_video', kind: 'video', name: 'track_video', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [] },
      {
        trackId: 'track_takes', kind: 'video', name: 'track_takes', order: 1, locked: false, muted: false, solo: false, hidden: false, role: 'staging',
        clips: clips.map((c) => ({ clipId: c.clipId, assetId: c.assetId, sourceStart: 0, sourceEnd: c.durationSec, timelineStart: 0 }))
      }
    ],
    operations: [], outputs: [],
    renderPresets: { draft: { resolution: '1280x720', videoBitrate: '2M', audioBitrate: '128k' }, youtube: { resolution: '1920x1080', videoBitrate: '8M', audioBitrate: '192k' } },
    takeGroups: [{ groupId: 'main', label: 'main', clipIds: clips.map((c) => c.clipId), reference: { kind: 'take', clipId: 'clip_take_01' } }]
  } as ManifestV3;
}

describe('compose-from-takes pipeline (e2e, core-driven)', () => {
  it('aligns 3 takes, composes a pickup + orphan scenario, and materializes a consistent timeline', () => {
    // take 1: the full clean script.
    // take 2: full script again, but the middle sentence is flubbed (fillers "uh"/"um" injected).
    // take 3: a pickup of just the flubbed middle sentence, preceded by an unrelated orphan aside.
    const take1Text = 'Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu.';
    const take2Text = 'Alpha beta gamma delta. Epsilon zeta uh eta um theta. Iota kappa lambda mu.';
    // A long unrelated aside precedes the pickup so the aligner's edit-distance backtrack cannot
    // absorb it into a bogus substitution match against the much-shorter neighbouring span - it
    // must classify the whole run as take-only ("orphan") material, as findOrphans requires >= 8
    // contiguous unmatched words (TAKES_CONSTANTS.MIN_ORPHAN_WORDS).
    const take3Text = 'totally random aside nobody expected this thing to happen during the recording today for absolutely no good reason at all honestly. Epsilon zeta eta theta.';

    const manifest = makeManifest([
      { clipId: 'clip_take_01', assetId: 'a1', durationSec: 6 },
      { clipId: 'clip_take_02', assetId: 'a2', durationSec: 6 },
      { clipId: 'clip_take_03', assetId: 'a3', durationSec: 12 }
    ]);

    const takeTranscripts = new Map<string, TranscriptWord[]>([
      ['clip_take_01', makeWords(take1Text, { clipId: 'clip_take_01' })],
      ['clip_take_02', makeWords(take2Text, { clipId: 'clip_take_02' })],
      ['clip_take_03', makeWords(take3Text, { clipId: 'clip_take_03' })]
    ]);

    const alignment = computeAlignment({ manifest, groupId: 'main', transcripts: takeTranscripts, generatedAt: '2026-01-01T00:00:00.000Z' });

    expect(alignment.spans.length).toBe(3);
    expect(alignment.orphans.length).toBeGreaterThanOrEqual(1);
    expect(alignment.orphans.some((o) => o.clipId === 'clip_take_03')).toBe(true);

    // Scripted composition: s001 and s003 from the clean take 1; s002 (the flubbed middle) is
    // replaced by take 3's pickup instead of take 2's flub. The orphan aside on take 3 is simply
    // never selected, which is how the composition schema represents "drop" for take material
    // (gaps only track dropped SPANS, since only spans - not orphans - are required coverage).
    const composition: CompositionFile = {
      schemaVersion: 1,
      groupId: 'main',
      selections: [
        { order: 1, clipId: 'clip_take_01', spanIds: ['s001'], chapterTitle: 'Intro', rationale: 'Clean take 1 opening' },
        { order: 2, clipId: 'clip_take_03', spanIds: ['s002'], chapterTitle: 'Middle (pickup)', rationale: 'Take 3 pickup avoids the flub in take 2' },
        { order: 3, clipId: 'clip_take_01', spanIds: ['s003'], chapterTitle: 'Close', rationale: 'Clean take 1 closing' }
      ],
      gaps: []
    };

    const validation = validateComposition(manifest, alignment, composition, takeTranscripts);
    expect(validation.errors).toEqual([]);

    const materialized = materializeComposition(manifest, validation.plan);
    const timeline = materialized.tracks.find((t) => t.trackId === 'track_video')!;
    expect(timeline.clips).toHaveLength(3);

    const distinctAssetIds = new Set(timeline.clips.map((c) => c.assetId));
    expect(distinctAssetIds.size).toBeGreaterThanOrEqual(2);

    const plan = buildRenderPlanV3(materialized);
    const distinctInputPaths = new Set(plan.composition.videoBase.map((segment) => segment.asset.path));
    expect(distinctInputPaths.size).toBeGreaterThanOrEqual(2);

    // Regression guard for the chapter-time-consistency bug class: chapters MUST be derived from
    // the same transcript-threaded plan that was actually materialized into the timeline, or their
    // startSec values drift from where the clips actually land (see agent-tools compose_apply /
    // CLI compose apply, both of which thread takeTranscripts through validateComposition before
    // materializing or deriving chapters).
    const chapters = deriveChapters(composition, alignment, validation.plan);
    expect(chapters).toHaveLength(3);
    chapters.forEach((chapter, i) => {
      expect(chapter.startSec).toBeCloseTo(timeline.clips[i].timelineStart, 5);
    });
  });
});
