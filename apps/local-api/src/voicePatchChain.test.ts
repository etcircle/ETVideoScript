import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendVoicePatchStepRecord,
  loadManifestV3,
  readProviderRequests,
  saveManifestV3,
  providerEstimatedSpend,
  readWorkspaceSettings,
  setProviderSecret,
  setPaidTransportForTests,
  writeWorkspaceSettings,
  voicePatchAccountingRequestId,
  voicePatchStepRecordId,
  voicePatchStepState,
  type PatchTransports
} from '@etvideoscript/core';
import { createApp, type LocalApiDeps } from './server';
import { appendApprovedRowWithSnapshot, readAdmissionGrant } from './voicePatchChain';
import { CloneChainGrantSchema, CLONE_CHAIN_GRANT_SKEW_MS, CLONE_CHAIN_GRANT_TTL_MS, grantFromAdmission, grantTotal, isGrantFresh } from './voiceRoutes';
import { readRootTerminals, readCommitMarkers, writeCommitMarker } from './voiceDurableState';
import { makeProject, seedPreparedVoice, writeTone } from './voiceFixtures';

function config(root: string, settingsHome: string) {
  return { host: '127.0.0.1', port: 0, workspaceRoot: root, enableTerminal: false, allowedOrigins: ['http://127.0.0.1:4318'], lanOrigins: [], terminalToken: null, settingsHome };
}

function roots() {
  const root = mkdtempSync(join(tmpdir(), 'etvs-patch-root-'));
  const home = mkdtempSync(join(tmpdir(), 'etvs-patch-home-'));
  return { root, home, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

const audioCache = new Map<string, Buffer>();
function toneBytes(seconds: number, hz: number): Buffer {
  const key = `${seconds}:${hz}`;
  const cached = audioCache.get(key);
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), 'etvs-patch-audio-'));
  writeTone(join(dir, 'a.wav'), seconds, hz);
  const bytes = readFileSync(join(dir, 'a.wav'));
  rmSync(dir, { recursive: true, force: true });
  audioCache.set(key, bytes);
  return bytes;
}

/** Transports that record their calls, so "was this re-billed?" is directly assertable. */
function fakeTransports(overrides: Partial<PatchTransports> = {}) {
  const calls: string[] = [];
  const transports: PatchTransports = {
    async tts(input) { calls.push('tts'); return overrides.tts ? overrides.tts(input) : { audio: toneBytes(1.0, 300), providerStatus: 200 }; },
    async sts(input) { calls.push('sts'); return overrides.sts ? overrides.sts(input) : { audio: toneBytes(1.2, 260), providerStatus: 200 }; }
  };
  return { transports, calls };
}

const REQUEST_ID = 'req-clone-chain-0001';

/** Stand-in for "the process died here" inside an injected transport. */
class SimulatedProcessDeath extends Error {
  constructor() { super('simulated process death'); this.name = 'SimulatedProcessDeath'; }
}

function patchBody(extra: Record<string, unknown> = {}) {
  return { mode: 'clone-chain', requestId: REQUEST_ID, start: 10, end: 11, text: 'brand new words', ...extra };
}

async function setupReady(root: string, home: string, options: Parameters<typeof makeProject>[2] = {}) {
  const fixture = await makeProject(root, 'p1', { seconds: 60, realVideo: false, ...options });
  seedPreparedVoice(home, 'p1', fixture.cleanupKey);
  return fixture;
}

