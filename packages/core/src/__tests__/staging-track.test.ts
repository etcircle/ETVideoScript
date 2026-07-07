import { describe, expect, it } from 'vitest';
import { TrackSchema } from '../tracks/schema';
import { buildBaseTimeline } from '../timeMap/compose';
import { primaryVideoClips, transcribableClips } from '../transcript';
import { validateManifestV3Document } from '../manifest/validate';
import { buildRenderPlan } from '../render/plan';
import { makeClip, makeManifest, makeTrack, makeVideoAsset } from './takes-fixtures';

const timeline = makeTrack({ trackId: 'track_video', kind: 'video', clips: [makeClip('clip_001', 'a1', 10)] });
const staging = makeTrack({ trackId: 'track_takes', kind: 'video', role: 'staging', hidden: true, order: 1000, clips: [makeClip('clip_take_01', 'a2', 20)] });

describe('Track.role', () => {
  it('defaults to timeline for existing manifests (back-compat)', () => {
    const parsed = TrackSchema.parse({ trackId: 't1', kind: 'video', name: 'V', order: 0, clips: [] });
    expect(parsed.role).toBe('timeline');
  });

  it('buildBaseTimeline excludes staging tracks', () => {
    const map = buildBaseTimeline([timeline, staging]);
    expect(map.segments.map((s) => s.clipId)).toEqual(['clip_001']);
  });

  it('transcribableClips includes staging clips after timeline clips', () => {
    const manifest = makeManifest({ assets: [makeVideoAsset('a1', 10), makeVideoAsset('a2', 20)], tracks: [timeline, staging] });
    expect(transcribableClips(manifest).map((c) => c.clipId)).toEqual(['clip_001', 'clip_take_01']);
  });

  it('transcribableClips still lists takes when timeline is empty (pre-compose)', () => {
    const emptyTimeline = makeTrack({ trackId: 'track_video', kind: 'video' });
    const manifest = makeManifest({ assets: [makeVideoAsset('a2', 20)], tracks: [emptyTimeline, staging] });
    expect(transcribableClips(manifest).map((c) => c.clipId)).toEqual(['clip_take_01']);
  });

  it('primaryVideoClips never returns staging clips', () => {
    const emptyTimeline = makeTrack({ trackId: 'track_video', kind: 'video' });
    const manifest = makeManifest({ assets: [makeVideoAsset('a2', 20)], tracks: [emptyTimeline, staging] });
    expect(primaryVideoClips(manifest)).toEqual([]);
  });

  it('rejects two staging tracks', () => {
    const staging2 = makeTrack({ trackId: 'track_takes2', kind: 'video', role: 'staging' });
    const result = validateManifestV3Document(makeManifest({ assets: [makeVideoAsset('a2', 20)], tracks: [staging, staging2] }));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/at most one staging track/i);
  });

  it('rejects a non-video staging track', () => {
    const badStaging = makeTrack({ trackId: 'track_takes', kind: 'audio', role: 'staging' });
    const result = validateManifestV3Document(makeManifest({ tracks: [badStaging] }));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/staging track must be a video track/i);
  });

  it('staging takes do not suppress a single-source channel fix in the render plan', () => {
    const sourceAsset = { assetId: 'asset_video_001', kind: 'video' as const, path: 'input/source.mp4', durationSec: 10, provenance: 'imported' as const, video: { width: 1920, height: 1080, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } };
    const sourceTrack = makeTrack({ trackId: 'track_video', kind: 'video', clips: [makeClip('clip_001', 'asset_video_001', 10)] });
    const withTakes = makeManifest({
      assets: [sourceAsset, makeVideoAsset('a2', 20)],
      tracks: [sourceTrack, staging],
      audioChannelFix: { status: 'approved', sourceChannel: 'left', detection: { leftRmsDb: -20, rightRmsDb: -60, auto: true }, appliedAt: '2026-01-01T00:00:00.000Z' }
    });
    const plan = buildRenderPlan(withTakes);
    expect(plan.audioSourceChannel).toBe('left'); // still active despite the staged take
  });
});
