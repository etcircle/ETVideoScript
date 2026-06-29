import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerEstimatedSpend, readProviderRequests } from '../providerRequests';
import { setProviderSecret, upsertProvider, writeWorkspaceSettings } from '../providerSettings';
import { runProvider } from '../providers';

// Paid spend cap (P4-1a): WorkspaceSettings.paidCaps is an optional USD ceiling
// keyed by provider id, enforced in runProvider before any provider call.

const originalFetch = globalThis.fetch;
afterEach(() => { (globalThis as any).fetch = originalFetch; });

function tempRoot() { return mkdtempSync(join(tmpdir(), 'etvs-paid-cap-')); }

function imageOkFetch(calls: { n: number }) {
  return Object.assign(async () => {
    calls.n += 1;
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: Buffer.from('img').toString('base64') }] }), text: async () => '' };
  }, { mock: true });
}

function registerPaidImageProvider(root: string) {
  upsertProvider({ homeDir: root, provider: { id: 'image-gen.xai', kind: 'image-gen', name: 'xai', tier: 'paid', enabled: true, default: false, secretRef: 'xai-cap-test' } });
}

function writeCaps(root: string, paidCaps: Record<string, number>) {
  writeWorkspaceSettings(root, { schemaVersion: 1, defaults: {}, paidCaps, taskOptions: { tts: {} }, updatedAt: new Date().toISOString() });
}

function runImage(root: string, requestId: string) {
  return runProvider({ homeDir: root, workspacePath: root, kind: 'image-gen', providerId: 'xai', requestType: 'image-gen', input: { prompt: 'gray square', count: 1 }, requestId, env: {} });
}

