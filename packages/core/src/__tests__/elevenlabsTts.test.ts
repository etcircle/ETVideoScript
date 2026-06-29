import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProvider, ProviderExecutionError, runProvider } from '../providers';
import { cloneElevenLabsVoice } from '../providers/tts/elevenlabs';
import { setProviderSecret, upsertProvider, type ProviderRecord } from '../providerSettings';

const originalFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
  vi.restoreAllMocks();
});

function tempRoot() { return mkdtempSync(join(tmpdir(), 'etvs-elevenlabs-tts-')); }

function record(costPerUnit?: ProviderRecord['costPerUnit']): ProviderRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: 'tts.elevenlabs',
    kind: 'tts',
    name: 'elevenlabs',
    tier: 'paid',
    enabled: true,
    default: false,
    createdAt: now,
    updatedAt: now,
    ...(costPerUnit ? { costPerUnit } : {})
  };
}

function configure(root: string, costPerUnit?: ProviderRecord['costPerUnit']) {
  upsertProvider({ homeDir: root, provider: { ...record(costPerUnit), secretRef: 'elevenlabs-test' } });
  setProviderSecret({ homeDir: root, secretRef: 'elevenlabs-test', value: 'test-elevenlabs-key' });
}

async function runTts(root: string, input: Record<string, unknown>) {
  return runProvider({
    homeDir: root,
    workspacePath: root,
    kind: 'tts',
    providerId: 'elevenlabs',
    requestType: 'tts',
    input,
    env: {}
  });
}

