import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { createApp } from './server';
import type { ApiConfig } from './config';

function config(root: string, overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    workspaceRoot: root,
    enableTerminal: false,
    enableAgent: false,
    allowedOrigins: ['http://127.0.0.1:4318', 'http://localhost:4318'],
    lanOrigins: [],
    terminalToken: 'test-token',
    ...overrides
  };
}

const remoteAddress = '192.168.99.99';
const lanOrigin = 'http://192.168.99.99:4318';

describe('LAN access server behavior', () => {
  it('preserves localhost HTTP query-token behavior by not requiring bearer auth locally', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-lan-api-'));
    const app = createApp(config(root, { terminalToken: null }));
    try {
      const response = await app.inject({ method: 'GET', url: '/health?token=query-token' });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires Authorization bearer token for non-localhost HTTP and rejects query tokens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-lan-api-'));
    const app = createApp(config(root, {
      host: '0.0.0.0',
      terminalToken: 'lan-token',
      lanOrigins: [lanOrigin],
      allowedOrigins: ['http://127.0.0.1:4318', 'http://localhost:4318', lanOrigin]
    }));
    try {
      // Fastify injection does not open a real remote socket; remoteAddress is the light-my-request-supported way to exercise request.ip.
      const queryOnly = await app.inject({ method: 'GET', url: '/health?token=lan-token', remoteAddress } as any);
      expect(queryOnly.statusCode).toBe(401);
      expect(JSON.parse(queryOnly.body).error).toBe('Token must be in Authorization header on non-localhost; query parameter rejected for security.');

      const header = await app.inject({ method: 'GET', url: '/health', headers: { authorization: 'Bearer lan-token' }, remoteAddress } as any);
      expect(header.statusCode).toBe(200);

      const missing = await app.inject({ method: 'GET', url: '/health', remoteAddress } as any);
      expect(missing.statusCode).toBe(401);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows explicit LAN CORS preflight origins and rejects unknown origins', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-lan-api-'));
    const app = createApp(config(root, {
      host: '0.0.0.0',
      terminalToken: 'lan-token',
      lanOrigins: [lanOrigin],
      allowedOrigins: ['http://127.0.0.1:4318', 'http://localhost:4318', lanOrigin]
    }));
    try {
      const allowed = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: lanOrigin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization'
        },
        remoteAddress
      } as any);
      expect([200, 204]).toContain(allowed.statusCode);
      expect(allowed.headers['access-control-allow-origin']).toBe(lanOrigin);

      const denied = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: {
          origin: 'http://evil.example',
          'access-control-request-method': 'GET'
        },
        remoteAddress
      } as any);
      expect(denied.statusCode).toBe(403);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps WebSocket agent handshake query-token carve-out for browser clients', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-lan-api-'));
    const app = createApp(config(root, {
      host: '0.0.0.0',
      enableAgent: true,
      terminalToken: 'lan-token',
      lanOrigins: [lanOrigin],
      allowedOrigins: ['http://127.0.0.1:4318', 'http://localhost:4318', lanOrigin]
    }));
    let ws: WebSocket | null = null;
    try {
      await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const port = (app.server.address() as AddressInfo).port;
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws/projects/episode-001/agent/test-session?token=lan-token`, { headers: { origin: lanOrigin } });
      await new Promise<void>((resolve, reject) => {
        ws!.once('open', resolve);
        ws!.once('error', reject);
      });
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws?.close();
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires bearer when X-Forwarded-For is present even from loopback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-lan-api-'));
    const app = createApp(config(root, { terminalToken: 'test-token' }));
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { 'x-forwarded-for': '192.168.99.99', host: '192.168.1.50:4443' }
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts bearer-authenticated requests through the proxy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-lan-api-'));
    const app = createApp(config(root, { terminalToken: 'test-token' }));
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: {
          'x-forwarded-for': '192.168.99.99',
          host: '192.168.1.50:4443',
          authorization: 'Bearer test-token'
        }
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exempts GET on media route from bearer when accessed through the proxy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-lan-api-'));
    const app = createApp(config(root, { terminalToken: 'test-token' }));
    try {
      // Hook short-circuits before the route runs. 404 from missing-project
      // route proves the auth gate did not block this request (would have
      // been 401 otherwise).
      const response = await app.inject({
        method: 'GET',
        url: '/api/projects/no-such-project/media/source',
        headers: { 'x-forwarded-for': '192.168.99.99', host: '192.168.1.50:4443' }
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exempts GET on peaks route from bearer when accessed through the proxy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-lan-api-'));
    const app = createApp(config(root, { terminalToken: 'test-token' }));
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/projects/no-such-project/peaks/clip_001',
        headers: { 'x-forwarded-for': '192.168.99.99', host: '192.168.1.50:4443' }
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still gates POST on proxied paths even under headerless prefixes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-lan-api-'));
    const app = createApp(config(root, { terminalToken: 'test-token' }));
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/projects/no-such-project/media/source',
        headers: { 'x-forwarded-for': '192.168.99.99', host: '192.168.1.50:4443' },
        payload: '{}'
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
