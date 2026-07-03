import { describe, expect, it } from 'vitest';
import { AudioChannelFixSchema, ManifestV3Schema, buildFfmpegCommandV3, buildRenderPlanV3 } from '../index';

const now = '2026-07-03T00:00:00.000Z';
const presets = { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: '1920x1080', videoBitrate: '6000k', audioBitrate: '192k' } };

// Minimal valid ManifestV3 fixture (mirrors studioCleanup.test.ts).
export function baseManifest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    manifestVersion: 3 as const,
    projectId: 'channel-fix-test',
    createdAt: now,
    updatedAt: now,
    assets: [
      { assetId: 'asset_video_001', kind: 'video' as const, path: 'input/source.mp4', durationSec: 10, provenance: 'imported' as const, video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } }
    ],
    tracks: [
      { trackId: 'track_video_001', kind: 'video' as const, name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 10, timelineStart: 0 }] }
    ],
    operations: [],
    outputs: [{ outputId: 'out_001', kind: 'full' as const, aspects: ['16:9' as const], status: 'manual' as const }],
    renderPresets: presets,
    ...overrides
  };
}

export const validFix = {
  status: 'approved' as const,
  sourceChannel: 'left' as const,
  detection: { leftRmsDb: -18.2, rightRmsDb: -92.4, auto: true },
  appliedAt: now
};

describe('AudioChannelFixSchema', () => {
  it('round-trips a valid approved record', () => {
    const parsed = AudioChannelFixSchema.parse(validFix);
    expect(parsed.status).toBe('approved');
    expect(parsed.sourceChannel).toBe('left');
    expect(parsed.detection.auto).toBe(true);
  });

  it('accepts disabled status and right channel', () => {
    const parsed = AudioChannelFixSchema.parse({ ...validFix, status: 'disabled', sourceChannel: 'right' });
    expect(parsed.status).toBe('disabled');
    expect(parsed.sourceChannel).toBe('right');
  });

  it('rejects unknown status, unknown channel, and missing detection', () => {
    expect(() => AudioChannelFixSchema.parse({ ...validFix, status: 'pending' })).toThrow();
    expect(() => AudioChannelFixSchema.parse({ ...validFix, sourceChannel: 'center' })).toThrow();
    const { detection: _detection, ...withoutDetection } = validFix;
    expect(() => AudioChannelFixSchema.parse(withoutDetection)).toThrow();
  });
});

describe('ManifestV3Schema audioChannelFix field', () => {
  it('parses without the field (back-compat)', () => {
    const parsed = ManifestV3Schema.parse(baseManifest());
    expect(parsed.audioChannelFix).toBeUndefined();
  });

  it('parses with the field and round-trips it', () => {
    const parsed = ManifestV3Schema.parse(baseManifest({ audioChannelFix: validFix }));
    expect(parsed.audioChannelFix?.sourceChannel).toBe('left');
  });
});

