import { createHash } from 'node:crypto';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import {
  appendProviderRequestEvent,
  appendVoicePatchStepRecord,
  assertInside,
  ensureElevenLabsCloneProvider,
  ensureElevenLabsStsProvider,
  ensureElevenLabsTtsProvider,
  findProjectCleanedClone,
  generatePatchViaSts,
  isStudioCleanupFresh,
  loadTranscript,
  readProviderRequests,
  readWorkspaceSettings,
  runProvider,
  voicePatchAccountingRequestId,
  voicePatchStepRecordId,
  voicePatchStepState,
  ELEVENLABS_TTS_DEFAULT_MODEL,
  ELEVENLABS_STS_DEFAULT_MODEL,
  FinalAssetImplausibleError,
  PaidStepFailedError,
  PaidStepUnknownOutcomeError,
  SeamBakeFailedError,
  StepArtifactCorruptError,
  type ManifestV3,
  type PatchStep,
  type PatchStepHooks,
  type PatchStepTerminal,
  type PatchTransports,
  type StsInput,
  type StsOutput,
  type TtsInput,
  type TtsOutput,
  type VoicePatchStepArtifact
} from '@etvideoscript/core';
import {
  appendRootTerminal,
  clearCommitMarker,
  readCommitMarker,
  readRootTerminal,
  sameRootTerminal,
  writeCommitMarker,
  type VoicePatchCommitMarker,
  type VoicePatchExecutionSnapshot,
  type VoicePatchOpImage,
  type VoicePatchRootTerminal
} from './voiceDurableState';
import { CloneChainGrantSchema, CLONE_CHAIN_CAP_ROOT, CLONE_CHAIN_STS_PROVIDER_ID, grantTotal, isGrantFresh, VOICE_RECIPE_VERSION, voicePreflight, type CloneChainGrant } from './voiceRoutes';

// ── The ear-locked recipe, pinned ───────────────────────────────────────────────
// D4: these live at the CALLSITE, never as retuned public core defaults.
export const CLONE_CHAIN_TTS_MODEL = ELEVENLABS_TTS_DEFAULT_MODEL;
export const CLONE_CHAIN_STS_MODEL = ELEVENLABS_STS_DEFAULT_MODEL;
export const CLONE_CHAIN_STS_VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.9, use_speaker_boost: true } as const;
/** The TTS step emits 24 kHz WAV, so the STS source part is declared as what it actually is. */
export const CLONE_CHAIN_STS_SOURCE_MIME = 'audio/wav';
export const CLONE_CHAIN_STS_SOURCE_FILENAME = 'tts.wav';

// ── ⟨Q3⟩/⟨R2⟩ versioned intent envelope ─────────────────────────────────────────

export interface CloneChainIntent {
  mode: 'clone-chain';
  clipId: string;
  text: string;
  targetStartSec: number;
  targetEndSec: number;
  granularity: 'word' | 'phrase' | 'sentence';
}

/**
 * The canonical versioned intent envelope. TAGGED (`v2:`) rather than shape-guessed: a stored
 * hash tells you unambiguously which canonicalizer produced it, so legacy (untagged v1) records
 * keep replaying against the frozen v1 function and new records against this one.
 *
 * Contains EVERY execution-affecting client field with normalized defaults — including `clipId`
 * (which the v1 canonicalizer omitted, a real pre-existing hole) and `mode`. `requestId` is
 * deliberately excluded: it is the lookup KEY, not part of the intent. Clone identity is
 * excluded too — it is mutable server state, and is guarded by the execution snapshot instead
 * (D5).
 */
export function cloneChainBodyHash(intent: CloneChainIntent): string {
  const canonical = JSON.stringify({
    v: 2,
    mode: intent.mode,
    clipId: intent.clipId,
    text: intent.text.trim(),
    targetStartSec: intent.targetStartSec,
    targetEndSec: intent.targetEndSec,
    granularity: intent.granularity
  });
  return `v2:${createHash('sha256').update(canonical).digest('hex')}`;
}

// ── Typed clone-resolution failures (D3) ────────────────────────────────────────

export type CloneResolution =
  | { ok: true; voiceId: string; cleanupIdentity: string; cleanedAssetRel: string; clipId: string; accountRef?: string }
  | { ok: false; code: 'clone-not-ready' | 'clone-stale' | 'clone-unknown-outcome'; message: string };

