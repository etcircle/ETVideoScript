import { afterEach, describe, expect, it, vi } from 'vitest';
import { speechToSpeechElevenlabs } from '../providers/tts/elevenlabs';

const originalFetch = globalThis.fetch;
afterEach(() => { (globalThis as any).fetch = originalFetch; vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------
// speechToSpeechElevenlabs adapter
// ---------------------------------------------------------------------------

describe('speechToSpeechElevenlabs', () => {
  it('POSTs to the S2S convert endpoint with the voiceId in the path', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    (globalThis as any).fetch = vi.fn(async (url: unknown, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(new Uint8Array(44), { status: 200 });
    });
    await speechToSpeechElevenlabs({
      audio: Buffer.from([1, 2, 3]),
      voiceId: 'abc123',
      secret: 'test-key',
      signal: new AbortController().signal
    });
    expect(calls[0]!.url).toContain('/v1/speech-to-speech/abc123');
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('sends the audio as a FormData file field named "audio"', async () => {
    const captured: Request[] = [];
    (globalThis as any).fetch = vi.fn(async (url: unknown, init: any) => {
      captured.push(new Request(url as string, init));
      return new Response(new Uint8Array(44), { status: 200 });
    });
    await speechToSpeechElevenlabs({
      audio: Buffer.from('raw-audio-bytes'),
      voiceId: 'abc123',
      secret: 'test-key',
      signal: new AbortController().signal
    });
    const parsed = await captured[0]!.formData();
    const file = parsed.get('audio');
    expect(file).toBeInstanceOf(Blob);
    expect(await (file as Blob).text()).toBe('raw-audio-bytes');
  });

  it('sets remove_background_noise to false in the form body', async () => {
    const captured: Request[] = [];
    (globalThis as any).fetch = vi.fn(async (url: unknown, init: any) => {
      captured.push(new Request(url as string, init));
      return new Response(new Uint8Array(44), { status: 200 });
    });
    await speechToSpeechElevenlabs({
      audio: Buffer.alloc(4),
      voiceId: 'v1',
      secret: 'key',
      signal: new AbortController().signal
    });
    const parsed = await captured[0]!.formData();
    expect(parsed.get('remove_background_noise')).toBe('false');
  });

  it('includes xi-api-key header', async () => {
    let capturedHeaders: Headers | null = null;
    (globalThis as any).fetch = vi.fn(async (_url: unknown, init: any) => {
      capturedHeaders = new Headers(init.headers);
      return new Response(new Uint8Array(44), { status: 200 });
    });
    await speechToSpeechElevenlabs({
      audio: Buffer.alloc(1),
      voiceId: 'v1',
      secret: 'my-secret-key',
      signal: new AbortController().signal
    });
    expect(capturedHeaders!.get('xi-api-key')).toBe('my-secret-key');
  });

  it('passes the optional model_id when provided', async () => {
    const captured: Request[] = [];
    (globalThis as any).fetch = vi.fn(async (url: unknown, init: any) => {
      captured.push(new Request(url as string, init));
      return new Response(new Uint8Array(44), { status: 200 });
    });
    await speechToSpeechElevenlabs({
      audio: Buffer.alloc(1),
      voiceId: 'v1',
      model: 'eleven_english_sts_v2',
      secret: 'key',
      signal: new AbortController().signal
    });
    const parsed = await captured[0]!.formData();
    expect(parsed.get('model_id')).toBe('eleven_english_sts_v2');
  });

  it('throws ProviderExecutionError when secret is empty', async () => {
    const fetchImpl = vi.fn();
    (globalThis as any).fetch = fetchImpl;
    await expect(speechToSpeechElevenlabs({
      audio: Buffer.alloc(1),
      voiceId: 'v1',
      secret: '',
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'provider_auth_failed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws ProviderExecutionError on HTTP error response', async () => {
    (globalThis as any).fetch = vi.fn(async () => new Response('bad input', { status: 400 }));
    await expect(speechToSpeechElevenlabs({
      audio: Buffer.alloc(1),
      voiceId: 'v1',
      secret: 'key',
      signal: new AbortController().signal
    })).rejects.toMatchObject({ providerStatus: 400 });
  });

  it('returns audio as a Buffer', async () => {
    const fakeAudio = new Uint8Array(100);
    (globalThis as any).fetch = vi.fn(async () => new Response(fakeAudio, { status: 200 }));
    const result = await speechToSpeechElevenlabs({
      audio: Buffer.alloc(1),
      voiceId: 'v1',
      secret: 'key',
      signal: new AbortController().signal
    });
    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(0);
  });
});
