import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync } from 'node:fs';
import { assertInside, atomicWriteFile, readRegularFileNoFollow, stageVerifiedWorkspaceFile } from './filesystem';
import { ffprobeDurationSecOrZero } from './media';
import { postMatchSeam } from './postMatchSeam';
import type { VoicePatchStepArtifact } from './schemas';

// ── The clone-chain patch generator (S1b W1.3, implementing D2 / D6 / D10) ────────
//
// One user action = TTS-in-clone → EL speech-to-speech onto the SAME clone → seam bake on the
// CLEANED bed → final probe of the attached asset. Every paid step is transported IN (the
// route injects them, so tests never need a network) and persisted OUT through hooks (the
// route owns ledger writes, so this module never touches the ledger's format).
//
// The money invariants live here, not in the route:
//   • a step with a durable TERMINAL is replayed, never re-billed;
//   • a step with a start marker but NO terminal is UNKNOWN-OUTCOME and is never auto-retried
//     — only a fresh user action with a new requestId may pay again;
//   • a replayed artifact is re-verified (symlink-safe read + size + sha256) before reuse; a
//     mismatch is its own unknown-outcome-class failure, never a silent re-synthesis.

export type PatchStep = 'tts' | 'sts';

export class PaidStepUnknownOutcomeError extends Error {
  readonly code = 'paid-step-unknown-outcome';
  readonly step: PatchStep;
  constructor(step: PatchStep) {
    super(`paid-step-unknown-outcome: the ${step} step was started but never reached a terminal (process died mid-call). It may or may not have been billed, so it is not retried automatically — start a new generation to try again.`);
    this.name = 'PaidStepUnknownOutcomeError';
    this.step = step;
  }
}

export class StepArtifactCorruptError extends Error {
  readonly code = 'step-artifact-corrupt';
  readonly step: PatchStep;
  constructor(step: PatchStep, detail: string) {
    super(`step-artifact-corrupt: the persisted ${step} artifact no longer matches its terminal record (${detail}). The step is NOT re-billed; start a new generation.`);
    this.name = 'StepArtifactCorruptError';
    this.step = step;
  }
}

export class PaidStepFailedError extends Error {
  readonly code = 'paid-step-failed';
  readonly step: PatchStep;
  readonly providerStatus?: number;
  readonly replayed: boolean;
  constructor(step: PatchStep, message: string, options: { providerStatus?: number; replayed?: boolean } = {}) {
    super(message);
    this.name = 'PaidStepFailedError';
    this.step = step;
    this.providerStatus = options.providerStatus;
    this.replayed = options.replayed ?? false;
  }
}

export class SeamBakeFailedError extends Error {
  readonly code = 'seam-bake-failed';
  constructor(detail: string) {
    super(`seam-bake-failed: ${detail}. The patch is not attached unbaked — a patch that has not been seated on the cleaned bed would be audible as a jump cut.`);
    this.name = 'SeamBakeFailedError';
  }
}

export class FinalAssetImplausibleError extends Error {
  readonly code = 'final-asset-implausible';
  readonly durationSec: number;
  constructor(durationSec: number, floorSec: number) {
    super(`final-asset-implausible: the attached asset probes at ${(durationSec * 1000).toFixed(0)} ms, below the ${(floorSec * 1000).toFixed(0)} ms floor. Rejected as a degraded provider payload.`);
    this.name = 'FinalAssetImplausibleError';
    this.durationSec = durationSec;
  }
}

/** A durable terminal for one paid step, as the route persists and reads it back. */
export type PatchStepTerminal =
  | { status: 'succeeded'; artifact: VoicePatchStepArtifact; providerStatus?: number }
  | { status: 'failed'; error: string; providerStatus?: number };

