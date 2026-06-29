import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

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
