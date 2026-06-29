import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProviderRequests } from '../providerRequests';
import { SettingsError, setDefaultProvider, setProviderSecret, upsertProvider } from '../providerSettings';
import { synthesizeSpeech } from '../tts';
import { getProvider, listProviders, providerErrorEnvelope, ProviderExecutionError, runProvider, type MediaProvider } from '../providers';

const originalFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function tempRoot() { return mkdtempSync(join(tmpdir(), 'etvs-provider-framework-')); }

function sampleInputFor(id: string): any {
  if (id.startsWith('tts.')) return { text: 'hello', voice: 'eve', language: 'en' };
  if (id === 'stt.mock') return { text: 'hello world', durationSec: 2 };
  if (id === 'stt.openai-whisper') return { audioPath: '/tmp/audio.wav', audioRel: 'media/extracted-audio.wav', durationSec: 60 };
  if (id === 'stt.homelab-whisper') return { audioPath: '/tmp/audio.wav', audioRel: 'media/extracted-audio.wav', durationSec: 2 };
  if (id === 'stt.elevenlabs') return { audioPath: '/tmp/audio.wav', audioRel: 'media/extracted-audio.wav', durationSec: 60 };
  if (id === 'stt.cartesia') return { audioPath: '/tmp/audio.wav', audioRel: 'media/extracted-audio.wav', durationSec: 60 };
  if (id.startsWith('studio-sound.')) return { inputPath: '/tmp/audio.wav', profile: 'podcast', filterChainVersion: 0, durationSec: 30 };
  if (id.startsWith('image-gen.')) return { prompt: 'gray square', count: 1 };
  if (id.startsWith('video-gen.')) return { prompt: 'black motion clip', durationSec: 1 };
  if (id.startsWith('music-gen.')) return { prompt: 'short tone', durationMs: 3000 };
  return {};
}

function adapterConforms(adapter: MediaProvider<any, any>, id: string, kind: string) {
  expect(adapter.id).toBe(id);
  expect(adapter.kind).toBe(kind);
  expect(adapter.mode === 'http' || adapter.mode === 'local').toBe(true);
  expect(adapter.id).toMatch(new RegExp(`^${kind}\\.[a-z0-9][a-z0-9-]*$`));
  expect(adapter.estimateCost(sampleInputFor(id), { schemaVersion: 1, id, kind: kind as any, name: id.split('.')[1]!, tier: adapter.tier, enabled: true, default: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })).toHaveProperty('currency');
}