describe('clone-chain voice-patch route (S1b W1.7/W1.8)', () => {
  // ── D3: the patch route never clones ────────────────────────────────────────
  it('refuses with clone-not-ready when no voice has been prepared', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports });
    try {
      await makeProject(root, 'p1', { seconds: 20 });
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).errorCode).toBe('clone-not-ready');
    } finally { await app.close(); cleanup(); }
  });

  it('refuses with clone-stale when the cleaned bed is no longer fresh — never falls back to raw (D6)', async () => {
    const { root, home, cleanup } = roots();
    const { transports, calls } = fakeTransports();
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 20, cleanup: 'disabled' });
      seedPreparedVoice(home, 'p1', fixture.cleanupKey);
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).errorCode).toBe('clone-stale');
      expect(calls).toEqual([]); // and nothing paid was attempted
    } finally { await app.close(); cleanup(); }
  });

  // ── ⟨Q6⟩ strict intake ──────────────────────────────────────────────────────
  it('rejects voice/model/provider overrides and unknown fields in clone-chain mode', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports });
    try {
      await setupReady(root, home);
      for (const field of ['provider', 'voice', 'voiceRef', 'model', 'language', 'cloneScope', 'referenceRange']) {
        const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody({ [field]: 'x' }) });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).errorCode).toBe('field-not-allowed');
      }
      const unknown = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody({ somethingElse: 1 }) });
      expect(unknown.statusCode).toBe(400);
      // requestId is MANDATORY in clone-chain (⟨R6⟩) — it is what makes a retry a replay.
      const noId = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: { mode: 'clone-chain', start: 10, end: 11, text: 'x' } });
      expect(noId.statusCode).toBe(400);
      expect(JSON.parse(noId.body).errorCode).toBe('invalid-request-id');
      const badMode = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody({ mode: 'something' }) });
      expect(badMode.statusCode).toBe(400);
      expect(JSON.parse(badMode.body).errorCode).toBe('invalid-mode');
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('leaves the legacy path untouched when mode is omitted (⟨R6⟩)', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await setupReady(root, home);
      // No mode ⇒ legacy-tts ⇒ the mock provider path existing callers rely on.
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: { start: 10, end: 11, text: 'legacy words', provider: 'mock', requestId: 'legacy-request-1' } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).operation.status).toBe('approved');
      // An explicit legacy-tts is the same path. Run it on a SEPARATE project: phrase snapping
      // over this fixture's gapless transcript widens to the whole run, so a second patch in
      // the same project would legitimately fail the overlap validator.
      await makeProject(root, 'p2', { seconds: 60 });
      const explicit = await app.inject({ method: 'POST', url: '/api/projects/p2/manifest/voice-patches', payload: { mode: 'legacy-tts', start: 20, end: 21, text: 'more legacy words', provider: 'mock', requestId: 'legacy-request-2' } });
      expect(explicit.statusCode).toBe(200);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('keeps UNTAGGED v1 bodyHashes replaying against the frozen v1 canonicalizer (⟨Q3⟩)', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      const fixture = await setupReady(root, home);
      // The fixture is generated BY THE CURRENT CODE on the legacy path, so its stored hash is
      // exactly what shipped workspaces contain: untagged hex, produced without clipId.
      const payload = { start: 10, end: 11, text: 'legacy words', provider: 'mock', requestId: 'legacy-request-1' };
      const first = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload });
      expect(first.statusCode).toBe(200);
      const stored = readProviderRequests(fixture.workspace).find((entry) => entry.requestId === 'legacy-request-1' && (entry as { bodyHash?: string }).bodyHash) as { bodyHash: string };
      expect(stored.bodyHash).toMatch(/^[0-9a-f]{64}$/); // untagged ⇒ v1
      expect(stored.bodyHash.startsWith('v2:')).toBe(false);

      // Matching replay works...
      const replay = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload });
      expect(replay.statusCode).toBe(200);
      expect(JSON.parse(replay.body).providerRequestId).toBe('legacy-request-1');
      // ...and a mismatched body on the same requestId is a 409, not a silent second synthesis.
      const conflict = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: { ...payload, text: 'different legacy words' } });
      expect(conflict.statusCode).toBe(409);
      expect(JSON.parse(conflict.body).error).toMatch(/different voice patch body/);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  // ── Happy path + replay ─────────────────────────────────────────────────────
  it('generates end to end, approves the op with the FINAL probed duration, and accounts BOTH paid steps separately', async () => {
    const { root, home, cleanup } = roots();
    const { transports, calls } = fakeTransports();
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(calls).toEqual(['tts', 'sts']);
      expect(body.operation).toMatchObject({ status: 'approved', seamBaked: true, clipId: 'clip_001' });
      expect(body.voiceId).toBe('el-voice-abc');
      expect(body.operation.durationGeneratedSec).toBeGreaterThan(0.1);
      expect(existsSync(join(fixture.workspace, body.operation.asset))).toBe(true);

      const op = loadManifestV3(fixture.workspace).operations.find((entry) => entry.id === body.operation.id)!;
      expect(op.status).toBe('approved');

      // ⟨R8⟩ both intermediate artifacts persisted under the canonical steps/ path.
      for (const step of ['tts', 'sts'] as const) {
        expect(existsSync(join(fixture.workspace, `assets/voice/steps/${voicePatchStepRecordId(REQUEST_ID, step)}.wav`))).toBe(true);
        expect(body.steps[step].sha256).toHaveLength(64);
        expect(body.steps[step].replayed).toBe(false);
      }
      // D7: two paid calls, two DISTINCT accounting request ids, each independently ledgered.
      const ledger = readProviderRequests(fixture.workspace);
      const ttsAcct = voicePatchAccountingRequestId(REQUEST_ID, 'tts');
      const stsAcct = voicePatchAccountingRequestId(REQUEST_ID, 'sts');
      expect(ttsAcct).not.toBe(stsAcct);
      // The step ledger records reference them, and the two steps never share a record id.
      const stepRecords = ledger.filter((entry) => (entry as { recordKind?: string }).recordKind === 'voice-patch-step');
      expect(new Set(stepRecords.map((entry) => entry.requestId)).size).toBe(2);
      expect(new Set(stepRecords.map((entry) => (entry as { accountingRequestId?: string }).accountingRequestId))).toEqual(new Set([ttsAcct, stsAcct]));
      // Exactly-once root terminal.
      expect(readRootTerminals(fixture.workspace)).toHaveLength(1);
      expect(readCommitMarkers(fixture.workspace)).toEqual({});
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('exposes per-step progress off the step ledger while the POST is in flight (⟨R7⟩)', async () => {
    const { root, home, cleanup } = roots();
    let releaseSts: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseSts = resolve; });
    const transports: PatchTransports = {
      async tts() { return { audio: toneBytes(1.0, 300) }; },
      async sts() { await gate; return { audio: toneBytes(1.2, 260) }; }
    };
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      await setupReady(root, home);
      const inFlight = app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      // Poll until the TTS terminal has landed and STS is the running step.
      let progress: any;
      for (let attempt = 0; attempt < 400; attempt++) {
        const res = await app.inject({ method: 'GET', url: `/api/projects/p1/manifest/voice-patches/${REQUEST_ID}/progress` });
        progress = JSON.parse(res.body);
        if (progress.steps[0].status === 'succeeded' && progress.steps[1].status === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(progress.steps[0]).toMatchObject({ step: 'tts', status: 'succeeded' });
      expect(progress.steps[1]).toMatchObject({ step: 'sts', status: 'running' });
      expect(progress.done).toBe(false);

      releaseSts!();
      await inFlight;
      const after = JSON.parse((await app.inject({ method: 'GET', url: `/api/projects/p1/manifest/voice-patches/${REQUEST_ID}/progress` })).body);
      expect(after).toMatchObject({ done: true, httpStatus: 200, seam: 'succeeded' });
      expect(after.steps.map((step: any) => step.status)).toEqual(['succeeded', 'succeeded']);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('replays the root terminal BYTE-FOR-BYTE on a repeat requestId, with no second paid call', async () => {
    const { root, home, cleanup } = roots();
    const { transports, calls } = fakeTransports();
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      const first = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      const second = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(second.statusCode).toBe(first.statusCode);
      expect(second.body).toBe(first.body);
      expect(calls).toEqual(['tts', 'sts']);
      expect(readRootTerminals(fixture.workspace)).toHaveLength(1);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('409s a requestId reused with a DIFFERENT body (⟨R2⟩ envelope covers clipId and mode)', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports });
    try {
      await setupReady(root, home);
      await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      const conflict = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody({ text: 'completely different words' }) });
      expect(conflict.statusCode).toBe(409);
      expect(JSON.parse(conflict.body).errorCode).toBe('request-id-conflict');
      // clipId is part of the v2 envelope precisely because v1 omitted it.
      const clipConflict = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody({ clipId: 'clip_001' }) });
      expect(clipConflict.statusCode).toBe(409);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  // ── ⟨F4⟩ root replay for all four error shapes ──────────────────────────────
  const failures: Array<{ name: string; overrides: Partial<PatchTransports>; status: number; errorCode: string }> = [
    { name: 'TTS failure', overrides: { tts: async () => { const e = new Error('ElevenLabs TTS failed with HTTP 429') as Error & { providerStatus?: number }; e.providerStatus = 429; throw e; } }, status: 502, errorCode: 'tts-failed' },
    { name: 'STS failure', overrides: { sts: async () => { const e = new Error('ElevenLabs speech-to-speech failed with HTTP 500') as Error & { providerStatus?: number }; e.providerStatus = 500; throw e; } }, status: 502, errorCode: 'sts-failed' },
    { name: 'degraded output', overrides: { sts: async () => ({ audio: Buffer.alloc(44) }) }, status: 502, errorCode: 'seam-bake-failed' }
  ];
  for (const failure of failures) {
    it(`records ${failure.name} as an exactly-once root terminal, rejects the op, and replays on retry`, async () => {
      const { root, home, cleanup } = roots();
      const { transports, calls } = fakeTransports(failure.overrides);
      const app = createApp(config(root, home), { cloneChainTransports: transports });
      try {
        const fixture = await setupReady(root, home);
        const first = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
        expect(first.statusCode).toBe(failure.status);
        expect(JSON.parse(first.body).errorCode).toBe(failure.errorCode);
        // The op is REJECTED (reversible), never left stranded as 'proposed'.
        const op = loadManifestV3(fixture.workspace).operations.find((entry) => entry.providerRequestId === REQUEST_ID)!;
        expect(op.status).toBe('rejected');

        const callsAfterFirst = [...calls];
        const retry = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
        expect(retry.statusCode).toBe(first.statusCode);
        expect(retry.body).toBe(first.body);
        expect(calls).toEqual(callsAfterFirst); // no re-billing
        expect(readRootTerminals(fixture.workspace)).toHaveLength(1);
      } finally { await app.close(); cleanup(); }
    }, 60000);
  }

  it('records a Phase-3 conflict when Studio Sound changes mid-generation, and replays it (D5/D6 snapshot guard)', async () => {
    const { root, home, cleanup } = roots();
    let fixtureWorkspace = '';
    const transports: PatchTransports = {
      async tts() { return { audio: toneBytes(1.0, 300) }; },
      async sts() {
        // Simulate the user re-running Studio Sound while the patch was generating: the
        // execution snapshot no longer describes the recording the audio was made for.
        const manifest = loadManifestV3(fixtureWorkspace);
        manifest.studioCleanup = { ...manifest.studioCleanup!, cacheKey: 'f'.repeat(64), assetPath: `assets/studio-clean/${'f'.repeat(64)}.wav` } as never;
        saveManifestV3(fixtureWorkspace, manifest, { revision: false });
        writeTone(join(fixtureWorkspace, `assets/studio-clean/${'f'.repeat(64)}.wav`), 60, 150);
        return { audio: toneBytes(1.2, 260) };
      }
    };
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      fixtureWorkspace = fixture.workspace;
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).errorCode).toBe('snapshot-conflict');
      const op = loadManifestV3(fixture.workspace).operations.find((entry) => entry.providerRequestId === REQUEST_ID)!;
      expect(op.status).toBe('rejected');
      const replay = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(replay.body).toBe(res.body);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  // ── Crash / restart at each step boundary (pre-seeded ledger states) ─────────
  it('treats a pre-seeded start marker with no terminal as unknown-outcome and NEVER re-bills it', async () => {
    const { root, home, cleanup } = roots();
    const { transports, calls } = fakeTransports();
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      // Crash between markStarted and the terminal — the money may already be spent.
      appendVoicePatchStepRecord(fixture.workspace, {
        recordKind: 'voice-patch-step', requestId: voicePatchStepRecordId(REQUEST_ID, 'tts'), parentRequestId: REQUEST_ID,
        step: 'tts', projectId: 'p1', operationId: '', provider: 'tts.elevenlabs', status: 'started', createdAt: new Date().toISOString()
      });
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).errorCode).toBe('paid-step-unknown-outcome');
      expect(calls).toEqual([]);
      // Sticky: a retry replays, it does not "try again".
      const retry = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(retry.body).toBe(res.body);
      expect(calls).toEqual([]);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('resumes from a persisted TTS terminal without re-billing the TTS step', async () => {
    const { root, home, cleanup } = roots();
    const { transports, calls } = fakeTransports();
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      // A prior attempt completed TTS and died before STS.
      const ttsRel = `assets/voice/steps/${voicePatchStepRecordId(REQUEST_ID, 'tts')}.wav`;
      const ttsBytes = toneBytes(1.0, 300);
      mkdirSync(join(fixture.workspace, 'assets/voice/steps'), { recursive: true });
      writeFileSync(join(fixture.workspace, ttsRel), ttsBytes);
      appendVoicePatchStepRecord(fixture.workspace, {
        recordKind: 'voice-patch-step', requestId: voicePatchStepRecordId(REQUEST_ID, 'tts'), parentRequestId: REQUEST_ID,
        step: 'tts', projectId: 'p1', operationId: '', provider: 'tts.elevenlabs', status: 'succeeded',
        createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        artifact: { relPath: ttsRel, bytes: ttsBytes.byteLength, sha256: createHash('sha256').update(ttsBytes).digest('hex'), durationSec: 1 }
      });
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(200);
      expect(calls).toEqual(['sts']); // TTS was replayed, only STS was paid for
      expect(JSON.parse(res.body).steps.tts.replayed).toBe(true);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('refuses a replayed step artifact that was swapped for a symlink (post-write race, ⟨Q7⟩)', async () => {
    const { root, home, cleanup } = roots();
    const { transports, calls } = fakeTransports();
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      const ttsRel = `assets/voice/steps/${voicePatchStepRecordId(REQUEST_ID, 'tts')}.wav`;
      const ttsBytes = toneBytes(1.0, 300);
      mkdirSync(join(fixture.workspace, 'assets/voice/steps'), { recursive: true });
      const decoy = join(fixture.workspace, 'assets/voice/steps/decoy.wav');
      writeFileSync(decoy, ttsBytes);
      symlinkSync(decoy, join(fixture.workspace, ttsRel));
      appendVoicePatchStepRecord(fixture.workspace, {
        recordKind: 'voice-patch-step', requestId: voicePatchStepRecordId(REQUEST_ID, 'tts'), parentRequestId: REQUEST_ID,
        step: 'tts', projectId: 'p1', operationId: '', provider: 'tts.elevenlabs', status: 'succeeded',
        createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        artifact: { relPath: ttsRel, bytes: ttsBytes.byteLength, sha256: createHash('sha256').update(ttsBytes).digest('hex'), durationSec: 1 }
      });
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).errorCode).toBe('step-artifact-corrupt');
      expect(calls).toEqual([]);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('completes an interrupted Phase-3 commit from its marker, and refuses to overwrite a conflicting terminal (⟨Q1⟩)', async () => {
    const { root, home, cleanup } = roots();
    const { transports } = fakeTransports();
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      // First run to completion so we have a real operation to recover against.
      const done = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      const operationId = JSON.parse(done.body).operation.id;

      const existingTerminal = readRootTerminals(fixture.workspace)[0]!;
      const opBefore = loadManifestV3(fixture.workspace).operations.find((entry) => entry.id === operationId)!;
      expect(opBefore.status).toBe('approved');

      // Simulate a crash after a marker was written but before its terminal — where the marker
      // describes an outcome the ledger already contradicts. It must neither overwrite the
      // terminal NOR apply its mutation.
      writeCommitMarker(fixture.workspace, {
        requestId: REQUEST_ID, projectId: 'p1', operationId, assetRel: 'assets/voice/other.wav',
        intendedOutcome: 'reject', httpStatus: 502, serializedBody: JSON.stringify({ error: 'different outcome' }),
        bodyHash: existingTerminal.bodyHash,
        executionSnapshot: existingTerminal.executionSnapshot!,
        expectedOpPreimage: { status: 'proposed', providerRequestId: REQUEST_ID, text: 'brand new words', targetStart: opBefore.target.start, targetEnd: opBefore.target.end },
        expectedOpPostimage: { status: 'rejected', providerRequestId: REQUEST_ID, text: 'brand new words', targetStart: opBefore.target.start, targetEnd: opBefore.target.end },
        createdAt: new Date().toISOString()
      });
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).errorCode).toBe('ledger-corruption');
      // The original terminal survives untouched, and the marker is retained for inspection.
      expect(readRootTerminals(fixture.workspace)).toHaveLength(1);
      expect(readRootTerminals(fixture.workspace)[0]!.httpStatus).toBe(200);
      expect(Object.keys(readCommitMarkers(fixture.workspace))).toEqual([REQUEST_ID]);
      // AND the manifest is untouched: recovery inspects terminals BEFORE mutating, so a
      // marker we refuse to publish can never flip an approved op to rejected.
      expect(loadManifestV3(fixture.workspace).operations.find((entry) => entry.id === operationId)!.status).toBe('approved');
    } finally { await app.close(); cleanup(); }
  }, 60000);

  // ── ⟨Q1⟩ crash windows, exercised by real fault injection + restart ─────────
  // The commit protocol is: write marker → mutate manifest → append terminal → clear marker.
  // Each window is killed for real, the app is RESTARTED (a fresh createApp, so nothing is in
  // memory), and both the terminal AND the manifest are asserted — a protocol that publishes the
  // right terminal while leaving the timeline in the wrong state is still broken.
  const windows: Array<{ window: 'after-marker' | 'after-mutation' | 'after-terminal'; opAfterCrash: string }> = [
    { window: 'after-marker', opAfterCrash: 'proposed' },
    { window: 'after-mutation', opAfterCrash: 'approved' },
    { window: 'after-terminal', opAfterCrash: 'approved' }
  ];
  for (const { window, opAfterCrash } of windows) {
    it(`recovers a commit crashed ${window}, converging on the same terminal AND the same manifest`, async () => {
      const { root, home, cleanup } = roots();
      const crashed = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports, commitCrashAt: window });
      const fixture = await setupReady(root, home);
      try {
        const boom = await crashed.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
        expect(boom.statusCode).toBe(500); // the "process died" — no response the client can use
      } finally { await crashed.close(); }

      // Mid-crash state: the marker is pending, and the manifest is wherever the crash left it.
      expect(Object.keys(readCommitMarkers(fixture.workspace))).toEqual([REQUEST_ID]);
      const opMid = loadManifestV3(fixture.workspace).operations.find((entry) => entry.providerRequestId === REQUEST_ID)!;
      expect(opMid.status).toBe(opAfterCrash);

      // RESTART, and let the same requestId arrive again (the client's transport retry).
      const { transports, calls } = fakeTransports();
      const restarted = createApp(config(root, home), { cloneChainTransports: transports });
      try {
        const res = await restarted.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).operation.status).toBe('approved');
        // The steps were already paid for before the crash; recovery must not re-bill them.
        expect(calls).toEqual([]);
        // Protocol completed: exactly one terminal, no marker left behind, op approved.
        expect(readRootTerminals(fixture.workspace)).toHaveLength(1);
        expect(readCommitMarkers(fixture.workspace)).toEqual({});
        const op = loadManifestV3(fixture.workspace).operations.find((entry) => entry.providerRequestId === REQUEST_ID)!;
        expect(op.status).toBe('approved');
        expect((op as any).durationGeneratedSec).toBeGreaterThan(0.1);
      } finally { await restarted.close(); cleanup(); }
    }, 60000);
  }

  // ── P1-2: the user edits or removes the op DURING the paid call ─────────────
  it('PRESERVES an operation the user rejected mid-generation instead of overwriting it, and still records a terminal', async () => {
    const { root, home, cleanup } = roots();
    let workspace = '';
    let operationId = '';
    const transports: PatchTransports = {
      async tts() { return { audio: toneBytes(1.0, 300) }; },
      async sts() {
        // The user rejects the proposed op while the paid call is in flight.
        const manifest = loadManifestV3(workspace);
        const op = manifest.operations.find((entry) => entry.providerRequestId === REQUEST_ID)!;
        operationId = op.id;
        (op as any).status = 'rejected';
        (op as any).reason = 'user changed their mind';
        saveManifestV3(workspace, manifest, { revision: false });
        const err = new Error('ElevenLabs speech-to-speech failed with HTTP 500') as Error & { providerStatus?: number };
        err.providerStatus = 500;
        throw err;
      }
    };
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      workspace = fixture.workspace;
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body).errorCode).toBe('operation-conflict');
      // The user's reason survives — our stale rejection did not clobber it.
      const op = loadManifestV3(fixture.workspace).operations.find((entry) => entry.id === operationId)!;
      expect(op.status).toBe('rejected');
      expect((op as any).reason).toBe('user changed their mind');
      // A terminal still exists, so a retry replays instead of re-billing.
      expect(readRootTerminals(fixture.workspace)).toHaveLength(1);
      const replay = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(replay.body).toBe(res.body);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('PRESERVES an operation the user re-worded mid-generation and refuses to attach the audio', async () => {
    const { root, home, cleanup } = roots();
    let workspace = '';
    const transports: PatchTransports = {
      async tts() { return { audio: toneBytes(1.0, 300) }; },
      async sts() {
        // A PATCH to the text keeps status and providerRequestId identical — status-only
        // matching would happily approve audio for the OLD wording.
        const manifest = loadManifestV3(workspace);
        const op = manifest.operations.find((entry) => entry.providerRequestId === REQUEST_ID)!;
        (op as any).text = 'the user typed something else';
        saveManifestV3(workspace, manifest, { revision: false });
        return { audio: toneBytes(1.2, 260) };
      }
    };
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      workspace = fixture.workspace;
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).errorCode).toBe('operation-conflict');
      const op = loadManifestV3(fixture.workspace).operations.find((entry) => entry.providerRequestId === REQUEST_ID)!;
      expect(op.status).toBe('proposed');            // still the user's, untouched
      expect((op as any).text).toBe('the user typed something else');
      expect((op as any).asset).toBeUndefined();     // and the audio was NOT attached
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('refuses to resume when the operation changed between Phase 1 and the retry — with zero provider calls', async () => {
    const { root, home, cleanup } = roots();
    // First attempt dies before any commit (crash at the marker window is not reached because
    // the STS step throws), leaving a Phase-1 op and an approved ledger row behind.
    const failing: PatchTransports = {
      async tts() { return { audio: toneBytes(1.0, 300) }; },
      async sts() { throw new SimulatedProcessDeath(); }
    };
    const first = createApp(config(root, home), { cloneChainTransports: failing });
    const fixture = await setupReady(root, home);
    try {
      await first.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
    } catch { /* the simulated death propagates */ } finally { await first.close(); }

    // Wipe the terminal the failure recorded so the retry takes the RESUME path, then edit the
    // operation — the resume must refuse rather than generate audio for what it now says.
    rmSync(join(fixture.workspace, 'logs/voice-patch-terminals.jsonl'), { force: true });
    const manifest = loadManifestV3(fixture.workspace);
    const op = manifest.operations.find((entry) => entry.providerRequestId === REQUEST_ID)!;
    (op as any).text = 'edited between phase 1 and the retry';
    saveManifestV3(fixture.workspace, manifest, { revision: false });

    const { transports, calls } = fakeTransports();
    const retry = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const res = await retry.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).errorCode).toBe('operation-conflict');
      expect(calls).toEqual([]);
    } finally { await retry.close(); cleanup(); }
  }, 60000);

  // ── P1-6: corrupt durable state fails closed ────────────────────────────────
  it('refuses to run when the reservation or terminal store is corrupt, instead of treating it as empty', async () => {
    const { root, home, cleanup } = roots();
    const { transports, calls } = fakeTransports();
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      // A truncated terminal log must NOT read as "no terminal" — that would re-execute (and
      // re-bill) a request whose outcome the user has already been given.
      writeFileSync(join(fixture.workspace, 'logs/voice-patch-terminals.jsonl'), '{"requestId":"req-clone-chain-0001","httpSta\n');
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(500);
      expect(calls).toEqual([]);

      // Two DIFFERENT terminals for one requestId are irreconcilable and must surface on the
      // ordinary replay path, not only during marker recovery.
      writeFileSync(join(fixture.workspace, 'logs/voice-patch-terminals.jsonl'), [
        JSON.stringify({ requestId: REQUEST_ID, projectId: 'p1', httpStatus: 200, serializedBody: '{"ok":1}', bodyHash: 'v2:a', createdAt: new Date().toISOString() }),
        JSON.stringify({ requestId: REQUEST_ID, projectId: 'p1', httpStatus: 502, serializedBody: '{"error":"other"}', bodyHash: 'v2:a', createdAt: new Date().toISOString() })
      ].join('\n') + '\n');
      const conflict = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(conflict.statusCode).toBe(500);
      expect(calls).toEqual([]);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('recovers a pending commit marker AT STARTUP, without the client ever retrying', async () => {
    const { root, home, cleanup } = roots();
    const crashed = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports, commitCrashAt: 'after-marker' });
    const fixture = await setupReady(root, home);
    try {
      await crashed.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
    } finally { await crashed.close(); }
    // Stranded: op still proposed, marker pending, no terminal.
    expect(loadManifestV3(fixture.workspace).operations.find((e) => e.providerRequestId === REQUEST_ID)!.status).toBe('proposed');
    expect(Object.keys(readCommitMarkers(fixture.workspace))).toEqual([REQUEST_ID]);

    // A fresh server with NO request for this id at all — startup recovery alone must finish it.
    const restarted = createApp(config(root, home));
    try {
      await restarted.ready();
      expect(readCommitMarkers(fixture.workspace)).toEqual({});
      expect(readRootTerminals(fixture.workspace)).toHaveLength(1);
      const op = loadManifestV3(fixture.workspace).operations.find((e) => e.providerRequestId === REQUEST_ID)!;
      expect(op.status).toBe('approved');
    } finally { await restarted.close(); cleanup(); }
  }, 60000);

  it('matches a real APPROVED postimage through the assetId indirection, so recovery is idempotent', async () => {
    const { root, home, cleanup } = roots();
    const crashed = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports, commitCrashAt: 'after-mutation' });
    const fixture = await setupReady(root, home);
    try {
      await crashed.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
    } finally { await crashed.close(); }

    // The mutation landed: persistence stored the asset as an assetId + assets[] row, NOT as
    // `operation.asset`. If the postimage comparison did not follow that indirection it would
    // read as "not yet applied", and recovery would re-apply (and could mis-report) the commit.
    const opAfterCrash = loadManifestV3(fixture.workspace).operations.find((e) => e.providerRequestId === REQUEST_ID)! as any;
    expect(opAfterCrash.status).toBe('approved');
    expect(opAfterCrash.asset).toBeUndefined();
    expect(opAfterCrash.assetId).toBeTruthy();
    const revisionsBefore = loadManifestV3(fixture.workspace).updatedAt;

    const restarted = createApp(config(root, home));
    try {
      await restarted.ready();
      expect(readCommitMarkers(fixture.workspace)).toEqual({});
      const op = loadManifestV3(fixture.workspace).operations.find((e) => e.providerRequestId === REQUEST_ID)! as any;
      expect(op.status).toBe('approved');
      expect(op.assetId).toBe(opAfterCrash.assetId);   // recognised as already-applied
      expect(loadManifestV3(fixture.workspace).updatedAt).toBe(revisionsBefore); // and not rewritten
    } finally { await restarted.close(); cleanup(); }
  }, 60000);

  it('keeps a pending marker whose operation matches NEITHER image, and reports the conflict', async () => {
    const { root, home, cleanup } = roots();
    const crashed = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports, commitCrashAt: 'after-marker' });
    const fixture = await setupReady(root, home);
    try {
      await crashed.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
    } finally { await crashed.close(); }

    // The user edits the operation before anything recovers it: it is now neither the preimage
    // the marker expects nor the postimage it would produce.
    const manifest = loadManifestV3(fixture.workspace);
    const op = manifest.operations.find((e) => e.providerRequestId === REQUEST_ID)!;
    (op as any).text = 'edited while the commit was pending';
    saveManifestV3(fixture.workspace, manifest, { revision: false });

    const restarted = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports });
    try {
      const res = await restarted.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).errorCode).toBe('commit-marker-conflict');
      // The marker is RETAINED (an operator has to resolve it) and no terminal was published for
      // a manifest state that does not exist.
      expect(Object.keys(readCommitMarkers(fixture.workspace))).toEqual([REQUEST_ID]);
      expect(readRootTerminals(fixture.workspace)).toHaveLength(0);
      expect((loadManifestV3(fixture.workspace).operations.find((e) => e.providerRequestId === REQUEST_ID)! as any).text).toBe('edited while the commit was pending');
    } finally { await restarted.close(); cleanup(); }
  }, 60000);

  it('refuses to resume against a re-trimmed clip whose stored coordinates no longer map', async () => {
    const { root, home, cleanup } = roots();
    const failing: PatchTransports = {
      async tts() { return { audio: toneBytes(1.0, 300) }; },
      async sts() { throw new SimulatedProcessDeath(); }
    };
    const first = createApp(config(root, home), { cloneChainTransports: failing });
    const fixture = await setupReady(root, home);
    try {
      await first.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
    } catch { /* expected */ } finally { await first.close(); }

    rmSync(join(fixture.workspace, 'logs/voice-patch-terminals.jsonl'), { force: true });
    // Re-trim the clip. The op's clip-local target is untouched, so a resume that only compared
    // the op would proceed — but the stored asset-axis coordinates now point at different audio,
    // and the seam would bake against the wrong stretch of the recording.
    const manifest = loadManifestV3(fixture.workspace);
    // Put the op back into the state Phase 1 left it in, so the GEOMETRY check is what fires
    // rather than the op-identity check that would otherwise mask it.
    const proposal = manifest.operations.find((entry) => entry.providerRequestId === REQUEST_ID)! as any;
    proposal.status = 'proposed';
    delete proposal.reason;
    (manifest.assets.find((a) => a.assetId === 'asset_video_001')! as any).durationSec = 70;
    const clip = manifest.tracks[0]!.clips.find((entry) => entry.clipId === 'clip_001')! as any;
    clip.sourceStart = 3;   // the clip now starts 3 s later in the asset...
    clip.sourceEnd = 63;    // ...with its length (and so the op's clip-local target) unchanged
    saveManifestV3(fixture.workspace, manifest, { revision: false });

    const { transports, calls } = fakeTransports();
    const retry = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const res = await retry.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).errorCode).toBe('range-conflict');
      expect(calls).toEqual([]);
    } finally { await retry.close(); cleanup(); }
  }, 60000);

  it('fails closed when the PAID ledger is truncated, rather than reading it as "no prior request"', async () => {
    const { root, home, cleanup } = roots();
    const { transports, calls } = fakeTransports();
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      const before = [...calls];
      // Lose the tail of the ledger the way an un-fsynced crash would, and delete the terminal so
      // the request looks unfinished. The strict reader must refuse — a skipped 'started' record
      // is exactly what would let a paid step be charged twice.
      const ledger = join(fixture.workspace, 'logs/provider-requests.jsonl');
      writeFileSync(ledger, readFileSync(ledger, 'utf8') + '{"requestId":"vps-trunc","stat');
      rmSync(join(fixture.workspace, 'logs/voice-patch-terminals.jsonl'), { force: true });

      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(500);
      expect(calls).toEqual(before); // nothing re-billed
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('retires an orphaned Phase-1 operation left by a crash between the op write and the ledger row', async () => {
    const { root, home, cleanup } = roots();
    const { transports } = fakeTransports();
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      // Reconstruct the crash window: the operation exists and is proposed, but its ledger row
      // and terminal are gone. Nothing was paid (the row precedes Phase 2).
      const manifest = loadManifestV3(fixture.workspace);
      const op = manifest.operations.find((e) => e.providerRequestId === REQUEST_ID)!;
      (op as any).status = 'proposed';
      delete (op as any).assetId;
      saveManifestV3(fixture.workspace, manifest, { revision: false });
      rmSync(join(fixture.workspace, 'logs/provider-requests.jsonl'), { force: true });
      rmSync(join(fixture.workspace, 'logs/voice-patch-terminals.jsonl'), { force: true });

      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(200);
      // Exactly one live proposal for this request: the orphan was retired reversibly (history
      // preserved as 'rejected'), not left behind as a duplicate.
      const ops = loadManifestV3(fixture.workspace).operations.filter((e) => e.providerRequestId === REQUEST_ID);
      expect(ops.filter((e) => e.status === 'approved')).toHaveLength(1);
      expect(ops.filter((e) => e.status === 'rejected')).toHaveLength(1);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  // ── Axis (⟨F13⟩) ────────────────────────────────────────────────────────────
  it('writes CLIP-LOCAL op targets for a trimmed clip (sourceStart != 0, timelineStart != 0)', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports });
    try {
      // The request axis is ASSET; op.target must be clip-local (asset − sourceStart).
      const fixture = await setupReady(root, home, { sourceStart: 5, timelineStart: 3, seconds: 60 });
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody({ start: 20, end: 21 }) });
      expect(res.statusCode).toBe(200);
      const op = loadManifestV3(fixture.workspace).operations.find((entry) => entry.providerRequestId === REQUEST_ID)!;
      // Snapping may widen to word/phrase boundaries, but the axis conversion must hold:
      // clip-local == asset − 5, and the target must stay inside the clip's local range.
      expect(op.target.kind).toBe('clip-span');
      const target = op.target as { start: number; end: number };
      expect(target.start).toBeGreaterThanOrEqual(0);
      expect(target.start).toBeLessThan(20);
      expect(target.end).toBeLessThanOrEqual(60);
      expect(JSON.parse(res.body).operation.start).toBe(target.start);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  // ── P1-2: geometry revalidated on the FRESH Phase-3 path, not only on resume ──
  it('refuses to approve when the clip is TRIMMED during Phase 2, and preserves the operation', async () => {
    const { root, home, cleanup } = roots();
    let workspace = '';
    const transports: PatchTransports = {
      async tts() { return { audio: toneBytes(1.0, 300) }; },
      async sts() {
        // trim_clip during the paid call: sourceStart moves, so the asset-axis coordinates the
        // audio was seated against no longer describe this clip. The op's clip-local target and
        // the execution snapshot are BOTH unchanged, so only the geometry check can catch it.
        const manifest = loadManifestV3(workspace);
        (manifest.assets.find((a) => a.assetId === 'asset_video_001')! as any).durationSec = 70;
        const clip = manifest.tracks[0]!.clips.find((entry) => entry.clipId === 'clip_001')! as any;
        clip.sourceStart = 4;
        clip.sourceEnd = 64;
        saveManifestV3(workspace, manifest, { revision: false });
        return { audio: toneBytes(1.2, 260) };
      }
    };
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      workspace = fixture.workspace;
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).errorCode).toBe('range-conflict');
      // The op is ours, so it is withdrawn reversibly — and it certainly is not approved with
      // audio seated at stale coordinates.
      const op = loadManifestV3(fixture.workspace).operations.find((e) => e.providerRequestId === REQUEST_ID)! as any;
      expect(op.status).toBe('rejected');
      expect(op.assetId).toBeUndefined();
    } finally { await app.close(); cleanup(); }
  }, 60000);

  // ── P1-3: the commit only publishes a terminal when the mutation really happened ──
  it('publishes NO terminal for an approve marker whose operation no longer exists', async () => {
    const { root, home, cleanup } = roots();
    const { transports, calls } = fakeTransports();
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      // A pending APPROVE marker whose operation is gone (deleted while the commit was pending).
      // Treating a missing op as "preserved" here would mint a 200 terminal describing an
      // approved operation that exists nowhere in the manifest.
      writeCommitMarker(fixture.workspace, {
        requestId: REQUEST_ID, projectId: 'p1', operationId: 'op_voice_patch_gone', assetRel: 'assets/voice/patch.wav',
        intendedOutcome: 'approve', httpStatus: 200,
        serializedBody: JSON.stringify({ providerRequestId: REQUEST_ID, operation: { id: 'op_voice_patch_gone', status: 'approved' } }),
        bodyHash: 'v2:deadbeef',
        executionSnapshot: { voiceId: 'el-voice-abc', accountRef: 'elevenlabs', cleanupIdentity: fixture.cleanupKey, ttsModel: 'eleven_multilingual_v2', stsModel: 'eleven_multilingual_sts_v2', recipeVersion: 's1b-1' },
        expectedOpPreimage: { status: 'proposed', providerRequestId: REQUEST_ID, text: 'brand new words', targetStart: 10, targetEnd: 11 },
        expectedOpPostimage: { status: 'approved', providerRequestId: REQUEST_ID, text: 'brand new words', targetStart: 10, targetEnd: 11, assetRel: 'assets/voice/patch.wav' },
        createdAt: new Date().toISOString()
      });

      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).errorCode).toBe('commit-marker-conflict');
      // No terminal for a state that does not exist; the marker is kept for an operator; and no
      // paid call was made off the back of it.
      expect(readRootTerminals(fixture.workspace)).toHaveLength(0);
      expect(Object.keys(readCommitMarkers(fixture.workspace))).toEqual([REQUEST_ID]);
      expect(calls).toEqual([]);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('publishes NO terminal when the guarded apply cannot reach the postimage', async () => {
    const { root, home, cleanup } = roots();
    let workspace = '';
    const transports: PatchTransports = {
      async tts() { return { audio: toneBytes(1.0, 300) }; },
      async sts() {
        // The op is DISABLED mid-call: it still exists (so this is not the missing-op case) but
        // matches neither the preimage the marker expects nor the approved postimage.
        const manifest = loadManifestV3(workspace);
        const op = manifest.operations.find((e) => e.providerRequestId === REQUEST_ID)!;
        (op as any).status = 'disabled';
        saveManifestV3(workspace, manifest, { revision: false });
        return { audio: toneBytes(1.2, 260) };
      }
    };
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      workspace = fixture.workspace;
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      // Phase 3's own image check catches this first and PRESERVES the user's state; either way
      // the operation must not be approved and must keep the status the user set.
      expect(res.statusCode).toBe(409);
      const op = loadManifestV3(fixture.workspace).operations.find((e) => e.providerRequestId === REQUEST_ID)! as any;
      expect(op.status).toBe('disabled');
      expect(op.assetId).toBeUndefined();
    } finally { await app.close(); cleanup(); }
  }, 60000);

  // ── P1-1: paid replay gates read the ledger strictly, but still accept legacy rows ──
  it('replays a LEGACY-shaped ledger row on the paid gate instead of skipping it', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      const fixture = await setupReady(root, home);
      const payload = { start: 10, end: 11, text: 'legacy words', provider: 'mock', requestId: 'legacy-shaped-1' };
      // Run it once so the real bodyHash for this exact body is on record...
      const first = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload });
      expect(first.statusCode).toBe(200);
      const realHash = (readProviderRequests(fixture.workspace).find((row) => row.requestId === 'legacy-shaped-1') as any).bodyHash;
      const operationId = JSON.parse(first.body).operation.id;

      // ...then rewrite the ledger as an OLDER WRITER would have: the row identifies the request,
      // its state and its body, but lacks the fields today's schemas require (cost, type,
      // voice/language). Skipping it on a paid gate would read as "never requested" and
      // re-execute the provider; the strict reader must MIGRATE it and replay instead.
      writeFileSync(join(fixture.workspace, 'logs/provider-requests.jsonl'),
        `${JSON.stringify({ requestId: 'legacy-shaped-1', status: 'succeeded', createdAt: new Date().toISOString(), provider: 'tts.mock', operationId, bodyHash: realHash })}\n`);

      const replay = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload });
      expect(replay.statusCode).toBe(200);
      expect(JSON.parse(replay.body).providerRequestId).toBe('legacy-shaped-1');
      expect(JSON.parse(replay.body).request.status).toBe('succeeded');
      // And a DIFFERENT body against the same legacy row is still a conflict, not a re-run.
      const conflict = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: { ...payload, text: 'something else entirely' } });
      expect(conflict.statusCode).toBe(409);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('treats a MALFORMED step record as corruption, not legacy history, and runs no paid step', async () => {
    const { root, home, cleanup } = roots();
    const { transports, calls } = fakeTransports();
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      // A 'started' marker for the TTS step whose own schema does not validate. If the migration
      // member accepted it, zod would strip recordKind/parentRequestId/step, the step readers
      // would see NO marker, and the paid TTS call would run a second time.
      writeFileSync(join(fixture.workspace, 'logs/provider-requests.jsonl'), `${JSON.stringify({
        recordKind: 'voice-patch-step',
        requestId: voicePatchStepRecordId(REQUEST_ID, 'tts'),
        parentRequestId: REQUEST_ID,
        step: 'not-a-real-step',
        provider: 'tts.elevenlabs',
        status: 'started',
        createdAt: new Date().toISOString()
      })}\n`);

      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(500);
      expect(calls).toEqual([]); // no transport ran — nothing was re-billed
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('does not let a step/generic HYBRID row hide a paid step marker', async () => {
    const { root, home, cleanup } = roots();
    const { transports, calls } = fakeTransports();
    const app = createApp(config(root, home), { cloneChainTransports: transports });
    try {
      const fixture = await setupReady(root, home);
      // Step discriminators + an INVALID step + an otherwise VALID generic body. Under
      // union-order dispatch the generic member accepted this and zod stripped recordKind/
      // parentRequestId/step, so the step readers saw no 'started' marker and re-ran the paid
      // TTS call. Discriminator-first routing makes it corruption instead.
      writeFileSync(join(fixture.workspace, 'logs/provider-requests.jsonl'), `${JSON.stringify({
        recordKind: 'voice-patch-step',
        parentRequestId: REQUEST_ID,
        step: 'not-a-real-step',
        requestId: voicePatchStepRecordId(REQUEST_ID, 'tts'),
        type: 'voice_patch',
        projectId: 'p1',
        provider: 'tts.elevenlabs',
        voice: '', language: '', bodyHash: '', operationId: 'op_1',
        status: 'started',
        cost: { currency: 'USD', estimated: 1, actual: null },
        createdAt: new Date().toISOString()
      })}\n`);

      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(500);
      expect(calls).toEqual([]);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('400s a malformed provider on the legacy route instead of crashing', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await setupReady(root, home);
      // A truthy non-string provider is a BAD REQUEST, and must stay one: deriving the canonical
      // ledger id from it BEFORE validation called a string method on it and turned the 400 into
      // a 500. Arrays are now in this list too: Array.prototype.includes exists, so ['mock'] used
      // to survive core's normalizeProviderId and resolve to a REAL adapter (S1b follow-up —
      // core's canonicalProviderId now fails closed on any non-string).
      // `false` and `0` are in the list because the route used to write `req.body.provider ||
      // 'mock'`: a truthiness gate reads a malformed value as "not specified" and silently
      // resolves it to a default provider, which on other paths is a PAID one.
      for (const badProvider of [{ id: 'xai' }, 42, true, ['mock'], ['mock', 'xai'], false, 0]) {
        const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: { start: 10, end: 11, text: 'words', provider: badProvider, requestId: 'malformed-provider-1' } });
        expect(res.statusCode).toBe(400);
      }
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('refuses a paid call when the spend ledger cannot be read in full, rather than undercounting the cap', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    setPaidTransportForTests(async () => new Response(new Uint8Array(48000), { status: 200 }));
    try {
      const fixture = await setupReady(root, home);
      setProviderSecret({ homeDir: home, secretRef: 'elevenlabs', value: 'sk_elevenlabs_0123456789abcdef0123456789abcdef' });
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 5 } });
      // Garbage the spend ledger. providerEstimatedSpend feeds the cap decision, so a lenient
      // read here would silently report a smaller total and admit calls past the ceiling.
      writeFileSync(join(fixture.workspace, 'logs/provider-requests.jsonl'), '{"this is not a ledger row"\n');
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).not.toBe(200);
    } finally { setPaidTransportForTests(null); await app.close(); cleanup(); }
  }, 60000);

  // ── D7/P1-6/P1-7: real accounting through the production transports ────────
  it('costs the STS step from its source duration and bounds the whole chain with ONE shared cap', async () => {
    const { root, home, cleanup } = roots();
    // Production wiring: NO injected transports, so the real runProvider path runs. The paid
    // boundary is served by an explicitly installed test transport instead.
    const app = createApp(config(root, home));
    setPaidTransportForTests(async (url) => {
      const target = String(url);
      if (target.includes('/v1/text-to-speech/')) return new Response(new Uint8Array(48000), { status: 200 });
      if (target.includes('/v1/speech-to-speech/')) return new Response(new Uint8Array(52800), { status: 200 });
      throw new Error(`unexpected paid endpoint: ${target}`);
    });
    try {
      const fixture = await setupReady(root, home);
      setProviderSecret({ homeDir: home, secretRef: 'elevenlabs', value: 'sk_elevenlabs_0123456789abcdef0123456789abcdef' });
      // A cap on the USER-FACING provider only. The hidden STS and clone ids never appear in the
      // cap UI, so they must inherit it — and share it, not each get their own allowance.
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 1 } });

      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(200);

      const ledger = readProviderRequests(fixture.workspace);
      const stsRows = ledger.filter((row) => row.provider === 'tts.elevenlabs-sts' && (row as any).cost);
      expect(stsRows.length).toBeGreaterThan(0);
      // The STS estimate is a real number, derived from the source duration. Before the fix this
      // was null, which (with a cap configured) fails the call closed.
      const stsEstimate = (stsRows.at(-1) as any).cost.estimated;
      expect(typeof stsEstimate).toBe('number');
      expect(stsEstimate).toBeGreaterThan(0);
      expect((stsRows.at(-1) as any).input.sourceDurationSec).toBeGreaterThan(0);

      // The cap covers the GROUP: spend from tts.elevenlabs and tts.elevenlabs-sts is summed, so
      // one ceiling cannot be spent once per hidden provider.
      const grouped = providerEstimatedSpend(fixture.workspace, ['tts.elevenlabs', 'tts.elevenlabs-sts', 'clone.elevenlabs']);
      const ttsOnly = providerEstimatedSpend(fixture.workspace, 'tts.elevenlabs');
      expect(grouped).toBeGreaterThan(ttsOnly);
    } finally { setPaidTransportForTests(null); await app.close(); cleanup(); }
  }, 60000);

  it('refuses the chain once the SHARED cap is exhausted, counting every provider in the group', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    setPaidTransportForTests(async () => new Response(new Uint8Array(48000), { status: 200 }));
    try {
      const fixture = await setupReady(root, home);
      setProviderSecret({ homeDir: home, secretRef: 'elevenlabs', value: 'sk_elevenlabs_0123456789abcdef0123456789abcdef' });
      // A ceiling far below one call's cost: the very first paid step must be refused.
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 0.000001 } });
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      // Round-4 P1-1 moved this refusal EARLIER: the pre-payment sequence admission catches it
      // in Phase 1 as a typed 409, before an operation exists, instead of surfacing as the
      // engine's 502 from inside Phase 2. The cap is still what refuses it, and the group is
      // still what is counted — only the moment and the shape changed, both for the better.
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.errorCode).toBe('cap-would-refuse-sequence');
      expect(body.cap.group).toEqual(expect.arrayContaining(['tts.elevenlabs', 'tts.elevenlabs-sts', 'clone.elevenlabs']));
      expect(loadManifestV3(fixture.workspace).operations.filter((op: any) => op.type === 'voice_patch')).toHaveLength(0);
    } finally { setPaidTransportForTests(null); await app.close(); cleanup(); }
  }, 60000);

  // ── D8 gate, at the route level ─────────────────────────────────────────────
  it('never touches the network when NO transports are injected, even with a real-looking key configured', async () => {
    const { root, home, cleanup } = roots();
    // Production wiring: no injected transports at all.
    const app = createApp(config(root, home));
    try {
      await setupReady(root, home);
      setProviderSecret({ homeDir: home, secretRef: 'elevenlabs', value: 'sk_elevenlabs_0123456789abcdef0123456789abcdef' });
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      // The paid boundary fails CLOSED: a 502 whose message is the gate, never a real call.
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body).error).toMatch(/paid-call-blocked/);
    } finally { await app.close(); cleanup(); }
  }, 60000);
});

