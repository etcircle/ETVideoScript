import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  appendJobStatus,
  assertInside,
  cloneCleanClip,
  decodeWavToPcm16kMono,
  ensureElevenLabsCloneProvider,
  ensureElevenLabsStsProvider,
  ensureElevenLabsTtsProvider,
  estimateProviderCalls,
  findProjectCleanedClone,
  isStudioCleanupFresh,
  latestJobs,
  loadTranscript,
  makeJobId,
  runProvider,
  selectCleanWindows,
  stageVerifiedWorkspaceFile,
  voicePatchStepState,
  ProviderRequestIdSchema,
  conservativeStsSourceSec,
  ELEVENLABS_STS_DEFAULT_MODEL,
  ELEVENLABS_TTS_DEFAULT_MODEL,
  CleanedSourceUnavailableError,
  InsufficientCleanWindowsError,
  type CleanWindow,
  type JobRecord,
  type ProviderBatchEstimate,
  type StsInput,
  type TtsInput,
  type ManifestV3
} from '@etvideoscript/core';
import type { CloneInput, CloneOutput } from '@etvideoscript/core';
import {
  casCloneReservation,
  cloneReservationKey,
  readCloneReservation,
  readCloneReservations,
  readRootTerminal,
  writeCloneReservation,
  type CloneReservation
} from './voiceDurableState';
import type { LocalApiRouteContext } from './routeContext';

export const PREPARE_VOICE_JOB_TYPE = 'prepare-voice';
/** Bumped whenever the recipe (models, prep chain, seam policy) changes; lives in the snapshot. */
export const VOICE_RECIPE_VERSION = 's1b-1';

// ── Preflight (D1 ⟨R4⟩ + ⟨F13⟩) ─────────────────────────────────────────────────

export type VoicePrepareErrorCode =
  | 'transcript-not-word-accurate'
  | 'cleaned-source-unavailable'
  | 'multi-clip-unsupported'
  | 'insufficient-clean-windows'
  | 'voice-slot-limit'
  | 'unknown-outcome'
  | 'interrupted'
  | 'clone-failed';

export type VoicePreflight =
  | { ok: true; clipId: string; cleanupIdentity: string; cleanedAssetRel: string; accountRef?: string }
  | { ok: false; errorCode: VoicePrepareErrorCode; message: string; details?: Record<string, unknown> };

/**
 * Everything that must hold before a paid clone is worth attempting, resolved from the manifest
 * + transcript + settings. Deliberately does NOT touch audio: the expensive decode belongs to
 * the job, and a preflight that can 202 a doomed job is worse than useless.
 *
 * ⟨F13⟩ eligibility: exactly ONE eligible cleaned speech source — the clip resolving to the
 * canonical `input/source.mp4`, which is the only recording studioCleanup describes. Unrelated
 * tracks, b-roll and caption tracks are simply not eligible and are ignored; only MULTIPLE
 * eligible sources are the unsupported case.
 */
export function voicePreflight(ws: string, manifest: ManifestV3, settingsHome?: string): VoicePreflight {
  const transcript = loadTranscript(ws);
  if (!transcript || transcript.provider.timing !== 'exact') {
    return {
      ok: false,
      errorCode: 'transcript-not-word-accurate',
      message: transcript
        ? `The transcript has "${transcript.provider.timing}" timing. Voice preparation needs real word timestamps — re-transcribe with a word-accurate provider.`
        : 'No transcript found. Transcribe the recording before preparing your voice.'
    };
  }

  const cleanup = manifest.studioCleanup;
  if (!cleanup || cleanup.status !== 'approved') {
    return { ok: false, errorCode: 'cleaned-source-unavailable', message: `Studio Sound is ${cleanup ? `"${cleanup.status}"` : 'not run yet'}. The clone trains on the cleaned recording, so run Studio Sound first.` };
  }
  if (!isStudioCleanupFresh(manifest)) {
    return { ok: false, errorCode: 'cleaned-source-unavailable', message: 'Studio Sound is stale (the channel-fix state changed since it ran). Re-run Studio Sound before preparing your voice.' };
  }
  // CANONICAL-KEY GATE, before any path is built from the key. StudioCleanupSchema keeps
  // cacheKey loose so older/hand-edited manifests still load, so every boundary that
  // interpolates it into a path must enforce the sha256-hex form itself — a traversal payload
  // survives both the assetPath equality check below (both sides interpolate the same string)
  // and assertInside (it stays inside the workspace).
  if (!/^[0-9a-f]{64}$/.test(cleanup.cacheKey)) {
    return { ok: false, errorCode: 'cleaned-source-unavailable', message: 'The Studio Sound record has a non-canonical cache key. Re-run Studio Sound to regenerate it.' };
  }
  const cleanedAssetRel = `assets/studio-clean/${cleanup.cacheKey}.wav`;
  if (cleanup.assetPath !== cleanedAssetRel || !existsSync(assertInside(ws, cleanedAssetRel))) {
    return { ok: false, errorCode: 'cleaned-source-unavailable', message: 'The cleaned recording is missing from the workspace. Re-run Studio Sound.' };
  }

  const eligible = manifest.tracks
    .filter((track) => track.kind === 'video')
    .flatMap((track) => track.clips ?? [])
    .filter((clip) => manifest.assets.find((asset) => asset.assetId === clip.assetId)?.path === 'input/source.mp4');
  if (eligible.length === 0) {
    return { ok: false, errorCode: 'cleaned-source-unavailable', message: 'No clip resolves to the base recording (input/source.mp4), so there is nothing the cleaned audio describes.' };
  }
  if (eligible.length > 1) {
    return {
      ok: false,
      errorCode: 'multi-clip-unsupported',
      message: `${eligible.length} clips resolve to the base recording. Preparing a voice from multiple eligible sources is not supported yet.`,
      details: { clipIds: eligible.map((clip) => clip.clipId) }
    };
  }

  // ⟨F11⟩ accountRef = the settings-store secretRef NAME (a non-secret discriminator), the same
  // locus S1a used at the caller. Never the secret value.
  const cloneProvider = ensureElevenLabsCloneProvider({ homeDir: settingsHome });
  return {
    ok: true,
    clipId: eligible[0]!.clipId,
    cleanupIdentity: cleanup.cacheKey,
    cleanedAssetRel,
    ...(cloneProvider.secretRef ? { accountRef: cloneProvider.secretRef } : {})
  };
}

