import { describe, expect, it, vi } from 'vitest';
import { getProvider, type TtsInput, type TtsOutput } from '../providers';
import { redactSecrets } from '../providerSettings';

// Minimal but valid WAV container: 'RIFF' at byte 0, 'WAVE' at byte 8 — what the adapter's
// degraded-payload guard checks for before accepting a 200 body as audio.
function wav(extra = 'data............'): Buffer {
  return Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WAVE'), Buffer.from(extra)]);
}

// Response body from a Buffer: pass a Uint8Array view so it is an unambiguous BodyInit
// (a Node Buffer<ArrayBufferLike> doesn't satisfy the DOM BodyInit type under @types/node).
function wavResponse(buf: Buffer, status = 200): Response {
  return new Response(Uint8Array.from(buf), { status });
}

function providerRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    id: 'tts.cartesia',
    kind: 'tts' as const,
    name: 'cartesia',
    tier: 'paid' as const,
    enabled: true,
    default: false,
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
    ...overrides
  };
}

function ctx(secret: string | undefined, guardedFetch: any, provider = providerRecord()) {
  return { provider, requestId: 'provider_tts', signal: new AbortController().signal, secret, guardedFetch };
}

describe('tts.cartesia adapter', () => {
  it('posts /tts/bytes with Bearer + Cartesia-Version, dated model, voice {mode:id}, wav/pcm_s16le, returning wav bytes', async () => {
    const adapter = getProvider<TtsInput, TtsOutput>('tts.cartesia')! as any;
    const audio = wav('payload-bytes');
    const calls: any[] = [];
    const guardedFetch = vi.fn(async (url: string, opts: any) => { calls.push({ url, opts }); return wavResponse(audio); });
    const out = await adapter.run({ text: 'Hello there', voice: 'voice-uuid-123', language: 'en' }, ctx('sk_car_test', guardedFetch));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.cartesia.ai/tts/bytes');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer sk_car_test');
    expect(calls[0].opts.headers['Cartesia-Version']).toBe('2026-03-01');
    const body = JSON.parse(calls[0].opts.body);
    expect(body.model_id).toBe('sonic-3-2026-01-12');
    expect(body.transcript).toBe('Hello there');
    expect(body.voice).toEqual({ mode: 'id', id: 'voice-uuid-123' });
    expect(body.language).toBe('en');
    expect(body.output_format).toEqual({ container: 'wav', sample_rate: 44100, encoding: 'pcm_s16le' });
    expect(out.mimeType).toBe('audio/wav');
    expect(Buffer.isBuffer(out.audio)).toBe(true);
    expect(out.audio.equals(audio)).toBe(true);
    expect(out.providerStatus).toBe(200);
  });

  it('allows a DATED model override but refuses a floating tag like sonic-3-latest', async () => {
    const adapter = getProvider('tts.cartesia')! as any;
    const bodies: any[] = [];
    const guardedFetch = vi.fn(async (_url: string, opts: any) => { bodies.push(JSON.parse(opts.body)); return wavResponse(wav()); });
    // Default is the pinned dated literal.
    await adapter.run({ text: 'x', voice: 'v', language: 'en' }, ctx('s', guardedFetch));
    expect(bodies[0].model_id).toBe('sonic-3-2026-01-12');
    expect(bodies[0].model_id).not.toContain('latest');
    // A future dated checkpoint is allowed.
    await adapter.run({ text: 'x', voice: 'v', language: 'en', model: 'sonic-3-2026-02-02' }, ctx('s', guardedFetch));
    expect(bodies[1].model_id).toBe('sonic-3-2026-02-02');
    // Any non-dated/floating id is refused BEFORE any network call (per-call input OR the record):
    // 'sonic-3-latest', a bare 'sonic-3', etc.
    const floatFetch = vi.fn(async () => wavResponse(wav()));
    for (const bad of ['sonic-3-latest', 'sonic-3', 'sonic-3-preview']) {
      await expect(adapter.run({ text: 'x', voice: 'v', language: 'en', model: bad }, ctx('s', floatFetch)))
        .rejects.toMatchObject({ code: 'provider_bad_request' });
    }
    await expect(adapter.run({ text: 'x', voice: 'v', language: 'en' }, ctx('s', floatFetch, providerRecord({ model: 'sonic-3-latest' }))))
      .rejects.toMatchObject({ code: 'provider_bad_request' });
    expect(floatFetch).not.toHaveBeenCalled();
  });

  it('estimates cost in USD per character and honors a costPerUnit override', () => {
    const adapter = getProvider('tts.cartesia')! as any;
    const est = adapter.estimateCost({ text: 'abcdefghij', voice: 'v', language: 'en' }, providerRecord());
    expect(est.currency).toBe('USD');
    expect(est.estimated).toBeGreaterThan(0);
    const overridden = adapter.estimateCost({ text: 'abcde', voice: 'v', language: 'en' }, providerRecord({ costPerUnit: { currency: 'USD', amount: 0.001 } }));
    expect(overridden.estimated).toBeCloseTo(0.005, 6);
  });

  it('throws provider_auth_failed without a secret and makes no network call', async () => {
    const adapter = getProvider('tts.cartesia')! as any;
    const guardedFetch = vi.fn();
    await expect(adapter.run({ text: 'x', voice: 'v', language: 'en' }, ctx(undefined, guardedFetch)))
      .rejects.toMatchObject({ code: 'provider_auth_failed' });
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it('surfaces a non-2xx with a bounded error body (not the raw unbounded response)', async () => {
    const adapter = getProvider('tts.cartesia')! as any;
    const guardedFetch = vi.fn(async () => new Response('e'.repeat(9000), { status: 400 }));
    await expect(adapter.run({ text: 'x', voice: 'v', language: 'en' }, ctx('s', guardedFetch)))
      .rejects.toThrow(/Cartesia TTS failed with HTTP 400/);
  });

  it('rejects a degraded 200 whose body is not a WAV container (empty body or JSON error), as provider_bad_request', async () => {
    const adapter = getProvider('tts.cartesia')! as any;
    // Empty body (message check).
    await expect(adapter.run({ text: 'x', voice: 'v', language: 'en' }, ctx('s', vi.fn(async () => new Response(new Uint8Array(0), { status: 200 })))))
      .rejects.toThrow(/did not return a WAV payload/);
    // JSON error returned with HTTP 200 (the dangerous case — would otherwise be saved as .wav).
    // Classifies as provider_bad_request, NOT provider_unavailable (the engine only honors `code`
    // when providerStatus is absent, so the throw must omit the 200 status).
    await expect(adapter.run({ text: 'x', voice: 'v', language: 'en' }, ctx('s', vi.fn(async () => new Response('{"error":"quota exceeded"}', { status: 200 })))))
      .rejects.toMatchObject({ code: 'provider_bad_request' });
  });

  it('serializes audio as a compact descriptor in the ledger path, never raw bytes', () => {
    // redactSecrets is what boundedLedgerOutput runs before the 8KB cap; it converts any Buffer
    // to {type:'Buffer', bytes:N} regardless of a per-adapter ledgerOutput. Proves a small/degenerate
    // TTS body can never be written into the provider ledger as a raw byte array.
    const out = { audio: wav('abc'), mimeType: 'audio/wav', providerStatus: 200 };
    const redacted = redactSecrets(out) as any;
    expect(redacted.audio).toEqual({ type: 'Buffer', bytes: out.audio.byteLength });
    expect(JSON.stringify(redacted)).not.toContain('"data"');
  });
});