describe('pre-payment sequence admission (round-4 P1-1)', () => {
  /**
   * The two step prices for THIS fixture's patch, derived rather than guessed: the route snaps
   * the selection to phrase boundaries, so the STS source duration is not simply end-start.
   * Runs on a throwaway project with fake transports (nothing paid).
   */
  async function stepPrices(root: string, home: string) {
    const app = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports });
    try {
      await makeProject(root, 'probe', { seconds: 60, realVideo: false });
      seedPreparedVoice(home, 'probe', (await makeProject(root, 'probe2', { seconds: 60, realVideo: false })).cleanupKey);
      const fixture = await makeProject(root, 'priced', { seconds: 60, realVideo: false });
      seedPreparedVoice(home, 'priced', fixture.cleanupKey);
      const patched = JSON.parse((await app.inject({ method: 'POST', url: '/api/projects/priced/manifest/voice-patches', payload: patchBody() })).body);
      const sourceDurationSec = patched.operation.durationRequestedSec as number;
      const estimate = JSON.parse((await app.inject({ method: 'GET', url: `/api/projects/priced/manifest/voice-patches/estimate?chars=${'brand new words'.length}&sourceDurationSec=${sourceDurationSec}` })).body);
      const priceOf = (step: string) => estimate.steps.find((entry: any) => entry.step === step).estimated as number;
      return { tts: priceOf('tts'), sts: priceOf('sts') };
    } finally { await app.close(); }
  }

  it('refuses the two-calls-under-one-ceiling case BEFORE any paid call is made', async () => {
    const { root, home, cleanup } = roots();
    // Production wiring: no injected transports, so a real paid attempt would reach the
    // transport. It must never be called.
    const app = createApp(config(root, home));
    let transportCalls = 0;
    setPaidTransportForTests(async () => { transportCalls += 1; return new Response(new Uint8Array(48000), { status: 200 }); });
    try {
      const prices = await stepPrices(root, home);
      const fixture = await setupReady(root, home);
      setProviderSecret({ homeDir: home, secretRef: 'elevenlabs', value: 'sk_elevenlabs_0123456789abcdef0123456789abcdef' });
      // Enough for either call alone; not enough for both. This is exactly the shape that made
      // production bill the TTS and then refuse the STS.
      const cap = Math.max(prices.tts, prices.sts) + Math.min(prices.tts, prices.sts) / 2;
      expect(cap).toBeGreaterThanOrEqual(prices.tts);
      expect(cap).toBeGreaterThanOrEqual(prices.sts);
      expect(cap).toBeLessThan(prices.tts + prices.sts);
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': cap } });

      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.errorCode).toBe('cap-would-refuse-sequence');
      expect(body.refusalScope).toBe('sequence-only');
      expect(body.refusedAtStep).toBe('sts');
      // The whole point: nothing was billed, and no operation was left behind.
      expect(transportCalls).toBe(0);
      expect(loadManifestV3(fixture.workspace).operations.filter((op: any) => op.type === 'voice_patch')).toHaveLength(0);
    } finally { setPaidTransportForTests(null); await app.close(); cleanup(); }
  }, 90000);

  it('distinguishes a single call that is unaffordable on its own', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    let transportCalls = 0;
    setPaidTransportForTests(async () => { transportCalls += 1; return new Response(new Uint8Array(48000), { status: 200 }); });
    try {
      const fixture = await setupReady(root, home);
      setProviderSecret({ homeDir: home, secretRef: 'elevenlabs', value: 'sk_elevenlabs_0123456789abcdef0123456789abcdef' });
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 0.0000001 } });

      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.errorCode).toBe('cap-would-refuse-sequence');
      // The FIRST call already breaches, so the remedy copy must not blame the sequence.
      expect(body.refusalScope).toBe('step-alone');
      expect(body.refusedAtStep).toBe('tts');
      expect(transportCalls).toBe(0);
    } finally { setPaidTransportForTests(null); await app.close(); cleanup(); }
  }, 60000);

  it('lets a comfortably-capped generation through unchanged', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    setPaidTransportForTests(async (url) => {
      const target = String(url);
      if (target.includes('/v1/text-to-speech/')) return new Response(new Uint8Array(48000), { status: 200 });
      if (target.includes('/v1/speech-to-speech/')) return new Response(new Uint8Array(52800), { status: 200 });
      throw new Error(`unexpected paid endpoint: ${target}`);
    });
    try {
      const fixture = await setupReady(root, home);
      setProviderSecret({ homeDir: home, secretRef: 'elevenlabs', value: 'sk_elevenlabs_0123456789abcdef0123456789abcdef' });
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 100 } });

      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });

      expect(res.statusCode).toBe(200);
    } finally { setPaidTransportForTests(null); await app.close(); cleanup(); }
  }, 60000);

  it('does not gate an UNCAPPED workspace', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports });
    try {
      await setupReady(root, home);
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBe(200);
    } finally { await app.close(); cleanup(); }
  }, 60000);
});