// ── Status (item 6) ─────────────────────────────────────────────────────────────

export type VoiceState = 'none' | 'preparing' | 'ready' | 'stale' | 'unknown-outcome';

export interface VoiceStatus {
  state: VoiceState;
  voiceId?: string;
  jobId?: string;
  errorCode?: string;
  message?: string;
}

function latestPrepareJob(ws: string): JobRecord | null {
  // Most-recent-by-createdAt: a bare find() over a job history returns the OLDEST match and
  // would pin the UI to a stale state forever (pattern_selector_recency).
  return latestJobs(ws).find((job) => job.type === PREPARE_VOICE_JOB_TYPE) ?? null;
}

/**
 * Derive the voice state from durable facts only — voices library, reservation, latest job, and
 * the D6 freshness contract. Nothing here depends on in-process memory, so the answer survives
 * a restart (and a restart is exactly when 'unknown-outcome' must be visible).
 */
export function deriveVoiceStatus(ws: string, projectId: string, manifest: ManifestV3, settingsHome?: string): VoiceStatus {
  const preflight = voicePreflight(ws, manifest, settingsHome);
  const job = latestPrepareJob(ws);

  if (!preflight.ok) {
    // A clone trained on a cleanup generation that is no longer current is STALE, not absent —
    // the distinction is what lets the UI offer "re-prepare" instead of "prepare". The lookup
    // is deliberately generation-AGNOSTIC (any cleaned clone for this project/provider/account):
    // the common way to get here is that the cleanup cacheKey CHANGED, so matching on the
    // current key would find nothing and report 'none', hiding the voice the user already has.
    // accountRef is resolved here too — matching is class-symmetric, so an untagged query would
    // never find the tagged record the prepare job wrote.
    const accountRef = ensureElevenLabsCloneProvider({ homeDir: settingsHome }).secretRef;
    const anyCleanedClone = findProjectCleanedClone({ homeDir: settingsHome }, { projectId, provider: 'elevenlabs', ...(accountRef ? { accountRef } : {}) });
    if (preflight.errorCode === 'cleaned-source-unavailable' && anyCleanedClone) {
      return { state: 'stale', voiceId: anyCleanedClone.voiceId, errorCode: preflight.errorCode, message: preflight.message };
    }
    return { state: 'none', errorCode: preflight.errorCode, message: preflight.message };
  }

  const voice = findProjectCleanedClone({ homeDir: settingsHome }, {
    projectId,
    provider: 'elevenlabs',
    ...(preflight.accountRef ? { accountRef: preflight.accountRef } : {}),
    cleanupIdentity: preflight.cleanupIdentity
  });
  if (voice) return { state: 'ready', voiceId: voice.voiceId, ...(job ? { jobId: job.jobId } : {}) };

  const reservation = readCloneReservation(ws, cloneReservationKey({
    ...(preflight.accountRef ? { accountRef: preflight.accountRef } : {}),
    cleanupIdentity: preflight.cleanupIdentity,
    sourceClass: 'cleaned',
    clipId: preflight.clipId
  }));
  if (reservation) {
    if (reservation.state === 'failed') {
      const unknown = reservation.errorCode === 'unknown-outcome';
      return { state: unknown ? 'unknown-outcome' : 'none', jobId: reservation.jobId, ...(reservation.errorCode ? { errorCode: reservation.errorCode } : {}), ...(reservation.errorMessage ? { message: reservation.errorMessage } : {}) };
    }
    if (reservation.state === 'provider-committed' || reservation.state === 'persisted') {
      // Committed remotely but no local record we can match — the operator must decide.
      return { state: 'unknown-outcome', jobId: reservation.jobId, errorCode: 'unknown-outcome', message: 'A voice was created remotely but no matching local record was found. Re-prepare to make a fresh one.' };
    }
    return { state: 'preparing', jobId: reservation.jobId };
  }

  if (job && (job.status === 'queued' || job.status === 'running')) return { state: 'preparing', jobId: job.jobId };
  if (job && job.status === 'failed') return { state: job.errorCode === 'unknown-outcome' ? 'unknown-outcome' : 'none', jobId: job.jobId, ...(job.errorCode ? { errorCode: job.errorCode } : {}), ...(job.error ? { message: job.error } : {}) };
  return { state: 'none' };
}

// ── Reconciliation (D1 ⟨F10⟩/⟨R5⟩) ──────────────────────────────────────────────

/**
 * Reconcile prepare-voice state that a crash or restart left dangling. A reservation whose job
 * is not live in THIS process cannot make progress, so it must reach a terminal:
 *
 *   • 'local-prep'                          → nothing was billed → failed + 'interrupted'
 *   • 'provider-in-flight' / '…-committed'  → the paid call may or may not have completed →
 *                                             failed + 'unknown-outcome', NEVER auto-retried
 *
 * The corresponding job is recorded as `status: 'failed'` + `errorCode` (⟨R5⟩) — the status enum
 * is deliberately not widened, so `/voice/status` can no longer stick at 'preparing' without
 * any schema or UI switch changing.
 */