describe('buildRenderPlan audioSourceChannel', () => {
  it('is set when the fix is approved', () => {
    const manifest = ManifestV3Schema.parse(baseManifest({ audioChannelFix: validFix }));
    expect(buildRenderPlanV3(manifest).audioSourceChannel).toBe('left');
  });

  it('is absent when the fix is disabled or missing', () => {
    const disabled = ManifestV3Schema.parse(baseManifest({ audioChannelFix: { ...validFix, status: 'disabled' } }));
    expect(buildRenderPlanV3(disabled).audioSourceChannel).toBeUndefined();
    expect(buildRenderPlanV3(ManifestV3Schema.parse(baseManifest())).audioSourceChannel).toBeUndefined();
  });

  it('is absent when the base asset is known mono (stale fix must not fail the render)', () => {
    const fixture = baseManifest({ audioChannelFix: validFix });
    (fixture.assets as Array<{ audio?: { sampleRate?: number; channels?: number } }>)[0]!.audio = { sampleRate: 48000, channels: 1 };
    expect(buildRenderPlanV3(ManifestV3Schema.parse(fixture)).audioSourceChannel).toBeUndefined();
  });

  it('is absent for multi-video-source projects (fix describes only the base recording)', () => {
    const fixture = baseManifest({ audioChannelFix: validFix });
    (fixture.assets as unknown[]).push({ assetId: 'asset_video_002', kind: 'video', path: 'assets/video/b.mp4', durationSec: 5, provenance: 'imported', video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } });
    (fixture.tracks as Array<{ clips: unknown[] }>)[0]!.clips.push({ clipId: 'clip_002', assetId: 'asset_video_002', sourceStart: 0, sourceEnd: 5, timelineStart: 10 });
    expect(buildRenderPlanV3(ManifestV3Schema.parse(fixture)).audioSourceChannel).toBeUndefined();
  });

  // Tightened post-review (issue #7b): the guard now requires EXACTLY 2 channels, not
  // "2 or missing". Trusting undefined/missing metadata let a base source that had gone
  // mono (stale/never-probed channel count) get panned into digital silence. Absent
  // metadata is no longer trusted; applyChannelFix backfills audio.channels at apply
  // time (channelBalance.ts) so legitimate approved fixes still carry accurate metadata.
  it('is absent when channel metadata is missing (older imports; no longer trusted)', () => {
    const fixture = baseManifest({ audioChannelFix: validFix });
    (fixture.assets as Array<{ audio?: { sampleRate?: number } }>)[0]!.audio = { sampleRate: 48000 };
    expect(buildRenderPlanV3(ManifestV3Schema.parse(fixture)).audioSourceChannel).toBeUndefined();
  });

  it('is absent when the base asset is multichannel (5.1/7.1 must not drop center-channel dialogue)', () => {
    const fixture = baseManifest({ audioChannelFix: validFix });
    (fixture.assets as Array<{ audio?: { sampleRate?: number; channels?: number } }>)[0]!.audio = { sampleRate: 48000, channels: 6 };
    expect(buildRenderPlanV3(ManifestV3Schema.parse(fixture)).audioSourceChannel).toBeUndefined();
  });

  // Issue #5: the fix always analyzes exactly input/source.mp4 (channelBalance.ts), so it
  // must never describe a DIFFERENT single remaining video source — e.g. the base clip was
  // removed from the timeline and one unrelated import is left. "exactly one video source"
  // alone is not enough scope; the source must actually BE input/source.mp4.
  it('is absent when the single video source is NOT input/source.mp4 (base clip removed, unrelated asset remains)', () => {
    const fixture = baseManifest({ audioChannelFix: validFix });
    (fixture.assets as unknown[])[0] = { assetId: 'asset_video_other', kind: 'video', path: 'assets/video/other.mp4', durationSec: 10, provenance: 'imported', video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } };
    (fixture.tracks as Array<{ clips: unknown[] }>)[0]!.clips[0] = { clipId: 'clip_001', assetId: 'asset_video_other', sourceStart: 0, sourceEnd: 10, timelineStart: 0 };
    expect(buildRenderPlanV3(ManifestV3Schema.parse(fixture)).audioSourceChannel).toBeUndefined();
  });
});

describe('buildFfmpegCommand channel-fix pan', () => {
  function filterComplex(fixtureOverrides: Partial<Record<string, unknown>> = {}) {
    const manifest = ManifestV3Schema.parse(baseManifest(fixtureOverrides));
    const command = buildFfmpegCommandV3('/tmp/etv-chanfix', buildRenderPlanV3(manifest), 'renders/draft.mp4');
    const index = command.args.indexOf('-filter_complex');
    return command.args[index + 1]!;
  }

  it('prepends pan=stereo duplication for an approved left fix', () => {
    expect(filterComplex({ audioChannelFix: validFix })).toContain('pan=stereo|c0=c0|c1=c0');
  });

  it('uses c1 for a right-channel fix', () => {
    expect(filterComplex({ audioChannelFix: { ...validFix, sourceChannel: 'right' } })).toContain('pan=stereo|c0=c1|c1=c1');
  });

  it('emits no pan when the fix is disabled or absent', () => {
    expect(filterComplex({ audioChannelFix: { ...validFix, status: 'disabled' } })).not.toContain('pan=stereo');
    expect(filterComplex()).not.toContain('pan=stereo');
  });

  it('does not pan the studio-cleaned WAV (cleanup swap wins)', () => {
    // Fingerprinted for the SAME fix state as validFix ('left') — not stale — so the
    // cleanup wins per render/plan.ts's fingerprint-based staleness check.
    const cleanup = { status: 'approved' as const, assetPath: 'assets/studio-clean/k.wav', cacheKey: 'k', provider: 'studio-sound.test', createdAt: '2026-07-03T00:00:00.000Z', audioChannelFixFingerprint: 'left' };
    const fc = filterComplex({ audioChannelFix: validFix, studioCleanup: cleanup });
    // The base audio chain reads the cleaned WAV; no stereo pan on it.
    expect(fc).not.toContain('pan=stereo');
  });

  it('is deterministic across runs', () => {
    expect(filterComplex({ audioChannelFix: validFix })).toBe(filterComplex({ audioChannelFix: validFix }));
  });
});
