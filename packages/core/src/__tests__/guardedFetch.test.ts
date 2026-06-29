import { describe, expect, it, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';

const lookupMock = vi.hoisted(() => vi.fn((hostname: string, _options: unknown, callback: any) => callback(null, hostname, 4)));
vi.mock('node:dns', () => ({ lookup: lookupMock }));
import { SettingsError } from '../providerSettings';
import { guardedFetch, isPublicGlobalUnicastIp } from '../network/guardedFetch';

afterEach(() => {
  vi.unstubAllGlobals();
  lookupMock.mockImplementation((hostname: string, _options: unknown, callback: any) => callback(null, hostname, 4));
});

describe('guardedFetch SSRF guard', () => {
  it('blocks paid literal private, IPv4-mapped private, .local, CGNAT, benchmark, multicast, and IPv6 documentation addresses', async () => {
    const urls = [
      'http://192.168.0.10',
      'http://[::ffff:192.168.0.10]',
      'http://printer.local',
      'http://100.64.1.2',
      'http://198.18.0.1',
      'http://224.0.0.1',
      'http://[2001:db8::1]'
    ];
    for (const url of urls) {
      await expect(guardedFetch(url, { tier: 'paid' })).rejects.toMatchObject({ code: 'ssrf_blocked' });
    }
  });

  it('allows local tier loopback through SSRF validation', async () => {
    await expect(guardedFetch('http://127.0.0.1:1', { tier: 'local', timeoutMs: 250 })).rejects.not.toMatchObject({ code: 'ssrf_blocked' });
  });

  it('blocks paid redirects that leave the original host or point at private addresses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } })));
    await expect(guardedFetch('https://example.com/start', { tier: 'paid' })).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });

  it('blocks paid hostnames that DNS-pin to private IPv4-mapped addresses', async () => {
    lookupMock.mockImplementation((_hostname: string, _options: unknown, callback: any) => callback(null, '::ffff:192.168.0.10', 6));
    await expect(guardedFetch('http://rebind.example.test/audio', { tier: 'paid', timeoutMs: 250 })).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });

  it('exposes public global unicast helper for DNS-pinned checks', () => {
    expect(isPublicGlobalUnicastIp('93.184.216.34')).toBe(true);
    expect(isPublicGlobalUnicastIp('10.0.0.1')).toBe(false);
    expect(isPublicGlobalUnicastIp('::ffff:192.168.0.1')).toBe(false);
    expect(isPublicGlobalUnicastIp('2001:db8::1')).toBe(false);
  });

  it('maps invalid protocols into settings envelopes', async () => {
    await expect(guardedFetch('file:///etc/passwd', { tier: 'paid' })).rejects.toBeInstanceOf(SettingsError);
    await expect(guardedFetch('file:///etc/passwd', { tier: 'paid' })).rejects.toMatchObject({ code: 'invalid_base_url' });
  });

  // Regression: awaiting agent.close() in the finally block deadlocked the caller
  // because close() waits for in-flight requests to drain, but the body isn't
  // consumed until the caller receives the response. Every paid HTTP provider
  // hung for the full AbortSignal timeout (~120s) before returning. The fix
  // makes agent.close() fire-and-forget. This test asserts the response is
  // returned to the caller in roughly the time the server takes to reply,
  // not after the caller's timeoutMs has elapsed.
  it('returns the response promptly when the body has not been read yet', async () => {
    const responsePayload = 'a'.repeat(8192);
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(responsePayload.length) });
      res.write(responsePayload.slice(0, 256));
      setTimeout(() => { res.end(responsePayload.slice(256)); }, 250);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const started = Date.now();
      const response = await guardedFetch(`http://127.0.0.1:${port}/slow-body`, { tier: 'local', timeoutMs: 5000 });
      const headersElapsed = Date.now() - started;
      expect(response.status).toBe(200);
      expect(headersElapsed).toBeLessThan(2000);
      const text = await response.text();
      expect(text.length).toBe(responsePayload.length);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Regression: keep the per-call timeoutMs armed across the body phase. If the
  // server sends headers immediately but stalls on the body, the body-read MUST
  // be aborted by timeoutMs and surfaced as the same SettingsError the
  // header-phase abort uses (so engine error classification stays consistent).
  // Without this, callers that fetch a large media payload would hang on a
  // stalled body even with a tight guardedFetch timeoutMs, and the engine would
  // misclassify the error as a generic provider_unavailable with a raw
  // AbortError message.
  it('aborts a stalled body read at timeoutMs and maps to provider_unreachable', async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '1048576' });
      // Send a tiny prefix so headers flush, then never send the rest.
      res.write(Buffer.alloc(64));
      // Intentionally do not call res.end(); the client must abort.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const started = Date.now();
      const response = await guardedFetch(`http://127.0.0.1:${port}/stall-body`, { tier: 'local', timeoutMs: 300 });
      const headersElapsed = Date.now() - started;
      expect(response.status).toBe(200);
      expect(headersElapsed).toBeLessThan(2000);
      await expect(response.arrayBuffer()).rejects.toMatchObject({ code: 'provider_unreachable' });
      const totalElapsed = Date.now() - started;
      expect(totalElapsed).toBeLessThan(2000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Regression: callers that read response.body.getReader() directly (e.g.
  // boundedResponseText for non-OK provider error responses) must also see
  // body-phase aborts mapped to the same SettingsError, not a raw AbortError.
  // Regression: native Response allows callers to probe response.body (e.g.
  // for null) and then still call .text()/.json()/.arrayBuffer(). The wrap
  // must not lock the underlying stream on property access.
  it('lets callers probe response.body without locking the stream', async () => {
    const payload = 'probed';
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(payload.length) });
      res.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const response = await guardedFetch(`http://127.0.0.1:${port}/probe`, { tier: 'local', timeoutMs: 5000 });
      // Inspect body — must not lock the stream.
      expect(response.body).toBeTruthy();
      const text = await response.text();
      expect(text).toBe(payload);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('maps stalled getReader() reads to provider_unreachable', async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Content-Length': '4096' });
      res.write('error preamble');
      // Stall — never call res.end().
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const response = await guardedFetch(`http://127.0.0.1:${port}/stall-stream`, { tier: 'local', timeoutMs: 300 });
      expect(response.body).toBeTruthy();
      const reader = response.body!.getReader();
      let saw: { code?: string } | null = null;
      try {
        // Drain until either done or rejected.
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch (err) {
        saw = err as { code?: string };
      } finally {
        await reader.cancel().catch(() => {});
      }
      expect(saw).toMatchObject({ code: 'provider_unreachable' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