export interface PatchStepHooks {
  /** Durable state of a step. `started` means a pre-call marker exists on disk. */
  readStep(step: PatchStep): { terminal: PatchStepTerminal | null; started: boolean };
  /** Durably record the pre-call marker. MUST be flushed before the paid call is made. */
  markStarted(step: PatchStep): void;
  markSucceeded(step: PatchStep, artifact: VoicePatchStepArtifact, providerStatus?: number): void;
  markFailed(step: PatchStep, error: string, providerStatus?: number): void;
}

export interface PatchTransports {
  tts(input: { text: string; voiceId: string }): Promise<{ audio: Buffer; providerStatus?: number }>;
  /** `sourceDurationSec` is the STS step's real billing unit — passed so spend caps can bound it. */
  sts(input: { audio: Buffer; voiceId: string; sourceDurationSec?: number }): Promise<{ audio: Buffer; providerStatus?: number }>;
}

export interface GeneratePatchViaStsParams {
  workspacePath: string;
  /** Route-level requestId; step storage keys derive from it (providerRequests.voicePatchStepRecordId). */
  parentRequestId: string;
  text: string;
  /** The project's EL clone voice id — the SAME clone for both the TTS and the STS step. */
  voiceId: string;
  /**
   * WORKSPACE-RELATIVE path of the FRESH cleaned bed the seam is baked against (D6). There is
   * deliberately no raw-bed fallback in this recipe: a cleaned-trained clone seated on a raw
   * bed is the exact mismatch the ear-locked recipe exists to avoid.
   *
   * Relative, not absolute, so this module can open it symlink-safely and stage the verified
   * bytes itself — handing ffmpeg the caller's path string would re-open it by name and reopen
   * the swap window a lexical check cannot close.
   */
  cleanedBedRel: string;
  /** Edit window on the ASSET axis (the axis the cleaned bed and the 48k reference share). */
  editStartSec: number;
  editEndSec: number;
  granularity?: 'word' | 'phrase' | 'sentence';
  /** Workspace-relative destination of the FINAL attached asset. */
  finalAssetRel: string;
  /** Workspace-relative paths for the two intermediate step assets (⟨R8⟩). */
  stepAssetRel: Record<PatchStep, string>;
  transports: PatchTransports;
  hooks: PatchStepHooks;
  /** ⟨R9⟩: floor only. There is NO upper bound — a longer patch legitimately extends the timeline. */
  minFinalDurationSec?: number;
}

export interface GeneratePatchViaStsResult {
  assetRel: string;
  durationSec: number;
  /** Always true on success: D10 makes an unbaked attach unrepresentable. */
  seamBaked: true;
  steps: Record<PatchStep, { artifact: VoicePatchStepArtifact; replayed: boolean }>;
  seamReport: Awaited<ReturnType<typeof postMatchSeam>>['report'];
}

/**
 * ⟨R9⟩ floor for the ATTACHED asset. Floor only — there is no upper bound, because a longer
 * patch legitimately extends the timeline.
 *
 * Exported so a test can pin the production value rather than restating the literal: the floor
 * is a money-adjacent acceptance bound and must not drift silently.
 */
export const DEFAULT_MIN_FINAL_SEC = 0.1;

/**
 * How much longer than the requested span a synthesized line may plausibly run.
 *
 * The speech-to-speech step bills by the duration of its SOURCE — the TTS output — which does
 * not exist when the chain is admitted against the spend cap. Admitting against the requested
 * span alone under-prices any patch whose synthesized line runs long (a mouthful of words in a
 * short slot), so admission prices the CONSERVATIVE bound below instead.
 *
 * There is deliberately no second copy of this factor on the execution side: Phase 1 converts
 * the bound into a granted AMOUNT, and execution compares its real estimate against that amount.
 * A TTS output longer than the bound therefore prices above the grant and falls back to the live
 * cap check — fail-closed, never a silent overspend. `conservativeStsSource.test.ts` pins the
 * relationship so the two cannot drift apart.
 */
export const STS_SOURCE_BOUND_FACTOR = 2;

