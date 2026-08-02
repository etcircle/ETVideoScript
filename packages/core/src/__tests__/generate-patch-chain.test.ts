import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generatePatchViaSts,
  DEFAULT_MIN_FINAL_SEC,
  FinalAssetImplausibleError,
  PaidStepFailedError,
  PaidStepUnknownOutcomeError,
  SeamBakeFailedError,
  StepArtifactCorruptError,
  type PatchStep,
  type PatchStepHooks,
  type PatchStepTerminal,
  type PatchTransports
} from '../generatePatch';
import type { VoicePatchStepArtifact } from '../schemas';

// Real audio: postMatchSeam and the final probe both shell out to ffmpeg/ffprobe, so synthetic
// byte blobs would exercise nothing. A tone is enough — the chain's contract is about ordering,
// idempotency and bounds, not about how the tone sounds.
function tone(path: string, seconds: number, hz = 220) {
  mkdirSync(join(path, '..'), { recursive: true });
  const result = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}`, '-ar', '24000', '-ac', '1', '-acodec', 'pcm_s16le', path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr}`);
}

/** 44-byte header-only WAV: valid file, zero audio — the degraded-provider-payload shape. */
function emptyWav(): Buffer {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(0, 40);
  return b;
}

/** In-memory step store with the same semantics the route's ledger-backed hooks provide. */
function memoryHooks() {
  const terminals = new Map<PatchStep, PatchStepTerminal>();
  const started = new Set<PatchStep>();
  const hooks: PatchStepHooks = {
    readStep: (step) => ({ terminal: terminals.get(step) ?? null, started: started.has(step) }),
    markStarted: (step) => { started.add(step); },
    markSucceeded: (step, artifact: VoicePatchStepArtifact, providerStatus) => { terminals.set(step, { status: 'succeeded', artifact, ...(providerStatus != null ? { providerStatus } : {}) }); },
    markFailed: (step, error, providerStatus) => { terminals.set(step, { status: 'failed', error, ...(providerStatus != null ? { providerStatus } : {}) }); }
  };
  return { hooks, terminals, started };
}

function setup(seconds = 20) {
  const ws = mkdtempSync(join(tmpdir(), 'etvs-chain-'));
  mkdirSync(join(ws, 'assets/voice/steps'), { recursive: true });
  mkdirSync(join(ws, 'assets/studio-clean'), { recursive: true });
  const bedRel = 'assets/studio-clean/bed.wav';
  tone(join(ws, bedRel), seconds, 180);
  const ttsWav = mkdtempSync(join(tmpdir(), 'etvs-chain-src-'));
  tone(join(ttsWav, 'tts.wav'), 1.0, 300);
  tone(join(ttsWav, 'sts.wav'), 1.1, 260);
  tone(join(ttsWav, 'long.wav'), 4.0, 260);
  return {
    ws,
    bedAbs: join(ws, bedRel),
    ttsAudio: readFileSync(join(ttsWav, 'tts.wav')),
    stsAudio: readFileSync(join(ttsWav, 'sts.wav')),
    longAudio: readFileSync(join(ttsWav, 'long.wav')),
    cleanup: () => { rmSync(ws, { recursive: true, force: true }); rmSync(ttsWav, { recursive: true, force: true }); }
  };
}

function params(fixture: ReturnType<typeof setup>, transports: PatchTransports, hooks: PatchStepHooks, overrides: Record<string, unknown> = {}) {
  return {
    workspacePath: fixture.ws,
    parentRequestId: 'req-chain-0001',
    text: 'replacement words',
    voiceId: 'clone-voice-1',
    cleanedBedRel: 'assets/studio-clean/bed.wav',
    editStartSec: 5,
    editEndSec: 6,
    granularity: 'phrase' as const,
    finalAssetRel: 'assets/voice/patch-req-chain-0001.wav',
    stepAssetRel: { tts: 'assets/voice/steps/tts.wav', sts: 'assets/voice/steps/sts.wav' },
    transports,
    hooks,
    ...overrides
  };
}