export function reconcileVoicePreparation(ws: string, projectId: string, liveJobIds: ReadonlySet<string>): void {
  for (const reservation of Object.values(readCloneReservations(ws))) {
    if (reservation.state === 'persisted' || reservation.state === 'failed') continue;
    if (liveJobIds.has(reservation.jobId)) continue;
    const billed = reservation.state !== 'local-prep';
    const errorCode: VoicePrepareErrorCode = billed ? 'unknown-outcome' : 'interrupted';
    const message = billed
      ? 'The server stopped while the voice clone call was in flight. It may or may not have been created, so it was not retried automatically.'
      : 'Voice preparation was interrupted before any paid call was made.';
    casCloneReservation(ws, reservation.key, ['local-prep', 'provider-in-flight', 'provider-committed'], { state: 'failed', errorCode, errorMessage: message });
    appendJobStatus(ws, { jobId: reservation.jobId, projectId, type: PREPARE_VOICE_JOB_TYPE, status: 'failed', completedAt: new Date().toISOString(), error: message, errorCode });
  }
  // Orphaned jobs with no reservation at all (e.g. the crash landed between the two writes).
  for (const job of latestJobs(ws)) {
    if (job.type !== PREPARE_VOICE_JOB_TYPE) continue;
    if (job.status !== 'queued' && job.status !== 'running') continue;
    if (liveJobIds.has(job.jobId)) continue;
    appendJobStatus(ws, { jobId: job.jobId, projectId, type: PREPARE_VOICE_JOB_TYPE, status: 'failed', completedAt: new Date().toISOString(), error: 'Voice preparation was interrupted.', errorCode: 'interrupted' });
  }
}

// ── The prepare-voice job ───────────────────────────────────────────────────────

function isSlotLimit(message: string, status?: number): boolean {
  // EL surfaces the IVC slot ceiling as a 4xx whose body names the voice limit. Matched on the
  // message because the status alone (400/403) is shared with unrelated request errors.
  return /voice[_ ]?limit|maximum number of (custom )?voices|voice slots?/i.test(message) && (status === undefined || status < 500);
}

// ── Prospective-cost estimation (read-only) ─────────────────────────────────────

/**
 * Upper bound on the text an estimate may be asked about, and — because an estimate must not be
 * answerable for a request the route would reject — the same bound the clone-chain intake
 * applies to `text`. Without it, `chars=100000000` allocates a 100 MB string (or throws out of
 * `repeat`) to answer a question about a patch nobody could ever submit.
 */
export const MAX_ESTIMATE_CHARS = 20_000;
/** An absurdity bound on the STS source duration — a day of audio is not a voice patch. */
export const MAX_ESTIMATE_SECONDS = 86_400;

/** A required, non-empty, whole count within [1, max]. Empty string and fractions are rejected. */
function parseCount(raw: string | undefined, max: number): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) return null;
  return value;
}

/** A required, finite, non-negative duration within [0, MAX_ESTIMATE_SECONDS]. */
function parseDuration(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > MAX_ESTIMATE_SECONDS) return null;
  return value;
}

/**
 * The TTS adapter prices by character count, so a synthetic string of the right length costs
 * exactly what the real one does. Bounded by MAX_ESTIMATE_CHARS above, which is what keeps this
 * allocation trivial.
 */
function ttsEstimateInput(chars: number, model?: string): TtsInput {
  return { text: 'x'.repeat(chars), voice: 'estimate', language: 'en', ...(model ? { model } : {}) };
}

/** The STS adapter prices by source DURATION; the empty buffer is never read for costing. */
function stsEstimateInput(sourceDurationSec: number): StsInput {
  return { audio: Buffer.alloc(0), voiceId: 'estimate', model: ELEVENLABS_STS_DEFAULT_MODEL, ...(sourceDurationSec > 0 ? { sourceDurationSec } : {}) };
}

/**
 * The clone chain's ORDERED admission projection: tts, then sts, each judged against the world
 * its predecessor leaves behind.
 *
 * Shared by the disclosure endpoint and by the POST's pre-payment preflight, so the number shown
 * to the user and the check that protects their money are the same computation. Read-only.
 */
/**
 * The provider whose grant the speech-to-speech step looks up. Single source for the admission
 * call, the map key `grantFromAdmission` writes, and the `providerId` the engine matches
 * against — so the three cannot drift into a grant that is issued but never honored.
 */
export const CLONE_CHAIN_STS_PROVIDER_ID = 'tts.elevenlabs-sts';

/** The user-facing provider whose cap covers the whole chain (engine.ts CAP_INHERITS_FROM). */
export const CLONE_CHAIN_CAP_ROOT = 'tts.elevenlabs';

export function cloneChainAdmission(ws: string, settingsHome: string | undefined, input: { chars: number; sourceDurationSec: number }): ProviderBatchEstimate {
  return estimateProviderCalls({
    workspacePath: ws, homeDir: settingsHome,
    calls: [
      { kind: 'tts', providerId: 'tts.elevenlabs', input: ttsEstimateInput(Math.min(Math.max(1, Math.round(input.chars)), MAX_ESTIMATE_CHARS), ELEVENLABS_TTS_DEFAULT_MODEL) satisfies TtsInput },
      // CONSERVATIVE BOUND, not the requested span: the STS step bills by the duration of the
      // TTS output, which does not exist yet and can run longer than the slot it replaces.
      // Admitting against the raw span under-prices exactly the patches most likely to overrun.
      { kind: 'tts', providerId: CLONE_CHAIN_STS_PROVIDER_ID, input: stsEstimateInput(conservativeStsSourceSec(input.sourceDurationSec)) satisfies StsInput }
    ]
  });
}