/**
 * D3: the patch route NEVER clones. It resolves the clone that already exists for the CURRENT
 * cleanup generation, or refuses with a typed 409 so the UI can offer a prepare CTA.
 *
 * D6: freshness is the existing cleaned-source contract (approved + fresh + content-addressed
 * artifact present), not bare cacheKey equality — and there is NO raw-bed fallback: refusing is
 * correct, mixing a cleaned-trained clone with a raw seam bed is not.
 */
export function resolveCloneForPatch(ws: string, projectId: string, manifest: ManifestV3, settingsHome?: string): CloneResolution {
  const preflight = voicePreflight(ws, manifest, settingsHome);
  if (!preflight.ok) {
    // A clone exists for some generation but the cleanup no longer matches ⇒ STALE (re-prepare);
    // nothing exists at all ⇒ NOT READY (prepare).
    const code = preflight.errorCode === 'cleaned-source-unavailable' ? 'clone-stale' : 'clone-not-ready';
    return { ok: false, code, message: preflight.message };
  }
  const voice = findProjectCleanedClone({ homeDir: settingsHome }, {
    projectId,
    provider: 'elevenlabs',
    ...(preflight.accountRef ? { accountRef: preflight.accountRef } : {}),
    cleanupIdentity: preflight.cleanupIdentity
  });
  if (!voice) return { ok: false, code: 'clone-not-ready', message: 'No prepared voice for this recording yet. Prepare your voice, then generate.' };
  return {
    ok: true,
    voiceId: voice.voiceId,
    cleanupIdentity: preflight.cleanupIdentity,
    cleanedAssetRel: preflight.cleanedAssetRel,
    clipId: preflight.clipId,
    ...(preflight.accountRef ? { accountRef: preflight.accountRef } : {})
  };
}

/** The snapshot is re-validated in Phase 3; anything that changed mid-flight is a conflict. */
export function buildExecutionSnapshot(resolution: Extract<CloneResolution, { ok: true }>): VoicePatchExecutionSnapshot {
  return {
    voiceId: resolution.voiceId,
    ...(resolution.accountRef ? { accountRef: resolution.accountRef } : {}),
    cleanupIdentity: resolution.cleanupIdentity,
    ttsModel: CLONE_CHAIN_TTS_MODEL,
    stsModel: CLONE_CHAIN_STS_MODEL,
    recipeVersion: VOICE_RECIPE_VERSION
  };
}

export function sameSnapshot(a: VoicePatchExecutionSnapshot, b: VoicePatchExecutionSnapshot): boolean {
  return a.voiceId === b.voiceId
    && a.accountRef === b.accountRef
    && a.cleanupIdentity === b.cleanupIdentity
    && a.ttsModel === b.ttsModel
    && a.stsModel === b.stsModel
    && a.recipeVersion === b.recipeVersion;
}

/** Read back the snapshot persisted alongside the Phase-1 'approved' ledger row (D5). */
export function readExecutionSnapshot(ws: string, requestId: string): VoicePatchExecutionSnapshot | null {
  for (const event of readProviderRequests(ws, { strict: true })) {
    if (event.requestId !== requestId) continue;
    const input = (event as { input?: Record<string, unknown> }).input;
    const snapshot = input?.executionSnapshot as VoicePatchExecutionSnapshot | undefined;
    if (snapshot?.voiceId) return snapshot;
  }
  return null;
}

/**
 * Read back the admission grant persisted with the Phase-1 row (round-5 P1-1b).
 *
 * Absent for LEGACY rows written before grants existed — those keep the live cap recheck, which
 * is the pre-grant behaviour and still correct, just less forgiving of a mid-chain cap change.
 */
export function readAdmissionGrant(ws: string, requestId: string): CloneChainGrant | null {
  for (const event of readProviderRequests(ws, { strict: true })) {
    if (event.requestId !== requestId) continue;
    const raw = (event as { input?: Record<string, unknown> }).input?.admissionGrant;
    if (raw === undefined) continue;
    // A record that does not parse is treated as ABSENT, not as an error: the live cap check
    // then applies, which is exactly what should happen when the grant cannot be trusted.
    const parsed = CloneChainGrantSchema.safeParse(raw);
    if (!parsed.success) return null;
    // The schema can only check a grant against the ceiling it CLAIMS it was issued under — a
    // number the record asserts about itself. Cross-check what can be checked against live
    // settings, in the one direction that is unambiguous:
    //
    //   • a grant claiming a ceiling where NONE is configured is incoherent (admission records
    //     capLimit only when a cap applies), so it is discarded;
    //   • a live cap LOWER than the claimed one is NOT rejected — that is precisely the
    //     mid-chain tightening grants exist to survive, and refusing here would restore the
    //     stranding of an already-paid step.
    //
    // The residual that remains is a forged capLimit inflating a grant's own total; it is
    // bounded by MAX_GRANT_TOTAL_USD, and by the engine's window, which is anchored to the
    // observed capSpent rather than to anything the grant claims about the ceiling.
    const liveCap = readWorkspaceSettings(ws).value.paidCaps[CLONE_CHAIN_CAP_ROOT] ?? null;
    if (parsed.data.capLimit != null && liveCap == null) return null;
    if (parsed.data.capSpent != null && parsed.data.capLimit != null && parsed.data.capSpent > parsed.data.capLimit) return null;
    return parsed.data;
  }
  return null;
}

