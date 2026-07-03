/**
 * G7 — Studio Sound tests
 *
 * Covers:
 *  1. StudioCleanupSchema Zod round-trip (valid + invalid shapes)
 *  2. ManifestV3 with studioCleanup field parses and round-trips
 *  3. buildRenderPlan: studioCleanupAudioPath set when approved, absent when
 *     disabled, absent when missing entirely
 *  4. The Isolator adapter's degraded-payload defense (mockWav + probeAudioBufferDurationSec)
 *
 * PAID-CALL GUARD: no real ElevenLabs API call is ever made in this file.
 * - The paidStudioSoundProvider.run() path that calls EL is guarded by
 *   `runInput.envTestMode === true` (returns mockWav early).
 * - The studioCleanupRoutes POST is guarded by ETVS_PAID_PROVIDER_TEST_MODE=1,
 *   which the route checks via process.env before calling `fetch`.
 * - Tests in this file pass `envTestMode: true` explicitly or test only the
 *   non-fetch branches (schema validation, render plan logic).
 */

import { describe, expect, it } from 'vitest';
import { ManifestV3Schema, StudioCleanupSchema, buildRenderPlanV3, channelFixFingerprint } from '../index';

const now = '2026-06-08T00:00:00.000Z';
const presets = { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: '1920x1080', videoBitrate: '6000k', audioBitrate: '192k' } };

// Minimal valid ManifestV3 fixture.
function baseManifest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    manifestVersion: 3 as const,
    projectId: 'studio-clean-test',
    createdAt: now,
    updatedAt: now,
    assets: [
      { assetId: 'asset_video_001', kind: 'video' as const, path: 'input/source.mp4', durationSec: 10, provenance: 'imported' as const, video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000 } }
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

describe('StudioCleanupSchema', () => {
  it('round-trips a valid approved record', () => {
    const input = {
      status: 'approved' as const,
      assetPath: 'assets/studio-clean/abc123.wav',
      cacheKey: 'abc123',
      provider: 'studio-sound.elevenlabs-isolation',
      providerId: 'el-iso-1717000000000',
      createdAt: now,
      costUsd: 0.14
    };
    const parsed = StudioCleanupSchema.parse(input);
    expect(parsed.status).toBe('approved');
    expect(parsed.assetPath).toBe('assets/studio-clean/abc123.wav');
    expect(parsed.cacheKey).toBe('abc123');
    expect(parsed.costUsd).toBe(0.14);
  });

  it('round-trips a disabled record (no costUsd)', () => {
    const input = { status: 'disabled' as const, assetPath: 'assets/studio-clean/abc123.wav', cacheKey: 'abc123', provider: 'studio-sound.elevenlabs-isolation', createdAt: now };
    const parsed = StudioCleanupSchema.parse(input);
    expect(parsed.status).toBe('disabled');
    expect(parsed.costUsd).toBeUndefined();
  });

  it('rejects missing required fields', () => {
    expect(() => StudioCleanupSchema.parse({ status: 'approved' })).toThrow();
  });

  it('rejects invalid status value', () => {
    expect(() => StudioCleanupSchema.parse({ status: 'unknown', assetPath: 'x', cacheKey: 'y', provider: 'z', createdAt: now })).toThrow();
  });

  it('rejects negative costUsd', () => {
    expect(() => StudioCleanupSchema.parse({ status: 'approved', assetPath: 'x', cacheKey: 'y', provider: 'z', createdAt: now, costUsd: -1 })).toThrow();
  });
});

describe('ManifestV3 studioCleanup field', () => {
  it('parses a manifest without studioCleanup (backward-compatible)', () => {
    const parsed = ManifestV3Schema.parse(baseManifest());
    expect(parsed.studioCleanup).toBeUndefined();
  });

  it('parses a manifest with an approved studioCleanup', () => {
    const parsed = ManifestV3Schema.parse(baseManifest({
      studioCleanup: { status: 'approved', assetPath: 'assets/studio-clean/abc.wav', cacheKey: 'abc', provider: 'studio-sound.elevenlabs-isolation', createdAt: now }
    }));
    expect(parsed.studioCleanup?.status).toBe('approved');
    expect(parsed.studioCleanup?.assetPath).toBe('assets/studio-clean/abc.wav');
  });

  it('parses a manifest with a disabled studioCleanup', () => {
    const parsed = ManifestV3Schema.parse(baseManifest({
      studioCleanup: { status: 'disabled', assetPath: 'assets/studio-clean/abc.wav', cacheKey: 'abc', provider: 'studio-sound.elevenlabs-isolation', createdAt: now }
    }));
    expect(parsed.studioCleanup?.status).toBe('disabled');
  });
});

