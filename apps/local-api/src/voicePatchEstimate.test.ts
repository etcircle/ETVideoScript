import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readWorkspaceSettings,
  upsertProvider,
  setPaidTransportForTests,
  writeWorkspaceSettings
} from '@etvideoscript/core';
import { createApp } from './server';
import { makeProject } from './voiceFixtures';

/**
 * The prospective-cost endpoint replaced a client-side mirror of the pricing table and the
 * cap-inheritance graph. These assert the three things the mirror got wrong — costPerUnit
 * overrides, cap-group spend, and which rows count — plus the invariant that matters most:
 * asking what a call costs must never make one.
 */

function config(root: string, settingsHome: string) {
  return { host: '127.0.0.1', port: 0, workspaceRoot: root, enableTerminal: false, allowedOrigins: ['http://127.0.0.1:4318'], lanOrigins: [], terminalToken: null, settingsHome };
}

function roots() {
  const root = mkdtempSync(join(tmpdir(), 'etvs-estimate-root-'));
  const home = mkdtempSync(join(tmpdir(), 'etvs-estimate-home-'));
  return { root, home, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

/** Every file under a directory, as path → bytes. Used to prove a read wrote nothing. */
function snapshotTree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) Object.assign(out, snapshotTree(full, base));
    else out[full.slice(base.length)] = readFileSync(full).toString('base64');
  }
  return out;
}

const url = (chars: number, sec: number) => `/api/projects/p1/manifest/voice-patches/estimate?chars=${chars}&sourceDurationSec=${sec}`;