/** The duration the STS step is ADMITTED against, given the requested patch span. */
export function conservativeStsSourceSec(requestedSec: number): number {
  return Math.max(0, requestedSec) * STS_SOURCE_BOUND_FACTOR;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Duration of a file we have just written ourselves, where an UNREADABLE result means the
 * PROVIDER handed us a degraded payload — not that the local machine is broken.
 *
 * `ffprobeDurationSecOrZero` only swallows the "probe ran, duration is N/A" case; a container
 * ffprobe rejects outright ("Invalid data found…") still throws, which is right for arbitrary
 * user media but wrong here: a paid provider returning a malformed WAV is exactly the
 * degraded-payload band this chain rejects cleanly.
 *
 * NARROW on purpose. Only a probe that RAN and rejected the CONTENT maps to 0. A missing file,
 * an unreadable file, or a missing/unspawnable ffprobe is local infrastructure breakage and
 * must propagate — reporting it as "the provider returned 0 ms" would blame a vendor for a
 * broken machine and quietly reject work that was actually fine.
 */
function probeDegradablePayload(absPath: string): number {
  if (!existsSync(absPath)) throw new Error(`probeDegradablePayload: file not found: ${absPath}`);
  accessSync(absPath, constants.R_OK);
  try { return ffprobeDurationSecOrZero(absPath); }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // ffprobe.run() throws `${command} failed: ${stderr}` only after the process actually ran;
    // a spawn failure (ENOENT on the binary) surfaces differently and is rethrown here.
    if (/^ffprobe failed:/.test(message)) return 0;
    throw err;
  }
}

/**
 * Run one paid step with full durable idempotency. Returns the step's audio bytes plus whether
 * they came from a replay. Never calls the transport when a terminal already exists.
 */
async function runStep(
  step: PatchStep,
  params: GeneratePatchViaStsParams,
  call: () => Promise<{ audio: Buffer; providerStatus?: number }>
): Promise<{ audio: Buffer; artifact: VoicePatchStepArtifact; replayed: boolean }> {
  const { workspacePath, hooks } = params;
  const state = hooks.readStep(step);

  if (state.terminal?.status === 'failed') {
    // Sticky paid failure: replay the stored terminal instead of re-executing (money).
    throw new PaidStepFailedError(step, state.terminal.error, { providerStatus: state.terminal.providerStatus, replayed: true });
  }
  if (state.terminal?.status === 'succeeded') {
    const artifact = state.terminal.artifact;
    // The ledger is durable state, not a trusted instruction: a record whose relPath points
    // somewhere other than THIS step's derived location would let a tampered (or simply
    // mismatched) record redirect the read. The path is derived from the requestId, so it is
    // fully determined — require equality rather than validating whatever the record says.
    if (artifact.relPath !== params.stepAssetRel[step]) {
      throw new StepArtifactCorruptError(step, `terminal points at "${artifact.relPath}" but this step's artifact is "${params.stepAssetRel[step]}"`);
    }
    // Re-verify before reuse: symlink-safe read of the SAME inode we then hash, plus size and
    // digest equality against the terminal. Anything else is corruption, not a cache miss.
    let verified: { bytes: Buffer; sha256: string };
    try {
      verified = readRegularFileNoFollow(workspacePath, artifact.relPath);
    } catch (err) {
      throw new StepArtifactCorruptError(step, err instanceof Error ? err.message : String(err));
    }
    if (verified.bytes.byteLength !== artifact.bytes) throw new StepArtifactCorruptError(step, `size ${verified.bytes.byteLength} != recorded ${artifact.bytes}`);
    if (verified.sha256 !== artifact.sha256) throw new StepArtifactCorruptError(step, 'sha256 mismatch');
    return { audio: verified.bytes, artifact, replayed: true };
  }
  if (state.started) {
    // Marker without terminal: the process died at or after the paid call. Unknown outcome —
    // never auto-rebilled.
    throw new PaidStepUnknownOutcomeError(step);
  }

  hooks.markStarted(step);
  let response: { audio: Buffer; providerStatus?: number };
  try {
    response = await call();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const providerStatus = (err as { providerStatus?: number } | null)?.providerStatus;
    hooks.markFailed(step, message, providerStatus);
    throw new PaidStepFailedError(step, message, { providerStatus });
  }

  const relPath = params.stepAssetRel[step];
  const abs = assertInside(workspacePath, relPath);
  // Atomic (tmp + rename): a partially-written step asset must never be reachable by a replay,
  // and rename REPLACES a pre-planted symlink instead of writing through it.
  atomicWriteFile(abs, response.audio);
  const artifact: VoicePatchStepArtifact = {
    relPath,
    bytes: response.audio.byteLength,
    sha256: sha256(response.audio),
    durationSec: probeDegradablePayload(abs)
  };
  hooks.markSucceeded(step, artifact, response.providerStatus);
  return { audio: response.audio, artifact, replayed: false };
}