describe('admission grants (round-5 P1-1b/c/d)', () => {
  /** How much of the ceiling one real TTS step consumes for this fixture's patch. */
  async function ttsSpend(workspace: string) {
    return providerEstimatedSpend(workspace, ['tts.elevenlabs', 'tts.elevenlabs-sts', 'clone.elevenlabs']);
  }

  it('persists the per-step grant with the Phase-1 row', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports });
    try {
      const fixture = await setupReady(root, home);
      // A cap must exist for the snapshot fields to mean anything — uncapped admission has no
      // ceiling to observe, and records that honestly.
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 100 } });
      await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });

      const grant = readAdmissionGrant(fixture.workspace, REQUEST_ID);
      expect(grant).not.toBeNull();
      // Keyed by PROVIDER ID, so a change in call order cannot hand a step the wrong amount.
      expect(Object.keys(grant!.steps).sort()).toEqual(['tts.elevenlabs', 'tts.elevenlabs-sts']);
      expect(grant!.currency).toBe('USD');
      expect(grant!.capLimit).toBe(100);
      expect(grant!.capSpent).toBe(0);
      expect(Date.parse(grant!.grantedAt)).toBeGreaterThan(0);
      // Priced against the CONSERVATIVE bound: exactly 2× the requested span, at $0.10/minute.
      const op = loadManifestV3(fixture.workspace).operations.find((entry: any) => entry.providerRequestId === REQUEST_ID)!;
      const requestedSec = Number((op as any).target.end) - Number((op as any).target.start);
      expect(grant!.steps['tts.elevenlabs-sts']!).toBeCloseTo(requestedSec * 2 / 60 * 0.1, 5);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('COMPLETES a resume under its grant after the cap was tightened mid-chain', async () => {
    const { root, home, cleanup } = roots();
    // Attempt 1 (generous cap): TTS succeeds and persists its terminal, then the process dies
    // inside STS. That TTS money is spent and unrecoverable, so the resume must be able to
    // finish — refusing it now would strand a paid step behind an op that can never complete.
    const dying = createApp(config(root, home), { cloneChainTransports: fakeTransports({ sts: async () => { throw new SimulatedProcessDeath(); } }).transports });
    const fixture = await setupReady(root, home);
    try {
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 100 } });
      await dying.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
    } finally { await dying.close(); }

    // A REAL process death loses the root terminal write too (it is the last thing Phase 2
    // does). Drop it so the retry takes the resume path rather than replaying the failure.
    // A REAL process death loses BOTH the root terminal and the commit marker it is
    // reconstructable from (the marker is written first, inside Phase 2's failure handling).
    rmSync(join(fixture.workspace, 'logs/voice-patch-terminals.jsonl'), { force: true });
    rmSync(join(fixture.workspace, 'logs/voice-patch-commit-markers.json'), { force: true });
    // …and the STS step terminal it never got to write. (A persisted step terminal — even a
    // failed one — is replayed by design, so leaving it would replay the failure rather than
    // exercise the resume.) The TTS terminal and the Phase-1 approved row are kept.
    const ledgerPath = join(fixture.workspace, 'logs/provider-requests.jsonl');
    const stsRecordId = voicePatchStepRecordId(REQUEST_ID, 'sts');
    const stsAccountingId = voicePatchAccountingRequestId(REQUEST_ID, 'sts');
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)
      .filter((line) => { const id = JSON.parse(line).requestId; return id !== stsRecordId && id !== stsAccountingId; })
      .join('\n') + '\n');
    const op = loadManifestV3(fixture.workspace).operations.find((entry: any) => entry.providerRequestId === REQUEST_ID);
    saveManifestV3(fixture.workspace, {
      ...loadManifestV3(fixture.workspace),
      operations: loadManifestV3(fixture.workspace).operations.map((entry: any) => entry.id === op!.id ? { ...entry, status: 'proposed', reason: undefined } : entry)
    } as any);

    const grant = readAdmissionGrant(fixture.workspace, REQUEST_ID);
    expect(grant!.steps['tts.elevenlabs-sts']).toBeGreaterThan(0);

    const app = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports });
    try {
      // The user tightens the cap to exactly what has ALREADY been spent: a live recheck would
      // refuse the STS step outright.
      const spent = providerEstimatedSpend(fixture.workspace, ['tts.elevenlabs', 'tts.elevenlabs-sts', 'clone.elevenlabs']);
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': spent } });

      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });

      if (res.statusCode !== 200) console.log('RESUME-DEBUG', res.statusCode, res.body.slice(0, 400));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).operation.status).toBe('approved');
    } finally { await app.close(); cleanup(); }
  }, 90000);

  it('refuses fail-closed when the TTS output runs past the conservative bound', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    setPaidTransportForTests(async (url) => {
      const target = String(url);
      // A TTS render far longer than the slot it replaces — well beyond what admission bounded.
      if (target.includes('/v1/text-to-speech/')) return new Response(new Uint8Array(toneBytes(300, 300)), { status: 200 });
      if (target.includes('/v1/speech-to-speech/')) return new Response(new Uint8Array(52800), { status: 200 });
      throw new Error(`unexpected paid endpoint: ${target}`);
    });
    try {
      // Probe FIRST: the shared voices library holds one prepared clone at a time, so seeding
      // the probe project after p1 would take p1's clone away.
      const admitted = await admittedTotal(root, home);
      const fixture = await setupReady(root, home);
      setProviderSecret({ homeDir: home, secretRef: 'elevenlabs', value: 'sk_elevenlabs_0123456789abcdef0123456789abcdef' });
      // The ceiling is DERIVED from what admission itself grants, so it comfortably admits the
      // chain and cannot admit a five-minute STS source.
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': admitted * 1.05 } });

      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });

      // Refused, not silently overspent. The op is rolled back reversibly and the TTS terminal
      // survives, so a retry replays it instead of re-billing.
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const op = loadManifestV3(fixture.workspace).operations.find((entry: any) => entry.providerRequestId === REQUEST_ID);
      expect(op?.status).toBe('rejected');
      expect(voicePatchStepState(fixture.workspace, REQUEST_ID, 'tts').terminal?.status).toBe('succeeded');
    } finally { setPaidTransportForTests(null); await app.close(); cleanup(); }
  }, 90000);

  it('REFUSES a legacy row with no grant once the cap tightens — the pre-grant behaviour', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    setPaidTransportForTests(async () => new Response(new Uint8Array(48000), { status: 200 }));
    try {
      const admitted = await admittedTotal(root, home);
      const fixture = await setupReady(root, home);
      setProviderSecret({ homeDir: home, secretRef: 'elevenlabs', value: 'sk_elevenlabs_0123456789abcdef0123456789abcdef' });
      // Strip the grant from the Phase-1 row the way a pre-grant writer would have left it, by
      // running Phase 1 and then rewriting that row without `admissionGrant`.
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': admitted * 1.05 } });
      await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      const ledgerPath = join(fixture.workspace, 'logs/provider-requests.jsonl');
      writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((line) => {
        const row = JSON.parse(line);
        if (row.input?.admissionGrant) delete row.input.admissionGrant;
        return JSON.stringify(row);
      }).join('\n') + '\n');
      expect(readAdmissionGrant(fixture.workspace, REQUEST_ID)).toBeNull();

      // Re-run the same request with the cap pulled below what has already been spent. With no
      // grant there is nothing to honor, so the live check refuses — which is precisely the
      // stranding that grants exist to prevent, preserved here for rows that never got one.
      rmSync(join(fixture.workspace, 'logs/voice-patch-terminals.jsonl'), { force: true });
      rmSync(join(fixture.workspace, 'logs/voice-patch-commit-markers.json'), { force: true });
      // …and put the op back the way a mid-Phase-2 death would have left it, so the retry takes
      // the resume path rather than being turned away by the operation guard.
      const manifest = loadManifestV3(fixture.workspace);
      const pending = manifest.operations.find((entry: any) => entry.providerRequestId === REQUEST_ID)!;
      (pending as any).status = 'proposed';
      delete (pending as any).assetRel;
      saveManifestV3(fixture.workspace, manifest, { revision: false });
      const stsRecordId = voicePatchStepRecordId(REQUEST_ID, 'sts');
      const stsAccountingId = voicePatchAccountingRequestId(REQUEST_ID, 'sts');
      writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)
        .filter((line) => { const id = JSON.parse(line).requestId; return id !== stsRecordId && id !== stsAccountingId; })
        .join('\n') + '\n');
      const spent = providerEstimatedSpend(fixture.workspace, ['tts.elevenlabs', 'tts.elevenlabs-sts', 'clone.elevenlabs']);
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': spent } });

      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      // Refused for a SPEND reason specifically — not incidentally by some other precondition.
      const body = JSON.parse(res.body);
      expect(['cap-would-refuse-sequence', 'tts-failed', 'sts-failed']).toContain(body.errorCode);
      if (body.errorCode !== 'cap-would-refuse-sequence') expect(String(body.error)).toMatch(/spend cap/i);
    } finally { setPaidTransportForTests(null); await app.close(); cleanup(); }
  }, 90000);

  it('does not honor a grant older than its TTL, nor one timestamped far in the future', async () => {
    const base = { steps: { 'tts.elevenlabs-sts': 0.2 }, currency: 'USD', capLimit: 1, capSpent: 0, grantedAt: new Date().toISOString() };
    expect(isGrantFresh(base)).toBe(true);
    expect(isGrantFresh({ ...base, grantedAt: new Date(Date.now() - 2 * CLONE_CHAIN_GRANT_TTL_MS).toISOString() })).toBe(false);
    // Forward skew is tolerated in MINUTES, not hours: a symmetric TTL would make a skewed
    // grant honorable for twice as long as one was ever meant to last.
    expect(isGrantFresh({ ...base, grantedAt: new Date(Date.now() + CLONE_CHAIN_GRANT_SKEW_MS / 2).toISOString() })).toBe(true);
    expect(isGrantFresh({ ...base, grantedAt: new Date(Date.now() + 2 * CLONE_CHAIN_GRANT_SKEW_MS).toISOString() })).toBe(false);
    expect(isGrantFresh({ ...base, grantedAt: new Date(Date.now() + CLONE_CHAIN_GRANT_TTL_MS / 2).toISOString() })).toBe(false);
  });

  it('treats a corrupt or over-claiming grant as absent, falling back to the live check', async () => {
    const base = { steps: { 'tts.elevenlabs-sts': 0.2 }, currency: 'USD', capLimit: 1, capSpent: 0, grantedAt: new Date().toISOString() };
    expect(CloneChainGrantSchema.safeParse(base).success).toBe(true);
    // Claims more than the ceiling it was issued under — impossible from admission, so forged.
    expect(CloneChainGrantSchema.safeParse({ ...base, steps: { 'tts.elevenlabs-sts': 5 } }).success).toBe(false);
    expect(CloneChainGrantSchema.safeParse({ ...base, steps: { 'tts.elevenlabs-sts': -1 } }).success).toBe(false);
    expect(CloneChainGrantSchema.safeParse({ ...base, capSpent: Number.NaN }).success).toBe(false);
    expect(CloneChainGrantSchema.safeParse({ ...base, grantedAt: 'whenever' }).success).toBe(false);
    expect(CloneChainGrantSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    // A null capLimit used to disable the over-claim refinement entirely, so this shape — which
    // `grantFromAdmission` can never emit — parsed and was honored for an arbitrary amount.
    expect(CloneChainGrantSchema.safeParse({ ...base, steps: { 'tts.elevenlabs-sts': 1e6 }, capLimit: null, capSpent: 0 }).success).toBe(false);
    expect(CloneChainGrantSchema.safeParse({ ...base, capLimit: null, capSpent: null }).success).toBe(true);
    expect(CloneChainGrantSchema.safeParse({ ...base, capLimit: 1, capSpent: null }).success).toBe(false);
    expect(CloneChainGrantSchema.safeParse({ ...base, capLimit: null }).success).toBe(false);
    // The absolute sanity ceiling applies even when no cap was configured.
    expect(CloneChainGrantSchema.safeParse({ steps: { 'tts.elevenlabs-sts': 1e6 }, currency: 'USD', capLimit: null, capSpent: null, grantedAt: base.grantedAt }).success).toBe(false);
  });

  it('discards a grant claiming a ceiling that is not configured, and keeps one under a TIGHTENED cap', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports });
    try {
      const fixture = await setupReady(root, home);
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 100 } });
      await app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody() });
      expect(readAdmissionGrant(fixture.workspace, REQUEST_ID)).not.toBeNull();

      // Tightening the cap must NOT invalidate the grant — that is the stranding it exists to
      // survive (a step already paid for under the old ceiling).
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 0.0001 } });
      expect(readAdmissionGrant(fixture.workspace, REQUEST_ID)).not.toBeNull();

      // Removing the cap entirely makes the grant incoherent: admission records a capLimit only
      // when a ceiling applies, so a grant claiming one where none exists was not written by it.
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: {} });
      expect(readAdmissionGrant(fixture.workspace, REQUEST_ID)).toBeNull();
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('never prices an unknown step at zero when summing per provider', () => {
    const unpriced = grantFromAdmission({
      steps: [
        { providerId: 'tts.elevenlabs', tier: 'paid', cost: { currency: 'USD', estimated: 0.01, actual: null }, wouldRefuse: false },
        { providerId: 'tts.elevenlabs', tier: 'paid', cost: { currency: 'USD', estimated: null, actual: null }, wouldRefuse: false }
      ],
      cap: { limit: 1, spent: 0, group: ['tts.elevenlabs'] },
      wouldRefuse: false
    });
    // Absorbing the null keeps the entry unpriced rather than granting the unknown call for free.
    expect(unpriced.steps['tts.elevenlabs']).toBeNull();
  });

  it('sums step amounts that resolve to the same provider rather than keeping the last', () => {
    const grant = grantFromAdmission({
      steps: [
        { providerId: 'tts.elevenlabs', tier: 'paid', cost: { currency: 'USD', estimated: 0.01, actual: null }, wouldRefuse: false },
        { providerId: 'tts.elevenlabs', tier: 'paid', cost: { currency: 'USD', estimated: 0.02, actual: null }, wouldRefuse: false }
      ],
      cap: { limit: 1, spent: 0, group: ['tts.elevenlabs'] },
      wouldRefuse: false
    });
    // Last-wins would record 0.02 and shrink the window below what was actually admitted.
    expect(grant.steps['tts.elevenlabs']).toBeCloseTo(0.03, 6);
    expect(grantTotal(grant)).toBeCloseTo(0.03, 6);
  });

  it('SAME-PROJECT double bypass: two chains under one cap cannot both ride their grants', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    setPaidTransportForTests(async (url) => {
      const target = String(url);
      // REAL audio: a word-sized patch has to survive the seam bake, or the chain fails for a
      // reason that has nothing to do with the cap and the race is never exercised.
      if (target.includes('/v1/text-to-speech/')) return new Response(new Uint8Array(toneBytes(0.4, 300)), { status: 200 });
      if (target.includes('/v1/speech-to-speech/')) return new Response(new Uint8Array(toneBytes(0.5, 260)), { status: 200 });
      throw new Error(`unexpected paid endpoint: ${target}`);
    });
    try {
      // WORD granularity and disjoint single-word targets. With the default phrase snapping both
      // selections widen to the fixture's single 60-second segment, which makes the two chains
      // overlap (so the second dies on manifest validation, not on any cap) and inflates the
      // conservative STS bound to ~38× a real patch — a cap sized off that can never trip.
      const chainA = { granularity: 'word' as const, start: 10, end: 10.4 };
      const chainB = { granularity: 'word' as const, start: 30, end: 30.4 };
      const { total: oneChain, maxStep } = await wordChainPrices(root, home, chainA);
      const fixture = await setupReady(root, home);
      setProviderSecret({ homeDir: home, secretRef: 'elevenlabs', value: 'sk_elevenlabs_0123456789abcdef0123456789abcdef' });
      // Room for ONE chain and a fifth more.
      //
      // WHAT THIS TEST PROVES: the end-to-end invariant — two chains racing under one ceiling
      // never both bill. WHICH guard catches the second one depends on timing (its Phase-1
      // admission if the first chain's spend has landed, the grant window if it has not), so
      // this cannot pin the window clause itself. That is done deterministically, and under
      // mutation, by packages/core/src/__tests__/admissionGrant.test.ts.
      const cap = oneChain * 1.2;
      writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': cap } });

      const [first, second] = await Promise.all([
        app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody({ requestId: 'req-chain-a-0001', ...chainA }) }),
        app.inject({ method: 'POST', url: '/api/projects/p1/manifest/voice-patches', payload: patchBody({ requestId: 'req-chain-b-0001', ...chainB }) })
      ]);

      const results = [first, second];
      const winners = results.filter((res) => res.statusCode === 200);
      const losers = results.filter((res) => res.statusCode !== 200);
      const requestIds = ['req-chain-a-0001', 'req-chain-b-0001'];
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      // Refused for a SPEND reason: either its Phase-1 admission already saw the other chain's
      // spend, or a paid step hit the live check because its grant window no longer covered it.
      const loser = JSON.parse(losers[0]!.body);
      expect(['cap-would-refuse-sequence', 'tts-failed', 'sts-failed']).toContain(loser.errorCode);
      if (loser.errorCode !== 'cap-would-refuse-sequence') expect(String(loser.error)).toMatch(/spend cap/i);

      // THE WINNER COUNT ABOVE IS WHAT BITES. The spend bounds below cannot detect a
      // double-bill on their own: admission prices the STS step at 2× the actual source
      // duration, so two fully-billed chains still land under a ceiling derived from admission
      // figures. They are a secondary sanity check, scaled off what the winner ACTUALLY spent.
      const spent = providerEstimatedSpend(fixture.workspace, ['tts.elevenlabs', 'tts.elevenlabs-sts', 'clone.elevenlabs']);
      // Scaled off what the WINNER actually spent (summed from its own accounting rows), not off
      // admission figures — that is the only number a second full billing could exceed.
      const winnerId = requestIds[results.indexOf(winners[0]!)]!;
      const winnerSpend = sumEstimates(fixture.workspace, winnerId);
      expect(winnerSpend).toBeGreaterThan(0);
      expect(spent).toBeLessThan(winnerSpend * 2);
      expect(spent).toBeLessThanOrEqual(cap + maxStep);
    } finally { setPaidTransportForTests(null); await app.close(); cleanup(); }
  }, 120000);

  it('counts a crashed step\'s "started" row toward the cap — TRACKED FOLLOW-UP, not a fix', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      const fixture = await setupReady(root, home);
      // A crash between the engine's 'started' row and its terminal leaves a fired-but-unfinished
      // row on disk. providerEstimatedSpend counts 'started' as spending (CALL_FIRED_STATUSES),
      // which is the CORRECT fail-closed choice — the call may well have been billed.
      //
      // The residue is that nothing ever reconciles such a row once the provider is known not to
      // have charged it, so the ceiling stays permanently smaller. Reconciliation is NOT built
      // here (it needs provider-side truth this app does not have). paidCap.test.ts pins the
      // BEHAVIOUR; this test exists so the accepted consequence is written down where the clone
      // chain's own reviewers will find it, rather than inferred from a shared invariant.
      const before = providerEstimatedSpend(fixture.workspace, ['tts.elevenlabs']);
      appendFileSync(join(fixture.workspace, 'logs/provider-requests.jsonl'), JSON.stringify({
        requestId: voicePatchAccountingRequestId('req-crashed-0001', 'sts'), type: 'voice_patch_sts', projectId: 'p1',
        provider: 'tts.elevenlabs', status: 'started', createdAt: new Date().toISOString(),
        cost: { currency: 'USD', estimated: 0.03, actual: null }
      }) + '\n');

      expect(providerEstimatedSpend(fixture.workspace, ['tts.elevenlabs'])).toBeCloseTo(before + 0.03, 6);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('CROSS-PROJECT (pre-existing, unrelated to grants): caps and ledgers are per-workspace', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    setPaidTransportForTests(async () => new Response(new Uint8Array(48000), { status: 200 }));
    try {
      // Two projects never shared a ceiling to begin with — `paidCaps` lives in each workspace's
      // settings and `providerEstimatedSpend` reads each workspace's ledger. This is documented
      // so nobody mistakes it for something grants introduced.
      const a = await makeProject(root, 'pa', { seconds: 60, realVideo: false });
      const b = await makeProject(root, 'pb', { seconds: 60, realVideo: false });
      for (const fixture of [a, b]) {
        writeWorkspaceSettings(fixture.workspace, { ...readWorkspaceSettings(fixture.workspace).value, paidCaps: { 'tts.elevenlabs': 0.01 } });
        expect(providerEstimatedSpend(fixture.workspace, ['tts.elevenlabs'])).toBe(0);
      }
      expect(readWorkspaceSettings(a.workspace).path).not.toBe(readWorkspaceSettings(b.workspace).path);
    } finally { setPaidTransportForTests(null); await app.close(); cleanup(); }
  }, 60000);
});

