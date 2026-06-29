import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneCartesiaVoice } from '../providers/tts/cartesia';

describe('cloneCartesiaVoice', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('posts multipart to /voices/clone and returns voiceId from id field', async () => {
    const calls: Array<{ url: string; init: RequestInit; request: Request }> = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init, request: new Request(url, init) });
      return new Response(JSON.stringify({ id: 'voice_abc123', name: 'Test Clone' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const result = await cloneCartesiaVoice({
      name: 'Test Clone',
      samples: [{ audio: Buffer.from([1, 2, 3, 4]), fileName: 'sample.wav', mimeType: 'audio/wav' }],
      secret: 'test-cartesia-key',
      signal: new AbortController().signal
    });

    expect(result).toEqual({ voiceId: 'voice_abc123' });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    // URL must end in /voices/clone
    expect(url).toMatch(/\/voices\/clone$/);
    expect(init.method).toBe('POST');
    // Body must be FormData
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('sets the correct headers (auth, version, no manual content-type)', async () => {
    const calls: Array<{ url: string; init: RequestInit; request: Request }> = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init, request: new Request(url, init) });
      return new Response(JSON.stringify({ id: 'voice_header_test' }), { status: 200 });
    });

    await cloneCartesiaVoice({
      name: 'Header Test',
      samples: [{ audio: Buffer.from('x'), fileName: 'test.wav', mimeType: 'audio/wav' }],
      secret: 'sk-test',
      signal: new AbortController().signal
    });

    const { init, request } = calls[0]!;
    // Content-Type must NOT be manually set — FormData sets its own boundary
    expect(new Headers(init.headers as HeadersInit).has('content-type')).toBe(false);
    // Request constructed from init will have multipart content-type from FormData
    expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data;/);
    // Auth and version headers must be present
    expect(new Headers(init.headers as HeadersInit).get('Authorization')).toBe('Bearer sk-test');
    expect(new Headers(init.headers as HeadersInit).get('Cartesia-Version')).toBe('2026-03-01');
  });

  it('sends name, language, and clip fields — does NOT send mode or enhance', async () => {
    const captured: Request[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init: RequestInit) => {
      captured.push(new Request(url, init));
      return new Response(JSON.stringify({ id: 'voice_field_test' }), { status: 200 });
    });

    await cloneCartesiaVoice({
      name: 'Field Test',
      description: 'My test description',
      language: 'en',
      samples: [{ audio: Buffer.from('audio-bytes-here'), fileName: 'clip.wav', mimeType: 'audio/wav' }],
      secret: 'test-key',
      signal: new AbortController().signal
    });

    const formData = await captured[0]!.formData();
    // Required fields
    expect(formData.get('name')).toBe('Field Test');
    expect(formData.get('language')).toBe('en');
    // Description should be present when provided
    expect(formData.get('description')).toBe('My test description');
    // Clip field
    const clip = formData.get('clip');
    expect(clip).toBeInstanceOf(Blob);
    expect((clip as File).name).toBe('clip.wav');
    expect((clip as Blob).type).toBe('audio/wav');
    expect(await (clip as Blob).text()).toBe('audio-bytes-here');
    // CRITICAL: no legacy fields that don't exist on 2026-03-01 schema
    expect(formData.has('mode')).toBe(false);
    expect(formData.has('enhance')).toBe(false);
  });

  it('preserves the uploaded clip filename/extension — non-wav uploads are not mislabeled', async () => {
    const captured: Request[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init: RequestInit) => {
      captured.push(new Request(url, init));
      return new Response(JSON.stringify({ id: 'voice_webm' }), { status: 200 });
    });

    await cloneCartesiaVoice({
      name: 'Webm Recording',
      samples: [{ audio: Buffer.from('webm-bytes'), fileName: 'recording.webm', mimeType: 'audio/webm' }],
      secret: 'test-key',
      signal: new AbortController().signal
    });

    const formData = await captured[0]!.formData();
    const clip = formData.get('clip') as File;
    expect(clip.name).toBe('recording.webm');
    expect((clip as Blob).type).toBe('audio/webm');
  });

  it('defaults language to "en" when not specified', async () => {
    const captured: Request[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init: RequestInit) => {
      captured.push(new Request(url, init));
      return new Response(JSON.stringify({ id: 'voice_lang_default' }), { status: 200 });
    });

    await cloneCartesiaVoice({
      name: 'Language Default',
      samples: [{ audio: Buffer.from('x'), fileName: 'clip.wav', mimeType: 'audio/wav' }],
      secret: 'test-key',
      signal: new AbortController().signal
    });

    const formData = await captured[0]!.formData();
    expect(formData.get('language')).toBe('en');
  });

  it('does not send description field when description is not provided', async () => {
    const captured: Request[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init: RequestInit) => {
      captured.push(new Request(url, init));
      return new Response(JSON.stringify({ id: 'voice_no_desc' }), { status: 200 });
    });

    await cloneCartesiaVoice({
      name: 'No Desc',
      samples: [{ audio: Buffer.from('x'), fileName: 'clip.wav', mimeType: 'audio/wav' }],
      secret: 'test-key',
      signal: new AbortController().signal
    });

    const formData = await captured[0]!.formData();
    expect(formData.has('description')).toBe(false);
  });

  it('rejects before fetch when secret is empty', async () => {
    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;

    await expect(cloneCartesiaVoice({
      name: 'No Auth',
      samples: [{ audio: Buffer.alloc(1), fileName: 'clip.wav', mimeType: 'audio/wav' }],
      secret: '',
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'provider_auth_failed' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects before fetch when samples is empty', async () => {
    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;

    await expect(cloneCartesiaVoice({
      name: 'No Samples',
      samples: [],
      secret: 'test-key',
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'provider_bad_request' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses a large successful clone response (not truncated by the error-body cap)', async () => {
    // A valid clone response can exceed the 2 KiB error-body cap (e.g. an echoed embedding).
    const big = { id: 'voice_big', embedding: Array.from({ length: 1000 }, (_, i) => i / 1000) };
    (globalThis as any).fetch = vi.fn(async () => new Response(JSON.stringify(big), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));

    const result = await cloneCartesiaVoice({
      name: 'Big Response',
      samples: [{ audio: Buffer.alloc(1), fileName: 'clip.wav', mimeType: 'audio/wav' }],
      secret: 'test-key',
      signal: new AbortController().signal
    });
    expect(result).toEqual({ voiceId: 'voice_big' });
  });

  it('surfaces HTTP 500 with bounded body and providerStatus', async () => {
    (globalThis as any).fetch = vi.fn(async () => new Response('e'.repeat(9000), { status: 500 }));

    await expect(cloneCartesiaVoice({
      name: 'Error Test',
      samples: [{ audio: Buffer.alloc(1), fileName: 'clip.wav', mimeType: 'audio/wav' }],
      secret: 'test-key',
      signal: new AbortController().signal
    })).rejects.toMatchObject({ providerStatus: 500 });
  });

  it('surfaces 200 not-JSON as malformed JSON error', async () => {
    (globalThis as any).fetch = vi.fn(async () => new Response('<html>nginx interstitial</html>', { status: 200 }));

    await expect(cloneCartesiaVoice({
      name: 'Bad JSON',
      samples: [{ audio: Buffer.alloc(1), fileName: 'clip.wav', mimeType: 'audio/wav' }],
      secret: 'test-key',
      signal: new AbortController().signal
    })).rejects.toMatchObject({ message: expect.stringContaining('malformed JSON') });
  });

  it('surfaces 200 missing id as provider_bad_request', async () => {
    (globalThis as any).fetch = vi.fn(async () => new Response(JSON.stringify({ name: 'x' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));

    await expect(cloneCartesiaVoice({
      name: 'Missing Id',
      samples: [{ audio: Buffer.alloc(1), fileName: 'clip.wav', mimeType: 'audio/wav' }],
      secret: 'test-key',
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'provider_bad_request', message: expect.stringContaining('missing a usable id') });
  });

  it('surfaces 200 whitespace-only id as provider_bad_request', async () => {
    (globalThis as any).fetch = vi.fn(async () => new Response(JSON.stringify({ id: '   ' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));

    await expect(cloneCartesiaVoice({
      name: 'Whitespace Id',
      samples: [{ audio: Buffer.alloc(1), fileName: 'clip.wav', mimeType: 'audio/wav' }],
      secret: 'test-key',
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'provider_bad_request', message: expect.stringContaining('usable id') });
  });

  it('surfaces 200 error payload as provider_bad_request', async () => {
    (globalThis as any).fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'bad clip' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));

    await expect(cloneCartesiaVoice({
      name: 'Error Payload',
      samples: [{ audio: Buffer.alloc(1), fileName: 'clip.wav', mimeType: 'audio/wav' }],
      secret: 'test-key',
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'provider_bad_request', message: expect.stringContaining('bad clip') });
  });

  it('rejects multiple samples before fetch — Cartesia IVC is single-clip', async () => {
    // Cartesia instant cloning takes one clip. Silently using samples[0] while the
    // caller (e.g. the enroll route) reports sampleCount=N would mislead the user into
    // thinking all recordings trained the voice, so the adapter rejects instead.
    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;

    await expect(cloneCartesiaVoice({
      name: 'Multi Sample',
      samples: [
        { audio: Buffer.from('first-sample'), fileName: 'first.wav', mimeType: 'audio/wav' },
        { audio: Buffer.from('second-sample'), fileName: 'second.wav', mimeType: 'audio/wav' }
      ],
      secret: 'test-key',
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'provider_bad_request', message: expect.stringContaining('single clip') });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
