import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { latestProviderRequest, readProviderRequests, setProviderSecret, upsertProvider } from '@etvideoscript/core';
import { createApp } from './server';

function config(root: string) {
  return { host: '127.0.0.1', port: 0, workspaceRoot: root, enableTerminal: false, enableAgent: false, allowedOrigins: ['http://127.0.0.1:4318'], lanOrigins: [], terminalToken: null };
}

async function createProject(app: ReturnType<typeof createApp>) {
  const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
  expect(created.statusCode).toBe(200);
}

function paidFetchStub() {
  let calls = 0;
  const image = Buffer.from('paid-image');
  const fn = vi.fn(async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: image.toString('base64') }] }),
      text: async () => '',
      arrayBuffer: async () => image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength)
    } as any;
  });
  return { fn, get calls() { return calls; } };
}

function setupPaid(root: string, enabled = true) {
  upsertProvider({ homeDir: root, provider: { id: 'image-gen.xai', kind: 'image-gen', name: 'xai', tier: 'paid', enabled, default: true, secretRef: 'xai-test', costPerUnit: { currency: 'USD', unit: 'image', amount: 0.12 } } });
  setProviderSecret({ homeDir: root, secretRef: 'xai-test', value: 'test-xai-key' });
}

describe('generation asset routes', () => {
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    process.env.HOME = originalHome;
    (globalThis as any).fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('generates mock media immediately and adds a generated asset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-generation-'));
    process.env.HOME = root;
    const app = createApp(config(root));
    try {
      await createProject(app);
      const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/generations', payload: { kind: 'image-gen', prompt: 'gray square', provider: 'mock', requestId: 'provider_mock_image' } });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.asset).toMatchObject({ providerRequestId: 'provider_mock_image', assetKind: 'image' });
      const asset = body.manifest.assets.find((candidate: any) => candidate.providerRequestId === 'provider_mock_image');
      expect(asset).toMatchObject({ provenance: 'generated' });
      expect(existsSync(join(root, 'episode-001', asset.path))).toBe(true);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('synthesizes paid generation directly and adds asset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-generation-'));
    process.env.HOME = root;
    setupPaid(root);
    const fetchStub = paidFetchStub();
    (globalThis as any).fetch = fetchStub.fn;
    const app = createApp(config(root));
    try {
      await createProject(app);
      const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/generations', payload: { kind: 'image-gen', prompt: 'paid square', requestId: 'provider_paid_image' } });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.asset).toMatchObject({ providerRequestId: 'provider_paid_image', assetKind: 'image' });
      expect(fetchStub.calls).toBe(1);
      const events = readProviderRequests(join(root, 'episode-001')).filter((event) => event.requestId === 'provider_paid_image');
      expect(events.map((event) => event.status)).toEqual(['approved', 'started', 'succeeded']);
      const asset = body.manifest.assets.find((candidate: any) => candidate.providerRequestId === 'provider_paid_image');
      expect(asset).toMatchObject({ provenance: 'generated' });
      const served = await app.inject({ method: 'GET', url: `/api/projects/episode-001/assets/${asset.path}` });
      expect(served.statusCode).toBe(200);
      expect(readFileSync(join(root, 'episode-001', asset.path)).toString()).toBe('paid-image');
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('fails fast on disabled provider, no pending row left behind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-generation-'));
    process.env.HOME = root;
    setupPaid(root, false);
    const app = createApp(config(root));
    try {
      await createProject(app);
      const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/generations', payload: { kind: 'image-gen', prompt: 'disabled', provider: 'xai', requestId: 'provider_disabled_image' } });
      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body.asset).toBeUndefined();
      const events = readProviderRequests(join(root, 'episode-001')).filter((event) => event.requestId === 'provider_disabled_image');
      expect(events.map((event) => event.status)).toEqual(['failed']);
      expect((latestProviderRequest(join(root, 'episode-001'), 'provider_disabled_image') as any).error).toContain('Provider is disabled');
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('is idempotent on concurrent POSTs with same requestId, only one provider call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-generation-'));
    process.env.HOME = root;
    setupPaid(root);
    const fetchStub = paidFetchStub();
    (globalThis as any).fetch = fetchStub.fn;
    const app = createApp(config(root));
    try {
      await createProject(app);
      const payload = { kind: 'image-gen', prompt: 'pay once', requestId: 'provider_concurrent_image' };
      const [first, second] = await Promise.all([
        app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/generations', payload }),
        app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/generations', payload })
      ]);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(first.body).providerRequestId).toBe('provider_concurrent_image');
      expect(JSON.parse(second.body).providerRequestId).toBe('provider_concurrent_image');
      expect(fetchStub.calls).toBe(1);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('returns 409 when concurrent POSTs share a requestId but differ in body (P4-1c bodyHash in dedup key)', async () => {
    // P4-1c regression: the dedup key includes bodyHash so the second concurrent POST does NOT
    // join the first promise; it runs its own Phase 1, sees the existing ledger row from the
    // first POST, and surfaces the 409 the API contract promises for mismatched requestId bodies.
    const root = mkdtempSync(join(tmpdir(), 'etvideo-generation-'));
    process.env.HOME = root;
    setupPaid(root);
    let firstReached!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstReached = resolve; });
    const image = Buffer.from('paid-image-conflict');
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        firstReached();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: image.toString('base64') }] }), text: async () => '' } as any;
    });
    (globalThis as any).fetch = fetchMock;
    const app = createApp(config(root));
    try {
      await createProject(app);
      const first = app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/generations', payload: { kind: 'image-gen', prompt: 'first body', requestId: 'provider_conflict_image' } });
      await firstStarted;
      const second = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/generations', payload: { kind: 'image-gen', prompt: 'DIFFERENT body', requestId: 'provider_conflict_image' } });
      // Second POST must be rejected with 409 even though the first is still mid-flight.
      expect(second.statusCode).toBe(409);
      releaseFirst();
      const firstResponse = await first;
      expect(firstResponse.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('runs concurrent DIFFERENT-requestId paid calls in parallel (P4-1c: mutex released during paid call)', async () => {
    // Before P4-1c the project manifest mutex was held for the entire paid provider call, so two
    // different-requestId paid POSTs on the same project serialized: at most one fetch in flight
    // at a time. After P4-1c the mutex is released during the paid call itself, so concurrent
    // different-requestId paid calls can be in flight simultaneously. This test pins that
    // behavior so future refactors don't accidentally re-introduce the contention.
    const root = mkdtempSync(join(tmpdir(), 'etvideo-generation-'));
    process.env.HOME = root;
    setupPaid(root);
    let peakInFlight = 0;
    let inFlight = 0;
    const releases: Array<() => void> = [];
    const image = Buffer.from('paid-image-parallel');
    const fetchMock = vi.fn(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      inFlight -= 1;
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: image.toString('base64') }] }), text: async () => '' } as any;
    });
    (globalThis as any).fetch = fetchMock;
    const app = createApp(config(root));
    try {
      await createProject(app);
      const a = app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/generations', payload: { kind: 'image-gen', prompt: 'A', requestId: 'provider_parallel_a' } });
      const b = app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/generations', payload: { kind: 'image-gen', prompt: 'B', requestId: 'provider_parallel_b' } });
      // Wait until both fetches have entered the barrier. Without the P4-1c refactor, only one
      // would be in flight at a time and `peakInFlight` would max out at 1.
      while (releases.length < 2) { await new Promise((resolve) => setTimeout(resolve, 5)); }
      expect(peakInFlight).toBe(2);
      releases.forEach((release) => release());
      const [first, second] = await Promise.all([a, b]);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Each request still got its own approved/started/succeeded sequence.
      const eventsA = readProviderRequests(join(root, 'episode-001')).filter((event) => event.requestId === 'provider_parallel_a').map((event) => event.status);
      const eventsB = readProviderRequests(join(root, 'episode-001')).filter((event) => event.requestId === 'provider_parallel_b').map((event) => event.status);
      expect(eventsA).toEqual(['approved', 'started', 'succeeded']);
      expect(eventsB).toEqual(['approved', 'started', 'succeeded']);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps paid create idempotent by requestId/bodyHash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-generation-'));
    process.env.HOME = root;
    setupPaid(root);
    const fetchStub = paidFetchStub();
    (globalThis as any).fetch = fetchStub.fn;
    const app = createApp(config(root));
    try {
      await createProject(app);
      const payload = { kind: 'image-gen', prompt: 'same body', requestId: 'provider_same_image' };
      expect((await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/generations', payload })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/generations', payload })).statusCode).toBe(200);
      expect(fetchStub.calls).toBe(1);
      const conflict = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/generations', payload: { ...payload, prompt: 'different body' } });
      expect(conflict.statusCode).toBe(409);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('returns a paid pre-call cost estimate when a paid provider is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-generation-'));
    process.env.HOME = root;
    setupPaid(root);
    const app = createApp(config(root));
    try {
      await createProject(app);
      const response = await app.inject({ method: 'GET', url: '/api/projects/episode-001/assets/generations/estimate?kind=image-gen' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toMatchObject({ providerId: 'image-gen.xai', tier: 'paid', configured: true });
      expect(body.cost.currency).toBe('USD');
      expect(typeof body.cost.estimated).toBe('number');
      expect(body.cost.estimated).toBeGreaterThan(0);
      expect(body.defaults).toMatchObject({ count: 1 });
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('reports the mock generation provider as free when no paid provider is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-generation-'));
    process.env.HOME = root;
    const app = createApp(config(root));
    try {
      await createProject(app);
      const response = await app.inject({ method: 'GET', url: '/api/projects/episode-001/assets/generations/estimate?kind=image-gen' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.tier).toBe('local');
      expect(body.providerId.startsWith('image-gen.')).toBe(true);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects cost estimate requests for non-generation kinds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-generation-'));
    process.env.HOME = root;
    const app = createApp(config(root));
    try {
      await createProject(app);
      const response = await app.inject({ method: 'GET', url: '/api/projects/episode-001/assets/generations/estimate?kind=tts' });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toMatch(/kind must be/);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