// ── Step persistence hooks (⟨F1⟩/⟨R8⟩) ──────────────────────────────────────────

export function makeStepHooks(ws: string, projectId: string, parentRequestId: string, operationId: string): PatchStepHooks {
  const provider = { tts: 'tts.elevenlabs', sts: CLONE_CHAIN_STS_PROVIDER_ID } as const;
  const base = (step: PatchStep) => ({
    recordKind: 'voice-patch-step' as const,
    requestId: voicePatchStepRecordId(parentRequestId, step),
    parentRequestId,
    step,
    projectId,
    operationId,
    provider: provider[step],
    accountingRequestId: voicePatchAccountingRequestId(parentRequestId, step)
  });
  return {
    readStep(step) {
      const state = voicePatchStepState(ws, parentRequestId, step);
      if (!state.terminal) return { terminal: null, started: state.started };
      const terminal: PatchStepTerminal = state.terminal.status === 'succeeded'
        ? { status: 'succeeded', artifact: state.terminal.artifact!, ...(state.terminal.stepProviderStatus != null ? { providerStatus: state.terminal.stepProviderStatus } : {}) }
        : { status: 'failed', error: state.terminal.error ?? 'unknown provider failure', ...(state.terminal.stepProviderStatus != null ? { providerStatus: state.terminal.stepProviderStatus } : {}) };
      return { terminal, started: state.started };
    },
    markStarted(step) {
      appendVoicePatchStepRecord(ws, { ...base(step), status: 'started', createdAt: new Date().toISOString() });
    },
    markSucceeded(step, artifact: VoicePatchStepArtifact, providerStatus) {
      appendVoicePatchStepRecord(ws, { ...base(step), status: 'succeeded', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), artifact, ...(providerStatus != null ? { stepProviderStatus: providerStatus } : {}) });
    },
    markFailed(step, error, providerStatus) {
      appendVoicePatchStepRecord(ws, { ...base(step), status: 'failed', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: error.slice(0, 4096), ...(providerStatus != null ? { stepProviderStatus: providerStatus } : {}) });
    }
  };
}

// ── Real paid transports (D7) ───────────────────────────────────────────────────

function providerFailure(message: string, statusCode?: number): Error & { providerStatus?: number } {
  const error = new Error(message) as Error & { providerStatus?: number };
  if (statusCode != null) error.providerStatus = statusCode;
  return error;
}

/**
 * Both synthesis steps run through runProvider with DISTINCT accounting request ids, so each is
 * capped, ledgered and cost-attributed independently and the real provider HTTP status survives
 * into the route's error payload.
 */
/**
 * The admission to attach to the speech-to-speech call, or nothing.
 *
 * Everything here is a reason to fall back to the live cap check: no grant, a stale one, or —
 * critically — no persisted TTS terminal, which is the only evidence that the money a grant
 * exists to protect was ever committed.
 */
function stsAdmission(ws: string, parentRequestId: string, grant: CloneChainGrant | null | undefined) {
  if (!grant || !isGrantFresh(grant)) return {};
  if (grant.capSpent == null) return {};
  if (!voicePatchStepState(ws, parentRequestId, 'tts').terminal) return {};
  const granted = grant.steps[CLONE_CHAIN_STS_PROVIDER_ID];
  if (typeof granted !== 'number') return {};
  return { admission: { grantedEstimate: granted, capSpentAtAdmission: grant.capSpent, chainTotal: grantTotal(grant), currency: grant.currency, providerId: CLONE_CHAIN_STS_PROVIDER_ID } };
}

