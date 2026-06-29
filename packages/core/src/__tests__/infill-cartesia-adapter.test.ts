import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProvider } from '../providers';
import type { InfillInput, InfillOutput } from '../providers/infill/cartesia';

// Minimal but valid WAV container: 'RIFF' at byte 0, 'WAVE' at byte 8 — what the adapter's
// degraded-payload guard checks for before accepting a 200 body as audio.
function wav(extra = 'data............'): Buffer {
  return Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WAVE'), Buffer.from(extra)]);
}

function wavResponse(buf: Buffer, status = 200): Response {
  return new Response(Uint8Array.from(buf), { status });
}

function providerRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    id: 'infill.cartesia',
    kind: 'infill' as const,
    name: 'cartesia',
    tier: 'paid' as const,
    enabled: true,
    default: false,
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    ...overrides
  };
}

function ctx(secret: string | undefined, guardedFetch: any, provider = providerRecord()) {
  return { provider, requestId: 'provider_infill_test', signal: new AbortController().signal, secret, guardedFetch };
}

// ---- temp WAV file helpers ----
let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `etvs-infill-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmpWav(name: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, wav('test-audio-data'));
  return path;
}

// ---- helpers to inspect multipart fields ----

/**
 * Collect all FormData entries from a guardedFetch call's `body` option.
 * Returns a Map of field name → value (string or File/Blob info).
 */
async function collectFormFields(body: FormData): Promise<Map<string, { isBlob: boolean; fileName?: string; value: string }>> {
  const result = new Map<string, { isBlob: boolean; fileName?: string; value: string }>();
  for (const [key, val] of (body as any).entries()) {
    if (typeof val === 'string') {
      result.set(key, { isBlob: false, value: val });
    } else {
      // File / Blob
      result.set(key, { isBlob: true, fileName: (val as any).name, value: '[blob]' });
    }
  }
  return result;
}

describe('infill.cartesia adapter', () => {
  it('is registered and accessible via getProvider', () => {
    const adapter = getProvider('infill.cartesia');
    expect(adapter).toBeDefined();
    expect(adapter?.id).toBe('infill.cartesia');
    expect(adapter?.kind).toBe('infill');
    expect(adapter?.tier).toBe('paid');
    expect(adapter?.mode).toBe('http');
  });

  it('POSTs /infill/bytes with Bearer + Cartesia-Version, multipart body, dated model, returning wav bytes', async () => {
    const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
    const audio = wav('infill-payload-bytes');
    const leftPath = writeTmpWav('left.wav');
    const rightPath = writeTmpWav('right.wav');

    const calls: Array<{ url: string; opts: any }> = [];
    const guardedFetch = vi.fn(async (url: string, opts: any) => {
      calls.push({ url, opts });
      return wavResponse(audio);
    });

    const out = await adapter.run(
      { leftAudioPath: leftPath, rightAudioPath: rightPath, transcript: 'Hello world', voiceId: 'voice-uuid-abc', language: 'en' },
      ctx('sk_car_test', guardedFetch)
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.cartesia.ai/infill/bytes');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer sk_car_test');
    expect(calls[0].opts.headers['Cartesia-Version']).toBe('2026-03-01');

    // Must NOT set Content-Type manually (FormData sets boundary automatically)
    expect(calls[0].opts.headers['Content-Type']).toBeUndefined();

    // body must be a FormData instance
    expect(calls[0].opts.body).toBeInstanceOf(FormData);

    // Inspect the multipart fields
    const fields = await collectFormFields(calls[0].opts.body);

    expect(fields.has('left_audio')).toBe(true);
    expect(fields.get('left_audio')?.isBlob).toBe(true);
    expect(fields.get('left_audio')?.fileName).toBe('left.wav');

    expect(fields.has('right_audio')).toBe(true);
    expect(fields.get('right_audio')?.isBlob).toBe(true);
    expect(fields.get('right_audio')?.fileName).toBe('right.wav');

    expect(fields.get('transcript')?.value).toBe('Hello world');
    expect(fields.get('model_id')?.value).toBe('sonic-3-2026-01-12');
    expect(fields.get('language')?.value).toBe('en');
    expect(fields.get('voice_id')?.value).toBe('voice-uuid-abc');

    expect(fields.get('output_format[container]')?.value).toBe('wav');
    expect(fields.get('output_format[sample_rate]')?.value).toBe('48000');
    expect(fields.get('output_format[encoding]')?.value).toBe('pcm_s16le');

    expect(out.mimeType).toBe('audio/wav');
    expect(Buffer.isBuffer(out.audio)).toBe(true);
    expect(out.audio.equals(audio)).toBe(true);
    expect(out.providerStatus).toBe(200);
  });

  it('omits voice_id field entirely when voiceId is not supplied (enforcement is upstream)', async () => {
    const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
    const leftPath = writeTmpWav('left.wav');
    const calls: Array<{ url: string; opts: any }> = [];
    const guardedFetch = vi.fn(async (url: string, opts: any) => {
      calls.push({ url, opts });
      return wavResponse(wav());
    });

    // No voiceId provided — the thin adapter omits the field (synthesizeInfillSpeech enforces presence)
    await adapter.run(
      { leftAudioPath: leftPath, transcript: 'Replace me', language: 'en' },
      ctx('sk', guardedFetch)
    );

    const fields = await collectFormFields(calls[0].opts.body);
    expect(fields.has('voice_id')).toBe(false);
    expect(fields.has('transcript')).toBe(true);
    expect(fields.has('left_audio')).toBe(true);
    expect(fields.has('right_audio')).toBe(false);
  });

  it('includes voice_id when voiceId is supplied and omits it when it is not (one case each)', async () => {
    const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
    const leftPath = writeTmpWav('left2.wav');

    // Case 1: voiceId present
    const callsWith: Array<{ url: string; opts: any }> = [];
    const fetchWith = vi.fn(async (url: string, opts: any) => { callsWith.push({ url, opts }); return wavResponse(wav()); });
    await adapter.run({ leftAudioPath: leftPath, transcript: 'x', voiceId: 'my-voice-id', language: 'en' }, ctx('sk', fetchWith));
    const fieldsWith = await collectFormFields(callsWith[0].opts.body);
    expect(fieldsWith.get('voice_id')?.value).toBe('my-voice-id');

    // Case 2: voiceId absent
    const callsWithout: Array<{ url: string; opts: any }> = [];
    const fetchWithout = vi.fn(async (url: string, opts: any) => { callsWithout.push({ url, opts }); return wavResponse(wav()); });
    await adapter.run({ leftAudioPath: leftPath, transcript: 'x', language: 'en' }, ctx('sk', fetchWithout));
    const fieldsWithout = await collectFormFields(callsWithout[0].opts.body);
    expect(fieldsWithout.has('voice_id')).toBe(false);
  });

  it('uses globalThis.FormData (not a foreign FormData class)', async () => {
    const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
    const leftPath = writeTmpWav('left3.wav');
    let capturedBody: unknown;
    const guardedFetch = vi.fn(async (_url: string, opts: any) => {
      capturedBody = opts.body;
      return wavResponse(wav());
    });
    await adapter.run({ leftAudioPath: leftPath, transcript: 'test', language: 'en' }, ctx('sk', guardedFetch));
    expect(capturedBody).toBeInstanceOf(globalThis.FormData);
  });

  it('does not set Content-Type header manually', async () => {
    const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
    const leftPath = writeTmpWav('left4.wav');
    let capturedHeaders: Record<string, string> = {};
    const guardedFetch = vi.fn(async (_url: string, opts: any) => {
      capturedHeaders = opts.headers;
      return wavResponse(wav());
    });
    await adapter.run({ leftAudioPath: leftPath, transcript: 'test', language: 'en' }, ctx('sk', guardedFetch));
    expect(capturedHeaders['Content-Type']).toBeUndefined();
    expect(capturedHeaders['content-type']).toBeUndefined();
  });

  describe('dated-model guard', () => {
    it('uses the default pinned model when no model is specified', async () => {
      const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
      const leftPath = writeTmpWav('lm1.wav');
      const calls: any[] = [];
      const guardedFetch = vi.fn(async (_url: string, opts: any) => { calls.push(opts); return wavResponse(wav()); });
      await adapter.run({ leftAudioPath: leftPath, transcript: 'x', language: 'en' }, ctx('sk', guardedFetch));
      const fields = await collectFormFields(calls[0].body);
      expect(fields.get('model_id')?.value).toBe('sonic-3-2026-01-12');
    });

    it('allows a future dated checkpoint override', async () => {
      const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
      const leftPath = writeTmpWav('lm2.wav');
      const calls: any[] = [];
      const guardedFetch = vi.fn(async (_url: string, opts: any) => { calls.push(opts); return wavResponse(wav()); });
      await adapter.run({ leftAudioPath: leftPath, transcript: 'x', language: 'en', model: 'sonic-3-2026-07-15' }, ctx('sk', guardedFetch));
      const fields = await collectFormFields(calls[0].body);
      expect(fields.get('model_id')?.value).toBe('sonic-3-2026-07-15');
    });

    it('rejects sonic-3-latest (floating alias) with provider_bad_request before any fetch', async () => {
      const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
      const leftPath = writeTmpWav('lm3.wav');
      const noFetch = vi.fn();
      await expect(
        adapter.run({ leftAudioPath: leftPath, transcript: 'x', language: 'en', model: 'sonic-3-latest' }, ctx('sk', noFetch))
      ).rejects.toMatchObject({ code: 'provider_bad_request' });
      expect(noFetch).not.toHaveBeenCalled();
    });

    it('rejects an undated alias (bare sonic-3) with provider_bad_request before any fetch', async () => {
      const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
      const leftPath = writeTmpWav('lm4.wav');
      const noFetch = vi.fn();
      await expect(
        adapter.run({ leftAudioPath: leftPath, transcript: 'x', language: 'en', model: 'sonic-3' }, ctx('sk', noFetch))
      ).rejects.toMatchObject({ code: 'provider_bad_request' });
      expect(noFetch).not.toHaveBeenCalled();
    });

    it('rejects a floating model from the provider record before any fetch', async () => {
      const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
      const leftPath = writeTmpWav('lm5.wav');
      const noFetch = vi.fn();
      await expect(
        adapter.run(
          { leftAudioPath: leftPath, transcript: 'x', language: 'en' },
          ctx('sk', noFetch, providerRecord({ model: 'sonic-3-latest' }))
        )
      ).rejects.toMatchObject({ code: 'provider_bad_request' });
      expect(noFetch).not.toHaveBeenCalled();
    });
  });

  it('throws provider_bad_request before any fetch when neither left nor right audio is provided', async () => {
    const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
    const noFetch = vi.fn();
    await expect(
      adapter.run({ transcript: 'Hello', language: 'en' }, ctx('sk', noFetch))
    ).rejects.toMatchObject({ code: 'provider_bad_request' });
    expect(noFetch).not.toHaveBeenCalled();
  });

  it('throws provider_auth_failed without a secret and makes no network call', async () => {
    const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
    const leftPath = writeTmpWav('auth.wav');
    const noFetch = vi.fn();
    await expect(
      adapter.run({ leftAudioPath: leftPath, transcript: 'x', language: 'en' }, ctx(undefined, noFetch))
    ).rejects.toMatchObject({ code: 'provider_auth_failed' });
    expect(noFetch).not.toHaveBeenCalled();
  });

  it('surfaces a non-2xx with a bounded error body', async () => {
    const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
    const leftPath = writeTmpWav('err.wav');
    const guardedFetch = vi.fn(async () => new Response('e'.repeat(9000), { status: 400 }));
    await expect(
      adapter.run({ leftAudioPath: leftPath, transcript: 'x', language: 'en' }, ctx('sk', guardedFetch))
    ).rejects.toThrow(/Cartesia infill failed with HTTP 400/);
  });

  it('classifies a 401 response as auth-failure via providerStatus', async () => {
    const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
    const leftPath = writeTmpWav('auth401.wav');
    const guardedFetch = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
    await expect(
      adapter.run({ leftAudioPath: leftPath, transcript: 'x', language: 'en' }, ctx('sk', guardedFetch))
    ).rejects.toMatchObject({ providerStatus: 401 });
  });

  describe('degraded-payload defense', () => {
    it('rejects a 200 whose body is empty (no RIFF/WAVE) as provider_bad_request', async () => {
      const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
      const leftPath = writeTmpWav('deg1.wav');
      const guardedFetch = vi.fn(async () => new Response(new Uint8Array(0), { status: 200 }));
      await expect(
        adapter.run({ leftAudioPath: leftPath, transcript: 'x', language: 'en' }, ctx('sk', guardedFetch))
      ).rejects.toThrow(/did not return a WAV payload/);
    });

    it('rejects a 200 whose body is a JSON error payload (not RIFF/WAVE) as provider_bad_request', async () => {
      const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
      const leftPath = writeTmpWav('deg2.wav');
      // This is the dangerous case: a 200 with an error-JSON body must NOT be persisted as .wav.
      // The throw must use code:'provider_bad_request' (not rely on providerStatus=200 alone)
      // because engine.ts only uses `code` when providerStatus is absent.
      const guardedFetch = vi.fn(async () => new Response('{"error":"quota exceeded"}', { status: 200 }));
      await expect(
        adapter.run({ leftAudioPath: leftPath, transcript: 'x', language: 'en' }, ctx('sk', guardedFetch))
      ).rejects.toMatchObject({ code: 'provider_bad_request' });
    });
  });

  it('estimates cost in CREDITS (not USD) at 1 credit/char + 300 fixed', () => {
    const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
    const est = adapter.estimateCost({ transcript: 'hello', leftAudioPath: '/some/path.wav', language: 'en' }, providerRecord());
    expect(est.currency).toBe('CREDITS');
    // 5 chars + 300 fixed = 305
    expect(est.estimated).toBe(305);
    expect(est.actual).toBeNull();

    // Longer transcript
    const est2 = adapter.estimateCost({ transcript: 'a'.repeat(100), language: 'en' }, providerRecord());
    expect(est2.estimated).toBe(400); // 100 + 300
  });

  it('ledgerInput redacts audio paths and records only metadata', () => {
    const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
    const rec = adapter.ledgerInput({
      leftAudioPath: '/workspace/project/media/ref-48k.wav',
      rightAudioPath: '/workspace/project/media/ref-48k-right.wav',
      transcript: 'Replace this word',
      voiceId: 'voice-abc',
      language: 'en',
      model: 'sonic-3-2026-01-12'
    });
    // Must NOT contain the absolute paths
    expect(JSON.stringify(rec)).not.toContain('/workspace');
    expect(JSON.stringify(rec)).not.toContain('leftAudioPath');
    expect(JSON.stringify(rec)).not.toContain('rightAudioPath');
    // Must contain safe metadata
    expect(rec).toMatchObject({
      transcriptLength: 17,
      hasVoiceId: true,
      hasLeft: true,
      hasRight: true,
      language: 'en',
      model: 'sonic-3-2026-01-12'
    });
  });

  it('ledgerInput records hasVoiceId:false when voiceId is absent', () => {
    const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
    const rec = adapter.ledgerInput({ leftAudioPath: '/x.wav', transcript: 'hi', language: 'en' });
    expect(rec.hasVoiceId).toBe(false);
  });

  it('ledgerOutput records audio byteLength and providerStatus, never the raw buffer', () => {
    const adapter = getProvider<InfillInput, InfillOutput>('infill.cartesia')! as any;
    const audio = wav('some-data');
    const rec = adapter.ledgerOutput({ audio, mimeType: 'audio/wav', providerStatus: 200 });
    expect(rec).toMatchObject({ audioBytes: audio.byteLength, mimeType: 'audio/wav', providerStatus: 200 });
    // Raw buffer must not be present
    expect(JSON.stringify(rec)).not.toContain('"data"');
    expect(Buffer.isBuffer((rec as any).audio)).toBe(false);
  });
});