describe('buildRenderPlan studioCleanupAudioPath', () => {
  it('is absent when no studioCleanup field', () => {
    const manifest = ManifestV3Schema.parse(baseManifest());
    const plan = buildRenderPlanV3(manifest);
    expect(plan.studioCleanupAudioPath).toBeUndefined();
  });

  it('is absent when studioCleanup.status is "disabled"', () => {
    const manifest = ManifestV3Schema.parse(baseManifest({
      studioCleanup: { status: 'disabled', assetPath: 'assets/studio-clean/abc.wav', cacheKey: 'abc', provider: 'studio-sound.elevenlabs-isolation', createdAt: now }
    }));
    const plan = buildRenderPlanV3(manifest);
    expect(plan.studioCleanupAudioPath).toBeUndefined();
  });

  it('is absent when studioCleanup.status is "pending"', () => {
    const manifest = ManifestV3Schema.parse(baseManifest({
      studioCleanup: { status: 'pending', assetPath: 'assets/studio-clean/abc.wav', cacheKey: 'abc', provider: 'studio-sound.elevenlabs-isolation', createdAt: now }
    }));
    const plan = buildRenderPlanV3(manifest);
    expect(plan.studioCleanupAudioPath).toBeUndefined();
  });

  it('is absent when studioCleanup.status is "rejected"', () => {
    const manifest = ManifestV3Schema.parse(baseManifest({
      studioCleanup: { status: 'rejected', assetPath: 'assets/studio-clean/abc.wav', cacheKey: 'abc', provider: 'studio-sound.elevenlabs-isolation', createdAt: now }
    }));
    const plan = buildRenderPlanV3(manifest);
    expect(plan.studioCleanupAudioPath).toBeUndefined();
  });

  it('equals the assetPath when studioCleanup.status is "approved"', () => {
    const manifest = ManifestV3Schema.parse(baseManifest({
      studioCleanup: { status: 'approved', assetPath: 'assets/studio-clean/abc.wav', cacheKey: 'abc', provider: 'studio-sound.elevenlabs-isolation', createdAt: now }
    }));
    const plan = buildRenderPlanV3(manifest);
    expect(plan.studioCleanupAudioPath).toBe('assets/studio-clean/abc.wav');
  });

  it('is reversible: approve then disable → undefined', () => {
    const approvedManifest = ManifestV3Schema.parse(baseManifest({
      studioCleanup: { status: 'approved', assetPath: 'assets/studio-clean/abc.wav', cacheKey: 'abc', provider: 'studio-sound.elevenlabs-isolation', createdAt: now }
    }));
    expect(buildRenderPlanV3(approvedManifest).studioCleanupAudioPath).toBe('assets/studio-clean/abc.wav');

    const disabledManifest = ManifestV3Schema.parse({ ...approvedManifest, studioCleanup: { ...approvedManifest.studioCleanup!, status: 'disabled' } });
    expect(buildRenderPlanV3(disabledManifest).studioCleanupAudioPath).toBeUndefined();
  });
});