export function makeCloneChainTransports(ws: string, projectId: string, parentRequestId: string, operationId: string, settingsHome?: string, grant?: CloneChainGrant | null): PatchTransports {
  ensureElevenLabsTtsProvider({ homeDir: settingsHome });
  ensureElevenLabsStsProvider({ homeDir: settingsHome });
  ensureElevenLabsCloneProvider({ homeDir: settingsHome });
  return {
    async tts({ text, voiceId }) {
      const envelope = await runProvider<TtsInput, TtsOutput>({
        kind: 'tts',
        providerId: 'tts.elevenlabs',
        input: { text, voice: voiceId, language: 'en', model: CLONE_CHAIN_TTS_MODEL },
        workspacePath: ws,
        projectId,
        operationId,
        requestType: 'voice_patch_tts',
        requestId: voicePatchAccountingRequestId(parentRequestId, 'tts'),
        homeDir: settingsHome
        // NO GRANT ON THE FIRST STEP (⚠ PAID PATH). On the fresh path admission has just run
        // against this same ledger, so the live check is redundant here — and on the RESUME
        // path it is the only protection left: a crash inside the TTS HTTP call leaves an
        // approved row, a snapshot and a proposed op but NO spend, so a grant here would let
        // the retry re-run an unbilled paid call cap-exempt, even against a cap the user has
        // since set to zero.
      });
      if (!envelope.ok) throw providerFailure(envelope.error.message, envelope.error.statusCode);
      return { audio: envelope.output.audio, ...(envelope.output.providerStatus != null ? { providerStatus: envelope.output.providerStatus } : {}) };
    },
    async sts({ audio, voiceId, sourceDurationSec }) {
      const envelope = await runProvider<StsInput, StsOutput>({
        kind: 'tts',
        providerId: CLONE_CHAIN_STS_PROVIDER_ID,
        input: {
          audio,
          voiceId,
          // EL bills speech-to-speech by SOURCE LENGTH. Dropping this here is what made the
          // production STS call report an unknown cost — which, with an inherited cap
          // configured, the engine correctly refuses to run. Only a finite positive duration is
          // forwarded; anything else stays undefined so the engine fails closed rather than
          // costing the call off a bogus number.
          ...(Number.isFinite(sourceDurationSec) && (sourceDurationSec ?? 0) > 0 ? { sourceDurationSec } : {}),
          model: CLONE_CHAIN_STS_MODEL,
          voiceSettings: { ...CLONE_CHAIN_STS_VOICE_SETTINGS },
          sourceMimeType: CLONE_CHAIN_STS_SOURCE_MIME,
          sourceFileName: CLONE_CHAIN_STS_SOURCE_FILENAME
        },
        workspacePath: ws,
        projectId,
        operationId,
        requestType: 'voice_patch_sts',
        requestId: voicePatchAccountingRequestId(parentRequestId, 'sts'),
        homeDir: settingsHome,
        // THE POINT OF THE GRANT (⚠ PAID PATH): by the time this runs, the TTS step has already
        // consumed part of the ceiling, so a live recheck would refuse the second half of an
        // operation the user was told was affordable — after billing the first half. The grant
        // covers this call up to the amount admitted against the CONSERVATIVE source bound; a
        // TTS output that ran longer than that bound prices above the grant and is refused by
        // the live check, fail-closed, with the TTS terminal retained and nothing re-billed.
        //
        // Conditioned on a PERSISTED TTS TERMINAL: that record is the proof money was actually
        // committed. Without it there is nothing stranded to protect, and granting would be
        // exempting a call the user never paid for.
        ...stsAdmission(ws, parentRequestId, grant)
      });
      if (!envelope.ok) throw providerFailure(envelope.error.message, envelope.error.statusCode);
      return { audio: envelope.output.audio, ...(envelope.output.providerStatus != null ? { providerStatus: envelope.output.providerStatus } : {}) };
    }
  };
}

// ── Phase-2 runner ──────────────────────────────────────────────────────────────

export interface CloneChainPhase2Input {
  ws: string;
  projectId: string;
  requestId: string;
  operationId: string;
  text: string;
  voiceId: string;
  cleanedAssetRel: string;
  /** ASSET-axis window (the axis the cleaned bed shares with the transcript). */
  assetStartSec: number;
  assetEndSec: number;
  /** ffprobe-visible floor for the attached asset; the caller passes the production value. */
  minFinalDurationSec?: number;
  granularity: 'word' | 'phrase' | 'sentence';
  transports: PatchTransports;
  settingsHome?: string;
}

