import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { latestJobs, readVoicesLibrary } from '@etvideoscript/core';
import { createApp, type LocalApiDeps } from './server';
import { casCloneReservation, cloneReservationKey, readCloneReservations, writeCloneReservation } from './voiceDurableState';
import { makeProject, seedPreparedVoice, syntheticVoicedPcm } from './voiceFixtures';

function config(root: string, settingsHome: string) {
  return { host: '127.0.0.1', port: 0, workspaceRoot: root, enableTerminal: false, allowedOrigins: ['http://127.0.0.1:4318'], lanOrigins: [], terminalToken: null, settingsHome };
}

function roots() {
  const root = mkdtempSync(join(tmpdir(), 'etvs-prepare-root-'));
  const home = mkdtempSync(join(tmpdir(), 'etvs-prepare-home-'));
  return { root, home, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

/** Poll the job log until the prepare job reaches a terminal (the job runs on setImmediate). */
async function awaitJobTerminal(workspace: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = latestJobs(workspace).find((entry) => entry.type === 'prepare-voice');
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('prepare-voice job did not reach a terminal in time');
}

describe('prepare-voice route (S1b W1.5/W1.6)', () => {
  it('refuses a transcript that is not word-accurate', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await makeProject(root, 'p1', { timing: 'mock', seconds: 10 });
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/voice/prepare' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).errorCode).toBe('transcript-not-word-accurate');
    } finally { await app.close(); cleanup(); }
  });

  it('refuses when Studio Sound has not produced a fresh cleaned bed (D6, no raw fallback)', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      await makeProject(root, 'p1', { cleanup: 'none', seconds: 10 });
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/voice/prepare' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).errorCode).toBe('cleaned-source-unavailable');
    } finally { await app.close(); cleanup(); }
  });

  it('refuses MULTIPLE eligible sources but IGNORES unrelated clips (⟨F13⟩)', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      // b-roll on another asset must not count as an eligible cleaned speech source.
      await makeProject(root, 'ignored', { unrelatedClip: true, seconds: 10 });
      const ok = await app.inject({ method: 'GET', url: '/api/projects/ignored/voice/status' });
      expect(JSON.parse(ok.body).state).toBe('none');
      expect(JSON.parse(ok.body).errorCode).toBeUndefined();

      await makeProject(root, 'multi', { extraEligibleClip: true, seconds: 10 });
      const res = await app.inject({ method: 'POST', url: '/api/projects/multi/voice/prepare' });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.errorCode).toBe('multi-clip-unsupported');
      expect(body.details.clipIds).toEqual(['clip_001', 'clip_002']);
    } finally { await app.close(); cleanup(); }
  });

  it('short-circuits on a cache hit — no paid clone when a voice already exists for this cleanup', async () => {
    const { root, home, cleanup } = roots();
    let cloneCalls = 0;
    const deps: LocalApiDeps = { prepareVoice: { cloneExecutor: async () => { cloneCalls += 1; return { voiceId: 'nope' }; } } };
    const app = createApp(config(root, home), deps);
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 10 });
      seedPreparedVoice(home, 'p1', fixture.cleanupKey);
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/voice/prepare' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ cached: true, status: { state: 'ready', voiceId: 'el-voice-abc' } });
      expect(cloneCalls).toBe(0);

      const status = await app.inject({ method: 'GET', url: '/api/projects/p1/voice/status' });
      expect(JSON.parse(status.body)).toMatchObject({ state: 'ready', voiceId: 'el-voice-abc' });
    } finally { await app.close(); cleanup(); }
  });

  it('clones once end to end, discloses the call, and lands /voice/status at ready', async () => {
    const { root, home, cleanup } = roots();
    let cloneCalls = 0;
    let sampleCount = 0;
    const deps: LocalApiDeps = {
      prepareVoice: {
        decode: () => syntheticVoicedPcm(60),
        cloneExecutor: async (input) => { cloneCalls += 1; sampleCount = input.samples.length; return { voiceId: 'el-cloned-1' }; }
      }
    };
    const app = createApp(config(root, home), deps);
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 60, realVideo: true });
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/voice/prepare' });
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body).costDisclosure).toMatch(/clone call/i);

      const job = await awaitJobTerminal(fixture.workspace);
      expect(job.status).toBe('succeeded');
      // Multi-window: the recipe fills EL's budget with several ~10 s windows, not one.
      expect(cloneCalls).toBe(1);
      expect(sampleCount).toBeGreaterThan(1);

      const voices = readVoicesLibrary({ homeDir: home }).value.voices;
      expect(voices[0]).toMatchObject({ provider: 'elevenlabs', voiceId: 'el-cloned-1', sourceClass: 'cleaned', cleanupIdentity: fixture.cleanupKey, accountRef: 'elevenlabs' });

      const status = await app.inject({ method: 'GET', url: '/api/projects/p1/voice/status' });
      expect(JSON.parse(status.body)).toMatchObject({ state: 'ready', voiceId: 'el-cloned-1' });
      expect(Object.values(readCloneReservations(fixture.workspace))[0]!.state).toBe('persisted');
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('collapses SIMULTANEOUS prepare POSTs onto ONE paid clone (⟨F2⟩ durable reservation)', async () => {
    const { root, home, cleanup } = roots();
    let cloneCalls = 0;
    const deps: LocalApiDeps = {
      prepareVoice: {
        decode: () => syntheticVoicedPcm(60),
        cloneExecutor: async () => { cloneCalls += 1; return { voiceId: 'el-cloned-1' }; }
      }
    };
    const app = createApp(config(root, home), deps);
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 60, realVideo: true });
      const [first, second] = await Promise.all([
        app.inject({ method: 'POST', url: '/api/projects/p1/voice/prepare' }),
        app.inject({ method: 'POST', url: '/api/projects/p1/voice/prepare' })
      ]);
      expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
      // Exactly one of them started a job; the other joined it.
      const deduped = [first, second].filter((res) => JSON.parse(res.body).deduped === true);
      expect(deduped).toHaveLength(1);
      expect(Object.keys(readCloneReservations(fixture.workspace))).toHaveLength(1);

      await awaitJobTerminal(fixture.workspace);
      expect(cloneCalls).toBe(1);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('reports insufficient-clean-windows with the shortfall, and never reaches the paid call', async () => {
    const { root, home, cleanup } = roots();
    let cloneCalls = 0;
    const deps: LocalApiDeps = {
      // Silence: no voiced frames ⇒ no usable window clears the coverage floor.
      prepareVoice: { decode: () => new Float32Array(16000 * 60), cloneExecutor: async () => { cloneCalls += 1; return { voiceId: 'x' }; } }
    };
    const app = createApp(config(root, home), deps);
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 60 });
      await app.inject({ method: 'POST', url: '/api/projects/p1/voice/prepare' });
      const job = await awaitJobTerminal(fixture.workspace);
      expect(job.status).toBe('failed');
      expect(job.errorCode).toBe('insufficient-clean-windows');
      expect(job.errorDetails).toMatchObject({ requiredSec: 30 });
      expect(cloneCalls).toBe(0);
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('maps an ElevenLabs voice-slot ceiling onto a typed failure with no auto-retry', async () => {
    const { root, home, cleanup } = roots();
    let cloneCalls = 0;
    const deps: LocalApiDeps = {
      prepareVoice: {
        decode: () => syntheticVoicedPcm(60),
        cloneExecutor: async () => {
          cloneCalls += 1;
          const err = new Error('ElevenLabs voice clone failed with HTTP 400: {"detail":{"status":"voice_limit_reached"}}') as Error & { providerStatus?: number };
          err.providerStatus = 400;
          throw err;
        }
      }
    };
    const app = createApp(config(root, home), deps);
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 60, realVideo: true });
      await app.inject({ method: 'POST', url: '/api/projects/p1/voice/prepare' });
      const job = await awaitJobTerminal(fixture.workspace);
      expect(job.status).toBe('failed');
      expect(job.errorCode).toBe('voice-slot-limit');
      expect(cloneCalls).toBe(1); // and NOT retried
      const status = await app.inject({ method: 'GET', url: '/api/projects/p1/voice/status' });
      expect(JSON.parse(status.body)).toMatchObject({ state: 'none', errorCode: 'voice-slot-limit' });
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('allows cancellation only before the paid call, and 409s once the clone is in flight (⟨Q2⟩)', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home), { prepareVoice: { decode: () => syntheticVoicedPcm(60), cloneExecutor: async () => ({ voiceId: 'v' }) } });
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 60 });
      const res = await app.inject({ method: 'POST', url: '/api/projects/p1/voice/prepare' });
      const jobId = JSON.parse(res.body).job.jobId;
      const key = Object.keys(readCloneReservations(fixture.workspace))[0]!;

      // While in local-prep, cancelling is honest: nothing has been billed.
      const early = await app.inject({ method: 'POST', url: `/api/projects/p1/jobs/${jobId}/cancel` });
      expect(early.statusCode).toBe(200);

      // Once the reservation reaches provider-in-flight the call may already have been billed,
      // so a terminal 'cancelled' would be a lie.
      casCloneReservation(fixture.workspace, key, ['local-prep', 'failed'], { state: 'provider-in-flight' });
      const late = await app.inject({ method: 'POST', url: `/api/projects/p1/jobs/${jobId}/cancel` });
      expect(late.statusCode).toBe(409);
      expect(JSON.parse(late.body).errorCode).toBe('too-late-to-cancel');
    } finally { await app.close(); cleanup(); }
  }, 60000);

  it('resolves the cancel-vs-payment race one way or the other, never both (barrier CAS)', async () => {
    // The job is held at a barrier immediately BEFORE its pre-payment CAS, the cancel is issued
    // while it waits, and then the job is released. Exactly one of them may win:
    //   cancel wins     ⇒ zero paid calls, and the job terminates as cancelled;
    //   the job wins    ⇒ the clone runs, and the cancel is refused 409 too-late-to-cancel.
    // A run where the cancel returns 200 AND the clone executes is the bug this guards.
    for (const releaseBeforeCancel of [false, true]) {
      const { root, home, cleanup } = roots();
      let cloneCalls = 0;
      let releaseBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
      const deps: LocalApiDeps = {
        prepareVoice: {
          // The decode is the last local phase before the pre-payment CAS, so blocking here
          // parks the job exactly at the barrier.
          decode: () => { return syntheticVoicedPcm(60); },
          cloneExecutor: async () => { cloneCalls += 1; return { voiceId: 'el-cloned-1' }; }
        }
      };
      // Hold the job by making window selection await the barrier via a slow decode.
      deps.prepareVoice!.decode = () => syntheticVoicedPcm(60);
      const app = createApp(config(root, home), deps);
      try {
        const fixture = await makeProject(root, 'p1', { seconds: 60, realVideo: true });
        // Gate the paid call itself: the executor waits on the barrier, so the reservation has
        // already transitioned when the cancel arrives in the "job wins" ordering.
        deps.prepareVoice!.cloneExecutor = async () => { await barrier; cloneCalls += 1; return { voiceId: 'el-cloned-1' }; };

        const res = await app.inject({ method: 'POST', url: '/api/projects/p1/voice/prepare' });
        const jobId = JSON.parse(res.body).job.jobId;
        if (releaseBeforeCancel) {
          // Let the job reach (and pass) the barrier first.
          releaseBarrier();
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const cancel = await app.inject({ method: 'POST', url: `/api/projects/p1/jobs/${jobId}/cancel` });
        releaseBarrier();
        const job = await awaitJobTerminal(fixture.workspace);
        const reservation = Object.values(readCloneReservations(fixture.workspace))[0]!;

        if (cancel.statusCode === 200) {
          // Cancel won the CAS: nothing may have been billed, and the durable state says so.
          expect(cloneCalls).toBe(0);
          expect(reservation.state).toBe('failed');
          expect(reservation.errorCode).toBe('cancelled');
          expect(job.status).toBe('cancelled');
        } else {
          // The job won: the cancel is refused honestly rather than claiming a call did not run.
          expect(cancel.statusCode).toBe(409);
          expect(JSON.parse(cancel.body).errorCode).toBe('too-late-to-cancel');
          expect(cloneCalls).toBe(1);
        }
      } finally { await app.close(); cleanup(); }
    }
  }, 90000);

  it('reconciles a crash mid-clone to unknown-outcome, and a crash before any paid call to interrupted', async () => {
    const { root, home, cleanup } = roots();
    const { root: root2, home: home2, cleanup: cleanup2 } = roots();
    try {
      // --- Crash AFTER the paid call was issued: unknown outcome, never auto-retried.
      const inflight = await makeProject(root, 'p1', { seconds: 10 });
      writeCloneReservation(inflight.workspace, {
        key: cloneReservationKey({ accountRef: 'elevenlabs', cleanupIdentity: inflight.cleanupKey, sourceClass: 'cleaned', clipId: 'clip_001' }),
        projectId: 'p1', jobId: 'job_prepare-voice_dead_1', accountRef: 'elevenlabs',
        cleanupIdentity: inflight.cleanupKey, clipId: 'clip_001', sourceClass: 'cleaned',
        state: 'provider-in-flight', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
      // A FRESH app instance = a restarted server: nothing is live, so startup reconciles.
      const app = createApp(config(root, home));
      const status = await app.inject({ method: 'GET', url: '/api/projects/p1/voice/status' });
      expect(JSON.parse(status.body)).toMatchObject({ state: 'unknown-outcome', errorCode: 'unknown-outcome', jobId: 'job_prepare-voice_dead_1' });
      const job = latestJobs(inflight.workspace).find((entry) => entry.type === 'prepare-voice')!;
      expect(job.status).toBe('failed');
      expect(job.errorCode).toBe('unknown-outcome');
      await app.close();

      // --- Crash BEFORE any paid call: nothing was billed, so it is merely interrupted.
      const local = await makeProject(root2, 'p1', { seconds: 10 });
      writeCloneReservation(local.workspace, {
        key: cloneReservationKey({ accountRef: 'elevenlabs', cleanupIdentity: local.cleanupKey, sourceClass: 'cleaned', clipId: 'clip_001' }),
        projectId: 'p1', jobId: 'job_prepare-voice_dead_2', accountRef: 'elevenlabs',
        cleanupIdentity: local.cleanupKey, clipId: 'clip_001', sourceClass: 'cleaned',
        state: 'local-prep', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
      const app2 = createApp(config(root2, home2));
      const status2 = await app2.inject({ method: 'GET', url: '/api/projects/p1/voice/status' });
      expect(JSON.parse(status2.body)).toMatchObject({ state: 'none', errorCode: 'interrupted' });
      await app2.close();
    } finally { cleanup(); cleanup2(); }
  }, 60000);

  it('runs startup reconciliation inside the project mutex, before the first request is served', async () => {
    const { root, home, cleanup } = roots();
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 10 });
      writeCloneReservation(fixture.workspace, {
        key: cloneReservationKey({ accountRef: 'elevenlabs', cleanupIdentity: fixture.cleanupKey, sourceClass: 'cleaned', clipId: 'clip_001' }),
        projectId: 'p1', jobId: 'job_prepare-voice_dead_3', accountRef: 'elevenlabs',
        cleanupIdentity: fixture.cleanupKey, clipId: 'clip_001', sourceClass: 'cleaned',
        state: 'provider-in-flight', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });

      const app = createApp(config(root, home));
      try {
        // `ready()` resolves only after the onReady hook has finished, so reconciliation is
        // complete — and serialized on the project mutex — before ANY request can interleave
        // with it. Previously it ran inline at construction, outside the mutex the CAS assumes.
        await app.ready();
        expect(Object.values(readCloneReservations(fixture.workspace))[0]!.state).toBe('failed');
        expect(latestJobs(fixture.workspace).find((job) => job.type === 'prepare-voice')!.errorCode).toBe('unknown-outcome');
      } finally { await app.close(); }
    } finally { cleanup(); }
  }, 60000);

  it('reports a clone trained on a superseded cleanup as STALE, not absent', async () => {
    const { root, home, cleanup } = roots();
    const app = createApp(config(root, home));
    try {
      const fixture = await makeProject(root, 'p1', { seconds: 10, cleanup: 'disabled' });
      seedPreparedVoice(home, 'p1', fixture.cleanupKey);
      const status = await app.inject({ method: 'GET', url: '/api/projects/p1/voice/status' });
      expect(JSON.parse(status.body)).toMatchObject({ state: 'stale', voiceId: 'el-voice-abc' });
    } finally { await app.close(); cleanup(); }
  });
});