describe('paid spend cap', () => {
  it('lets a paid call through when no cap is configured', async () => {
    const root = tempRoot();
    try {
      registerPaidImageProvider(root);
      setProviderSecret({ homeDir: root, secretRef: 'xai-cap-test', value: 'test-key' });
      (globalThis as any).fetch = imageOkFetch({ n: 0 });
      const envelope = await runImage(root, 'provider_cap_nocap');
      expect(envelope.ok).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('lets a paid call through when the estimate stays under the cap', async () => {
    const root = tempRoot();
    try {
      registerPaidImageProvider(root);
      setProviderSecret({ homeDir: root, secretRef: 'xai-cap-test', value: 'test-key' });
      writeCaps(root, { 'image-gen.xai': 1 });
      (globalThis as any).fetch = imageOkFetch({ n: 0 });
      const envelope = await runImage(root, 'provider_cap_under');
      expect(envelope.ok).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('blocks a paid call that would exceed the cap without calling the provider or writing a started row', async () => {
    const root = tempRoot();
    try {
      registerPaidImageProvider(root);
      setProviderSecret({ homeDir: root, secretRef: 'xai-cap-test', value: 'test-key' });
      writeCaps(root, { 'image-gen.xai': 0.03 }); // xAI image is $0.02/image: one call fits, two do not
      const calls = { n: 0 };
      (globalThis as any).fetch = imageOkFetch(calls);
      const first = await runImage(root, 'provider_cap_first');
      expect(first.ok).toBe(true);
      const second = await runImage(root, 'provider_cap_second');
      expect(second.ok).toBe(false);
      if (second.ok === false) {
        expect(second.error.code).toBe('paid_cap_exceeded');
        expect(second.error.fix).toMatch(/Settings/);
      }
      expect(calls.n).toBe(1); // the provider was called only for the first request
      const events = readProviderRequests(root);
      expect(events.some((event) => event.requestId === 'provider_cap_second')).toBe(false);
      expect(events.map((event) => event.status)).toEqual(['started', 'succeeded']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('excludes failed requests from the cap total', async () => {
    const root = tempRoot();
    try {
      registerPaidImageProvider(root); // secret intentionally not set yet -> the first call fails auth
      writeCaps(root, { 'image-gen.xai': 0.1 });
      (globalThis as any).fetch = imageOkFetch({ n: 0 });
      const failed = await runImage(root, 'provider_cap_failed');
      expect(failed.ok).toBe(false);
      expect(providerEstimatedSpend(root, 'image-gen.xai')).toBe(0); // a failed call costs nothing toward the cap
      setProviderSecret({ homeDir: root, secretRef: 'xai-cap-test', value: 'test-key' });
      const ok = await runImage(root, 'provider_cap_after_fail');
      expect(ok.ok).toBe(true); // still under the cap because the failed call did not count
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('counts a legacy single-row succeeded ledger entry toward the cap (no started row)', async () => {
    // Some legacy/generic ledger entries are a single 'succeeded' (or 'called') row with cost,
    // no preceding 'started'. The cap must still treat those as committed spend or upgrading
    // to the P4-1c version would silently zero out historical spend.
    const { appendProviderRequestEvent } = await import('../providerRequests');
    const root = tempRoot();
    try {
      appendProviderRequestEvent(root, { schemaVersion: 1, type: 'voice_patch', requestId: 'req_legacy_succeeded', projectId: 'p', provider: 'tts.xai', status: 'succeeded', createdAt: '2026-04-01T00:00:00.000Z', completedAt: '2026-04-01T00:00:01.000Z', cost: { currency: 'USD', estimated: 0.04, actual: 0.04 } } as any);
      appendProviderRequestEvent(root, { schemaVersion: 1, type: 'voice_patch', requestId: 'req_legacy_called', projectId: 'p', provider: 'tts.xai', status: 'called', createdAt: '2026-04-01T00:00:02.000Z', cost: { currency: 'USD', estimated: 0.03, actual: null } } as any);
      expect(providerEstimatedSpend(root, 'tts.xai')).toBeCloseTo(0.07, 4);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reserves cap spend for an in-flight paid call (started but not yet succeeded) (P4-1c regression)', async () => {
    // P4-1c: with the manifest mutex released during paid calls, two same-provider POSTs can
    // run in parallel. Each Phase 1 checks the cap; if in-flight (started but not yet succeeded)
    // calls don't reserve cap spend, both can pass the cap check and the configured cap is
    // exceeded by N×estimate. This locks the in-flight reservation behavior.
    const { appendProviderRequestEvent } = await import('../providerRequests');
    const root = tempRoot();
    try {
      appendProviderRequestEvent(root, { schemaVersion: 1, type: 'voice_patch', requestId: 'req_inflight', projectId: 'p', provider: 'tts.xai', status: 'approved', createdAt: '2026-05-20T00:00:00.000Z', cost: { currency: 'USD', estimated: 0.05, actual: null } } as any);
      appendProviderRequestEvent(root, { schemaVersion: 1, type: 'voice_patch', requestId: 'req_inflight', projectId: 'p', provider: 'tts.xai', status: 'started', createdAt: '2026-05-20T00:00:01.000Z', cost: { currency: 'USD', estimated: 0.05, actual: null } } as any);
      // No succeeded/failed yet — the call is mid-flight. Its estimate MUST count.
      expect(providerEstimatedSpend(root, 'tts.xai')).toBeCloseTo(0.05, 4);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('counts a paid call toward the cap even when it terminated as op_update_failed (P4-1c regression)', async () => {
    // P4-1c: with the manifest mutex released during the paid call, the user can edit/reject
    // the proposed voice_patch before Phase 3 attaches the asset; we then append
    // op_update_failed (since we refuse to resurrect the user's intent). The actual paid call
    // already succeeded — its cost must still count toward the spend cap, otherwise repeated
    // mid-flight conflicts could exceed the configured cap.
    const { appendProviderRequestEvent } = await import('../providerRequests');
    const root = tempRoot();
    try {
      appendProviderRequestEvent(root, { schemaVersion: 1, type: 'voice_patch', requestId: 'req_paid_conflict', projectId: 'p', provider: 'tts.xai', status: 'approved', createdAt: '2026-05-20T00:00:00.000Z', cost: { currency: 'USD', estimated: 0.05, actual: null } } as any);
      appendProviderRequestEvent(root, { schemaVersion: 1, type: 'voice_patch', requestId: 'req_paid_conflict', projectId: 'p', provider: 'tts.xai', status: 'started', createdAt: '2026-05-20T00:00:01.000Z', cost: { currency: 'USD', estimated: 0.05, actual: null } } as any);
      appendProviderRequestEvent(root, { schemaVersion: 1, type: 'voice_patch', requestId: 'req_paid_conflict', projectId: 'p', provider: 'tts.xai', status: 'succeeded', createdAt: '2026-05-20T00:00:02.000Z', completedAt: '2026-05-20T00:00:02.000Z', cost: { currency: 'USD', estimated: 0.05, actual: 0.05 } } as any);
      appendProviderRequestEvent(root, { schemaVersion: 1, type: 'voice_patch', requestId: 'req_paid_conflict', projectId: 'p', provider: 'tts.xai', status: 'op_update_failed', createdAt: '2026-05-20T00:00:03.000Z', completedAt: '2026-05-20T00:00:03.000Z', error: 'user edited mid-flight', cost: { currency: 'USD', estimated: 0.05, actual: 0.05 } } as any);
      expect(providerEstimatedSpend(root, 'tts.xai')).toBeCloseTo(0.05, 4);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('never caps a local-tier provider', async () => {
    const root = tempRoot();
    try {
      writeCaps(root, { 'tts.mock': 0 }); // a 0 cap would block every call if it applied to local providers
      const envelope = await runProvider({ homeDir: root, workspacePath: root, kind: 'tts', providerId: 'mock', requestType: 'tts', input: { text: 'hello', voice: 'eve', language: 'en' } });
      expect(envelope.ok).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