export async function runCloneChainPhase2(input: CloneChainPhase2Input) {
  return generatePatchViaSts({
    workspacePath: input.ws,
    parentRequestId: input.requestId,
    text: input.text,
    voiceId: input.voiceId,
    // Workspace-RELATIVE: generatePatchViaSts opens it symlink-safely and stages the verified
    // bytes itself, so ffmpeg never re-opens a caller-supplied path by name.
    cleanedBedRel: input.cleanedAssetRel,
    editStartSec: input.assetStartSec,
    editEndSec: input.assetEndSec,
    ...(input.minFinalDurationSec !== undefined ? { minFinalDurationSec: input.minFinalDurationSec } : {}),
    granularity: input.granularity,
    finalAssetRel: `assets/voice/patch-${input.requestId}.wav`,
    stepAssetRel: {
      tts: `assets/voice/steps/${voicePatchStepRecordId(input.requestId, 'tts')}.wav`,
      sts: `assets/voice/steps/${voicePatchStepRecordId(input.requestId, 'sts')}.wav`
    },
    transports: input.transports,
    hooks: makeStepHooks(input.ws, input.projectId, input.requestId, input.operationId)
  });
}

/** Map a Phase-2 failure onto its HTTP shape. All of these become root terminals (⟨F4⟩). */
export function phase2ErrorResponse(err: unknown): { code: number; body: { error: string; errorCode: string; providerStatus?: number } } {
  if (err instanceof PaidStepUnknownOutcomeError) {
    return { code: 409, body: { error: err.message, errorCode: 'paid-step-unknown-outcome' } };
  }
  if (err instanceof StepArtifactCorruptError) {
    return { code: 409, body: { error: err.message, errorCode: 'step-artifact-corrupt' } };
  }
  if (err instanceof PaidStepFailedError) {
    return { code: 502, body: { error: err.message, errorCode: `${err.step}-failed`, ...(err.providerStatus != null ? { providerStatus: err.providerStatus } : {}) } };
  }
  if (err instanceof SeamBakeFailedError) {
    return { code: 502, body: { error: err.message, errorCode: 'seam-bake-failed' } };
  }
  if (err instanceof FinalAssetImplausibleError) {
    return { code: 502, body: { error: err.message, errorCode: 'final-asset-implausible' } };
  }
  return { code: 500, body: { error: err instanceof Error ? err.message : String(err), errorCode: 'internal-error' } };
}

// ── ⟨Q1⟩ crash-consistent commit protocol ───────────────────────────────────────

export type MarkerRecovery =
  | { kind: 'none' }
  | { kind: 'recovered'; terminal: VoicePatchRootTerminal }
  | { kind: 'ledger-corruption'; message: string }
  | { kind: 'marker-conflict'; message: string };

/**
 * What applying a marker did. `conflict` means the operation matched NEITHER image — it is not
 * the op this marker describes any more, and the marker cannot be completed against it.
 */
export type MarkerApplyResult = 'applied' | 'already-applied' | 'preserved' | 'conflict';

/**
 * Resolve the asset PATH an operation currently points at.
 *
 * Persistence does not keep `asset` on the operation: updateManifestOperation converts it into
 * an `assetId` plus a row in `manifest.assets` (server.ts addAssetV3). Comparing an image's
 * `assetRel` against `operation.asset` therefore never matches a genuinely persisted success —
 * which silently turned the postimage check into a no-op. The comparison has to follow the same
 * indirection the writer used.
 */
function operationAssetRel(operation: any, manifest?: ManifestV3): string {
  if (typeof operation?.asset === 'string' && operation.asset) return operation.asset;
  const assetId = operation?.assetId;
  if (!assetId || !manifest) return '';
  return manifest.assets.find((asset) => asset.assetId === assetId)?.path ?? '';
}

/** The op fields that constitute its identity for pre/postimage comparison. */
export function opImage(operation: any, manifest?: ManifestV3): VoicePatchOpImage {
  const assetRel = operationAssetRel(operation, manifest);
  return {
    status: String(operation?.status ?? 'missing'),
    providerRequestId: String(operation?.providerRequestId ?? ''),
    text: String(operation?.text ?? ''),
    ...(operation?.target?.clipId ? { targetClipId: String(operation.target.clipId) } : {}),
    ...(operation?.target?.trackId ? { targetTrackId: String(operation.target.trackId) } : {}),
    targetStart: Number(operation?.target?.start ?? NaN),
    targetEnd: Number(operation?.target?.end ?? NaN),
    ...(assetRel ? { assetRel } : {}),
    ...(operation?.durationGeneratedSec != null ? { durationGeneratedSec: Number(operation.durationGeneratedSec) } : {}),
    ...(operation?.durationRequestedSec != null ? { durationRequestedSec: Number(operation.durationRequestedSec) } : {}),
    ...(operation?.seamBaked != null ? { seamBaked: Boolean(operation.seamBaked) } : {})
  };
}

