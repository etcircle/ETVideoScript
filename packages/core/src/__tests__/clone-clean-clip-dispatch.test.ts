import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneCleanClip } from '../voiceClone';
import { readVoicesLibrary, upsertVoice, type SettingsPathsInput } from '../providerSettings';
import { saveManifestV3, type ManifestV3 } from '../index';

// cloneCleanClip's clone dispatch is the unit under test. The prep chain (extract 48k
// reference → slice → trim → loudnorm) is REAL ffmpeg — only the remote clone HTTP call is
// mocked (per the NO-paid-call constraint). We drive it with an explicit referenceRange so
// the pure selector is out of scope here (covered by clean-clip-select.test.ts) and the test
// stays deterministic.
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const describeIfFfmpeg = ffmpegAvailable ? describe : describe.skip;

function fixtureManifest(durationSec: number): ManifestV3 {
  return {
    manifestVersion: 3,
    projectId: 'clone-dispatch-test',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    assets: [{
      assetId: 'asset_video_001',
      kind: 'video',
      path: 'input/source.mp4',
      durationSec,
      provenance: 'imported',
      video: { width: 160, height: 90, fps: 30 },
      audio: { sampleRate: 48000 }
    }],
    tracks: [{
      trackId: 'track_video_001',
      kind: 'video',
      name: 'Base',
      order: 0,
      locked: false,
      muted: false,
      solo: false,
      hidden: false,
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

describeIfFfmpeg('cloneCleanClip — provider-dispatched clone', () => {
  let workspace: string;
  let settingsInput: SettingsPathsInput;
  let originalFetch: typeof globalThis.fetch;
  const SOURCE_DURATION = 10;
  const REFERENCE_RANGE = { clipId: 'clip_001', start: 1, end: 8 };

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'etvs-clone-dispatch-'));
    // Hermetic settings home so the voices library lives inside this temp dir.
    settingsInput = { homeDir: workspace, workspacePath: workspace, etvsDir: join(workspace, '.etvs') };
    mkdirSync(join(workspace, 'input'), { recursive: true });
    spawnSync('ffmpeg', [
      '-f', 'lavfi', '-i', `color=c=black:s=160x90:duration=${SOURCE_DURATION}:rate=30`,
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${SOURCE_DURATION}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest', '-y', join(workspace, 'input', 'source.mp4')
    ], { stdio: 'ignore' });
    saveManifestV3(workspace, fixtureManifest(SOURCE_DURATION), { revision: false });
  }, 60_000);

  afterAll(() => { if (workspace) rmSync(workspace, { recursive: true, force: true }); });

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('dispatches to the ElevenLabs adapter and records provider=elevenlabs', async () => {
    const calls: string[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      // EL clone endpoint is /v1/voices/add and returns { voice_id }.
      return new Response(JSON.stringify({ voice_id: 'el_clone_abc' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    });

    const result = await cloneCleanClip(workspace, {
      ...settingsInput,
      projectId: 'proj-el',
      scope: 'project',
      provider: 'elevenlabs',
      referenceRange: REFERENCE_RANGE,
      secret: 'el-key',
      signal: new AbortController().signal
    });

    expect(result.cached).toBe(false);
    expect(result.voice.provider).toBe('elevenlabs');
    expect(result.voice.voiceId).toBe('el_clone_abc');
    // The EL IVC endpoint (not Cartesia's /voices/clone) was hit.
    expect(calls.some((u) => u.includes('/v1/voices/add'))).toBe(true);
    expect(calls.some((u) => u.includes('/voices/clone'))).toBe(false);
  }, 60_000);

  it('defaults to elevenlabs when no provider is given (matches the route default)', async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ voice_id: 'el_default_xyz' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    );
    const result = await cloneCleanClip(workspace, {
      ...settingsInput,
      projectId: 'proj-default',
      scope: 'project',
      // provider omitted on purpose
      referenceRange: REFERENCE_RANGE,
      secret: 'el-key',
      signal: new AbortController().signal
    });
    expect(result.voice.provider).toBe('elevenlabs');
  }, 60_000);

  it('dispatches to the Cartesia adapter and records provider=cartesia (unchanged path)', async () => {
    const calls: string[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      // Cartesia clone endpoint returns { id }.
      return new Response(JSON.stringify({ id: 'cartesia_clone_123' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    });
    const result = await cloneCleanClip(workspace, {
      ...settingsInput,
      projectId: 'proj-cartesia',
      scope: 'project',
      provider: 'cartesia',
      referenceRange: REFERENCE_RANGE,
      secret: 'cartesia-key',
      signal: new AbortController().signal
    });
    expect(result.voice.provider).toBe('cartesia');
    expect(result.voice.voiceId).toBe('cartesia_clone_123');
    expect(calls.some((u) => u.includes('/voices/clone'))).toBe(true);
    expect(calls.some((u) => u.includes('/v1/voices/add'))).toBe(false);
  }, 60_000);

  it('cache-hits per provider — EL reuses an EL record, does not fall through to a Cartesia one', async () => {
    // Seed BOTH an EL and a Cartesia cached voice for the SAME project/scope/range.
    const range = { clipId: 'clip_001', start: 1, end: 8 };
    upsertVoice({
      ...settingsInput,
      voice: {
        id: 'voice-el-cached', name: 'el-cached', provider: 'elevenlabs', voiceId: 'el_cached_voice',
        originProjectId: 'proj-cache', cloneScope: 'project', sourceAudioRange: range,
        provenance: { method: 'ivc', createdBy: 'clone-route' }
      }
    });
    upsertVoice({
      ...settingsInput,
      voice: {
        id: 'voice-cart-cached', name: 'cart-cached', provider: 'cartesia', voiceId: 'cart_cached_voice',
        originProjectId: 'proj-cache', cloneScope: 'project', sourceAudioRange: range,
        provenance: { method: 'ivc', createdBy: 'clone-route' }
      }
    });

    // A network call would prove the cache MISSED — fetch must never fire on a hit.
    const fetchSpy = vi.fn(async () => { throw new Error('cache miss: no clone HTTP call should occur'); });
    (globalThis as any).fetch = fetchSpy;

    const elHit = await cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-cache', scope: 'project', provider: 'elevenlabs',
      referenceRange: range, secret: 'el-key', signal: new AbortController().signal
    });
    expect(elHit.cached).toBe(true);
    expect(elHit.voice.voiceId).toBe('el_cached_voice');

    const cartHit = await cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-cache', scope: 'project', provider: 'cartesia',
      referenceRange: range, secret: 'cart-key', signal: new AbortController().signal
    });
    expect(cartHit.cached).toBe(true);
    expect(cartHit.voice.voiceId).toBe('cart_cached_voice');

    expect(fetchSpy).not.toHaveBeenCalled();
  }, 60_000);

  it('legacy cartesia cache records still hit (backward-compatible)', async () => {
    // A record written by the old Cartesia-hardwired path carries provider: 'cartesia' and no
    // provider-specific extras. It must still be reused for a Cartesia request.
    const range = { clipId: 'clip_001', start: 2, end: 7 };
    upsertVoice({
      ...settingsInput,
      voice: {
        id: 'voice-legacy', name: 'legacy', provider: 'cartesia', voiceId: 'legacy_cart_voice',
        originProjectId: 'proj-legacy', cloneScope: 'project', sourceAudioRange: range,
        provenance: { method: 'ivc', createdBy: 'clone-route' }
      }
    });
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('legacy record should cache-hit, not re-clone'); });
    const hit = await cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-legacy', scope: 'project', provider: 'cartesia',
      referenceRange: range, secret: 'cart-key', signal: new AbortController().signal
    });
    expect(hit.cached).toBe(true);
    expect(hit.voice.voiceId).toBe('legacy_cart_voice');
    // Sanity: the library actually contains the seeded record.
    expect(readVoicesLibrary(settingsInput).value.voices.some((v) => v.id === 'voice-legacy')).toBe(true);
  }, 60_000);
});
