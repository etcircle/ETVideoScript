import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneCleanClip } from '../voiceClone';
import { readVoicesLibrary, upsertVoice, type SettingsPathsInput } from '../providerSettings';
import { saveManifestV3, type ManifestV3 } from '../index';

// Multi-sample (EL maxSamples>1) clone mode + the extended cache identity. The clone HTTP call
// is mocked (no paid call); the per-window prep chain (extract 48k ref → slice → trim → loudnorm)
// is REAL ffmpeg, same pattern as clone-clean-clip-dispatch.test.ts. Cartesia (maxSamples 1) is
// exercised to prove it IGNORES multiWindow and stays single-window.
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const describeIfFfmpeg = ffmpegAvailable ? describe : describe.skip;

const SOURCE_DURATION = 40;

function fixtureManifest(durationSec: number): ManifestV3 {
  return {
    manifestVersion: 3,
    projectId: 'clone-mw-test',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    assets: [{
      assetId: 'asset_video_001', kind: 'video', path: 'input/source.mp4', durationSec,
      provenance: 'imported', video: { width: 160, height: 90, fps: 30 }, audio: { sampleRate: 48000 }
    }],
    tracks: [{
      trackId: 'track_video_001', kind: 'video', name: 'Base', order: 0,
      locked: false, muted: false, solo: false, hidden: false,
      clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: durationSec, timelineStart: 0 }]
    }],
    operations: [],
    outputs: [{ outputId: 'output_001', kind: 'full', aspects: ['16:9'], status: 'manual' }],
    renderPresets: {
      draft: { resolution: '160x90', videoBitrate: '250k', audioBitrate: '64k' },
      youtube: { resolution: '320x180', videoBitrate: '500k', audioBitrate: '128k' }
    }
  };
}

// Two ascending windows on the base clip (asset axis) — the shape selectCleanWindows returns.
const WINDOWS = [
  { clipId: 'clip_001', start: 1, end: 11 },
  { clipId: 'clip_001', start: 15, end: 25 }
];