describe('clone-chain estimate endpoint', () => {
  it('prices the two steps on their own units and never issues a paid call', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    let paidCalls = 0;
    setPaidTransportForTests(async () => { paidCalls += 1; return new Response(new Uint8Array(0), { status: 200 }); });
    try {
      await makeProject(root, 'p1', { seconds: 20 });
      const res = await app.inject({ method: 'GET', url: url(100, 30) });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(paidCalls).toBe(0);
      expect(body.calls).toBe(2);
      const tts = body.steps.find((step: any) => step.step === 'tts');
      const sts = body.steps.find((step: any) => step.step === 'sts');
      expect(tts.providerId).toBe('tts.elevenlabs');
      expect(sts.providerId).toBe('tts.elevenlabs-sts');
      // Per character vs per minute of source. The STS figure is priced against the
      // CONSERVATIVE bound (2× the selection), because the real source is the TTS output and it
      // can run longer than the slot: 30s selected ⇒ admitted for 60s ⇒ $0.10.
      expect(tts.estimated).toBeCloseTo(0.01, 6);
      expect(sts.estimated).toBeCloseTo(0.10, 6);
      expect(body.total).toBeCloseTo(0.11, 6);
      expect(body.currency).toBe('USD');
      expect(body.wouldExceedCap).toBe(false);
    } finally { setPaidTransportForTests(null); await app.close(); cleanup(); }
  });

  it('scales the STS estimate with duration, not with character count', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await makeProject(root, 'p1', { seconds: 20 });
      const many = JSON.parse((await app.inject({ method: 'GET', url: url(400, 2) })).body);
      const long = JSON.parse((await app.inject({ method: 'GET', url: url(10, 120) })).body);
      const stsOf = (body: any) => body.steps.find((step: any) => step.step === 'sts').estimated;

      // A wordy patch in a 2-second slot: the naive "double the per-char figure" model
      // overcharged this by an order of magnitude.
      expect(stsOf(many)).toBeCloseTo(4 / 60 * 0.1, 6);
      expect(stsOf(long)).toBeCloseTo(240 / 60 * 0.1, 6);
      expect(stsOf(long)).toBeGreaterThan(stsOf(many));
    } finally { await app.close(); cleanup(); }
  });

  it('honors a costPerUnit override as a flat per-call amount, like the adapters do', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await makeProject(root, 'p1', { seconds: 20 });
      upsertProvider({ homeDir: home, provider: { id: 'tts.elevenlabs-sts', kind: 'tts', name: 'elevenlabs-sts', tier: 'paid', costPerUnit: { currency: 'USD', unit: 'call', amount: 0.42 } } });

      const body = JSON.parse((await app.inject({ method: 'GET', url: url(100, 30) })).body);

      // The mirrored client model could not see this at all and would have reported $0.05.
      expect(body.steps.find((step: any) => step.step === 'sts').estimated).toBeCloseTo(0.42, 6);
      expect(body.total).toBeCloseTo(0.43, 6);
    } finally { await app.close(); cleanup(); }
  });

  it('reports the cap group and refuses when the shared ceiling would be breached', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 20 });
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 0.001 } });

      const body = JSON.parse((await app.inject({ method: 'GET', url: url(100, 30) })).body);

      expect(body.cap.limit).toBe(0.001);
      // A cap set on the user-facing id covers the hidden ones that bill the same account.
      expect(body.cap.group).toEqual(expect.arrayContaining(['tts.elevenlabs', 'tts.elevenlabs-sts', 'clone.elevenlabs']));
      expect(body.wouldExceedCap).toBe(true);
      expect(body.refusal).toBe('cap-exceeded');
    } finally { await app.close(); cleanup(); }
  });

  it('admits the call when the cap is comfortable', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 20 });
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 100 } });

      const body = JSON.parse((await app.inject({ method: 'GET', url: url(100, 30) })).body);

      expect(body.wouldExceedCap).toBe(false);
      expect(body.cap.spent).toBe(0);
    } finally { await app.close(); cleanup(); }
  });

  it('refuses (rather than reporting "fine") when the ledger cannot be totalled', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 20 });
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 100 } });
      // The same garbage that makes runProvider refuse the real call.
      writeFileSync(join(fixture.workspace, 'logs/provider-requests.jsonl'), '{"this is not a ledger row"\n');

      const body = JSON.parse((await app.inject({ method: 'GET', url: url(100, 30) })).body);

      expect(body.wouldExceedCap).toBe(true);
      expect(body.refusal).toBe('ledger-unreadable');
      expect(body.cap.spent).toBeNull();
    } finally { await app.close(); cleanup(); }
  });

  it('reports no cap pressure when none is configured', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await makeProject(root, 'p1', { seconds: 20 });
      const body = JSON.parse((await app.inject({ method: 'GET', url: url(100, 30) })).body);
      expect(body.cap.limit).toBeNull();
      expect(body.wouldExceedCap).toBe(false);
    } finally { await app.close(); cleanup(); }
  });

  it('rejects nonsense inputs rather than pricing them', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await makeProject(root, 'p1', { seconds: 20 });
      for (const bad of ['chars=-1&sourceDurationSec=1', 'chars=abc&sourceDurationSec=1', 'chars=1&sourceDurationSec=-4', 'chars=1']) {
        const res = await app.inject({ method: 'GET', url: `/api/projects/p1/manifest/voice-patches/estimate?${bad}` });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).errorCode).toBe('invalid-estimate-input');
      }
    } finally { await app.close(); cleanup(); }
  });

  it('is a pure read — asking twice changes nothing in the ledger', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 20 });
      await app.inject({ method: 'GET', url: url(100, 30) });
      await app.inject({ method: 'GET', url: url(100, 30) });
      const body = JSON.parse((await app.inject({ method: 'GET', url: url(100, 30) })).body);
      // No reservation, no ledger row: spend stays at zero across repeated estimates.
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 100 } });
      const capped = JSON.parse((await app.inject({ method: 'GET', url: url(100, 30) })).body);
      expect(body.total).toBeCloseTo(capped.total, 6);
      expect(capped.cap.spent).toBe(0);
    } finally { await app.close(); cleanup(); }
  });
});