describe('generatePatchViaSts (S1b W1.3 — D2/D6/D10)', () => {
  it('runs TTS -> STS -> cleaned-bed seam -> final probe and records only the FINAL duration', async () => {
    const fixture = setup();
    try {
      const calls: string[] = [];
      const transports: PatchTransports = {
        async tts() { calls.push('tts'); return { audio: fixture.ttsAudio, providerStatus: 200 }; },
        async sts({ audio }) { calls.push('sts'); expect(audio.equals(fixture.ttsAudio)).toBe(true); return { audio: fixture.stsAudio, providerStatus: 200 }; }
      };
      const { hooks } = memoryHooks();
      const result = await generatePatchViaSts(params(fixture, transports, hooks));
      // Ordering is load-bearing: the STS step must be fed the TTS output, not the source text.
      expect(calls).toEqual(['tts', 'sts']);
      expect(result.seamBaked).toBe(true);
      expect(result.steps.tts.replayed).toBe(false);
      expect(result.steps.sts.replayed).toBe(false);
      // The probe is of the ATTACHED asset after the bake — not of the STS output.
      expect(result.durationSec).toBeGreaterThan(0.1);
      expect(result.assetRel).toBe('assets/voice/patch-req-chain-0001.wav');
      expect(result.steps.tts.artifact.sha256).toHaveLength(64);
      expect(result.steps.sts.artifact.bytes).toBe(fixture.stsAudio.byteLength);
    } finally { fixture.cleanup(); }
  });

  it('accepts a materially LONGER final asset (⟨R9⟩: no upper bound — longer patches extend the timeline)', async () => {
    const fixture = setup();
    try {
      const transports: PatchTransports = {
        async tts() { return { audio: fixture.ttsAudio }; },
        async sts() { return { audio: fixture.longAudio }; }
      };
      const result = await generatePatchViaSts(params(fixture, transports, memoryHooks().hooks));
      // 4s of audio for a 1s slot is accepted, on purpose.
      expect(result.durationSec).toBeGreaterThan(3);
    } finally { fixture.cleanup(); }
  });

    it('never attaches an unprobeable zero-length payload — it fails terminally instead', async () => {
    const fixture = setup();
    try {
      const transports: PatchTransports = {
        async tts() { return { audio: fixture.ttsAudio }; },
        async sts() { return { audio: emptyWav() }; }
      };
      // Whether the bake or the probe catches it first, the outcome must be a TYPED terminal
      // failure — never a silently attached silent gap.
      await expect(generatePatchViaSts(params(fixture, transports, memoryHooks().hooks))).rejects.toSatisfy(
        (err: unknown) => err instanceof SeamBakeFailedError || err instanceof FinalAssetImplausibleError
      );
    } finally { fixture.cleanup(); }
  });

  it('REPLAYS both persisted step terminals without calling either transport again', async () => {
    const fixture = setup();
    try {
      let ttsCalls = 0;
      let stsCalls = 0;
      const transports: PatchTransports = {
        async tts() { ttsCalls += 1; return { audio: fixture.ttsAudio }; },
        async sts() { stsCalls += 1; return { audio: fixture.stsAudio }; }
      };
      const { hooks } = memoryHooks();
      await generatePatchViaSts(params(fixture, transports, hooks));
      expect([ttsCalls, stsCalls]).toEqual([1, 1]);

      const replay = await generatePatchViaSts(params(fixture, transports, hooks));
      expect([ttsCalls, stsCalls]).toEqual([1, 1]); // no re-billing
      expect(replay.steps.tts.replayed).toBe(true);
      expect(replay.steps.sts.replayed).toBe(true);
    } finally { fixture.cleanup(); }
  });

  it('treats a start marker with no terminal as UNKNOWN OUTCOME and never re-bills it', async () => {
    const fixture = setup();
    try {
      let ttsCalls = 0;
      const transports: PatchTransports = {
        async tts() { ttsCalls += 1; return { audio: fixture.ttsAudio }; },
        async sts() { return { audio: fixture.stsAudio }; }
      };
      const store = memoryHooks();
      store.started.add('tts'); // crash between markStarted and the terminal
      await expect(generatePatchViaSts(params(fixture, transports, store.hooks))).rejects.toBeInstanceOf(PaidStepUnknownOutcomeError);
      expect(ttsCalls).toBe(0);
    } finally { fixture.cleanup(); }
  });

  it('replays a sticky FAILED step terminal instead of re-executing it', async () => {
    const fixture = setup();
    try {
      let ttsCalls = 0;
      const transports: PatchTransports = {
        async tts() { ttsCalls += 1; return { audio: fixture.ttsAudio }; },
        async sts() { return { audio: fixture.stsAudio }; }
      };
      const store = memoryHooks();
      store.terminals.set('tts', { status: 'failed', error: 'ElevenLabs TTS failed with HTTP 429', providerStatus: 429 });
      await expect(generatePatchViaSts(params(fixture, transports, store.hooks))).rejects.toMatchObject({ code: 'paid-step-failed', step: 'tts', providerStatus: 429, replayed: true });
      expect(ttsCalls).toBe(0);
    } finally { fixture.cleanup(); }
  });

  it('records a transport failure as a terminal so the NEXT attempt replays it', async () => {
    const fixture = setup();
    try {
      let stsCalls = 0;
      const transports: PatchTransports = {
        async tts() { return { audio: fixture.ttsAudio }; },
        async sts() { stsCalls += 1; const err = new Error('ElevenLabs speech-to-speech failed with HTTP 502') as Error & { providerStatus?: number }; err.providerStatus = 502; throw err; }
      };
      const store = memoryHooks();
      await expect(generatePatchViaSts(params(fixture, transports, store.hooks))).rejects.toBeInstanceOf(PaidStepFailedError);
      expect(store.terminals.get('sts')).toMatchObject({ status: 'failed', providerStatus: 502 });
      await expect(generatePatchViaSts(params(fixture, transports, store.hooks))).rejects.toMatchObject({ replayed: true });
      expect(stsCalls).toBe(1);
    } finally { fixture.cleanup(); }
  });

  it('refuses to reuse a step artifact whose bytes changed under its terminal', async () => {
    const fixture = setup();
    try {
      const transports: PatchTransports = {
        async tts() { return { audio: fixture.ttsAudio }; },
        async sts() { return { audio: fixture.stsAudio }; }
      };
      const { hooks } = memoryHooks();
      await generatePatchViaSts(params(fixture, transports, hooks));
      // Tamper with the persisted TTS artifact.
      writeFileSync(join(fixture.ws, 'assets/voice/steps/tts.wav'), Buffer.concat([fixture.ttsAudio, Buffer.from('tampered')]));
      await expect(generatePatchViaSts(params(fixture, transports, hooks))).rejects.toBeInstanceOf(StepArtifactCorruptError);
    } finally { fixture.cleanup(); }
  });

  it('refuses a step artifact REPLACED BY A SYMLINK after the write (post-write race, ⟨Q7⟩)', async () => {
    const fixture = setup();
    try {
      const transports: PatchTransports = {
        async tts() { return { audio: fixture.ttsAudio }; },
        async sts() { return { audio: fixture.stsAudio }; }
      };
      const { hooks } = memoryHooks();
      await generatePatchViaSts(params(fixture, transports, hooks));
      // Swap the artifact for a symlink pointing at byte-identical content: only O_NOFOLLOW
      // catches this — a plain read + sha256 comparison would happily accept it.
      const stepPath = join(fixture.ws, 'assets/voice/steps/tts.wav');
      const decoy = join(fixture.ws, 'assets/voice/steps/decoy.wav');
      writeFileSync(decoy, fixture.ttsAudio);
      unlinkSync(stepPath);
      symlinkSync(decoy, stepPath);
      await expect(generatePatchViaSts(params(fixture, transports, hooks))).rejects.toBeInstanceOf(StepArtifactCorruptError);
    } finally { fixture.cleanup(); }
  });

  it('refuses a cleaned bed reached through a SYMLINKED LEAF, and never bakes against it (⟨Q7⟩)', async () => {
    const fixture = setup();
    try {
      const transports: PatchTransports = {
        async tts() { return { audio: fixture.ttsAudio }; },
        async sts() { return { audio: fixture.stsAudio }; }
      };
      // A symlink where the cleaned bed should be: lexically inside the workspace, so
      // assertInside alone accepts it — and ffmpeg would happily read whatever it points at,
      // baking that audio's neighbours into the patch that ships to the user's timeline.
      const secret = join(fixture.ws, 'assets/studio-clean/private.wav');
      tone(secret, 5, 440);
      const bedRel = 'assets/studio-clean/linked-bed.wav';
      symlinkSync(secret, join(fixture.ws, bedRel));
      await expect(generatePatchViaSts(params(fixture, transports, memoryHooks().hooks, { cleanedBedRel: bedRel })))
        .rejects.toBeInstanceOf(SeamBakeFailedError);
    } finally { fixture.cleanup(); }
  });

  it('refuses a cleaned bed reached through a SYMLINKED ANCESTOR DIRECTORY (⟨Q7⟩)', async () => {
    const fixture = setup();
    try {
      const transports: PatchTransports = {
        async tts() { return { audio: fixture.ttsAudio }; },
        async sts() { return { audio: fixture.stsAudio }; }
      };
      // The leaf is a genuine file; the DIRECTORY above it is the symlink. O_NOFOLLOW on the
      // leaf alone would sail straight through this.
      const realDir = join(fixture.ws, 'assets/real-clean');
      mkdirSync(realDir, { recursive: true });
      tone(join(realDir, 'bed.wav'), 5, 440);
      symlinkSync(realDir, join(fixture.ws, 'assets/linked-clean'));
      await expect(generatePatchViaSts(params(fixture, transports, memoryHooks().hooks, { cleanedBedRel: 'assets/linked-clean/bed.wav' })))
        .rejects.toBeInstanceOf(SeamBakeFailedError);
    } finally { fixture.cleanup(); }
  });

  it('refuses a replayed artifact whose terminal points at a DIFFERENT path than this step derives', async () => {
    const fixture = setup();
    try {
      const transports: PatchTransports = {
        async tts() { return { audio: fixture.ttsAudio }; },
        async sts() { return { audio: fixture.stsAudio }; }
      };
      const store = memoryHooks();
      // A ledger record is durable state, not an instruction: pointing it elsewhere must not
      // redirect the read, even when the bytes there hash correctly.
      const elsewhere = 'assets/voice/steps/elsewhere.wav';
      writeFileSync(join(fixture.ws, elsewhere), fixture.ttsAudio);
      store.terminals.set('tts', {
        status: 'succeeded',
        artifact: { relPath: elsewhere, bytes: fixture.ttsAudio.byteLength, sha256: createHash('sha256').update(fixture.ttsAudio).digest('hex'), durationSec: 1 }
      });
      await expect(generatePatchViaSts(params(fixture, transports, store.hooks))).rejects.toBeInstanceOf(StepArtifactCorruptError);
    } finally { fixture.cleanup(); }
  });

  it('rejects a REAL 90 ms payload terminally — the seam catches it before the floor can', async () => {
    const fixture = setup();
    try {
      // Measured behaviour, not an assumption: postMatchSeam's level match runs loudnorm, whose
      // EBU R128 integrated-loudness measurement has a ~400 ms gate (see LEVEL_MEASURE_WINDOW_SEC).
      // A 90 ms patch therefore cannot be baked AT ALL — at 0.09/0.15/0.25 s the bake declines and
      // only from ~0.4 s does it succeed. So in production a sub-floor provider payload is caught
      // HERE, and the ⟨R9⟩ floor is defence-in-depth behind it (pinned separately below).
      const shortDir = mkdtempSync(join(tmpdir(), 'etvs-chain-short-'));
      tone(join(shortDir, 'short.wav'), 0.09, 260);
      const shortAudio = readFileSync(join(shortDir, 'short.wav'));
      const transports: PatchTransports = {
        async tts() { return { audio: fixture.ttsAudio }; },
        async sts() { return { audio: shortAudio }; }
      };
      const rejection = await generatePatchViaSts(params(fixture, transports, memoryHooks().hooks, { editStartSec: 5, editEndSec: 5.09, granularity: 'word' }))
        .then(() => null, (err: unknown) => err);
      // Exactly one outcome, asserted precisely — and never a silent attach.
      expect(rejection).toBeInstanceOf(SeamBakeFailedError);
      rmSync(shortDir, { recursive: true, force: true });
    } finally { fixture.cleanup(); }
  });

  it('rejects a REAL 90 ms asset under the SHIPPED 0.1 s floor when the bake succeeds (silent neighbours)', async () => {
    // The seam only runs loudnorm when a neighbour is loud enough to measure (postMatchSeam
    // NEIGHBOR_SILENCE_FLOOR_LUFS). With a near-SILENT bed it takes the transcode-only branch,
    // which has no ~400 ms integrated-loudness gate — so a 90 ms patch bakes successfully and
    // reaches the production floor. This is the path a degraded provider payload takes on a
    // quiet stretch of a recording.
    const ws = mkdtempSync(join(tmpdir(), 'etvs-chain-silent-'));
    try {
      mkdirSync(join(ws, 'assets/voice/steps'), { recursive: true });
      mkdirSync(join(ws, 'assets/studio-clean'), { recursive: true });
      // A silent bed: measurable as a file, but below the neighbour usability floor.
      const bedRel = 'assets/studio-clean/silent-bed.wav';
      const silent = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '20', '-acodec', 'pcm_s16le', join(ws, bedRel)], { encoding: 'utf8' });
      if (silent.status !== 0) throw new Error(`ffmpeg fixture failed: ${silent.stderr}`);

      const srcDir = mkdtempSync(join(tmpdir(), 'etvs-chain-silent-src-'));
      tone(join(srcDir, 'tts.wav'), 1.0, 300);
      tone(join(srcDir, 'short.wav'), 0.09, 260);
      const transports: PatchTransports = {
        async tts() { return { audio: readFileSync(join(srcDir, 'tts.wav')) }; },
        async sts() { return { audio: readFileSync(join(srcDir, 'short.wav')) }; }
      };

      const rejection = await generatePatchViaSts({
        workspacePath: ws,
        parentRequestId: 'req-silent-0001',
        text: 'replacement words',
        voiceId: 'clone-voice-1',
        cleanedBedRel: bedRel,
        editStartSec: 5,
        editEndSec: 5.09,
        granularity: 'word',
        finalAssetRel: 'assets/voice/patch-req-silent-0001.wav',
        stepAssetRel: { tts: 'assets/voice/steps/tts.wav', sts: 'assets/voice/steps/sts.wav' },
        transports,
        hooks: memoryHooks().hooks
      }).then(() => null, (err: unknown) => err);

      // The bake SUCCEEDED and the floor is what rejected it — asserted exactly, so deleting the
      // floor check cannot leave this green.
      expect(rejection).toBeInstanceOf(FinalAssetImplausibleError);
      expect((rejection as FinalAssetImplausibleError).durationSec).toBeGreaterThan(0);
      expect((rejection as FinalAssetImplausibleError).durationSec).toBeLessThan(DEFAULT_MIN_FINAL_SEC);
      rmSync(srcDir, { recursive: true, force: true });
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('pins the PRODUCTION floor constant at 0.1 s and enforces it on the attached asset', async () => {
    // The floor constant itself is pinned so it cannot drift silently...
    expect(DEFAULT_MIN_FINAL_SEC).toBe(0.1);

    const fixture = setup();
    try {
      const transports: PatchTransports = {
        async tts() { return { audio: fixture.ttsAudio }; },
        async sts() { return { audio: fixture.stsAudio }; }
      };
      // ...and the CHECK is exercised by moving the bound above a real baked asset. Deleting the
      // floor check in generatePatchViaSts makes this assertion fail, which is the property that
      // matters; a genuinely bakeable sub-0.1 s asset does not exist (see the seam gate above).
      const rejection = await generatePatchViaSts(params(fixture, transports, memoryHooks().hooks, { minFinalDurationSec: 10 }))
        .then(() => null, (err: unknown) => err);
      expect(rejection).toBeInstanceOf(FinalAssetImplausibleError);
      expect((rejection as FinalAssetImplausibleError).durationSec).toBeGreaterThan(0);
      expect((rejection as FinalAssetImplausibleError).durationSec).toBeLessThan(10);
      // The same asset passes under the shipped floor: the rejection is the bound, not the audio.
      const accepted = await generatePatchViaSts(params(fixture, transports, memoryHooks().hooks));
      expect(accepted.durationSec).toBeGreaterThanOrEqual(DEFAULT_MIN_FINAL_SEC);
    } finally { fixture.cleanup(); }
  });

  it('surfaces a MISSING ffprobe binary as infrastructure breakage, never as degraded provider audio', async () => {
    const fixture = setup();
    const originalPath = process.env.PATH;
    try {
      const transports: PatchTransports = {
        async tts() { return { audio: fixture.ttsAudio }; },
        async sts() { return { audio: fixture.stsAudio }; }
      };
      // ENOENT on the probe binary. spawnSync reports it via `error` with status null — which the
      // old run() collapsed into the same "ffprobe failed:" message a rejected FILE produces, so
      // a broken machine was reported as "the provider returned 0 ms" and the work was rejected.
      process.env.PATH = join(fixture.ws, 'no-binaries-here');
      const rejection = await generatePatchViaSts(params(fixture, transports, memoryHooks().hooks))
        .then(() => null, (err: unknown) => err);
      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).not.toBeInstanceOf(FinalAssetImplausibleError);
      expect(String((rejection as Error).message)).toMatch(/could not be spawned|ENOENT/);
    } finally { process.env.PATH = originalPath; fixture.cleanup(); }
  });

  it('propagates local infrastructure failures instead of blaming the provider', async () => {
    const fixture = setup();
    try {
      const transports: PatchTransports = {
        // A transport that "succeeds" but whose bytes we then make unreadable stands in for a
        // broken machine: the chain must NOT report it as a degraded provider payload.
        async tts() { return { audio: fixture.ttsAudio }; },
        async sts() { return { audio: fixture.stsAudio }; }
      };
      const { hooks } = memoryHooks();
      // Point the final asset at a directory that cannot be created (a file sits where the
      // parent dir would go) — a local write failure, not a provider problem.
      writeFileSync(join(fixture.ws, 'assets/voice/blocker'), 'not a directory');
      await expect(generatePatchViaSts(params(fixture, transports, hooks, { finalAssetRel: 'assets/voice/blocker/final.wav' })))
        .rejects.toSatisfy((err: unknown) =>
          !(err instanceof FinalAssetImplausibleError) && !(err instanceof SeamBakeFailedError));
    } finally { fixture.cleanup(); }
  });

  it('makes a seam failure TERMINAL — no unbaked attach (D10)', async () => {
    const fixture = setup();
    try {
      const transports: PatchTransports = {
        async tts() { return { audio: fixture.ttsAudio }; },
        async sts() { return { audio: fixture.stsAudio }; }
      };
      // The cleaned bed is gone: postMatchSeam cannot bake, and D6 forbids falling back to raw.
      await expect(generatePatchViaSts(params(fixture, transports, memoryHooks().hooks, { cleanedBedRel: 'assets/studio-clean/gone.wav' })))
        .rejects.toBeInstanceOf(SeamBakeFailedError);
    } finally { fixture.cleanup(); }
  });
});