describe('media provider framework', () => {
  it('registers media adapters that conform to id/kind/cost shape', () => {
    expect(listProviders().map((provider) => provider.id)).toEqual(expect.arrayContaining([
      'tts.mock', 'tts.xai', 'tts.elevenlabs', 'tts.cartesia',
      'stt.mock', 'stt.homelab-whisper', 'stt.openai-whisper', 'stt.elevenlabs', 'stt.cartesia',
      'studio-sound.ffmpeg-local', 'studio-sound.adobe-enhance', 'studio-sound.elevenlabs-isolation',
      'image-gen.mock', 'image-gen.xai', 'video-gen.mock', 'video-gen.xai', 'music-gen.mock', 'music-gen.elevenlabs'
    ]));
    adapterConforms(getProvider('tts.mock')!, 'tts.mock', 'tts');
    adapterConforms(getProvider('tts.xai')!, 'tts.xai', 'tts');
    adapterConforms(getProvider('tts.elevenlabs')!, 'tts.elevenlabs', 'tts');
    adapterConforms(getProvider('tts.cartesia')!, 'tts.cartesia', 'tts');
    adapterConforms(getProvider('stt.mock')!, 'stt.mock', 'stt');
    adapterConforms(getProvider('stt.homelab-whisper')!, 'stt.homelab-whisper', 'stt');
    adapterConforms(getProvider('stt.openai-whisper')!, 'stt.openai-whisper', 'stt');
    adapterConforms(getProvider('stt.elevenlabs')!, 'stt.elevenlabs', 'stt');
    adapterConforms(getProvider('stt.cartesia')!, 'stt.cartesia', 'stt');
    adapterConforms(getProvider('studio-sound.ffmpeg-local')!, 'studio-sound.ffmpeg-local', 'studio-sound');
    adapterConforms(getProvider('studio-sound.adobe-enhance')!, 'studio-sound.adobe-enhance', 'studio-sound');
    adapterConforms(getProvider('studio-sound.elevenlabs-isolation')!, 'studio-sound.elevenlabs-isolation', 'studio-sound');
    adapterConforms(getProvider('image-gen.mock')!, 'image-gen.mock', 'image-gen');
    adapterConforms(getProvider('image-gen.xai')!, 'image-gen.xai', 'image-gen');
    adapterConforms(getProvider('video-gen.mock')!, 'video-gen.mock', 'video-gen');
    adapterConforms(getProvider('video-gen.xai')!, 'video-gen.xai', 'video-gen');
    adapterConforms(getProvider('music-gen.mock')!, 'music-gen.mock', 'music-gen');
    adapterConforms(getProvider('music-gen.elevenlabs')!, 'music-gen.elevenlabs', 'music-gen');
  });

  it.each([
    ['tts.elevenlabs', ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5']],
    ['tts.cartesia', ['sonic-3-2026-01-12']],
    ['stt.openai-whisper', ['whisper-1']],
    ['stt.elevenlabs', ['scribe_v2', 'scribe_v1']],
    ['stt.cartesia', ['ink-whisper']],
    ['image-gen.xai', ['grok-imagine-image', 'grok-imagine-image-quality']],
    ['video-gen.xai', ['grok-imagine-video']],
    ['music-gen.elevenlabs', ['music_v1']]
  ])('exposes static availableModels for %s', (id, models) => {
    expect(getProvider(id)?.availableModels).toEqual(models);
  });

  it('writes started and succeeded generic ledger rows for mock TTS without domain writes in runProvider', async () => {
    const root = tempRoot();
    try {
      const envelope = await runProvider({ workspacePath: root, kind: 'tts', providerId: 'mock', requestType: 'tts', input: { text: 'hello', voice: 'eve', language: 'en' } });
      expect(envelope.ok).toBe(true);
      const events = readProviderRequests(root);
      expect(events.map((event) => event.status)).toEqual(['started', 'succeeded']);
      expect(events.every((event) => 'type' in event && event.type === 'tts')).toBe(true);
      expect(events.every((event) => 'cost' in event && event.cost.currency === 'USD')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('writes compact output descriptors for successful mock TTS ledger rows instead of byte-expanded audio', async () => {
    const root = tempRoot();
    try {
      const text = 'long mock clip '.repeat(400);
      const envelope = await runProvider({ workspacePath: root, kind: 'tts', providerId: 'mock', requestType: 'tts', input: { text, voice: 'eve', language: 'en' } });
      expect(envelope.ok).toBe(true);
      const outputAudioBytes = envelope.ok && envelope.output && typeof envelope.output === 'object' && 'audio' in envelope.output && Buffer.isBuffer(envelope.output.audio)
        ? envelope.output.audio.byteLength
        : 0;
      expect(outputAudioBytes).toBeGreaterThan(300_000);

      const ledgerPath = join(root, 'logs/provider-requests.jsonl');
      expect(statSync(ledgerPath).size).toBeLessThan(20_000);

      const succeeded = readProviderRequests(root).find((event) => 'type' in event && event.status === 'succeeded');
      expect(succeeded).toBeTruthy();
      const output = (succeeded as { output?: Record<string, unknown> }).output;
      const audio = output?.audio as Record<string, unknown> | undefined;
      expect(audio).toMatchObject({ type: 'Buffer', bytes: outputAudioBytes });
      expect(typeof audio?.bytes).toBe('number');
      expect(audio).not.toHaveProperty('0');
      expect(output?.mimeType).toBe('audio/wav');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('maps provider failures to redacted actionable envelopes and failed ledger rows', async () => {
    const root = tempRoot();
    try {
      // homeDir pinned to root so the engine reads secrets from the isolated tempRoot,
      // not $HOME/.etvs. Without this, the test silently picks up any real xai key
      // the developer has configured and the auth-failed branch never runs.
      const envelope = await runProvider({ homeDir: root, workspacePath: root, kind: 'tts', providerId: 'xai', requestType: 'tts', input: { text: 'secret Bearer abc123', voice: 'eve', language: 'en' }, env: {} });
      expect(envelope.ok).toBe(false);
      if (envelope.ok === false) {
        expect(envelope.error.code).toBe('provider_auth_failed');
        expect(envelope.error.problem).toBeTruthy();
        expect(envelope.error.cause).toBeTruthy();
        expect(envelope.error.fix).toBeTruthy();
        expect(JSON.stringify(envelope.error)).not.toContain('abc123');
      }
      expect(readProviderRequests(root).map((event) => event.status)).toEqual(['started', 'failed']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects an explicitly selected disabled provider before adapter execution or ledger writes', async () => {
    const root = tempRoot();
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    (globalThis as any).fetch = Object.assign(async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    }, { mock: true });
    try {
      upsertProvider({ homeDir: root, provider: { id: 'tts.xai', kind: 'tts', name: 'xai', tier: 'paid', enabled: false, default: false, secretRef: 'xai-test' } });
      setProviderSecret({ homeDir: root, secretRef: 'xai-test', value: 'test-xai-key' });
      const envelope = await runProvider({ homeDir: root, workspacePath: root, kind: 'tts', providerId: 'xai', requestType: 'tts', input: { text: 'disabled explicit', voice: 'eve', language: 'en' }, env: {} });
      expect(envelope.ok).toBe(false);
      if (envelope.ok === false) {
        expect(envelope.providerId).toBe('tts.xai');
        expect(envelope.error.code).toBe('provider_disabled');
        expect(envelope.error.problem).toBe('Provider is disabled.');
        expect(envelope.error.fix).toBe('Enable the provider in Settings, or select another provider.');
      }
      expect(fetchCalls).toBe(0);
      expect(readProviderRequests(root)).toEqual([]);
    } finally {
      (globalThis as any).fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps synthesizeSpeech as the typed public TTS API that owns asset writes', async () => {
    const root = tempRoot();
    try {
      const result = await synthesizeSpeech(root, { text: 'hello world', provider: 'mock', voice: 'eve' });
      expect(result.asset).toMatch(/^assets\/voice\/patch-/);
      expect(readFileSync(join(root, result.asset)).subarray(0, 4).toString()).toBe('RIFF');
      expect(result.providerRequestId).toMatch(/^provider_/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });


  it('resolves synthesizeSpeech through the configured TTS default when no provider is passed', async () => {
    const root = tempRoot();
    try {
      upsertProvider({ homeDir: root, provider: { id: 'tts.xai', kind: 'tts', name: 'xai', tier: 'paid', enabled: true, default: false, secretRef: 'xai-test' } });
      setProviderSecret({ homeDir: root, secretRef: 'xai-test', value: 'test-xai-key' });
      setDefaultProvider({ homeDir: root, kind: 'tts', id: 'tts.xai', acknowledgePaid: true });
      const audio = Buffer.from('RIFF0000WAVE');
      const originalFetch = globalThis.fetch;
      (globalThis as any).fetch = Object.assign(async () => ({ ok: true, status: 201, arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) }), { mock: true });
      try {
        const result = await synthesizeSpeech(root, { text: 'hello default', voice: 'eve', homeDir: root });
        expect(result.provider).toBe('xai');
        const requests = readProviderRequests(root);
        expect(requests.map((event) => event.provider)).toEqual(['tts.xai', 'tts.xai']);
        expect(requests.at(-1)).toMatchObject({ status: 'succeeded', providerStatus: 201 });
      } finally {
        (globalThis as any).fetch = originalFetch;
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('maps SettingsError codes into actionable provider envelopes', () => {
    const cases = [
      ['auth_failed', 'provider_auth_failed'],
      ['provider_unreachable', 'provider_unavailable'],
      ['tls_failed', 'provider_unavailable'],
      ['invalid_base_url', 'provider_bad_request']
    ] as const;
    for (const [settingsCode, providerCode] of cases) {
      const envelope = providerErrorEnvelope(new SettingsError(settingsCode, `settings failed: ${settingsCode}`), { providerId: 'tts.xai', requestId: 'req_12345678' });
      expect(envelope.code).toBe(providerCode);
      expect(envelope.providerId).toBe('tts.xai');
      expect(envelope.requestId).toBe('req_12345678');
      expect(envelope.fix).toBeTruthy();
    }
  });

  it('classifies HTTP provider status failures with statusCode/requestId/providerId', () => {
    const envelope = providerErrorEnvelope(new ProviderExecutionError('xAI TTS failed: 503 provider down', { providerStatus: 503 }), { providerId: 'tts.xai', requestId: 'req_12345678' });
    expect(envelope.code).toBe('provider_unavailable');
    expect(envelope.providerId).toBe('tts.xai');
    expect(envelope.requestId).toBe('req_12345678');
    expect(envelope.statusCode).toBe(503);
  });

  it('runs xAI image generation with bearer auth and decodes b64 media', async () => {
    const root = tempRoot();
    try {
      upsertProvider({ homeDir: root, provider: { id: 'image-gen.xai', kind: 'image-gen', name: 'xai', tier: 'paid', enabled: true, default: false, secretRef: 'xai-test' } });
      setProviderSecret({ homeDir: root, secretRef: 'xai-test', value: 'secret-xai' });
      const bytes = Buffer.from('image-bytes');
      const calls: any[] = [];
      (globalThis as any).fetch = Object.assign(async (_url: string, init: any) => {
        calls.push(init);
        return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: bytes.toString('base64') }] }), text: async () => '' };
      }, { mock: true });
      const envelope = await runProvider({ homeDir: root, workspacePath: root, kind: 'image-gen', providerId: 'xai', requestType: 'image-gen', input: { prompt: 'gray square', count: 1 }, env: {} });
      expect(envelope.ok).toBe(true);
      if (envelope.ok) expect((envelope.output as any).media.equals(bytes)).toBe(true);
      expect(calls[0].headers.Authorization).toBe('Bearer secret-xai');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('runs xAI video generation through pending/done polling and errors on failed polls', async () => {
    const provider = getProvider('video-gen.xai')!;
    const downloaded = Buffer.from('mp4-bytes');
    const urls: string[] = [];
    const guardedFetch = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith('/generations')) return { ok: true, status: 200, json: async () => ({ request_id: 'video_req_1' }), text: async () => '' } as any;
      if (url.endsWith('/video_req_1') && urls.filter((item) => item.endsWith('/video_req_1')).length === 1) return { ok: true, status: 200, json: async () => ({ status: 'pending' }), text: async () => '' } as any;
      if (url.endsWith('/video_req_1')) return { ok: true, status: 200, json: async () => ({ status: 'done', video: { url: 'https://cdn.x.ai/video.mp4', duration: 4 } }), text: async () => '' } as any;
      return { ok: true, status: 200, arrayBuffer: async () => downloaded.buffer.slice(downloaded.byteOffset, downloaded.byteOffset + downloaded.byteLength), text: async () => '' } as any;
    });
    vi.useFakeTimers();
    const providerRecord = { schemaVersion: 1 as const, id: 'video-gen.xai', kind: 'video-gen' as const, name: 'xai', tier: 'paid' as const, enabled: true, default: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const run = provider.run({ prompt: 'moving square', durationSec: 4 }, { provider: providerRecord, requestId: 'provider_video', signal: new AbortController().signal, secret: 'secret-xai', guardedFetch } as any);
    await vi.advanceTimersByTimeAsync(5000);
    const output = await run;
    expect((output as any).media.equals(downloaded)).toBe(true);

    const failedFetch = vi.fn(async (url: string) => url.endsWith('/generations')
      ? { ok: true, status: 200, json: async () => ({ request_id: 'video_req_failed' }), text: async () => '' } as any
      : { ok: true, status: 200, json: async () => ({ status: 'failed', error: { message: 'render failed' } }), text: async () => '' } as any);
    await expect(provider.run({ prompt: 'bad video' }, { provider: providerRecord, requestId: 'provider_video_failed', signal: new AbortController().signal, secret: 'secret-xai', guardedFetch: failedFetch } as any)).rejects.toThrow(/render failed/);
  });

  it('runs ElevenLabs music with xi-api-key auth and returns audio bytes', async () => {
    const root = tempRoot();
    try {
      upsertProvider({ homeDir: root, provider: { id: 'music-gen.elevenlabs', kind: 'music-gen', name: 'elevenlabs', tier: 'paid', enabled: true, default: false, secretRef: 'eleven-test' } });
      setProviderSecret({ homeDir: root, secretRef: 'eleven-test', value: 'secret-eleven' });
      const audio = Buffer.from('mp3-bytes');
      const calls: any[] = [];
      (globalThis as any).fetch = Object.assign(async (_url: string, init: any) => {
        calls.push(init);
        return { ok: true, status: 200, arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength), text: async () => '' };
      }, { mock: true });
      const envelope = await runProvider({ homeDir: root, workspacePath: root, kind: 'music-gen', providerId: 'elevenlabs', requestType: 'music-gen', input: { prompt: 'warm bed', durationMs: 3000 }, env: {} });
      expect(envelope.ok).toBe(true);
      if (envelope.ok) expect((envelope.output as any).media.equals(audio)).toBe(true);
      expect(calls[0].headers['xi-api-key']).toBe('secret-eleven');
      expect(calls[0].headers.Authorization).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['image-gen', 'xai'],
    ['video-gen', 'xai'],
    ['music-gen', 'elevenlabs']
  ] as const)('maps missing %s.%s secrets to provider_auth_failed', async (kind, name) => {
    const root = tempRoot();
    try {
      upsertProvider({ homeDir: root, provider: { id: `${kind}.${name}`, kind, name, tier: 'paid', enabled: true, default: false, secretRef: `${name}-missing` } });
      const envelope = await runProvider({ homeDir: root, workspacePath: root, kind, providerId: name, requestType: kind, input: sampleInputFor(`${kind}.${name}`), env: {} });
      expect(envelope.ok).toBe(false);
      if (envelope.ok === false) expect(envelope.error.code).toBe('provider_auth_failed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