/**
 * The ear-locked generate chain. Order is load-bearing (D10): STS output → attach → seam bake
 * on the cleaned bed → probe the ATTACHED asset → persist only that final duration. Probing
 * the STS output instead would record a duration the timeline never sees.
 */
export async function generatePatchViaSts(params: GeneratePatchViaStsParams): Promise<GeneratePatchViaStsResult> {
  const { workspacePath, transports, voiceId } = params;
  const floor = params.minFinalDurationSec ?? DEFAULT_MIN_FINAL_SEC;

  const tts = await runStep('tts', params, () => transports.tts({ text: params.text, voiceId }));
  const sts = await runStep('sts', params, () => transports.sts({ audio: tts.audio, voiceId, sourceDurationSec: tts.artifact.durationSec }));

  const finalAbs = assertInside(workspacePath, params.finalAssetRel);
  atomicWriteFile(finalAbs, sts.audio);

  // The seam reads the cleaned bed with ffmpeg. Stage it from a no-follow-verified descriptor
  // first so a symlink planted at the asset (or an ancestor) cannot substitute other audio into
  // the user's timeline — and cannot leak it, since the seam's neighbours end up in the patch.
  let stagedBed: ReturnType<typeof stageVerifiedWorkspaceFile>;
  try {
    stagedBed = stageVerifiedWorkspaceFile(workspacePath, params.cleanedBedRel, { fileName: 'cleaned-bed.wav' });
  } catch (err) {
    // A missing, symlinked, or otherwise unverifiable cleaned bed is a "cannot seat this patch"
    // condition, not an internal error — it must reach the caller as the same TERMINAL typed
    // failure an unsuccessful bake does, so the op is rejected instead of 500ing.
    throw new SeamBakeFailedError(`the cleaned bed at ${params.cleanedBedRel} could not be read safely (${err instanceof Error ? err.message : String(err)})`);
  }
  let seam: Awaited<ReturnType<typeof postMatchSeam>>;
  try {
    seam = await postMatchSeam(finalAbs, {
      referenceAbsPath: stagedBed.path,
      editStartSec: params.editStartSec,
      editEndSec: params.editEndSec,
      ...(params.granularity ? { granularity: params.granularity } : {})
    });
  } finally {
    stagedBed.dispose();
  }
  if (!seam.baked) {
    throw new SeamBakeFailedError(`the seam bake against ${params.cleanedBedRel} did not complete`);
  }

  // FINAL probe — of the attached asset, AFTER the bake. Floor only (⟨R9⟩): a materially
  // longer patch is a legitimate outcome that extends the timeline (voice_patch phase-1
  // semantics), so there is no upper bound to trip on.
  const durationSec = probeDegradablePayload(finalAbs);
  if (!Number.isFinite(durationSec) || durationSec < floor) throw new FinalAssetImplausibleError(durationSec, floor);

  return {
    assetRel: params.finalAssetRel,
    durationSec,
    seamBaked: true,
    steps: {
      tts: { artifact: tts.artifact, replayed: tts.replayed },
      sts: { artifact: sts.artifact, replayed: sts.replayed }
    },
    seamReport: seam.report
  };
}