/** Estimated spend attributable to ONE chain, summed from its two accounting rows. */
function sumEstimates(workspace: string, parentRequestId: string): number {
  const ids = new Set((['tts', 'sts'] as const).map((step) => voicePatchAccountingRequestId(parentRequestId, step)));
  const latestByRequest = new Map<string, number>();
  for (const row of readProviderRequests(workspace) as any[]) {
    if (!ids.has(row.requestId)) continue;
    if (row.status === 'failed') continue;
    if (typeof row.cost?.estimated === 'number') latestByRequest.set(row.requestId, row.cost.estimated);
  }
  return [...latestByRequest.values()].reduce((sum, amount) => sum + amount, 0);
}

/**
 * What admission grants a WORD-granularity patch, and the largest single step in it. Probed on a
 * throwaway project so the numbers are the server's, not the test author's arithmetic.
 */
async function wordChainPrices(root: string, home: string, target: { granularity: 'word'; start: number; end: number }) {
  const app = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports });
  try {
    const probe = await makeProject(root, 'word-probe', { seconds: 60, realVideo: false });
    seedPreparedVoice(home, 'word-probe', probe.cleanupKey);
    const res = await app.inject({ method: 'POST', url: '/api/projects/word-probe/manifest/voice-patches', payload: patchBody({ ...target }) });
    // A probe that did not generate has no grant to read, and a silently-zero price would size
    // the race's ceiling at nothing.
    expect(res.statusCode).toBe(200);
    const grant = readAdmissionGrant(probe.workspace, REQUEST_ID)!;
    const amounts = Object.values(grant.steps).map((amount) => amount ?? 0);
    return { total: grantTotal(grant), maxStep: Math.max(...amounts) };
  } finally { await app.close(); }
}

/** What Phase-1 admission grants this fixture's patch, probed without paying for anything. */
async function admittedTotal(root: string, home: string) {
  const app = createApp(config(root, home), { cloneChainTransports: fakeTransports().transports });
  try {
    const probe = await makeProject(root, 'grant-probe', { seconds: 60, realVideo: false });
    seedPreparedVoice(home, 'grant-probe', probe.cleanupKey);
    await app.inject({ method: 'POST', url: '/api/projects/grant-probe/manifest/voice-patches', payload: patchBody() });
    return grantTotal(readAdmissionGrant(probe.workspace, REQUEST_ID)!);
  } finally { await app.close(); }
}