/**
 * Identity comparison for the pre/postimage guard. Status alone is NOT identity: an op the user
 * edited during the paid call can keep its status while its text or target changed, and mutating
 * it then would attach audio generated for a different intent.
 *
 * Optional fields participate only when the IMAGE specifies them, so a preimage (no asset yet)
 * and a postimage (asset, durations, seamBaked) share one function. `manifest` is required to
 * resolve assetId → path; without it an asset-bearing image can never match, so callers that
 * compare a postimage must pass it.
 */
export function matchesOpImage(operation: any, image: VoicePatchOpImage, manifest?: ManifestV3): boolean {
  if (!operation) return false;
  if (String(operation.status) !== image.status) return false;
  if (String(operation.providerRequestId ?? '') !== image.providerRequestId) return false;
  if (String(operation.text ?? '') !== image.text) return false;
  if (image.targetClipId !== undefined && String(operation.target?.clipId ?? '') !== image.targetClipId) return false;
  if (image.targetTrackId !== undefined && String(operation.target?.trackId ?? '') !== image.targetTrackId) return false;
  if (Number(operation.target?.start) !== image.targetStart) return false;
  if (Number(operation.target?.end) !== image.targetEnd) return false;
  if (image.assetRel !== undefined && operationAssetRel(operation, manifest) !== image.assetRel) return false;
  if (image.durationGeneratedSec !== undefined && Number(operation.durationGeneratedSec) !== image.durationGeneratedSec) return false;
  if (image.durationRequestedSec !== undefined && Number(operation.durationRequestedSec) !== image.durationRequestedSec) return false;
  if (image.seamBaked !== undefined && Boolean(operation.seamBaked) !== image.seamBaked) return false;
  return true;
}

/**
 * Complete an interrupted Phase-3 commit. Runs under the project mutex.
 *
 * The marker persists the FINALIZED terminal, so recovery never re-derives anything: it rolls
 * the manifest forward to the intended postimage if that has not happened yet, then reconciles
 * the terminal. Because the terminal log is append-only with no uniqueness enforcement, the
 * "terminal already appended, marker not yet cleared" window is a real state and is handled by
 * COMPARING rather than by assuming absence:
 *
 *   terminal absent            → append it from the marker
 *   identical terminal present → accept (idempotent)
 *   conflicting terminal       → sticky `ledger-corruption`; NEVER overwrite, marker retained
 */
export function recoverCommitMarker(
  ws: string,
  requestId: string,
  apply: (marker: VoicePatchCommitMarker) => MarkerApplyResult
): MarkerRecovery {
  const marker = readCommitMarker(ws, requestId);
  if (!marker) return { kind: 'none' };

  const rebuilt: VoicePatchRootTerminal = {
    requestId: marker.requestId,
    projectId: marker.projectId,
    httpStatus: marker.httpStatus,
    serializedBody: marker.serializedBody,
    bodyHash: marker.bodyHash,
    executionSnapshot: marker.executionSnapshot,
    createdAt: marker.createdAt
  };

  // INSPECT TERMINALS FIRST, MUTATE SECOND. A conflicting terminal means this marker describes
  // an outcome the ledger already contradicts — applying its mutation would push the manifest
  // toward a state we are simultaneously refusing to publish, i.e. corrupt the timeline on the
  // strength of a record we have declared untrustworthy.
  const existing = readRootTerminal(ws, requestId);
  if (existing && !sameRootTerminal(existing, rebuilt)) {
    return {
      kind: 'ledger-corruption',
      message: `A different terminal already exists for requestId ${requestId} (HTTP ${existing.httpStatus} vs the pending marker's HTTP ${rebuilt.httpStatus}). Refusing to overwrite it or to apply the marker's mutation; the marker has been retained for inspection.`
    };
  }

  // Roll the manifest mutation forward. The marker was written BEFORE the mutation, so after a
  // crash in that window the op is still at its preimage and the terminal we publish would
  // otherwise describe a state that never happened. `apply` is itself image-guarded, so an op
  // the user has since edited is preserved rather than overwritten.
  const applied = apply(marker);
  if (applied === 'conflict') {
    // The operation matches neither image, so we cannot honestly say this marker's outcome
    // describes it. Publishing the terminal anyway would tell the client about a manifest state
    // that does not exist — KEEP the marker and surface the conflict instead.
    return {
      kind: 'marker-conflict',
      message: `The pending commit for requestId ${requestId} no longer matches operation ${marker.operationId} in either its before or after state. The marker has been retained; resolve it before retrying.`
    };
  }

  if (!existing) {
    appendRootTerminal(ws, rebuilt);
    clearCommitMarker(ws, requestId);
    return { kind: 'recovered', terminal: rebuilt };
  }
  // Identical terminal already present (crash after the append, before the marker clear):
  // accept it and finish the protocol.
  clearCommitMarker(ws, requestId);
  return { kind: 'recovered', terminal: existing };
}

