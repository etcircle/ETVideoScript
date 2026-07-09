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

  it('rejects an unknown provider at runtime — core has NO default provider', async () => {
    // `provider` is required at the type level, but params commonly arrive from parsed JSON
    // bodies; an unrecognized string must fail fast, not dispatch to undefined.clone.
    // (Defaulting is ROUTE policy — settingsRoutes' `fields.provider ?? 'elevenlabs'` —
    // deliberately NOT replicated in core; see the CLONE_PROVIDERS note in voiceClone.ts.)
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    await expect(cloneCleanClip(workspace, {
      ...settingsInput,
      projectId: 'proj-bad',
      scope: 'project',
      provider: 'not-a-provider' as any,
      referenceRange: REFERENCE_RANGE,
      secret: 'key',
      signal: new AbortController().signal
    })).rejects.toThrow(/unsupported clone provider/);
    expect(fetchSpy).not.toHaveBeenCalled();
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
    // accountRef. It must still be reused for a Cartesia request. Note `provider` is now
    // REQUIRED — a caller reaching its legacy Cartesia cache does so by explicitly passing
    // 'cartesia', which is the point of the required-provider change: no core default can
    // silently route it to a different provider and skip these records.
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

  it('same provider + DIFFERENT accountRef → cache miss (fresh clone under the new account)', async () => {
    const range = { clipId: 'clip_001', start: 3, end: 8 };
    // Record created under account A.
    upsertVoice({
      ...settingsInput,
      voice: {
        id: 'voice-acct-a', name: 'acct-a', provider: 'elevenlabs', voiceId: 'el_acct_a_voice',
        accountRef: 'elevenlabs:acct-a', originProjectId: 'proj-acct', cloneScope: 'project',
        sourceAudioRange: range, provenance: { method: 'ivc', createdBy: 'clone-route' }
      }
    });
    // Request under account B: the A-record's voiceId does not exist in B, so the cache MUST
    // miss and a fresh clone call must fire.
    const calls: string[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ voice_id: 'el_acct_b_voice' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    });
    const result = await cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-acct', scope: 'project', provider: 'elevenlabs',
      accountRef: 'elevenlabs:acct-b',
      referenceRange: range, secret: 'el-key-b', signal: new AbortController().signal
    });
    expect(result.cached).toBe(false);
    expect(result.voice.voiceId).toBe('el_acct_b_voice');
    expect(result.voice.accountRef).toBe('elevenlabs:acct-b');
    expect(calls.length).toBeGreaterThan(0);

    // And the MATCHING accountRef now cache-hits its own record.
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('matching accountRef should cache-hit'); });
    const hitA = await cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-acct', scope: 'project', provider: 'elevenlabs',
      accountRef: 'elevenlabs:acct-a',
      referenceRange: range, secret: 'el-key-a', signal: new AbortController().signal
    });
    expect(hitA.cached).toBe(true);
    expect(hitA.voice.voiceId).toBe('el_acct_a_voice');
  }, 60_000);

  it('legacy record WITHOUT accountRef still hits an account-tagged request (no orphaning)', async () => {
    const range = { clipId: 'clip_001', start: 4, end: 9 };
    // Legacy/unscoped record: no accountRef field at all.
    upsertVoice({
      ...settingsInput,
      voice: {
        id: 'voice-unscoped', name: 'unscoped', provider: 'cartesia', voiceId: 'cart_unscoped_voice',
        originProjectId: 'proj-unscoped', cloneScope: 'project', sourceAudioRange: range,
        provenance: { method: 'ivc', createdBy: 'clone-route' }
      }
    });
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('legacy unscoped record must match any account'); });
    const hit = await cloneCleanClip(workspace, {
      ...settingsInput, projectId: 'proj-unscoped', scope: 'project', provider: 'cartesia',
      accountRef: 'cartesia:some-new-account',
      referenceRange: range, secret: 'cart-key', signal: new AbortController().signal
    });
    expect(hit.cached).toBe(true);
    expect(hit.voice.voiceId).toBe('cart_unscoped_voice');
  }, 60_000);
});
