import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, createCloneChainVoicePatch, getCloneChainEstimate, getTtsEstimate, newRequestId, prepareVoice } from './api';

// Mirrors ProviderRequestIdSchema (packages/core/src/schemas.ts): 8–128 chars, no colons.
const PROVIDER_REQUEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

describe('api error parsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns string error payloads without raw JSON noise', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Operation target is invalid' }), { status: 400 })));

    await expect(api('/broken')).rejects.toThrow('Operation target is invalid');
  });

  it('keeps structured error code/message payloads readable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'bad_request', message: 'Missing clip' } }), { status: 400 })));

    await expect(api('/broken')).rejects.toThrow('bad_request: Missing clip');
  });
});

describe('typed API errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('carries the errorCode so the UI can branch on it, not on prose', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'No prepared voice for this recording yet.', errorCode: 'clone-not-ready' }),
      { status: 409 }
    )));

    const error = await createCloneChainVoicePatch('p', { requestId: 'vp-1', start: 0, end: 1, text: 'hi' }).catch((err) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.errorCode).toBe('clone-not-ready');
    expect(error.status).toBe(409);
    expect(error.message).toBe('No prepared voice for this recording yet.');
  });

  it('keeps typed failure details (e.g. usableSec/requiredSec) reachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'Not enough clean speech.', errorCode: 'insufficient-clean-windows', details: { usableSec: 12, requiredSec: 60 } }),
      { status: 409 }
    )));

    const error = await prepareVoice('p').catch((err) => err);

    expect(error.details).toEqual({ usableSec: 12, requiredSec: 60 });
  });

  it('still throws a plain-message error when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway exploded', { status: 502 })));

    await expect(api('/broken')).rejects.toThrow('gateway exploded');
  });
});

describe('clone-chain request bodies', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends mode:clone-chain with the mandatory client requestId and nothing the server rejects', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ providerRequestId: 'vp-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await createCloneChainVoicePatch('episode-001', { requestId: 'vp-1', clipId: 'clip-1', start: 1, end: 2, text: 'hello' });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.mode).toBe('clone-chain');
    expect(body.requestId).toBe('vp-1');
    // ⟨Q6⟩: these are a 400 in clone-chain mode — the client must never send them.
    for (const key of ['provider', 'voice', 'voiceRef', 'model', 'language', 'cloneScope', 'referenceRange']) {
      expect(body).not.toHaveProperty(key);
    }
  });
});

describe('newRequestId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('satisfies the server ProviderRequestIdSchema', () => {
    const id = newRequestId();
    expect(id).toMatch(PROVIDER_REQUEST_ID);
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(id.length).toBeLessThanOrEqual(128);
  });

  it('stays schema-valid without crypto.randomUUID (plain-http LAN, a non-secure context)', () => {
    vi.stubGlobal('crypto', { getRandomValues: (arr: Uint8Array) => { arr.fill(7); return arr; } });

    const id = newRequestId();

    expect(id).toMatch(PROVIDER_REQUEST_ID);
    expect(id.length).toBeGreaterThanOrEqual(8);
  });

  it('is unique per call', () => {
    expect(newRequestId()).not.toBe(newRequestId());
  });
});

describe('estimate endpoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks the server for the chain estimate rather than pricing it locally', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ total: 0.06 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getCloneChainEstimate('episode-001', { chars: 100, sourceDurationSec: 30 });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/manifest/voice-patches/estimate');
    expect(url).toContain('chars=100');
    expect(url).toContain('sourceDurationSec=30');
  });

  it('passes provider and model through for the legacy single-call estimate', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ total: 0.01 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getTtsEstimate('episode-001', { providerId: 'tts.xai', chars: 42, model: 'grok-tts' });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/tts-estimate');
    expect(url).toContain('providerId=tts.xai');
    expect(url).toContain('chars=42');
    expect(url).toContain('model=grok-tts');
  });

  it('omits the model when there is none, rather than sending "undefined"', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getTtsEstimate('episode-001', { providerId: 'tts.mock', chars: 1 });

    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('model=');
  });
});