/**
 * A simulated process death, used only by the crash-window tests. Named so a real failure can
 * never be mistaken for one.
 */
export class SimulatedCommitCrash extends Error {
  constructor(readonly window: CommitCrashWindow) {
    super(`simulated crash after ${window}`);
    this.name = 'SimulatedCommitCrash';
  }
}

/** The four windows the ⟨Q1⟩ protocol has to survive, in execution order. */
export type CommitCrashWindow = 'before-marker' | 'after-marker' | 'after-mutation' | 'after-terminal';

export type CommitOutcome =
  | { ok: true; terminal: VoicePatchRootTerminal }
  | { ok: false; reason: string };

/**
 * Write the marker, mutate, publish the terminal, clear the marker — in that exact order.
 *
 * The mutation's RESULT is load-bearing, not advisory. A terminal is the promise "this is the
 * manifest state your request produced", so it may only be published once the mutation actually
 * produced it:
 *   • apply reports `conflict`, or throws → the marker is RETAINED and NO terminal is appended;
 *     the caller surfaces a commit-marker conflict and an operator resolves it.
 *   • apply reports applied/already-applied/preserved → the terminal is published and the
 *     marker cleared.
 * Publishing regardless (as an earlier revision did) hands the client a description of a
 * manifest that does not exist, and makes the next recovery believe the commit completed.
 */
export function commitWithMarker(
  ws: string,
  marker: VoicePatchCommitMarker,
  apply: () => MarkerApplyResult,
  crashAt?: CommitCrashWindow
): CommitOutcome {
  if (crashAt === 'before-marker') throw new SimulatedCommitCrash(crashAt);
  writeCommitMarker(ws, marker);
  if (crashAt === 'after-marker') throw new SimulatedCommitCrash(crashAt);
  let applied: MarkerApplyResult;
  try {
    applied = apply();
  } catch (err) {
    if (err instanceof SimulatedCommitCrash) throw err;
    return { ok: false, reason: `The commit for requestId ${marker.requestId} could not be applied to operation ${marker.operationId} (${err instanceof Error ? err.message : String(err)}). The pending marker has been retained and no terminal was published.` };
  }
  if (applied === 'conflict') {
    return { ok: false, reason: `The commit for requestId ${marker.requestId} no longer matches operation ${marker.operationId} in either its before or after state. The pending marker has been retained and no terminal was published.` };
  }
  if (crashAt === 'after-mutation') throw new SimulatedCommitCrash(crashAt);
  const terminal: VoicePatchRootTerminal = {
    requestId: marker.requestId,
    projectId: marker.projectId,
    httpStatus: marker.httpStatus,
    serializedBody: marker.serializedBody,
    bodyHash: marker.bodyHash,
    executionSnapshot: marker.executionSnapshot,
    createdAt: marker.createdAt
  };
  appendRootTerminal(ws, terminal);
  if (crashAt === 'after-terminal') throw new SimulatedCommitCrash(crashAt);
  clearCommitMarker(ws, marker.requestId);
  return { ok: true, terminal };
}

/**
 * The immutable coordinates Phase 1 resolved, persisted so a RESUME never recomputes them.
 *
 * Snapping reads the transcript, which is mutable: re-deriving the window on a resume could
 * hand the paid steps (and the seam) a different range than the op was created for, and approve
 * audio for the wrong target. Both axes are stored — clip-local for the op/body-match guard,
 * asset-axis for the seam and transcript lookups.
 */
export const VoicePatchResolvedRangeSchema = z.object({
  clipId: z.string().min(1).max(128),
  opStart: z.number().finite().nonnegative(),
  opEnd: z.number().finite().positive(),
  assetStart: z.number().finite().nonnegative(),
  assetEnd: z.number().finite().positive()
}).refine((range) => range.opStart < range.opEnd, { message: 'opStart must be < opEnd', path: ['opEnd'] })
  .refine((range) => range.assetStart < range.assetEnd, { message: 'assetStart must be < assetEnd', path: ['assetEnd'] })
  .refine((range) => Math.abs((range.assetEnd - range.assetStart) - (range.opEnd - range.opStart)) < 1e-6, { message: 'the asset-axis and clip-local spans must have the same length', path: ['assetEnd'] });

export type VoicePatchResolvedRange = z.infer<typeof VoicePatchResolvedRangeSchema>;