/**
 * How long a grant stays honorable.
 *
 * A grant is a snapshot of a spend ceiling. An hour-old one describes a world the user may have
 * deliberately changed since — and a chain that has been paused that long is not the "finish
 * what you already paid for" case grants exist to protect.
 */
export const CLONE_CHAIN_GRANT_TTL_MS = 60 * 60 * 1000;

/**
 * Tolerance for a grant timestamped in the FUTURE (clock skew, a restored backup). Kept to
 * minutes rather than reusing the TTL: a symmetric hour would make a skewed grant honorable for
 * two hours, doubling the window it was meant to bound.
 */
export const CLONE_CHAIN_GRANT_SKEW_MS = 5 * 60 * 1000;

/** No legitimate voice patch is granted anywhere near this. */
export const MAX_GRANT_TOTAL_USD = 100;

/**
 * The per-step amounts an admission granted, persisted with the Phase-1 row and handed to the
 * paid steps so a cap that tightens mid-chain cannot strand a half-billed generation.
 *
 * Validated on read rather than trusted: this record decides whether a paid call may skip a
 * spend ceiling, and it lives in an append-only log that hand-edits and older writers can both
 * reach. Anything that does not parse is treated as absent — the live check then applies, which
 * is the safe direction.
 */
export const CloneChainGrantSchema = z.object({
  steps: z.record(z.string().min(1).max(128), z.number().finite().nonnegative().nullable()),
  currency: z.string().min(1).max(16),
  capLimit: z.number().finite().nullable(),
  capSpent: z.number().finite().nonnegative().nullable(),
  grantedAt: z.string().datetime()
}).strict().superRefine((grant, ctx) => {
  const total = Object.values(grant.steps).reduce<number>((sum, amount) => sum + (amount ?? 0), 0);
  // An absolute sanity ceiling. No voice patch is worth this, and a grant is a licence to spend
  // — a number this large is a corrupt or forged record whatever the cap says.
  if (total > MAX_GRANT_TOTAL_USD) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'granted total is implausibly large' });
  // capLimit and capSpent are observed TOGETHER or not at all: admission records both when a
  // ceiling applies and neither when none does. A record with one but not the other cannot have
  // come from `grantFromAdmission` — and the null-capLimit half of it was a hole, because the
  // total-vs-limit refinement below has nothing to compare against.
  if ((grant.capLimit == null) !== (grant.capSpent == null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'capLimit and capSpent must both be present or both absent' });
    return;
  }
  // A grant may never claim more than the ceiling it was issued under. Such a record cannot
  // have come from `grantFromAdmission` (admission refuses first), so it is corrupt or forged.
  if (grant.capLimit == null) return;
  if (total > grant.capLimit) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'granted total exceeds the cap it was issued under' });
});
export type CloneChainGrant = z.infer<typeof CloneChainGrantSchema>;

export function isGrantFresh(grant: CloneChainGrant, now = Date.now()): boolean {
  const granted = Date.parse(grant.grantedAt);
  return Number.isFinite(granted) && now - granted <= CLONE_CHAIN_GRANT_TTL_MS && now - granted >= -CLONE_CHAIN_GRANT_SKEW_MS;
}


/** Sum of everything the admission granted, i.e. the width of the window the grant opens. */
export function grantTotal(grant: CloneChainGrant): number {
  return Object.values(grant.steps).reduce<number>((sum, amount) => sum + (amount ?? 0), 0);
}

export function grantFromAdmission(batch: ProviderBatchEstimate): CloneChainGrant {
  // Keyed by PROVIDER ID, not by position: the consumer asks "what was granted to
  // tts.elevenlabs-sts", and a positional map silently hands it the wrong step's amount if the
  // call order ever changes.
  const steps: Record<string, number | null> = {};
  for (const step of batch.steps) {
    // SUMMED, not last-wins: a chain that calls one provider twice would otherwise record only
    // the final amount, understating chainTotal and shrinking the window below what was admitted.
    //
    // NULL-ABSORBING: if any contributing call could not be priced, the provider's entry stays
    // null. Adding an unknown as zero would quietly grant that step for free — and the engine
    // already refuses an unpriceable call under a cap, so null is the honest record.
    const amount = step.cost.estimated;
    const seen = step.providerId in steps;
    const previous = seen ? steps[step.providerId] : undefined;
    steps[step.providerId] = amount == null || (seen && previous == null) ? null : (previous ?? 0) + amount;
  }
  return {
    steps,
    currency: batch.steps.find((step) => step.cost.currency)?.cost.currency ?? 'USD',
    capLimit: batch.cap.limit,
    capSpent: batch.cap.spent,
    grantedAt: new Date().toISOString()
  };
}