// Issue #3/#9/#11: an approved studioCleanup was previously invalidated by comparing
// audioChannelFix.appliedAt against studioCleanup.createdAt with plain Date.parse
// ordering — defeated by a same-value re-apply/re-disable churning appliedAt with no
// real value change, same-millisecond races, and future-dated hand edits. Replaced with
// a VALUE fingerprint recorded on the cleanup at creation time (studioCleanupRoutes.ts)
// and compared against the CURRENT fix fingerprint here — immune to all three.
describe('buildRenderPlan studioCleanupStale (fingerprint-based)', () => {
  const createdAt = '2026-06-08T00:00:00.000Z';
  const cleanupWithFingerprint = (audioChannelFixFingerprint?: string) => ({
    status: 'approved' as const, assetPath: 'assets/studio-clean/abc.wav', cacheKey: 'abc', provider: 'studio-sound.elevenlabs-isolation', createdAt, ...(audioChannelFixFingerprint !== undefined ? { audioChannelFixFingerprint } : {})
  });
  const fixture = (audioChannelFix: unknown, cleanup: ReturnType<typeof cleanupWithFingerprint>) => baseManifest({
    assets: [{ assetId: 'asset_video_001', kind: 'video' as const, path: 'input/source.mp4', durationSec: 10, provenance: 'imported' as const, video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } }],
    studioCleanup: cleanup,
    audioChannelFix
  });
  const approvedLeft = { status: 'approved' as const, sourceChannel: 'left' as const, detection: { leftRmsDb: -18, rightRmsDb: -92, auto: true }, appliedAt: createdAt };
  const disabledLeft = { ...approvedLeft, status: 'disabled' as const };

  it('is absent (not stale) when the cleanup fingerprint matches the current fix state', () => {
    const manifest = ManifestV3Schema.parse(fixture(approvedLeft, cleanupWithFingerprint(channelFixFingerprint('left'))));
    const plan = buildRenderPlanV3(manifest);
    expect(plan.studioCleanupStale).toBeUndefined();
    expect(plan.studioCleanupAudioPath).toBe('assets/studio-clean/abc.wav');
  });

  it('is stale (falls back to raw re-panned audio) when a fix APPLY changed the fingerprint after the cleanup was generated (dispute point 1)', () => {
    // Cleanup was fingerprinted for 'none' (no fix yet); the fix is now approved 'left'.
    const manifest = ManifestV3Schema.parse(fixture(approvedLeft, cleanupWithFingerprint(channelFixFingerprint(undefined))));
    const plan = buildRenderPlanV3(manifest);
    expect(plan.studioCleanupStale).toBe(true);
    expect(plan.studioCleanupAudioPath).toBeUndefined();
    expect(plan.audioSourceChannel).toBe('left'); // raw audio is still correctly re-panned
  });

  it('is stale when a fix DISABLE changed the fingerprint after the cleanup was generated, so disabling has a visible effect on the render (dispute point 2)', () => {
    // Cleanup was fingerprinted for the approved 'left' fix; it has since been disabled.
    const manifest = ManifestV3Schema.parse(fixture(disabledLeft, cleanupWithFingerprint(channelFixFingerprint('left'))));
    const plan = buildRenderPlanV3(manifest);
    expect(plan.studioCleanupStale).toBe(true);
    expect(plan.studioCleanupAudioPath).toBeUndefined();
    expect(plan.audioSourceChannel).toBeUndefined(); // fix disabled: raw audio, unpanned
  });

  it('is stale when the fingerprint field is missing on the cleanup AND a fix record exists (legacy cleanup, pre-fingerprint field)', () => {
    const manifest = ManifestV3Schema.parse(fixture(approvedLeft, cleanupWithFingerprint(undefined)));
    const plan = buildRenderPlanV3(manifest);
    expect(plan.studioCleanupStale).toBe(true);
    expect(plan.studioCleanupAudioPath).toBeUndefined();
  });

  it('never auto-reruns the paid cleanup — staleness only ever suppresses the cached asset', () => {
    const approvedRight = { status: 'approved' as const, sourceChannel: 'right' as const, detection: { leftRmsDb: -92, rightRmsDb: -18, auto: true }, appliedAt: createdAt };
    const manifest = ManifestV3Schema.parse(fixture(approvedRight, cleanupWithFingerprint(channelFixFingerprint('left'))));
    const plan = buildRenderPlanV3(manifest);
    // No paid-provider fields anywhere on the plan; studioCleanup itself is untouched
    // (still 'approved' on the source manifest) — only the render's USE of it is suppressed.
    expect(manifest.studioCleanup?.status).toBe('approved');
    expect(plan.studioCleanupAudioPath).toBeUndefined();
  });

  it('is absent when there is no channel fix at all, regardless of the cleanup\'s recorded fingerprint (or lack thereof)', () => {
    expect(buildRenderPlanV3(ManifestV3Schema.parse(fixture(undefined, cleanupWithFingerprint(channelFixFingerprint(undefined))))).studioCleanupStale).toBeUndefined();
    // A legacy cleanup with NO fingerprint field at all, and no channel-fix history ever —
    // the common case, and every manifest that predates this whole feature — must not be
    // treated as stale just because the new field happens to be absent.
    expect(buildRenderPlanV3(ManifestV3Schema.parse(fixture(undefined, cleanupWithFingerprint(undefined)))).studioCleanupStale).toBeUndefined();
  });

  it('is a true no-op-immune comparison: identical fingerprints stay fresh regardless of appliedAt/createdAt ordering', () => {
    // appliedAt is LATER than createdAt (the old, now-abandoned timestamp-ordering check
    // would have called this stale) but the fingerprint matches — must NOT be stale.
    const laterAppliedFix = { ...approvedLeft, appliedAt: '2026-06-08T05:00:00.000Z' };
    const manifest = ManifestV3Schema.parse(fixture(laterAppliedFix, cleanupWithFingerprint(channelFixFingerprint('left'))));
    expect(buildRenderPlanV3(manifest).studioCleanupStale).toBeUndefined();
  });
});