describeIfFfmpeg('cloneCleanClip — multi-window mode + cache identity', () => {
  let workspace: string;
  let settingsInput: SettingsPathsInput;
  let originalFetch: typeof globalThis.fetch;
  let cleanedRel: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'etvs-clone-mw-'));
    settingsInput = { homeDir: workspace, workspacePath: workspace, etvsDir: join(workspace, '.etvs') };
    mkdirSync(join(workspace, 'input'), { recursive: true });
    spawnSync('ffmpeg', [
      '-f', 'lavfi', '-i', `color=c=black:s=160x90:duration=${SOURCE_DURATION}:rate=30`,
      '-f', 'lavfi', '-i', `sine=frequency=150:sample_rate=48000:duration=${SOURCE_DURATION}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', '-y', join(workspace, 'input', 'source.mp4')
    ], { stdio: 'ignore' });
    saveManifestV3(workspace, fixtureManifest(SOURCE_DURATION), { revision: false });
    // A stand-in "cleaned" WAV (length-preserving) for sourceClass:'cleaned' prep.
    cleanedRel = 'assets/studio-clean/testkey.wav';
    mkdirSync(join(workspace, 'assets', 'studio-clean'), { recursive: true });
    spawnSync('ffmpeg', [
      '-f', 'lavfi', '-i', `sine=frequency=150:sample_rate=48000:duration=${SOURCE_DURATION}`,
      '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le', '-y', join(workspace, cleanedRel)
    ], { stdio: 'ignore' });
  }, 90_000);

  afterAll(() => { if (workspace) rmSync(workspace, { recursive: true, force: true }); });
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('uploads N separate samples for an EL multi-window clone and records the identity', async () => {
    let sampleCountSeen = -1;
    (globalThis as any).fetch = vi.fn(async (url: string, init?: RequestInit) => {
      // EL /v1/voices/add takes multipart form-data; count the "files" parts.
      if (init?.body instanceof FormData) {
        sampleCountSeen = init.body.getAll('files').length;
      }
      return new Response(JSON.stringify({ voice_id: 'el_mw_voice' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const result = await cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-mw', scope: 'project', provider: 'elevenlabs',
      multiWindow: { windows: WINDOWS, sourceClass: 'raw' },
      secret: 'el-key', signal: new AbortController().signal
    });

    expect(result.cached).toBe(false);
    expect(result.sampleCount).toBe(2);
    expect(sampleCountSeen).toBe(2); // two sample files in ONE add call
    expect(result.voice.provider).toBe('elevenlabs');
    expect(result.voice.sourceClass).toBe('raw');
    expect(result.voice.windows).toEqual(WINDOWS);
    expect(result.voice.cleanupIdentity).toBeUndefined();
  }, 90_000);

  it('cache-hits an identical multi-window request (no second clone call)', async () => {
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('cache miss: no clone HTTP call should occur'); });
    const hit = await cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-mw', scope: 'project', provider: 'elevenlabs',
      multiWindow: { windows: WINDOWS, sourceClass: 'raw' },
      secret: 'el-key', signal: new AbortController().signal
    });
    expect(hit.cached).toBe(true);
    expect(hit.voice.voiceId).toBe('el_mw_voice');
    expect(hit.sampleCount).toBe(2);
  }, 90_000);

  it('a multi-window request NEVER reuses a legacy single-window record (class-symmetric)', async () => {
    // Seed a LEGACY record whose sourceAudioRange spans the SAME range as the multi-window request.
    upsertVoice({
      ...settingsInput,
      voice: {
        id: 'voice-legacy-span', name: 'legacy-span', provider: 'elevenlabs', voiceId: 'el_legacy_span',
        originProjectId: 'proj-legacy-mw', cloneScope: 'project',
        sourceAudioRange: { clipId: 'clip_001', start: 1, end: 25 },
        provenance: { method: 'ivc', createdBy: 'clone-route' }
      }
    });
    const calls: string[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ voice_id: 'el_fresh_mw' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const result = await cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-legacy-mw', scope: 'project', provider: 'elevenlabs',
      multiWindow: { windows: WINDOWS, sourceClass: 'raw' },
      secret: 'el-key', signal: new AbortController().signal
    });
    expect(result.cached).toBe(false); // did NOT reuse the legacy record
    expect(result.voice.voiceId).toBe('el_fresh_mw');
    expect(calls.length).toBeGreaterThan(0);
    // Legacy record untouched.
    expect(readVoicesLibrary(settingsInput).value.voices.some((v) => v.id === 'voice-legacy-span')).toBe(true);
  }, 90_000);

  it('a legacy single-window request NEVER reuses a multi-window record (symmetric other way)', async () => {
    // Seed a MULTI-WINDOW record.
    upsertVoice({
      ...settingsInput,
      voice: {
        id: 'voice-mw-only', name: 'mw-only', provider: 'elevenlabs', voiceId: 'el_mw_only',
        originProjectId: 'proj-sym', cloneScope: 'project',
        sourceAudioRange: { clipId: 'clip_001', start: 1, end: 11 },
        sourceClass: 'raw', windows: [{ clipId: 'clip_001', start: 1, end: 11 }],
        provenance: { method: 'ivc', createdBy: 'clone-route' }
      }
    });
    const calls: string[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ voice_id: 'el_fresh_legacy' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    // A LEGACY (single-window) request with the SAME range must miss the multi-window record.
    const result = await cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-sym', scope: 'project', provider: 'elevenlabs',
      referenceRange: { clipId: 'clip_001', start: 1, end: 11 },
      secret: 'el-key', signal: new AbortController().signal
    });
    expect(result.cached).toBe(false);
    expect(result.voice.voiceId).toBe('el_fresh_legacy');
    expect(calls.length).toBeGreaterThan(0);
  }, 90_000);

  it('a changed window SET misses (fresh clone)', async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ voice_id: 'el_changed_windows' }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const changed = [{ clipId: 'clip_001', start: 1, end: 11 }, { clipId: 'clip_001', start: 15, end: 26 }]; // end 25→26
    const result = await cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-mw', scope: 'project', provider: 'elevenlabs',
      multiWindow: { windows: changed, sourceClass: 'raw' },
      secret: 'el-key', signal: new AbortController().signal
    });
    // proj-mw already has the WINDOWS record from the first test; a different window set must miss.
    expect(result.cached).toBe(false);
    expect(result.voice.voiceId).toBe('el_changed_windows');
  }, 90_000);

  it('cleaned source: records cleanupIdentity, and a changed cleanupIdentity misses', async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ voice_id: 'el_cleaned_a' }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const cleanedReq = (cacheKey: string) => ({
      ...settingsInput, projectId: 'proj-cleaned', scope: 'project' as const, provider: 'elevenlabs' as const,
      multiWindow: { windows: WINDOWS, sourceClass: 'cleaned' as const, cleanupIdentity: cacheKey, cleanedAssetPath: cleanedRel },
      secret: 'el-key', signal: new AbortController().signal
    });
    const first = await cloneCleanClip(workspace, cleanedReq('cacheKeyA'));
    expect(first.cached).toBe(false);
    expect(first.voice.sourceClass).toBe('cleaned');
    expect(first.voice.cleanupIdentity).toBe('cacheKeyA');

    // Same cleanupIdentity → cache hit.
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('same cleanupIdentity should cache-hit'); });
    const hit = await cloneCleanClip(workspace, cleanedReq('cacheKeyA'));
    expect(hit.cached).toBe(true);
    expect(hit.voice.voiceId).toBe('el_cleaned_a');

    // Different cleanupIdentity (re-cleaned recording) → miss, fresh clone.
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ voice_id: 'el_cleaned_b' }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const miss = await cloneCleanClip(workspace, cleanedReq('cacheKeyB'));
    expect(miss.cached).toBe(false);
    expect(miss.voice.voiceId).toBe('el_cleaned_b');
  }, 90_000);

  it('cleaned request vs a raw multi-window record (same windows) misses (sourceClass differs)', async () => {
    // The proj-mw raw record with WINDOWS exists from the first test. A CLEANED request with the
    // same windows must not reuse it — different prepared audio (raw ref vs cleaned bed).
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ voice_id: 'el_cleaned_vs_raw' }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const result = await cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-mw', scope: 'project', provider: 'elevenlabs',
      multiWindow: { windows: WINDOWS, sourceClass: 'cleaned', cleanupIdentity: 'k', cleanedAssetPath: cleanedRel },
      secret: 'el-key', signal: new AbortController().signal
    });
    expect(result.cached).toBe(false);
    expect(result.voice.sourceClass).toBe('cleaned');
  }, 90_000);

  it('Cartesia (maxSamples 1) IGNORES multiWindow and stays single-window', async () => {
    const calls: { files: number }[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const files = init?.body instanceof FormData ? init.body.getAll('clip').length + init.body.getAll('files').length : 0;
      calls.push({ files });
      return new Response(JSON.stringify({ id: 'cart_single' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const result = await cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-cart-mw', scope: 'project', provider: 'cartesia',
      // multiWindow supplied but Cartesia can't use it → falls back to the single-window path.
      // We give an explicit referenceRange so it doesn't need a transcript (multiWindow is inert).
      multiWindow: { windows: WINDOWS, sourceClass: 'raw' },
      referenceRange: { clipId: 'clip_001', start: 1, end: 8 },
      secret: 'cart-key', signal: new AbortController().signal
    });
    // Single-window path: sampleCount 1, no multi-window fields recorded.
    expect(result.sampleCount).toBe(1);
    expect(result.voice.windows).toBeUndefined();
    expect(result.voice.sourceClass).toBeUndefined();
    expect(calls.length).toBeGreaterThan(0);
  }, 90_000);

  it('rejects sourceClass:cleaned without cleanupIdentity BEFORE any remote call', async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    await expect(cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-bad', scope: 'project', provider: 'elevenlabs',
      multiWindow: { windows: WINDOWS, sourceClass: 'cleaned', cleanedAssetPath: cleanedRel },
      secret: 'el-key', signal: new AbortController().signal
    })).rejects.toThrow(/cleanupIdentity is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 90_000);

  it('rejects out-of-order windows BEFORE any remote call', async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    await expect(cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-bad', scope: 'project', provider: 'elevenlabs',
      multiWindow: { windows: [{ clipId: 'clip_001', start: 15, end: 25 }, { clipId: 'clip_001', start: 1, end: 11 }], sourceClass: 'raw' },
      secret: 'el-key', signal: new AbortController().signal
    })).rejects.toThrow(/ascending-start order/);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 90_000);
});