/** Flatten a batch estimate to the wire shape the Studio displays verbatim. */
function batchResponse(batch: ProviderBatchEstimate, names: readonly string[]) {
  const steps = batch.steps.map((step, index) => ({
    step: names[index] ?? String(index),
    providerId: step.providerId,
    currency: step.cost.currency,
    estimated: step.cost.estimated,
    ...(step.refusal ? { refusal: step.refusal } : {})
  }));
  const currencies = [...new Set(steps.map((step) => step.currency))];
  const anyUnknown = steps.some((step) => step.estimated == null);
  return {
    calls: steps.length,
    steps,
    // A total is only meaningful when every step is priced AND priced in one currency. Anything
    // else reports null rather than inventing a sum the user would read as authoritative.
    total: anyUnknown || currencies.length > 1 ? null : Number(steps.reduce((sum, step) => sum + (step.estimated ?? 0), 0).toFixed(6)),
    currency: currencies.length === 1 ? currencies[0] : null,
    cap: batch.cap,
    wouldExceedCap: batch.wouldRefuse,
    ...(batch.refusal ? { refusal: batch.refusal } : {}),
    ...(batch.refusalScope ? { refusalScope: batch.refusalScope } : {}),
    ...(batch.refusedAtStep !== undefined ? { refusedAtStep: names[batch.refusedAtStep] ?? batch.refusedAtStep } : {})
  };
}

export interface PrepareVoiceDeps {
  /** Test seam: replaces the paid clone executor so no test ever needs a network. */
  cloneExecutor?: (input: { name: string; samples: { audio: Buffer; fileName: string; mimeType: string }[] }) => Promise<{ voiceId: string }>;
  /** Test seam: replaces the ffmpeg decode of the cleaned bed. */
  decode?: (absPath: string) => Float32Array;
}