describe('clone-chain estimate — ORDERED batch admission', () => {
  it('refuses two calls that each fit but do not fit in sequence', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 20 });
      // TTS $0.01, STS $0.10 (30s selection admitted against a 60s bound), total $0.11. A
      // $0.105 ceiling admits either call alone — and in production bills the TTS and then
      // refuses the STS, charging for half a generation.
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 0.105 } });

      const body = JSON.parse((await app.inject({ method: 'GET', url: url(100, 30) })).body);

      expect(body.steps.find((step: any) => step.step === 'tts').estimated).toBeCloseTo(0.01, 6);
      expect(body.steps.find((step: any) => step.step === 'sts').estimated).toBeCloseTo(0.10, 6);
      expect(body.wouldExceedCap).toBe(true);
      expect(body.refusal).toBe('cap-exceeded');
      // The FIRST call is affordable; the second is the one that breaks.
      expect(body.refusedAtStep).toBe('sts');
      expect(body.steps.find((step: any) => step.step === 'tts').refusal).toBeUndefined();
    } finally { await app.close(); cleanup(); }
  });

  it('admits the same pair when the ceiling covers the whole sequence', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 20 });
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 0.111 } });
      const body = JSON.parse((await app.inject({ method: 'GET', url: url(100, 30) })).body);
      expect(body.wouldExceedCap).toBe(false);
    } finally { await app.close(); cleanup(); }
  });

  it('marks the clone-chain verdict advisory — the STS source does not exist yet', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await makeProject(root, 'p1', { seconds: 20 });
      const body = JSON.parse((await app.inject({ method: 'GET', url: url(100, 30) })).body);
      // Production measures the TTS OUTPUT duration; this is priced off the selection.
      expect(body.authoritative).toBe(false);
      expect(body.basis).toBe('selection-duration');
    } finally { await app.close(); cleanup(); }
  });

  it('refuses when only the hidden STS id is capped and the group ledger cannot be read', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 20 });
      // A cap on the HIDDEN id only. runProvider still preflights the whole group's ledger, so
      // an estimator that scanned the STS id alone would admit a call execution refuses.
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs-sts': 100 } });
      writeFileSync(join(fixture.workspace, 'logs/provider-requests.jsonl'), '{"this is not a ledger row"\n');

      const body = JSON.parse((await app.inject({ method: 'GET', url: url(100, 30) })).body);

      expect(body.wouldExceedCap).toBe(true);
      expect(body.refusal).toBe('ledger-unreadable');
    } finally { await app.close(); cleanup(); }
  });
});

describe('estimate endpoints are strictly read-only', () => {
  it('leaves the entire settings directory byte-identical', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 20 });
      // Materialize whatever a normal project start creates, then snapshot everything.
      await app.inject({ method: 'GET', url: '/api/projects/p1/voice/status' });
      const before = snapshotTree(home);
      const workspaceBefore = snapshotTree(fixture.workspace);

      await app.inject({ method: 'GET', url: url(100, 30) });
      await app.inject({ method: 'GET', url: '/api/projects/p1/tts-estimate?providerId=tts.elevenlabs&chars=100' });

      // providers.json in particular: the route used to "ensure" both providers, which writes.
      expect(snapshotTree(home)).toEqual(before);
      expect(snapshotTree(fixture.workspace)).toEqual(workspaceBefore);
    } finally { await app.close(); cleanup(); }
  });

  it('prices an unregistered provider from its adapter defaults rather than registering it', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await makeProject(root, 'p1', { seconds: 20 });
      const before = snapshotTree(home);

      const body = JSON.parse((await app.inject({ method: 'GET', url: url(100, 30) })).body);

      expect(body.total).toBeCloseTo(0.11, 6);
      expect(snapshotTree(home)).toEqual(before);
    } finally { await app.close(); cleanup(); }
  });

  it('does not persist a schema migration of an older provider registry', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await makeProject(root, 'p1', { seconds: 20 });
      // The settings dir is `.etvs` (providerSettings.ts:247). The earlier version of this test
      // wrote `.etvideoscript/`, which production never reads — so it passed without ever
      // exercising the migration path it claims to cover.
      const registryPath = join(home, '.etvs', 'providers.json');
      mkdirSync(join(home, '.etvs'), { recursive: true });
      const legacy = JSON.stringify({ schemaVersion: 0, providers: [], updatedAt: '2026-01-01T00:00:00.000Z' });
      writeFileSync(registryPath, legacy);

      await app.inject({ method: 'GET', url: url(100, 30) });

      // Reading to answer a question must not rewrite the user's settings (nor drop a .bak).
      expect(readFileSync(registryPath, 'utf8')).toBe(legacy);
      expect(existsSync(`${registryPath}.v0.bak`)).toBe(false);
    } finally { await app.close(); cleanup(); }
  });
});