/**
 * Read back the ranges persisted alongside the Phase-1 'approved' ledger row.
 *
 * SCHEMA-VALIDATED, not shape-sniffed: these coordinates drive a paid resume and the seam bake,
 * so a NaN, an inverted span, or a pair of axes that disagree on length must read as "no usable
 * range" (which refuses the resume) rather than flow into ffmpeg.
 */
export function readResolvedRange(ws: string, requestId: string): VoicePatchResolvedRange | null {
  for (const event of readProviderRequests(ws, { strict: true })) {
    if (event.requestId !== requestId) continue;
    const input = (event as { input?: Record<string, unknown> }).input;
    const parsed = VoicePatchResolvedRangeSchema.safeParse(input?.resolvedRange);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * Verify a persisted range still describes the CURRENT timeline geometry before any paid resume.
 *
 * Two things can have moved since Phase 1: which clip is the eligible cleaned source, and where
 * that clip starts in its asset. The second is the subtle one — the asset-axis coordinates the
 * seam bakes against are `clip-local + clip.sourceStart`, so a clip that has been re-trimmed
 * leaves the stored pair internally consistent while pointing at a different stretch of audio.
 */
export function verifyResolvedRangeGeometry(
  range: VoicePatchResolvedRange,
  manifest: ManifestV3,
  eligibleClipId: string
): { ok: true } | { ok: false; message: string } {
  if (range.clipId !== eligibleClipId) {
    return { ok: false, message: `This generation was started against clip ${range.clipId}, but the eligible cleaned source is now ${eligibleClipId}; start a new generation.` };
  }
  const entry = manifest.tracks
    .filter((track) => track.kind === 'video')
    .flatMap((track) => (track.clips ?? []).map((clip) => ({ track, clip })))
    .find(({ clip }) => clip.clipId === range.clipId);
  if (!entry) return { ok: false, message: `Clip ${range.clipId} is no longer on the timeline; start a new generation.` };
  const sourceStart = Number(entry.clip.sourceStart ?? 0);
  const sourceEnd = Number(entry.clip.sourceEnd ?? Number.POSITIVE_INFINITY);
  if (Math.abs(range.assetStart - (range.opStart + sourceStart)) > 1e-6) {
    return { ok: false, message: `Clip ${range.clipId} has been re-trimmed since this generation started, so its stored coordinates no longer point at the same audio; start a new generation.` };
  }
  if (range.assetStart < sourceStart - 1e-6 || range.assetEnd > sourceEnd + 1e-6) {
    return { ok: false, message: `The stored range now falls outside clip ${range.clipId}; start a new generation.` };
  }
  return { ok: true };
}

/** Append the Phase-1 'approved' ledger row carrying the immutable execution snapshot (D5). */
export function appendApprovedRowWithSnapshot(ws: string, input: {
  requestId: string;
  projectId: string;
  operationId: string;
  bodyHash: string;
  text: string;
  snapshot: VoicePatchExecutionSnapshot;
  resolvedRange: VoicePatchResolvedRange;
  start: number;
  end: number;
  /** The per-step cap amounts Phase 1 admitted (round-5 P1-1b). Absent on legacy rows. */
  admissionGrant?: CloneChainGrant;
}) {
  return appendProviderRequestEvent(ws, {
    requestId: input.requestId,
    type: 'voice_patch',
    projectId: input.projectId,
    provider: 'tts.elevenlabs',
    voice: input.snapshot.voiceId,
    language: 'en',
    bodyHash: input.bodyHash,
    operationId: input.operationId,
    status: 'approved',
    input: { executionSnapshot: input.snapshot, resolvedRange: input.resolvedRange, mode: 'clone-chain', start: input.start, end: input.end, ...(input.admissionGrant ? { admissionGrant: input.admissionGrant } : {}) },
    cost: { currency: 'USD', estimated: 0, actual: 0 },
    createdAt: new Date().toISOString()
  } as never);
}

/** Cleanup freshness as observed RIGHT NOW — the Phase-3 revalidation input. */
export function currentCleanupIdentity(ws: string, manifest: ManifestV3): string | null {
  const cleanup = manifest.studioCleanup;
  if (!cleanup || cleanup.status !== 'approved' || !isStudioCleanupFresh(manifest)) return null;
  if (!existsSync(assertInside(ws, `assets/studio-clean/${cleanup.cacheKey}.wav`))) return null;
  return cleanup.cacheKey;
}

/** Word-accurate transcript is a hard requirement of the whole chain (⟨R4⟩). */
export function hasWordAccurateTranscript(ws: string): boolean {
  return loadTranscript(ws)?.provider.timing === 'exact';
}
