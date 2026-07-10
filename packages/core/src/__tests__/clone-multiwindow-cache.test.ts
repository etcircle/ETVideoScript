import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneCleanClip, CleanedSourceUnavailableError } from '../voiceClone';
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

// Canonical sha256-hex cache keys — the cleaned contract enforces ^[0-9a-f]{64}$ before any
// path construction (traversal defense), so fixtures must use canonical keys too.
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_K = 'c'.repeat(64);
const KEY_GHOST = 'd'.repeat(64);

describeIfFfmpeg('cloneCleanClip — multi-window mode + cache identity', () => {
  let workspace: string;
  let settingsInput: SettingsPathsInput;
  let originalFetch: typeof globalThis.fetch;

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
    // Stand-in "cleaned" WAVs (length-preserving) at the CONTENT-ADDRESSED paths core now
    // enforces (assets/studio-clean/<cacheKey>.wav) — one per cacheKey the tests use.
    mkdirSync(join(workspace, 'assets', 'studio-clean'), { recursive: true });
    for (const key of [KEY_A, KEY_B, KEY_K]) {
      spawnSync('ffmpeg', [
        '-f', 'lavfi', '-i', `sine=frequency=150:sample_rate=48000:duration=${SOURCE_DURATION}`,
        '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le', '-y', join(workspace, 'assets', 'studio-clean', `${key}.wav`)
      ], { stdio: 'ignore' });
    }
  }, 90_000);

  // Manifest subset core verifies the cleaned source against: an approved cleanup for
  // `cacheKey` at its content-addressed path, plus tracks/assets from the fixture (clip_001 →
  // input/source.mp4). `over` lets negative tests break exactly one invariant at a time.
  function cleanedManifest(cacheKey: string, over: Partial<NonNullable<ManifestV3['studioCleanup']>> & { audioChannelFix?: ManifestV3['audioChannelFix'] } = {}) {
    const { audioChannelFix, ...cleanupOver } = over;
    const fixture = fixtureManifest(SOURCE_DURATION);
    return {
      studioCleanup: {
        status: 'approved' as const,
        assetPath: `assets/studio-clean/${cacheKey}.wav`,
        cacheKey,
        provider: 'studio-sound.elevenlabs-isolation',
        createdAt: '2026-07-10T00:00:00.000Z',
        ...cleanupOver
      },
      audioChannelFix,
      tracks: fixture.tracks,
      assets: fixture.assets
    };
  }

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
      multiWindow: { windows: WINDOWS, sourceClass: 'cleaned' as const, cleanupIdentity: cacheKey, manifest: cleanedManifest(cacheKey) },
      secret: 'el-key', signal: new AbortController().signal
    });
    const first = await cloneCleanClip(workspace, cleanedReq(KEY_A));
    expect(first.cached).toBe(false);
    expect(first.voice.sourceClass).toBe('cleaned');
    expect(first.voice.cleanupIdentity).toBe(KEY_A);

    // Same cleanupIdentity → cache hit.
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('same cleanupIdentity should cache-hit'); });
    const hit = await cloneCleanClip(workspace, cleanedReq(KEY_A));
    expect(hit.cached).toBe(true);
    expect(hit.voice.voiceId).toBe('el_cleaned_a');

    // Different cleanupIdentity (re-cleaned recording) → miss, fresh clone.
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ voice_id: 'el_cleaned_b' }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const miss = await cloneCleanClip(workspace, cleanedReq(KEY_B));
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
      multiWindow: { windows: WINDOWS, sourceClass: 'cleaned', cleanupIdentity: KEY_K, manifest: cleanedManifest(KEY_K) },
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
      multiWindow: { windows: WINDOWS, sourceClass: 'cleaned', manifest: cleanedManifest(KEY_A) },
      secret: 'el-key', signal: new AbortController().signal
    })).rejects.toThrow(CleanedSourceUnavailableError); // typed, not a plain Error — callers branch on .code
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

  // ── Hermes S1a review fold: core-enforced cleaned contract + single-clip + partial shapes ──

  it('rejects mixed-clip windows BEFORE any remote call (single-clip invariant)', async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    await expect(cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-bad', scope: 'project', provider: 'elevenlabs',
      multiWindow: { windows: [{ clipId: 'clip_001', start: 1, end: 11 }, { clipId: 'clip_002', start: 15, end: 25 }], sourceClass: 'raw' },
      secret: 'el-key', signal: new AbortController().signal
    })).rejects.toThrow(/ONE clip/);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 90_000);

  it('STALE cleanup → typed error, NO cache hit and NO remote call (even with a matching record)', async () => {
    // proj-cleaned already holds a matching cacheKeyA record from the earlier test. A stale
    // cleanup must NOT even serve that cache hit — validation precedes the cache read.
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    const staleManifest = cleanedManifest(KEY_A, {
      // A channel fix exists but the cleanup carries no matching fingerprint → stale by the
      // same rule render uses.
      audioChannelFix: { status: 'approved', sourceChannel: 'left', detection: { leftRmsDb: -12, rightRmsDb: -60, auto: true }, appliedAt: '2026-07-10T00:00:00.000Z' }
    });
    await expect(cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-cleaned', scope: 'project', provider: 'elevenlabs',
      multiWindow: { windows: WINDOWS, sourceClass: 'cleaned', cleanupIdentity: KEY_A, manifest: staleManifest },
      secret: 'el-key', signal: new AbortController().signal
    })).rejects.toThrow(CleanedSourceUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 90_000);

  it('non-approved cleanup → typed error before cache/remote', async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    await expect(cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-cleaned', scope: 'project', provider: 'elevenlabs',
      multiWindow: { windows: WINDOWS, sourceClass: 'cleaned', cleanupIdentity: KEY_A, manifest: cleanedManifest(KEY_A, { status: 'disabled' }) },
      secret: 'el-key', signal: new AbortController().signal
    })).rejects.toThrow(/status "disabled"/);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 90_000);

  it('cleanupIdentity that does not match studioCleanup.cacheKey → typed error', async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    await expect(cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-cleaned', scope: 'project', provider: 'elevenlabs',
      // Manifest says cacheKeyA; the request claims cacheKeyB → windows were selected against
      // a different cleanup generation.
      multiWindow: { windows: WINDOWS, sourceClass: 'cleaned', cleanupIdentity: KEY_B, manifest: cleanedManifest(KEY_A) },
      secret: 'el-key', signal: new AbortController().signal
    })).rejects.toThrow(/does not match the manifest's studioCleanup.cacheKey/);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 90_000);

  it('missing cleaned artifact → typed error before cache/remote', async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    // KEY_GHOST has an approved manifest record but no WAV on disk (canonical form so the
    // format gate passes and the existence check is what fires).
    await expect(cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-cleaned', scope: 'project', provider: 'elevenlabs',
      multiWindow: { windows: WINDOWS, sourceClass: 'cleaned', cleanupIdentity: KEY_GHOST, manifest: cleanedManifest(KEY_GHOST) },
      secret: 'el-key', signal: new AbortController().signal
    })).rejects.toThrow(/cleaned artifact missing/);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 90_000);

  it('assetPath that is not the content-addressed path for cacheKey → typed error', async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    await expect(cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-cleaned', scope: 'project', provider: 'elevenlabs',
      multiWindow: {
        windows: WINDOWS, sourceClass: 'cleaned', cleanupIdentity: KEY_A,
        // Hand-edited assetPath pointing at a DIFFERENT (existing) file must not be trusted.
        manifest: cleanedManifest(KEY_A, { assetPath: `assets/studio-clean/${KEY_B}.wav` })
      },
      secret: 'el-key', signal: new AbortController().signal
    })).rejects.toThrow(/not the expected content-addressed path/);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 90_000);

  it('TRAVERSAL cacheKey (../../…) → typed error, NO cache hit, NO remote call (Hermes repro)', async () => {
    // Hermes round-2 P1 payload: a non-canonical cacheKey that stays inside the workspace.
    // Both sides of the assetPath equality interpolate the same string, and assertInside
    // passes (media/... is inside the workspace) — only the sha256-hex format gate stops it.
    const evilKey = '../../media/clip_001/evil';
    mkdirSync(join(workspace, 'media', 'clip_001'), { recursive: true });
    spawnSync('ffmpeg', [
      '-f', 'lavfi', '-i', 'sine=frequency=999:sample_rate=48000:duration=2',
      '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le', '-y', join(workspace, 'media', 'clip_001', 'evil.wav')
    ], { stdio: 'ignore' });
    // Seed a matching cached record keyed to the traversal identity — the original repro
    // returned this as a laundered cache hit, so the gate must fire BEFORE the cache read.
    upsertVoice({
      ...settingsInput,
      voice: {
        id: 'voice-evil', name: 'evil', provider: 'elevenlabs', voiceId: 'remote-probe',
        originProjectId: 'proj-evil', cloneScope: 'project',
        sourceAudioRange: { clipId: 'clip_001', start: 1, end: 25 },
        sourceClass: 'cleaned', cleanupIdentity: evilKey, windows: WINDOWS,
        provenance: { method: 'ivc', createdBy: 'clone-route' }
      }
    });
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    await expect(cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-evil', scope: 'project', provider: 'elevenlabs',
      multiWindow: { windows: WINDOWS, sourceClass: 'cleaned', cleanupIdentity: evilKey, manifest: cleanedManifest(evilKey) },
      secret: 'el-key', signal: new AbortController().signal
    })).rejects.toThrow(/not a canonical sha256 hex key/);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 90_000);

  it('cleaned windows on a clip that is not the base recording → typed error', async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    // Manifest whose clip_001 belongs to an asset that is NOT input/source.mp4.
    const manifest = cleanedManifest(KEY_A);
    manifest.assets = [{ ...manifest.assets[0]!, path: 'input/other-import.mp4' }];
    await expect(cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-cleaned', scope: 'project', provider: 'elevenlabs',
      multiWindow: { windows: WINDOWS, sourceClass: 'cleaned', cleanupIdentity: KEY_A, manifest },
      secret: 'el-key', signal: new AbortController().signal
    })).rejects.toThrow(/studioCleanup describes only input\/source.mp4/);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 90_000);

  it('partial new-shape records never match a LEGACY request (class matrix)', async () => {
    const range = { clipId: 'clip_001', start: 2, end: 9 };
    // Three partially-new records, each carrying exactly ONE of the trio, with a
    // sourceAudioRange that would match the legacy request below if class-checking failed.
    upsertVoice({ ...settingsInput, voice: {
      id: 'partial-sc', name: 'P1', provider: 'elevenlabs', voiceId: 'el_partial_sc',
      originProjectId: 'proj-matrix', cloneScope: 'project', sourceAudioRange: range, sourceClass: 'raw'
    } });
    upsertVoice({ ...settingsInput, voice: {
      id: 'partial-ci', name: 'P2', provider: 'elevenlabs', voiceId: 'el_partial_ci',
      originProjectId: 'proj-matrix', cloneScope: 'project', sourceAudioRange: range, cleanupIdentity: 'someKey'
    } });
    upsertVoice({ ...settingsInput, voice: {
      id: 'partial-w', name: 'P3', provider: 'elevenlabs', voiceId: 'el_partial_w',
      originProjectId: 'proj-matrix', cloneScope: 'project', sourceAudioRange: range,
      windows: [{ clipId: 'clip_001', start: 2, end: 9 }]
    } });
    const calls: string[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ voice_id: 'el_fresh_matrix' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    // LEGACY request over the same range: all three partial records must be skipped.
    const result = await cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-matrix', scope: 'project', provider: 'elevenlabs',
      referenceRange: range, secret: 'el-key', signal: new AbortController().signal
    });
    expect(result.cached).toBe(false);
    expect(result.voice.voiceId).toBe('el_fresh_matrix');
    expect(calls.length).toBeGreaterThan(0);
  }, 90_000);

  it('a multi-window request never matches a partial record missing windows (matrix, other side)', async () => {
    // partial-sc (sourceClass:'raw', NO windows) is new-shaped, so it survives the class check
    // for a raw multi-window request — but windowsMatch fails on its absent windows. Use a
    // window set unique to this test so no other record can hit.
    const uniqueWindows = [{ clipId: 'clip_001', start: 3, end: 13 }];
    const calls: string[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ voice_id: 'el_fresh_matrix_mw' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const result = await cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-matrix', scope: 'project', provider: 'elevenlabs',
      multiWindow: { windows: uniqueWindows, sourceClass: 'raw' },
      secret: 'el-key', signal: new AbortController().signal
    });
    expect(result.cached).toBe(false);
    expect(result.voice.voiceId).toBe('el_fresh_matrix_mw');
    expect(calls.length).toBeGreaterThan(0);
  }, 90_000);
});