describe('legacy single-call TTS estimate', () => {
  it('prices the configured provider server-side', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await makeProject(root, 'p1', { seconds: 20 });
      const body = JSON.parse((await app.inject({ method: 'GET', url: '/api/projects/p1/tts-estimate?providerId=tts.elevenlabs&chars=100' })).body);
      expect(body.calls).toBe(1);
      expect(body.total).toBeCloseTo(0.01, 6);
      expect(body.currency).toBe('USD');
      // The text is exact here, so unlike the chain this verdict is not a projection.
      expect(body.authoritative).toBe(true);
    } finally { await app.close(); cleanup(); }
  });

  it('prices a local provider at zero and never reports cap pressure for it', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 20 });
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.mock': 0.000001 } });
      const body = JSON.parse((await app.inject({ method: 'GET', url: '/api/projects/p1/tts-estimate?providerId=tts.mock&chars=5000' })).body);
      expect(body.wouldExceedCap).toBe(false);
    } finally { await app.close(); cleanup(); }
  });

  it('rejects a missing or malformed providerId', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await makeProject(root, 'p1', { seconds: 20 });
      for (const qs of ['chars=10', 'providerId=&chars=10', 'providerId=../../etc/passwd&chars=10', 'providerId=tts.mock&chars=10&model=%20bad%20']) {
        const res = await app.inject({ method: 'GET', url: `/api/projects/p1/tts-estimate?${qs}` });
        expect(res.statusCode).toBe(400);
      }
    } finally { await app.close(); cleanup(); }
  });
});

describe('estimate input bounds', () => {
  it('rejects empty, fractional, huge and non-integer character counts', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await makeProject(root, 'p1', { seconds: 20 });
      for (const chars of ['', '0', '1.5', '1e9', '100000000', 'Infinity', '20001']) {
        const res = await app.inject({ method: 'GET', url: `/api/projects/p1/manifest/voice-patches/estimate?chars=${encodeURIComponent(chars)}&sourceDurationSec=1` });
        expect(res.statusCode, `chars=${chars}`).toBe(400);
      }
    } finally { await app.close(); cleanup(); }
  });

  it('rejects an out-of-range source duration but accepts zero', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await makeProject(root, 'p1', { seconds: 20 });
      expect((await app.inject({ method: 'GET', url: url(10, 86401) })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: url(10, 0) })).statusCode).toBe(200);
    } finally { await app.close(); cleanup(); }
  });

  it('accepts the maximum, and the clone-chain POST accepts text of that same length', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await makeProject(root, 'p1', { seconds: 20 });
      // The estimate bound must not be stricter than the request bound, or the UI cannot price
      // a patch the route would accept.
      expect((await app.inject({ method: 'GET', url: url(20000, 1) })).statusCode).toBe(200);
      const overlong = await app.inject({
        method: 'POST', url: '/api/projects/p1/manifest/voice-patches',
        payload: { mode: 'clone-chain', requestId: 'vp-bound-check-0001', start: 0, end: 1, text: 'x'.repeat(20001) }
      });
      expect(overlong.statusCode).toBe(400);
      expect(JSON.parse(overlong.body).errorCode).toBe('invalid-text');
    } finally { await app.close(); cleanup(); }
  });
});

describe('estimate refusal discriminators (round-4 P2-2 / P2-3)', () => {
  it('says "step-alone" when a single call already breaches the ceiling', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 20 });
      // Below the TTS price on its own — the sequence is not what makes this fail.
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 0.001 } });

      const body = JSON.parse((await app.inject({ method: 'GET', url: url(100, 30) })).body);

      expect(body.refusal).toBe('cap-exceeded');
      expect(body.refusalScope).toBe('step-alone');
      expect(body.refusedAtStep).toBe('tts');
    } finally { await app.close(); cleanup(); }
  });

  it('says "sequence-only" when each call fits but the pair does not', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 20 });
      // TTS $0.01, STS $0.10: either alone fits under $0.105; together they do not.
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 0.105 } });

      const body = JSON.parse((await app.inject({ method: 'GET', url: url(100, 30) })).body);

      expect(body.refusalScope).toBe('sequence-only');
      expect(body.refusedAtStep).toBe('sts');
      expect(body.steps.find((step: any) => step.step === 'tts').refusal).toBeUndefined();
    } finally { await app.close(); cleanup(); }
  });

  it('refuses a DISABLED provider rather than reporting it admissible', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await makeProject(root, 'p1', { seconds: 20 });
      // runProvider refuses a disabled provider outright, so an estimate that priced it happily
      // promised a call that cannot run — and pointed the user at the cap, which is not the fix.
      upsertProvider({ homeDir: home, provider: { id: 'tts.elevenlabs', kind: 'tts', name: 'elevenlabs', tier: 'paid', enabled: false } });

      const body = JSON.parse((await app.inject({ method: 'GET', url: url(100, 30) })).body);

      expect(body.wouldExceedCap).toBe(true);
      expect(body.refusal).toBe('provider-disabled');
      expect(body.refusedAtStep).toBe('tts');
      expect(body.refusalScope).toBeUndefined();
    } finally { await app.close(); cleanup(); }
  });
});