export function registerVoiceRoutes(ctx: LocalApiRouteContext, liveJobIds: Set<string>, cancelledJobs: Set<string>, deps: PrepareVoiceDeps = {}) {
  const { app, workspace, loadManifest } = ctx;
  const settingsHome = ctx.config.settingsHome;

  function stage(name: string, status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled') {
    return { name, status, ...(status === 'running' ? { startedAt: new Date().toISOString() } : {}), ...(status === 'succeeded' || status === 'failed' || status === 'cancelled' ? { completedAt: new Date().toISOString() } : {}) };
  }

  async function runPrepareVoiceJob(projectId: string, jobId: string, reservationKey: string, preflight: Extract<VoicePreflight, { ok: true }>) {
    const ws = workspace(projectId);
    const createdAt = new Date().toISOString();
    liveJobIds.add(jobId);
    const controller = new AbortController();
    // EVERY reservation transition runs under the project mutex — the same lock the cancel
    // endpoint takes. Read-modify-write on the reservation file is only a CAS with respect to
    // writers that serialize on one lock; without it a cancel and the pre-payment transition
    // can both observe 'local-prep' and both proceed, which is a paid call the user was told
    // was cancelled.
    const transition = (from: Parameters<typeof casCloneReservation>[2], patch: Parameters<typeof casCloneReservation>[3]) =>
      ctx.withProjectManifestMutex(projectId, async () => casCloneReservation(ws, reservationKey, from, patch));

    const failJob = async (errorCode: VoicePrepareErrorCode, message: string, details?: Record<string, unknown>, stages?: any[]) => {
      await transition(['local-prep', 'provider-in-flight', 'provider-committed'], { state: 'failed', errorCode, errorMessage: message });
      appendJobStatus(ws, { jobId, projectId, type: PREPARE_VOICE_JOB_TYPE, status: 'failed', createdAt, completedAt: new Date().toISOString(), error: message, errorCode, ...(details ? { errorDetails: details } : {}), ...(stages ? { stages } : {}) });
    };

    /**
     * Give up because the reservation is no longer ours (a cancel won the CAS, or reconciliation
     * terminated it). Records the job as cancelled and returns — WITHOUT paying.
     */
    const abandonToCancel = (stages: any[]) => {
      appendJobStatus(ws, { jobId, projectId, type: PREPARE_VOICE_JOB_TYPE, status: 'cancelled', createdAt, completedAt: new Date().toISOString(), stages: stages.map((s) => s.status === 'queued' || s.status === 'running' ? stage(s.name, 'cancelled') : s) });
    };

    try {
      let stages = [stage('decoding', 'running'), stage('selecting-windows', 'queued'), stage('cloning', 'queued')];
      appendJobStatus(ws, { jobId, projectId, type: PREPARE_VOICE_JOB_TYPE, status: 'running', createdAt, startedAt: new Date().toISOString(), stages });

      // ⟨Q2⟩: cancellation is only legal in 'local-prep'. The AUTHORITATIVE decision is the
      // durable CAS immediately before the paid call; these in-memory checks between local
      // phases are only an early exit so a cancelled job stops burning CPU.
      const cancelled = () => cancelledJobs.has(jobId);
      if (cancelled()) { abandonToCancel(stages); return; }

      // SYMLINK SAFETY: decode a staged copy read through the no-follow path, never the
      // workspace path itself — ffmpeg would re-open it by name and a swapped symlink would
      // feed (and, via the clone, upload) arbitrary local audio.
      const stagedBed = stageVerifiedWorkspaceFile(ws, preflight.cleanedAssetRel, { fileName: 'cleaned-source.wav' });
      let pcm16k: Float32Array;
      try {
        const decode = deps.decode ?? decodeWavToPcm16kMono;
        pcm16k = decode(stagedBed.path);
      } finally {
        stagedBed.dispose();
      }

      stages = [stage('decoding', 'succeeded'), stage('selecting-windows', 'running'), stage('cloning', 'queued')];
      appendJobStatus(ws, { jobId, projectId, type: PREPARE_VOICE_JOB_TYPE, status: 'running', createdAt, stages });
      if (cancelled()) { abandonToCancel(stages); return; }

      const transcript = loadTranscript(ws)!;
      let windows: CleanWindow[];
      try {
        windows = selectCleanWindows({ words: transcript, clipId: preflight.clipId, pcm16k }).windows;
      } catch (err) {
        if (err instanceof InsufficientCleanWindowsError) {
          await failJob('insufficient-clean-windows', err.message, { usableSec: err.usableSec, requiredSec: err.requiredSec }, [stage('decoding', 'succeeded'), stage('selecting-windows', 'failed'), stage('cloning', 'cancelled')]);
          return;
        }
        throw err;
      }

      stages = [stage('decoding', 'succeeded'), stage('selecting-windows', 'succeeded'), stage('cloning', 'running')];
      appendJobStatus(ws, { jobId, projectId, type: PREPARE_VOICE_JOB_TYPE, status: 'running', createdAt, stages });

      // THE BARRIER. Past this point the next thing that happens is a PAID call, so this CAS —
      // taken under the same mutex the cancel endpoint takes — is what decides the race: either
      // cancel got 'local-prep' first (this returns null, and nothing is billed) or we did (and
      // cancel now sees 'provider-in-flight' and returns 409 too-late-to-cancel). There is no
      // interleaving in which both win.
      const reserved = await transition(['local-prep'], { state: 'provider-in-flight' });
      if (!reserved) { abandonToCancel(stages); return; }

      const cloneExecutor = deps.cloneExecutor ?? (async (input: { name: string; samples: { audio: Buffer; fileName: string; mimeType: string }[] }) => {
        // ⟨R4⟩/⟨Q5⟩: the paid clone runs through runProvider, so spend caps, cap reservation,
        // ledger events and structured provider errors all apply — no bespoke second path.
        const envelope = await runProvider<CloneInput, CloneOutput>({
          kind: 'clone',
          providerId: 'clone.elevenlabs',
          input: { name: input.name, samples: input.samples },
          workspacePath: ws,
          projectId,
          requestType: 'voice_clone',
          homeDir: settingsHome,
          timeoutMs: 5 * 60 * 1000
        });
        if (!envelope.ok) {
          const error = new Error(envelope.error.message) as Error & { providerStatus?: number };
          error.providerStatus = envelope.error.statusCode;
          throw error;
        }
        return { voiceId: envelope.output.voiceId };
      });

      let result;
      try {
        result = await cloneCleanClip(ws, {
          scope: 'project',
          provider: 'elevenlabs',
          ...(preflight.accountRef ? { accountRef: preflight.accountRef } : {}),
          signal: controller.signal,
          projectId,
          homeDir: settingsHome,
          cloneExecutor: async (request) => {
            const cloned = await cloneExecutor(request);
            // The remote voice now EXISTS. Record that before the local persist so a crash in
            // the window between them is visible as 'provider-committed' → unknown-outcome,
            // never as a retryable local-prep.
            await transition(['provider-in-flight'], { state: 'provider-committed', voiceId: cloned.voiceId });
            return cloned;
          },
          multiWindow: {
            windows: windows.map((w) => ({ clipId: w.clipId, start: w.start, end: w.end })),
            sourceClass: 'cleaned',
            cleanupIdentity: preflight.cleanupIdentity,
            manifest: loadManifest(ws)
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const providerStatus = (err as { providerStatus?: number } | null)?.providerStatus;
        if (err instanceof CleanedSourceUnavailableError) { await failJob('cleaned-source-unavailable', message); return; }
        if (err instanceof InsufficientCleanWindowsError) { await failJob('insufficient-clean-windows', message, { usableSec: err.usableSec, requiredSec: err.requiredSec }); return; }
        if (isSlotLimit(message, providerStatus)) { await failJob('voice-slot-limit', message); return; }
        // An aborted in-flight paid call is UNKNOWN OUTCOME, never 'cancelled' (⟨Q2⟩): the
        // request may already have reached ElevenLabs.
        const current = await ctx.withProjectManifestMutex(projectId, async () => readCloneReservation(ws, reservationKey));
        if (current && current.state !== 'local-prep') { await failJob('unknown-outcome', message); return; }
        await failJob('clone-failed', message);
        return;
      }

      await transition(['provider-in-flight', 'provider-committed'], { state: 'persisted', voiceId: result.voice.voiceId });
      appendJobStatus(ws, {
        jobId, projectId, type: PREPARE_VOICE_JOB_TYPE, status: 'succeeded', createdAt, completedAt: new Date().toISOString(),
        stages: [stage('decoding', 'succeeded'), stage('selecting-windows', 'succeeded'), stage('cloning', 'succeeded')],
        input: { voiceId: result.voice.voiceId, sampleCount: result.sampleCount, cached: result.cached }
      });
    } catch (err) {
      await failJob('clone-failed', err instanceof Error ? err.message : String(err));
    } finally {
      liveJobIds.delete(jobId);
      cancelledJobs.delete(jobId);
    }
  }

  /**
   * POST /api/projects/:projectId/voice/prepare
   *
   * 202 + the job. The RESERVATION is written synchronously here — before the response, before
   * setImmediate — so two simultaneous POSTs cannot both reach the paid clone (⟨F2⟩).
   */
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/voice/prepare', async (req, reply) => {
    const { projectId } = req.params;
    const ws = workspace(projectId);
    const started = await ctx.withProjectManifestMutex(projectId, async () => {
      reconcileVoicePreparation(ws, projectId, liveJobIds);
      const preflight = voicePreflight(ws, loadManifest(ws), settingsHome);
      if (!preflight.ok) return { kind: 'early' as const, code: 409, body: { error: preflight.message, errorCode: preflight.errorCode, ...(preflight.details ? { details: preflight.details } : {}) } };

      const voice = findProjectCleanedClone({ homeDir: settingsHome }, {
        projectId,
        provider: 'elevenlabs',
        ...(preflight.accountRef ? { accountRef: preflight.accountRef } : {}),
        cleanupIdentity: preflight.cleanupIdentity
      });
      if (voice) return { kind: 'early' as const, code: 200, body: { status: { state: 'ready', voiceId: voice.voiceId } as VoiceStatus, cached: true } };

      const key = cloneReservationKey({
        ...(preflight.accountRef ? { accountRef: preflight.accountRef } : {}),
        cleanupIdentity: preflight.cleanupIdentity,
        sourceClass: 'cleaned',
        clipId: preflight.clipId
      });
      const existing = readCloneReservation(ws, key);
      if (existing && existing.state !== 'failed' && existing.state !== 'persisted') {
        // Duplicate POST for the same structural clone — join the running job, never start a
        // second paid call.
        return { kind: 'early' as const, code: 202, body: { job: { jobId: existing.jobId, type: PREPARE_VOICE_JOB_TYPE, status: 'running' }, deduped: true } };
      }

      const jobId = makeJobId(PREPARE_VOICE_JOB_TYPE);
      const reservation: CloneReservation = {
        key, projectId, jobId,
        ...(preflight.accountRef ? { accountRef: preflight.accountRef } : {}),
        cleanupIdentity: preflight.cleanupIdentity,
        clipId: preflight.clipId,
        sourceClass: 'cleaned',
        state: 'local-prep',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      writeCloneReservation(ws, reservation);
      const job = appendJobStatus(ws, { jobId, projectId, type: PREPARE_VOICE_JOB_TYPE, status: 'queued' });
      // Claim the job id BEFORE releasing the mutex: reconciliation must not see it as orphaned
      // in the window between the queued record and setImmediate actually firing.
      liveJobIds.add(jobId);
      return { kind: 'start' as const, jobId, key, preflight, job };
    });

    if (started.kind === 'early') return reply.code(started.code).send(started.body);
    setImmediate(() => { void runPrepareVoiceJob(projectId, started.jobId, started.key, started.preflight); });
    return reply.code(202).send({
      job: started.job,
      // D7: every paid call discloses its estimate/activity. EL bills IVC by plan tier, so the
      // honest disclosure is the call count, not a fabricated dollar figure.
      costDisclosure: 'ElevenLabs instant voice clone — 1 clone call (billed by plan tier, not per call)'
    });
  });

  /**
   * GET /api/projects/:projectId/manifest/voice-patches/:requestId/progress — ⟨R7⟩
   *
   * Per-step activity while the POST is still in flight, read straight off the step ledger.
   * A polled read of durable state rather than SSE/WS: the state is already persisted for
   * idempotency, so streaming it would add a second, weaker source of the same truth.
   */
  app.get<{ Params: { projectId: string; requestId: string } }>('/api/projects/:projectId/manifest/voice-patches/:requestId/progress', async (req, reply) => {
    const { projectId, requestId } = req.params;
    if (!ProviderRequestIdSchema.safeParse(requestId).success) return reply.code(400).send({ error: 'Invalid requestId' });
    const ws = workspace(projectId);
    const steps = (['tts', 'sts'] as const).map((step) => {
      const state = voicePatchStepState(ws, requestId, step);
      const status = state.terminal ? state.terminal.status : state.started ? 'running' : 'pending';
      return {
        step,
        status,
        ...(state.terminal?.status === 'succeeded' ? { durationSec: state.terminal.artifact?.durationSec } : {}),
        ...(state.terminal?.status === 'failed' ? { error: state.terminal.error } : {})
      };
    });
    const terminal = readRootTerminal(ws, requestId);
    return {
      requestId,
      steps,
      // 'seam' has no ledger record of its own — it runs between the last step terminal and the
      // root terminal, so its state is exactly derivable from those two.
      seam: terminal ? (terminal.httpStatus === 200 ? 'succeeded' : 'failed') : steps[1]!.status === 'succeeded' ? 'running' : 'pending',
      done: !!terminal,
      ...(terminal ? { httpStatus: terminal.httpStatus } : {})
    };
  });

  /**
   * GET /api/projects/:projectId/manifest/voice-patches/estimate?chars=&sourceDurationSec=
   *
   * What a prospective clone-chain generation would cost and whether the spend cap would admit
   * it. It runs the SAME adapters and the SAME ORDERED cap admission arithmetic the real call
   * will run (`estimateProviderCalls`), so the disclosure the user sees is the arithmetic the
   * engine will perform — including the case that matters most: two calls that each fit under
   * the remaining ceiling but do not fit in sequence, which in production bills the first and
   * refuses the second.
   *
   * This exists because the client previously mirrored the pricing table and the cap-inheritance
   * graph. A mirror cannot see a `costPerUnit` override (both ElevenLabs adapters treat one as a
   * flat per-call amount), cannot know which ledger rows count toward a cap (failed calls do
   * not; foreign currencies are not comparable), and cannot reproduce the fail-closed refusals.
   *
   * READ-ONLY, strictly: no paid call, no ledger write, no reservation, and no settings write —
   * providers are neither registered nor migrated-on-read here. An unregistered provider is
   * priced from its adapter defaults, which is exactly what the real call would use.
   *
   * ADVISORY, honestly: `wouldExceedCap` is a projection, not a guarantee. The STS step bills by
   * the duration of its SOURCE — the TTS output — which does not exist yet, so the caller
   * supplies the selection's duration and `cloneChainAdmission` prices a CONSERVATIVE multiple
   * of it (`conservativeStsSourceSec`). An output past that bound is still refused at execution
   * time, fail-closed. `authoritative: false` + `basis` say so, so the UI presents an estimate
   * as an estimate rather than a promise.
   */
  app.get<{ Params: { projectId: string }; Querystring: { chars?: string; sourceDurationSec?: string } }>('/api/projects/:projectId/manifest/voice-patches/estimate', async (req, reply) => {
    const chars = parseCount(req.query.chars, MAX_ESTIMATE_CHARS);
    const sourceDurationSec = parseDuration(req.query.sourceDurationSec);
    if (chars === null) return reply.code(400).send({ error: `chars must be an integer between 1 and ${MAX_ESTIMATE_CHARS}`, errorCode: 'invalid-estimate-input' });
    if (sourceDurationSec === null) return reply.code(400).send({ error: `sourceDurationSec must be a number between 0 and ${MAX_ESTIMATE_SECONDS}`, errorCode: 'invalid-estimate-input' });
    const ws = workspace(req.params.projectId);

    // ORDER IS THE POINT: tts then sts, each judged against the world its predecessor leaves.
    const batch = cloneChainAdmission(ws, settingsHome, { chars, sourceDurationSec });
    return { ...batchResponse(batch, ['tts', 'sts']), authoritative: false, basis: 'selection-duration' };
  });

  /**
   * GET /api/projects/:projectId/tts-estimate?providerId=&model=&chars=
   *
   * The same service for the LEGACY single-call voice-patch path, so no cost figure anywhere in
   * the Studio is computed from a client-side copy of the pricing table. Same read-only and
   * advisory properties as above (with no STS step, this one's only imprecision is the text
   * itself, which is exact).
   */
  app.get<{ Params: { projectId: string }; Querystring: { providerId?: string; model?: string; chars?: string } }>('/api/projects/:projectId/tts-estimate', async (req, reply) => {
    const chars = parseCount(req.query.chars, MAX_ESTIMATE_CHARS);
    if (chars === null) return reply.code(400).send({ error: `chars must be an integer between 1 and ${MAX_ESTIMATE_CHARS}`, errorCode: 'invalid-estimate-input' });
    const providerId = req.query.providerId;
    // The id is interpolated into nothing and resolved against the registry, but a hostile value
    // still has no business reaching the resolver.
    if (!providerId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(providerId)) return reply.code(400).send({ error: 'providerId is required', errorCode: 'invalid-estimate-input' });
    const model = req.query.model;
    if (model !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)) return reply.code(400).send({ error: 'invalid model', errorCode: 'invalid-estimate-input' });

    const batch = estimateProviderCalls({
      workspacePath: workspace(req.params.projectId), homeDir: settingsHome,
      calls: [{ kind: 'tts', providerId, input: ttsEstimateInput(chars, model) satisfies TtsInput }]
    });
    return { ...batchResponse(batch, ['tts']), authoritative: true, basis: 'exact-text' };
  });

  /** GET /api/projects/:projectId/voice/status — item 6. */
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/voice/status', async (req) => {
    const { projectId } = req.params;
    const ws = workspace(projectId);
    return ctx.withProjectManifestMutex(projectId, async () => {
      reconcileVoicePreparation(ws, projectId, liveJobIds);
      return deriveVoiceStatus(ws, projectId, loadManifest(ws), settingsHome);
    });
  });
}

