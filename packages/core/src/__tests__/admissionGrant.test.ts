import { afterEach, describe, expect, it } from 'vitest';
import { usePaidTransportStubbingGlobalFetch } from './paidTransportTestSetup';
usePaidTransportStubbingGlobalFetch();
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerEstimatedSpend } from '../providerRequests';
import { setProviderSecret, upsertProvider, writeWorkspaceSettings } from '../providerSettings';
import { runProvider } from '../providers';

/**
 * `RunProviderInput.admission` — the cap grant, exercised directly.
 *
 * A grant lets a paid call past a spend ceiling, so its honoring rule deserves a test that can
 * only pass for the right reason. Everything here drives `runProvider` itself: a flat
 * `costPerUnit` makes every call cost exactly $0.10, so each case differs only in the grant.
 *
 * The rule under test: a grant is a WINDOW, not a bypass. It is honored only while
 * `spent + estimate <= capSpentAtAdmission + chainTotal`, and only for the currency and provider
 * it was issued for. That inequality is what stops two operations admitted moments apart from
 * each riding its own grant past the same ceiling.
 */

const CALL_COST = 0.1;
const originalFetch = globalThis.fetch;
afterEach(() => { (globalThis as any).fetch = originalFetch; });

function tempRoot() { return mkdtempSync(join(tmpdir(), 'etvs-admission-')); }

function okFetch(calls: { n: number }) {
  return Object.assign(async () => {
    calls.n += 1;
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: Buffer.from('img').toString('base64') }] }), text: async () => '' };
  }, { mock: true });
}

function setup(root: string) {
  upsertProvider({ homeDir: root, provider: { id: 'image-gen.xai', kind: 'image-gen', name: 'xai', tier: 'paid', enabled: true, secretRef: 'xai-admission', costPerUnit: { currency: 'USD', unit: 'call', amount: CALL_COST } } });
  setProviderSecret({ homeDir: root, secretRef: 'xai-admission', value: 'test-key' });
}

function writeCap(root: string, limit: number) {
  writeWorkspaceSettings(root, { schemaVersion: 1, defaults: {}, paidCaps: { 'image-gen.xai': limit }, taskOptions: { tts: {} }, updatedAt: new Date().toISOString() });
}

type Admission = NonNullable<Parameters<typeof runProvider>[0]['admission']>;

function grant(overrides: Partial<Admission> = {}): Admission {
  return { grantedEstimate: CALL_COST, capSpentAtAdmission: 0, chainTotal: CALL_COST, currency: 'USD', providerId: 'image-gen.xai', ...overrides };
}

function run(root: string, requestId: string, admission?: Admission) {
  return runProvider({
    homeDir: root, workspacePath: root, kind: 'image-gen', providerId: 'xai', requestType: 'image-gen',
    input: { prompt: 'gray square', count: 1 }, requestId, env: {},
    ...(admission ? { admission } : {})
  });
}

describe('admission grants in runProvider', () => {
  it('WITHOUT a grant, a call over the cap is refused', async () => {
    const root = tempRoot();
    const calls = { n: 0 };
    try {
      setup(root);
      writeCap(root, CALL_COST / 2);
      (globalThis as any).fetch = okFetch(calls);

      const envelope = await run(root, 'provider_admission_none');

      expect(envelope.ok).toBe(false);
      expect(envelope.ok === false && envelope.error.code).toBe('paid_cap_exceeded');
      expect(calls.n).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('HONORS a grant for the same call under a cap that would otherwise refuse it', async () => {
    const root = tempRoot();
    const calls = { n: 0 };
    try {
      setup(root);
      // Half what the call costs: without the grant this is the refusal above.
      writeCap(root, CALL_COST / 2);
      (globalThis as any).fetch = okFetch(calls);

      const envelope = await run(root, 'provider_admission_honored', grant());

      expect(envelope.ok).toBe(true);
      expect(calls.n).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('REFUSES once the ledger has grown past the window the admission observed', async () => {
    const root = tempRoot();
    const calls = { n: 0 };
    try {
      setup(root);
      writeCap(root, 10);
      (globalThis as any).fetch = okFetch(calls);
      // Somebody else's call lands between admission and this one — the same shape as a second
      // clone chain running concurrently in this workspace.
      await run(root, 'provider_admission_other_spend');
      expect(providerEstimatedSpend(root, 'image-gen.xai')).toBeCloseTo(CALL_COST, 6);
      writeCap(root, CALL_COST / 2);

      // The grant still says capSpentAtAdmission: 0 — the world it was issued in.
      const envelope = await run(root, 'provider_admission_window_blown', grant());

      // spent(0.1) + estimate(0.1) = 0.2 > window(0 + 0.1) ⇒ ordinary live check ⇒ refused.
      expect(envelope.ok).toBe(false);
      expect(envelope.ok === false && envelope.error.code).toBe('paid_cap_exceeded');
      expect(calls.n).toBe(1); // only the first, unrelated call
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('HONORS a grant whose baseline already includes that spend', async () => {
    const root = tempRoot();
    const calls = { n: 0 };
    try {
      setup(root);
      writeCap(root, 10);
      (globalThis as any).fetch = okFetch(calls);
      await run(root, 'provider_admission_prior');
      writeCap(root, CALL_COST / 2);

      // Same ledger as the previous case; the ONLY difference is that this admission was taken
      // after that spend, so its window covers it. This is what proves the window is doing the
      // work rather than some incidental property of the grant.
      const envelope = await run(root, 'provider_admission_window_ok', grant({ capSpentAtAdmission: CALL_COST }));

      expect(envelope.ok).toBe(true);
      expect(calls.n).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('REFUSES a grant with no observed baseline (capSpentAtAdmission null)', async () => {
    const root = tempRoot();
    const calls = { n: 0 };
    try {
      setup(root);
      writeCap(root, CALL_COST / 2);
      (globalThis as any).fetch = okFetch(calls);

      const envelope = await run(root, 'provider_admission_null_baseline', grant({ capSpentAtAdmission: null }));

      expect(envelope.ok).toBe(false);
      expect(calls.n).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('REFUSES a grant issued in a different currency', async () => {
    const root = tempRoot();
    const calls = { n: 0 };
    try {
      setup(root);
      writeCap(root, CALL_COST / 2);
      (globalThis as any).fetch = okFetch(calls);

      // An amount in credits is not an amount in dollars.
      const envelope = await run(root, 'provider_admission_currency', grant({ currency: 'CREDITS' }));

      expect(envelope.ok).toBe(false);
      expect(calls.n).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('REFUSES a grant issued for a different provider', async () => {
    const root = tempRoot();
    const calls = { n: 0 };
    try {
      setup(root);
      writeCap(root, CALL_COST / 2);
      (globalThis as any).fetch = okFetch(calls);

      // A grant for one step of a chain is not a licence for another.
      const envelope = await run(root, 'provider_admission_provider', grant({ providerId: 'tts.elevenlabs-sts' }));

      expect(envelope.ok).toBe(false);
      expect(calls.n).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('REFUSES a call that prices above the amount granted', async () => {
    const root = tempRoot();
    const calls = { n: 0 };
    try {
      setup(root);
      writeCap(root, CALL_COST / 2);
      (globalThis as any).fetch = okFetch(calls);

      // The chain total would admit it, but this STEP was granted less than it now costs —
      // the overrun case (a synthesized line longer than the conservative bound).
      const envelope = await run(root, 'provider_admission_over_step', grant({ grantedEstimate: CALL_COST / 2, chainTotal: CALL_COST * 4 }));

      expect(envelope.ok).toBe(false);
      expect(calls.n).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
