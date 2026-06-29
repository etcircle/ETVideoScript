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
import { ManifestV3Schema, StudioCleanupSchema, buildRenderPlanV3 } from '../index';

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