/**
 * ⟨Q2⟩ prepare-voice-aware cancel dispatch, used by the generic job-cancel route.
 *
 * Cancelling is only legal while the reservation is in 'local-prep'. From 'provider-in-flight'
 * on, the clone may already have been created and billed, so a terminal `cancelled` would be a
 * lie: the endpoint returns 409 `too-late-to-cancel` and the job runs to its real terminal.
 *
 * The decision is a DURABLE CAS taken under the project mutex — the same lock the job takes for
 * its pre-payment transition — and it happens BEFORE the 200 is acknowledged. An in-memory flag
 * alone could be set while the job had already moved to 'provider-in-flight' on another tick,
 * acknowledging a cancellation for a call that was about to be billed.
 */
export async function cancelPrepareVoice(
  ctx: Pick<LocalApiRouteContext, 'withProjectManifestMutex'>,
  projectId: string,
  ws: string,
  jobId: string,
  cancelledJobs: Set<string>
): Promise<{ ok: true } | { ok: false; code: number; body: { error: string; errorCode: string } }> {
  return ctx.withProjectManifestMutex(projectId, async () => {
    const reservation = Object.values(readCloneReservations(ws)).find((entry) => entry.jobId === jobId) ?? null;
    if (!reservation) {
      // No reservation (e.g. the job never got that far): the in-memory flag is all there is,
      // and nothing paid can be pending without a reservation.
      cancelledJobs.add(jobId);
      return { ok: true as const };
    }
    if (reservation.state === 'failed' || reservation.state === 'persisted') {
      return { ok: false as const, code: 409, body: { error: 'This voice preparation has already finished.', errorCode: 'too-late-to-cancel' } };
    }
    const cancelledReservation = casCloneReservation(ws, reservation.key, ['local-prep'], { state: 'failed', errorCode: 'cancelled', errorMessage: 'Cancelled by the user before any paid call.' });
    if (!cancelledReservation) {
      return { ok: false as const, code: 409, body: { error: 'The voice clone call is already in flight — it cannot be cancelled without lying about whether it was billed.', errorCode: 'too-late-to-cancel' } };
    }
    cancelledJobs.add(jobId);
    appendJobStatus(ws, { jobId, projectId, type: PREPARE_VOICE_JOB_TYPE, status: 'cancelled', completedAt: new Date().toISOString() });
    return { ok: true as const };
  });
}