// Issue #5: studioCleanup describes ONLY input/source.mp4's audio.
describe('buildRenderPlan studioCleanupAudioPath scope guard', () => {
  it('is absent when the single remaining video source is NOT input/source.mp4 (base clip removed, unrelated asset remains)', () => {
    const manifest = ManifestV3Schema.parse({
      manifestVersion: 3 as const,
      projectId: 'studio-clean-scope-test',
      createdAt: now,
      updatedAt: now,
      assets: [{ assetId: 'asset_video_other', kind: 'video' as const, path: 'assets/video/other.mp4', durationSec: 10, provenance: 'imported' as const, video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000 } }],
      tracks: [{ trackId: 'track_video_001', kind: 'video' as const, name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [{ clipId: 'clip_001', assetId: 'asset_video_other', sourceStart: 0, sourceEnd: 10, timelineStart: 0 }] }],
      operations: [],
      outputs: [{ outputId: 'out_001', kind: 'full' as const, aspects: ['16:9' as const], status: 'manual' as const }],
      renderPresets: presets,
      studioCleanup: { status: 'approved' as const, assetPath: 'assets/studio-clean/abc.wav', cacheKey: 'abc', provider: 'studio-sound.elevenlabs-isolation', createdAt: now }
    });
    expect(buildRenderPlanV3(manifest).studioCleanupAudioPath).toBeUndefined();
  });
});

describe('EL Isolator adapter degraded-payload defense', () => {
  it('mockWav returns a buffer with RIFF/WAVE header', async () => {
    const { mockWav } = await import('../providers/studio-sound/shared');
    const wav = mockWav();
    expect(wav.subarray(0, 4).toString('binary')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('binary')).toBe('WAVE');
  });

  it('transcodeToWav48k passes RIFF/WAVE buffers through unchanged', async () => {
    const { mockWav, transcodeToWav48k } = await import('../providers/studio-sound/shared');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(`${tmpdir()}/studio-test-`);
    try {
      const wav = mockWav();
      const result = transcodeToWav48k(wav, tmp);
      // Should be the same buffer reference (fast-path)
      expect(result).toBe(wav);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('paidStudioSoundProvider returns mockWav in envTestMode without any HTTP call', async () => {
    const { paidStudioSoundProvider, mockWav } = await import('../providers/studio-sound/shared');
    // Build a provider instance (elevenlabs-isolation shape).
    const provider = paidStudioSoundProvider({ id: 'studio-sound.elevenlabs-isolation', name: 'elevenlabs-isolation', displayName: 'ElevenLabs Isolation', endpoint: 'https://api.elevenlabs.io/v1/audio-isolation' });
    // Minimal mock context — guardedFetch must NOT be called.
    const guardedFetchCalled = { value: false };
    const context = {
      secret: 'test-key',
      provider: { baseUrl: undefined, tier: 'paid' },
      signal: new AbortController().signal,
      tempDir: '/tmp',
      guardedFetch: async () => { guardedFetchCalled.value = true; throw new Error('should not call'); }
    };
    const result = await provider.run({ inputPath: '/dev/null', profile: 'clean_voice', filterChainVersion: 0, durationSec: 10, envTestMode: true }, context as any);
    expect(guardedFetchCalled.value).toBe(false);
    const mock = mockWav();
    expect(result.audio.subarray(0, 4).toString('binary')).toBe(mock.subarray(0, 4).toString('binary'));
    expect(result.mimeType).toBe('audio/wav');
    expect(result.providerStatus).toBe(200);
  });

  it('paidStudioSoundProvider throws when no credential and not in test mode', async () => {
    const { paidStudioSoundProvider } = await import('../providers/studio-sound/shared');
    const provider = paidStudioSoundProvider({ id: 'studio-sound.elevenlabs-isolation', name: 'elevenlabs-isolation', displayName: 'ElevenLabs Isolation', endpoint: 'https://api.elevenlabs.io/v1/audio-isolation' });
    const context = { secret: undefined, provider: { baseUrl: undefined, tier: 'paid' }, signal: new AbortController().signal, tempDir: '/tmp', guardedFetch: async () => ({}) };
    await expect(provider.run({ inputPath: '/dev/null', profile: 'clean_voice', filterChainVersion: 0, durationSec: 10, envTestMode: false }, context as any)).rejects.toThrow('Configure credentials');
  });
});