describe('ElevenLabs TTS provider', () => {
  it('posts text to ElevenLabs and wraps returned PCM as WAV', async () => {
    const root = tempRoot();
    const calls: Array<{ url: string; init: any }> = [];
    (globalThis as any).fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(new Uint8Array(32), { status: 200 });
    });
    try {
      configure(root);
      const envelope = await runTts(root, { text: 'hello', voice: 'voice_123' });
      expect(envelope.ok).toBe(true);
      expect(calls[0]!.url).toMatch(/\/v1\/text-to-speech\/voice_123\?output_format=pcm_24000$/);
      expect(new Headers(calls[0]!.init.headers).get('xi-api-key')).toBe('test-elevenlabs-key');
      expect(new Headers(calls[0]!.init.headers).get('accept')).toBe('audio/basic');
      expect(JSON.parse(calls[0]!.init.body)).toMatchObject({ text: 'hello', model_id: 'eleven_multilingual_v2' });
      if (envelope.ok) {
        const output = envelope.output as { audio: Buffer; mimeType: string };
        expect(output.mimeType).toBe('audio/wav');
        expect(output.audio.subarray(0, 4).toString()).toBe('RIFF');
        expect(output.audio.subarray(8, 12).toString()).toBe('WAVE');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('passes a requested ElevenLabs model override', async () => {
    const root = tempRoot();
    let body: any;
    (globalThis as any).fetch = vi.fn(async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response(new Uint8Array(2), { status: 200 });
    });
    try {
      configure(root);
      const envelope = await runTts(root, { text: 'hello', voice: 'eve', model: 'eleven_turbo_v2_5' });
      expect(envelope.ok).toBe(true);
      expect(body.model_id).toBe('eleven_turbo_v2_5');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('includes language_code only when a language is supplied', async () => {
    const root = tempRoot();
    const bodies: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(new Uint8Array(2), { status: 200 });
    });
    try {
      configure(root);
      expect((await runTts(root, { text: 'hello', voice: 'eve' })).ok).toBe(true);
      expect((await runTts(root, { text: 'hello', voice: 'eve', language: 'en' })).ok).toBe(true);
      expect(bodies[0]).not.toHaveProperty('language_code');
      expect(bodies[1]).toHaveProperty('language_code', 'en');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails before fetch when no ElevenLabs secret is configured', async () => {
    const root = tempRoot();
    const fetchImpl = vi.fn();
    (globalThis as any).fetch = fetchImpl;
    try {
      const envelope = await runTts(root, { text: 'hello', voice: 'eve', language: 'en' });
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) expect(envelope.error.code).toBe('provider_auth_failed');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('surfaces ElevenLabs HTTP failures with status and bounded body', async () => {
    const root = tempRoot();
    (globalThis as any).fetch = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    try {
      configure(root);
      const envelope = await runTts(root, { text: 'hello', voice: 'eve', language: 'en' });
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) {
        expect(envelope.error.statusCode).toBe(401);
        expect(envelope.error.message).toContain('unauthorized');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('estimates ElevenLabs TTS cost at the multilingual_v2 per-character rate by default', () => {
    const adapter = getProvider('tts.elevenlabs')!;
    expect(adapter.estimateCost({ text: 'a'.repeat(1000), voice: 'eve', language: 'en' } as any, record()))
      .toMatchObject({ currency: 'USD', estimated: 0.1, actual: null });
  });

  it('estimates ElevenLabs TTS cost at the flash/turbo rate when those models are selected', () => {
    const adapter = getProvider('tts.elevenlabs')!;
    const input = { text: 'a'.repeat(1000), voice: 'eve', language: 'en', model: 'eleven_turbo_v2_5' } as any;
    expect(adapter.estimateCost(input, record())).toMatchObject({ estimated: 0.05, actual: null });
    expect(adapter.actualCost!({ audio: Buffer.alloc(0), mimeType: 'audio/wav' } as any, input, record()))
      .toMatchObject({ estimated: 0.05, actual: 0.05 });
  });

  it('uses provider cost overrides for estimate and actual cost', () => {
    const adapter = getProvider('tts.elevenlabs')!;
    const provider = record({ currency: 'USD', unit: 'request', amount: 0.05 });
    const input = { text: 'a'.repeat(1000), voice: 'eve', language: 'en' } as any;
    expect(adapter.estimateCost(input, provider)).toMatchObject({ estimated: 0.05, actual: null });
    expect(adapter.actualCost!({ audio: Buffer.alloc(0), mimeType: 'audio/wav' } as any, input, provider))
      .toMatchObject({ estimated: 0.05, actual: 0.05 });
  });
});

describe('cloneElevenLabsVoice', () => {
  it('posts multipart voice samples and returns the cloned voice id', async () => {
    const calls: Array<{ url: string; init: any; request: Request }> = [];
    (globalThis as any).fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init, request: new Request(url, init) });
      return new Response(JSON.stringify({ voice_id: 'el_voice_123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    const result = await cloneElevenLabsVoice({
      name: 'Eve',
      description: 'sample',
      samples: [{ audio: Buffer.from([1, 2, 3]), fileName: 'sample.wav', mimeType: 'audio/wav' }],
      secret: 'test-elevenlabs-key',
      signal: new AbortController().signal
    });
    expect(result).toEqual({ voiceId: 'el_voice_123' });
    expect(calls[0]!.url).toMatch(/\/v1\/voices\/add$/);
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
    expect(calls[0]!.request.headers.get('content-type')).toMatch(/^multipart\/form-data;/);
    expect(new Headers(calls[0]!.init.headers).has('content-type')).toBe(false);
    expect(new Headers(calls[0]!.init.headers).get('xi-api-key')).toBe('test-elevenlabs-key');
  });

  it('actually serializes name and files into the multipart body (undici@7 FormData regression guard)', async () => {
    // npm undici@7 silently drops FormData fields when its fetch is paired with
    // globalThis FormData, surfacing as ElevenLabs HTTP 422 "name missing". This
    // test re-parses the request body to prove BOTH fields land in the wire bytes
    // — a Request().formData() round-trip catches the bug guardedFetch dodges.
    const captured: Array<Request> = [];
    (globalThis as any).fetch = vi.fn(async (url, init) => {
      captured.push(new Request(url, init));
      return new Response(JSON.stringify({ voice_id: 'el_voice_456' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    await cloneElevenLabsVoice({
      name: 'Eve Roundtrip',
      description: 'with description',
      samples: [{ audio: Buffer.from('audio-bytes-here'), fileName: 'roundtrip.wav', mimeType: 'audio/wav' }],
      secret: 'test-key',
      signal: new AbortController().signal
    });
    const parsed = await captured[0]!.formData();
    expect(parsed.get('name')).toBe('Eve Roundtrip');
    expect(parsed.get('description')).toBe('with description');
    const file = parsed.get('files');
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe('roundtrip.wav');
    expect((file as Blob).type).toBe('audio/wav');
    expect(await (file as Blob).text()).toBe('audio-bytes-here');
  });

  it('fails before fetch when cloning without a secret', async () => {
    const fetchImpl = vi.fn();
    (globalThis as any).fetch = fetchImpl;
    await expect(cloneElevenLabsVoice({
      name: 'Eve',
      samples: [{ audio: Buffer.alloc(1), fileName: 'sample.wav', mimeType: 'audio/wav' }],
      secret: '',
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'provider_auth_failed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces clone HTTP failures with status and bounded body', async () => {
    (globalThis as any).fetch = vi.fn(async () => new Response('bad sample', { status: 400 }));
    await expect(cloneElevenLabsVoice({
      name: 'Eve',
      samples: [{ audio: Buffer.alloc(1), fileName: 'sample.wav', mimeType: 'audio/wav' }],
      secret: 'test-elevenlabs-key',
      signal: new AbortController().signal
    })).rejects.toMatchObject({ providerStatus: 400, message: expect.stringContaining('bad sample') });
  });

  it('requires voice_id in successful clone responses', async () => {
    (globalThis as any).fetch = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    await expect(cloneElevenLabsVoice({
      name: 'Eve',
      samples: [{ audio: Buffer.alloc(1), fileName: 'sample.wav', mimeType: 'audio/wav' }],
      secret: 'test-elevenlabs-key',
      signal: new AbortController().signal
    })).rejects.toThrow('missing voice_id');
  });

  it('surfaces malformed clone JSON as a provider error, not a raw SyntaxError', async () => {
    (globalThis as any).fetch = vi.fn(async () => new Response('<html>nginx interstitial</html>', { status: 200 }));
    await expect(cloneElevenLabsVoice({
      name: 'Eve',
      samples: [{ audio: Buffer.alloc(1), fileName: 'sample.wav', mimeType: 'audio/wav' }],
      secret: 'test-elevenlabs-key',
      signal: new AbortController().signal
    })).rejects.toMatchObject({ providerStatus: 200, message: expect.stringContaining('malformed JSON') });
  });
});
