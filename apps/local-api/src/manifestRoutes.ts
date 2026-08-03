import { z } from 'zod';
import { appendProviderRequestEvent, assertInside, assertSpeechProviderSupported, canonicalProviderId, isAbsentProviderId, extractSurroundingTranscriptText, ffprobeDurationSecOrZero, latestProviderRequest, loadProject, loadTranscript, ProviderRequestIdSchema, readProviderRequests, readSecrets, summarizeProviderRequestsForWorkspace, synthesizeReplacementSpeech, VoiceReferenceSchema, snapSpanToBoundaries, VoicePatchReferenceRangeSchema, type PatchTransports, type SnapMode } from '@etvideoscript/core';
import { speechToSpeechElevenlabs } from '@etvideoscript/core/providers/tts/elevenlabs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  appendApprovedRowWithSnapshot,
  buildExecutionSnapshot,
  cloneChainBodyHash,
  commitWithMarker,
  currentCleanupIdentity,
  makeCloneChainTransports,
  phase2ErrorResponse,
  readAdmissionGrant,
  readExecutionSnapshot,
  matchesOpImage,
  type MarkerApplyResult,
  readResolvedRange,
  verifyResolvedRangeGeometry,
  recoverCommitMarker,
  SimulatedCommitCrash,
  type CommitCrashWindow,
  resolveCloneForPatch,
  runCloneChainPhase2,
  sameSnapshot
} from './voicePatchChain';
import { cloneChainAdmission, grantFromAdmission, MAX_ESTIMATE_CHARS } from './voiceRoutes';
import { readCommitMarkers, readRootTerminal } from './voiceDurableState';
import type { VoicePatchCommitMarker } from './voiceDurableState';
import type { LocalApiRouteContext } from './routeContext';

// ⟨Q6⟩: the clone-chain variant is an explicit ALLOWLIST, not a deny-list — a field the server
// silently ignores is a field the user believes took effect. `.strict()` makes anything outside
// the shape a 400, and typing every field means a wrong-typed value (numeric clipId, non-string
// reason) is also a 400 rather than being coerced, dropped, or crashing downstream.
const CloneChainRequestSchema = z.object({
  mode: z.literal('clone-chain'),
  // ⟨R6⟩: client-generated and MANDATORY in clone-chain — it is what makes a transport retry
  // replay instead of re-billing.
  requestId: ProviderRequestIdSchema,
  clipId: z.string().min(1).max(128).optional(),
  start: z.number().finite(),
  end: z.number().finite(),
  // Bounded so the prospective-cost endpoint can price ANY text this route would accept without
  // being asked to materialize an unbounded string (and so a patch nobody could submit is not
  // answerable). A replacement line is a sentence, not a novel.
  text: z.string().trim().min(1).max(MAX_ESTIMATE_CHARS),
  granularity: z.enum(['word', 'phrase', 'sentence']).optional(),
  reason: z.string().max(500).optional()
}).strict();

// Named explicitly so the 400 can say WHY: in clone-chain the voice is the project's prepared
// clone and the models are the locked recipe — supplying these would be silently overridden.
const CLONE_CHAIN_REJECTED_KEYS = ['provider', 'voice', 'voiceRef', 'model', 'language', 'cloneScope', 'referenceRange'];

async function readMultipartBuffer(part: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of part.file) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Snap a raw [start, end] selection (ASSET axis) to word/phrase/sentence boundaries,
 * then return BOTH axes:
 *   assetStart / assetEnd — snapped asset-axis coords clamped to the clip's asset range.
 *   opStart / opEnd       — clip-local coords (assetStart - clipEntry.sourceStart).
 *
 * FIX 5: transcript lookups (extractSurroundingTranscriptText, word-filter) need ASSET-axis
 * coords; op.target and clipTarget() need CLIP-LOCAL coords. This function emits both so
 * each call site uses the correct axis without manual arithmetic.
 *
 * For single-import projects clip.sourceStart === 0, so both axes are identical — provably
 * a no-op vs the pre-FIX5 behaviour. For trimmed/multi-clip sources the clamp is correct.
 *
 * Clamp: snapped asset values are clamped to [clipStart, clipEnd] (the clip's asset range).
 * If aStart >= aEnd after the clamp, fall back to the raw selection clamped — never emits
 * start >= end.
 *
 * Passthrough (no-op) when: transcript is missing, words array is empty, or the clip is not
 * found — behaves identically to the pre-W6 verbatim flow.
 *
 * @param ws         - workspace path
 * @param clipId     - the clip the selection is on
 * @param rawStart   - raw asset-axis start from the request body
 * @param rawEnd     - raw asset-axis end from the request body
 * @param granularity - snap mode ('word' | 'phrase' | 'sentence')
 * @param manifest   - current ManifestV3 (to resolve clip.sourceStart / sourceEnd)
 */
function snapSelection(
  ws: string,
  clipId: string,
  rawStart: number,
  rawEnd: number,
  granularity: SnapMode,
  manifest: any
): { assetStart: number; assetEnd: number; opStart: number; opEnd: number; appliedMode: SnapMode; downgraded: boolean; outOfRange: boolean } {
  const clipEntry = (manifest.tracks as any[] | undefined)
    ?.flatMap((track: any) => track.clips as any[])
    ?.find((clip: any) => clip.clipId === clipId);
  const clipSourceStart: number = clipEntry && Number.isFinite(clipEntry.sourceStart) ? (clipEntry.sourceStart as number) : 0;
  const clipSourceEnd: number = clipEntry && Number.isFinite(clipEntry.sourceEnd) ? (clipEntry.sourceEnd as number) : Infinity;

  // AXIS (definitive, traced to the UI): rawStart/rawEnd are ASSET-axis — the studio
  // client's clipSpanTargetsForWords (apps/studio-web/.../store/editTargets.ts) builds the
  // request from word.start/word.end VERBATIM (transcript words are asset-axis), with NO
  // sourceStart subtraction. So comparing/snapping against asset-axis words + the clip's
  // asset range here is correct; the conversion to clip-local op.target (− clipSourceStart)
  // happens only at the very end. (For single-import clips sourceStart===0, asset == clip-local,
  // which is why reviewers repeatedly flip on this — but the UI's contract is asset-axis.)

  // Out-of-range guard: a selection WHOLLY before/after the clip's asset range must be
  // REJECTED, not snapped. Without this, snapSpanToBoundaries' nearest-word fallback + the
  // clamp below would silently rescue a stale/bad selection (e.g. start=-5, or beyond
  // sourceEnd) into a patch on the first/last word — the pre-W6 verbatim path failed
  // validateLocal for such inputs. Partial overlap is fine (the clamp trims the overflow).
  if (rawEnd <= clipSourceStart || rawStart >= clipSourceEnd) {
    return { assetStart: rawStart, assetEnd: rawEnd, opStart: rawStart - clipSourceStart, opEnd: rawEnd - clipSourceStart, appliedMode: granularity, downgraded: false, outOfRange: true };
  }

  const words = loadTranscript(ws);
  if (!words || !Array.isArray(words.words) || words.words.length === 0) {
    // Passthrough: asset axis = raw, clip-local = raw - clipSourceStart.
    return { assetStart: rawStart, assetEnd: rawEnd, opStart: rawStart - clipSourceStart, opEnd: rawEnd - clipSourceStart, appliedMode: granularity, downgraded: false, outOfRange: false };
  }

  const snapped = snapSpanToBoundaries(words, { start: rawStart, end: rawEnd, clipId }, granularity);

  // Clamp snapped asset coords to the clip's asset range.
  const clipAssetEnd: number = Number.isFinite(clipSourceEnd) ? clipSourceEnd : snapped.end;
  let aStart = Math.min(Math.max(snapped.start, clipSourceStart), clipAssetEnd);
  let aEnd   = Math.min(Math.max(snapped.end,   clipSourceStart), clipAssetEnd);
  if (aStart >= aEnd) {
    // Clamp collapsed the span — fall back to raw selection clamped.
    aStart = Math.min(Math.max(rawStart, clipSourceStart), clipAssetEnd);
    aEnd   = Math.min(Math.max(rawEnd,   clipSourceStart), clipAssetEnd);
  }

  return {
    assetStart: aStart,
    assetEnd: aEnd,
    // Clip-local = asset - clipSourceStart.
    opStart: aStart - clipSourceStart,
    opEnd:   aEnd   - clipSourceStart,
    appliedMode: snapped.mode,
    downgraded: snapped.downgraded,
    outOfRange: false
  };
}

export function registerManifestRoutes(ctx: LocalApiRouteContext, cloneChainTransports?: PatchTransports, commitCrashAt?: CommitCrashWindow) {
  const { app, workspace, loadManifest, validateWorkspaceManifest, validateManifestDocument, addManifestOperation, addVoicePatchOperation, updateManifestOperation, clipTarget, providerBodyHash, baseProviderEvent, providerExecutionShape, voicePatchDurationWarning } = ctx;
  const settingsHome = ctx.config.settingsHome;

  function providerRequestBodyHash(ws: string, requestId: string): string | undefined {
    return (readProviderRequests(ws).find((event: any) => event.requestId === requestId && typeof event.bodyHash === 'string') as { bodyHash?: string } | undefined)?.bodyHash;
  }

  /**
   * STRICT variant for the clone chain. A skipped or truncated ledger line on this path means a
   * paid record may be missing, and proceeding would risk a second charge — so it fails closed
   * rather than reporting "no prior request". The legacy route keeps the lenient lookup above,
   * which older workspaces depend on.
   */
  function providerRequestBodyHashStrict(ws: string, requestId: string): string | undefined {
    return (readProviderRequests(ws, { strict: true }).find((event: any) => event.requestId === requestId && typeof event.bodyHash === 'string') as { bodyHash?: string } | undefined)?.bodyHash;
  }

  /**
   * Apply a commit marker's intended manifest mutation, idempotently and IMAGE-GUARDED.
   * Recovery and the happy path share this so a recovered commit lands exactly the state the
   * original would have — and, just as importantly, declines exactly the same mutations.
   *
   * Three guards, in order:
   *   • `intendedOutcome: 'preserve'` — the request has a terminal but the op is the user's now.
   *     Never touched.
   *   • already at the POSTIMAGE — the mutation landed before the crash. No-op.
   *   • not at the PREIMAGE — the op was edited, re-targeted, rejected or disabled while the
   *     paid call was in flight. Mutating it would overwrite the user's state with a decision
   *     made about a different operation, so we leave it alone. (Comparing only `status`, as an
   *     earlier revision did, cannot tell "still ours" from "edited but coincidentally the same
   *     status" — that is how an approved op could be flipped to rejected.)
   */
  function applyCommitMarker(ws: string, marker: VoicePatchCommitMarker): MarkerApplyResult {
    if (marker.intendedOutcome === 'preserve') return 'preserved';
    const before = loadManifest(ws);
    const current = before.operations.find((op: any) => op.id === marker.operationId);
    // A MISSING operation is only benign for a 'preserve' marker (handled above). For approve or
    // reject it is a conflict: the terminal would describe a postimage that does not exist
    // anywhere in the manifest.
    if (!current) return 'conflict';
    if (matchesOpImage(current, marker.expectedOpPostimage, before)) return 'already-applied';
    if (!matchesOpImage(current, marker.expectedOpPreimage, before)) return 'conflict';
    if (marker.intendedOutcome === 'approve') {
      updateManifestOperation(ws, marker.operationId, {
        status: 'approved',
        asset: marker.assetRel,
        providerRequestId: marker.requestId,
        ...(marker.expectedOpPostimage.durationGeneratedSec != null ? { durationGeneratedSec: marker.expectedOpPostimage.durationGeneratedSec } : {}),
        ...(marker.expectedOpPostimage.durationRequestedSec != null ? { durationRequestedSec: marker.expectedOpPostimage.durationRequestedSec } : {}),
        seamBaked: true
      });
    } else {
      updateManifestOperation(ws, marker.operationId, { status: 'rejected', reason: `Generation failed (HTTP ${marker.httpStatus}).` });
    }
    // VERIFY the write landed as the postimage describes. The marker's whole purpose is that the
    // terminal we publish and the manifest agree; an update that silently produced something
    // else (a schema coercion, a rejected field) must not be reported as a completed commit.
    const after = loadManifest(ws);
    const updated = after.operations.find((op: any) => op.id === marker.operationId);
    return matchesOpImage(updated, marker.expectedOpPostimage, after) ? 'applied' : 'conflict';
  }

  /**
   * D9/⟨R6⟩ clone-chain mode: the ear-locked recipe end to end. Everything paid is idempotent
   * against `requestId`; everything mutable is snapshotted at Phase 1 and revalidated at
   * Phase 3; the route never clones (D3) and never falls back to a raw seam bed (D6).
   */
  async function handleCloneChain(req: any, reply: any) {
    const projectId: string = req.params.projectId;
    const ws = workspace(projectId);
    const body = req.body ?? {};

    // ── ⟨Q6⟩ strict intake ──────────────────────────────────────────────────────
    // Named rejections first so the 400 explains WHY these particular fields are refused;
    // everything else is caught by the strict schema below (which also TYPE-checks, so a
    // numeric clipId or a non-string reason is a 400 rather than a silent drop or a 500).
    const rejected = CLONE_CHAIN_REJECTED_KEYS.filter((key) => body[key] !== undefined);
    if (rejected.length) return reply.code(400).send({ error: `In clone-chain mode the voice and models are fixed by the prepared clone and the locked recipe; remove: ${rejected.join(', ')}`, errorCode: 'field-not-allowed' });
    const parsedBody = CloneChainRequestSchema.safeParse(body);
    if (!parsedBody.success) {
      const issue = parsedBody.error.issues[0]!;
      const path = issue.path.join('.');
      const unrecognized = issue.code === 'unrecognized_keys';
      return reply.code(400).send({
        error: unrecognized
          ? `Unsupported field(s) in clone-chain mode: ${(issue as { keys?: string[] }).keys?.join(', ') ?? path}`
          : `${path || 'body'}: ${issue.message}`,
        errorCode: unrecognized ? 'field-not-allowed'
          : path === 'requestId' ? 'invalid-request-id'
          : path === 'text' ? 'invalid-text'
          : path === 'granularity' ? 'invalid-granularity'
          : 'invalid-range'
      });
    }
    const parsed = parsedBody.data;
    if (parsed.start >= parsed.end) return reply.code(400).send({ error: 'start/end must be finite and start < end', errorCode: 'invalid-range' });
    const granularity: SnapMode = parsed.granularity ?? 'phrase';

    const requestId: string = parsed.requestId;
    const text: string = parsed.text.trim();
    // D5: hash is CLIENT INTENT only. `clipId` is taken verbatim from the body (normalized to
    // '' when omitted) so the hash is computable BEFORE any server-state resolution — which is
    // what lets the root terminal be consulted before clone resolution or freshness (⟨F4⟩).
    const bodyHash = cloneChainBodyHash({
      mode: 'clone-chain',
      clipId: parsed.clipId ?? '',
      text,
      targetStartSec: body.start,
      targetEndSec: body.end,
      granularity
    });

    const result = await ctx.withInFlightProviderCall(`vp:${projectId}:${requestId}:${bodyHash}`, async () => {
      // ── Phase 1 (locked) ──────────────────────────────────────────────────────
      const phase1 = await ctx.withProjectManifestMutex(projectId, async () => {
        // Finish any interrupted commit BEFORE reading the terminal log — otherwise a crashed
        // predecessor's outcome would look absent and be re-executed.
        const recovery = recoverCommitMarker(ws, requestId, (marker) => applyCommitMarker(ws, marker));
        if (recovery.kind === 'ledger-corruption') {
          return { kind: 'early' as const, code: 500, body: { error: recovery.message, errorCode: 'ledger-corruption' } };
        }
        if (recovery.kind === 'marker-conflict') {
          return { kind: 'early' as const, code: 409, body: { error: recovery.message, errorCode: 'commit-marker-conflict' } };
        }
        if (recovery.kind === 'recovered') {
          if (recovery.terminal.bodyHash !== bodyHash) return { kind: 'early' as const, code: 409, body: { error: 'requestId already exists with a different voice patch body', errorCode: 'request-id-conflict' } };
          return { kind: 'early' as const, code: recovery.terminal.httpStatus, body: JSON.parse(recovery.terminal.serializedBody) };
        }

        // ⟨F4⟩ ROOT-TERMINAL-FIRST: consulted before clone resolution and before any freshness
        // check, and replayed byte-for-byte.
        const terminal = readRootTerminal(ws, requestId);
        if (terminal) {
          if (terminal.bodyHash !== bodyHash) return { kind: 'early' as const, code: 409, body: { error: 'requestId already exists with a different voice patch body', errorCode: 'request-id-conflict' } };
          return { kind: 'early' as const, code: terminal.httpStatus, body: JSON.parse(terminal.serializedBody) };
        }

        const manifest = loadManifest(ws);
        const resolution = resolveCloneForPatch(ws, projectId, manifest, settingsHome);
        if (!resolution.ok) return { kind: 'early' as const, code: 409, body: { error: resolution.message, errorCode: resolution.code } };
        if (parsed.clipId && parsed.clipId !== resolution.clipId) {
          return { kind: 'early' as const, code: 400, body: { error: `Clip ${body.clipId} is not the eligible cleaned speech source (${resolution.clipId}).`, errorCode: 'clip-not-eligible' } };
        }

        // RESUME after a Phase-1 that died in Phase 2. Reuse the operation, its snapshot AND its
        // persisted coordinates — never re-derive the window. Snapping reads the transcript,
        // which is mutable: recomputing it here could hand the paid steps a different range than
        // the op was created for and approve audio for the wrong target.
        const existingRequest = latestProviderRequest(ws, requestId, { strict: true });
        if (existingRequest) {
          if (providerRequestBodyHashStrict(ws, requestId) !== bodyHash) return { kind: 'early' as const, code: 409, body: { error: 'requestId already exists with a different voice patch body', errorCode: 'request-id-conflict' } };
          const snapshot = readExecutionSnapshot(ws, requestId);
          const storedRange = readResolvedRange(ws, requestId);
          const operation = loadManifest(ws).operations.find((op: any) => op.id === (existingRequest as any).operationId);
          if (snapshot && storedRange && operation) {
            // The op must still BE the one Phase 1 created, on the stored coordinates, and the
            // live server state must still match the snapshot. Anything else means resuming
            // would attach audio to something it was not generated for — refuse before paying.
            const stillOurs = operation.status === 'proposed'
              && operation.providerRequestId === requestId
              && operation.text === text
              && operation.target?.clipId === storedRange.clipId
              && Number(operation.target?.start) === storedRange.opStart
              && Number(operation.target?.end) === storedRange.opEnd;
            if (!stillOurs) {
              return { kind: 'early' as const, code: 409, body: { error: 'The operation this generation belongs to has changed since it started; start a new generation.', errorCode: 'operation-conflict' } };
            }
            // The stored range must still describe the SAME geometry: the eligible clip cannot
            // have changed, and the asset-axis coordinates the seam uses must still be the
            // clip-local ones offset by the clip's CURRENT sourceStart. A re-trimmed clip
            // silently invalidates that mapping, and generating against it would bake the patch
            // against the wrong stretch of the recording.
            const geometry = verifyResolvedRangeGeometry(storedRange, manifest, resolution.clipId);
            if (!geometry.ok) {
              return { kind: 'early' as const, code: 409, body: { error: geometry.message, errorCode: 'range-conflict' } };
            }
            if (!sameSnapshot(buildExecutionSnapshot(resolution), snapshot)) {
              return { kind: 'early' as const, code: 409, body: { error: 'Studio Sound or the prepared voice changed since this generation started; start a new generation.', errorCode: 'snapshot-conflict' } };
            }
            // RESUME under the ORIGINAL grant. This is what lets a chain whose TTS already
            // produced a step terminal finish even if the cap tightened afterwards — the money
            // for that TTS is already spent, and refusing the STS now would strand it.
            return { kind: 'continue' as const, operation, snapshot, resolution, range: storedRange, grant: readAdmissionGrant(ws, requestId) };
          }
          // A ledger row exists but its snapshot/range/op does not — the record is unusable for
          // a resume and we cannot know what it authorised. Refuse rather than start a second
          // generation under an id that already has history.
          return { kind: 'early' as const, code: 409, body: { error: 'This generation has incomplete history and cannot be resumed; start a new generation.', errorCode: 'operation-conflict' } };
        }

        // CRASH-CONSISTENCY of the Phase-1 pair (op write, then approved row): if we died
        // between them, an op carrying this requestId exists with NO ledger row. Nothing was
        // paid (the row is written before Phase 2), so the orphan is retired — reversibly, per
        // the manifest rules — instead of leaving a duplicate proposal behind.
        for (const orphan of loadManifest(ws).operations.filter((op: any) => op.type === 'voice_patch' && op.providerRequestId === requestId && op.status === 'proposed')) {
          updateManifestOperation(ws, orphan.id, { status: 'rejected', reason: 'Superseded: the generation that proposed it did not record a provider request (interrupted before any paid call).' });
        }

        const snap = snapSelection(ws, resolution.clipId, parsed.start, parsed.end, granularity, manifest);
        if (snap.outOfRange) return { kind: 'early' as const, code: 400, body: { error: 'Voice patch selection is outside the clip range', errorCode: 'invalid-range' } };
        const voiceRef = { providerId: 'tts.elevenlabs', voiceId: resolution.voiceId };
        const preview = { type: 'voice_patch' as const, status: 'proposed' as const, target: clipTarget(manifest, resolution.clipId, snap.opStart, snap.opEnd), text, voiceRef, providerRequestId: requestId, id: '__preview__', proposedBy: 'user' as const, createdBy: 'user' as const, createdAt: new Date().toISOString() };
        const previewValidation = validateManifestDocument({ ...manifest, operations: [...manifest.operations, preview], updatedAt: new Date().toISOString() });
        if (!previewValidation.valid) return { kind: 'early' as const, code: 400, body: { error: `Voice patch rejected:\n${previewValidation.errors.join('\n')}`, errorCode: 'validation-failed' } };

        // PRE-PAYMENT SEQUENCE ADMISSION (server-authoritative).
        //
        // The engine caps each call independently, which cannot see that this ONE user action is
        // two paid calls under one shared ceiling: with $0.055 left, a $0.01 TTS and a $0.05 STS
        // each pass, so production bills the first and refuses the second — the user charged for
        // half a generation. This runs the same ordered projection the disclosure endpoint runs,
        // before the operation exists and before anything is billed, so the client-side gate is
        // advisory (a stale or failed estimate can no longer let a partial bill through).
        //
        // Deliberately conservative: the STS step is priced off the REQUESTED span, because its
        // real billing unit — the TTS output duration — does not exist yet. A chain the engine
        // would have admitted can therefore be refused here. That costs nothing and is
        // recoverable (raise the cap); the inverse is a charge the user was told would not happen.
        const admission = cloneChainAdmission(ws, settingsHome, { chars: text.length, sourceDurationSec: Math.max(0, snap.assetEnd - snap.assetStart) });
        // ⚠ ACCEPTED, NOT OVERLOOKED: admissions are not RESERVED against one another, so two
        // chains admitted close together in the same project both open a window. What keeps
        // that honest is the window's shape, not the mutex (which covers Phase 1 only): a grant
        // is honored solely while `spent + estimate <= capSpentAtAdmission + chainTotal`, so the
        // second chain — which sees the first one's spend — falls outside its own window and is
        // refused by the ordinary live check. The residual is bounded by one step's estimate,
        // and only in the interval before the first chain's spend reaches the ledger.
        //
        // NOT the same thing as the cross-project case: spend caps are per-workspace and the
        // ledger is per-workspace, so two projects never shared a ceiling to begin with. That
        // predates grants entirely and is unchanged by them.
        // (`voicePatchChain.test.ts` pins both behaviours.)
        if (admission.wouldRefuse) {
          return { kind: 'early' as const, code: 409, body: {
            error: admission.refusal === 'cap-exceeded'
              ? admission.refusalScope === 'sequence-only'
                ? 'This generation is two paid calls under one spend cap. They fit individually but not in sequence, so it would bill the first and be refused on the second.'
                : 'This generation would exceed the workspace spend cap.'
              : admission.refusal === 'provider-disabled'
                ? 'A provider this generation needs is disabled in Settings.'
                : admission.refusal === 'ledger-unreadable'
                  ? 'The provider ledger cannot be totalled, so the spend cap cannot admit this generation.'
                  : 'This generation cannot be priced, so the spend cap cannot admit it.',
            errorCode: 'cap-would-refuse-sequence',
            refusal: admission.refusal,
            ...(admission.refusalScope ? { refusalScope: admission.refusalScope } : {}),
            ...(admission.refusedAtStep !== undefined ? { refusedAtStep: ['tts', 'sts'][admission.refusedAtStep] ?? admission.refusedAtStep } : {}),
            cap: admission.cap
          } };
        }

        const operation = addVoicePatchOperation(ws, { clipId: resolution.clipId, start: snap.opStart, end: snap.opEnd, text, voiceRef, status: 'proposed', providerRequestId: requestId, granularity, reason: parsed.reason || 'Replacement speech in your prepared voice' });
        const snapshot = buildExecutionSnapshot(resolution);
        const range = { clipId: resolution.clipId, opStart: snap.opStart, opEnd: snap.opEnd, assetStart: snap.assetStart, assetEnd: snap.assetEnd };
        const grant = grantFromAdmission(admission);
        appendApprovedRowWithSnapshot(ws, { requestId, projectId, operationId: operation.id, bodyHash, text, snapshot, resolvedRange: range, start: snap.opStart, end: snap.opEnd, admissionGrant: grant });
        return { kind: 'continue' as const, operation, snapshot, resolution, range, grant };
      });
      if (phase1.kind === 'early') return { kind: 'early' as const, code: phase1.code, body: phase1.body };

      const { operation, snapshot, resolution, range, grant } = phase1;
      const requestedSec = range.opEnd - range.opStart;
      // The op as Phase 1 left it. Every later mutation is guarded against THIS image, so an op
      // the user edits mid-flight is preserved rather than overwritten.
      const preimage = {
        status: 'proposed', providerRequestId: requestId, text,
        targetClipId: range.clipId,
        targetTrackId: String((operation as any).target?.trackId ?? ''),
        targetStart: range.opStart, targetEnd: range.opEnd
      };

      // ── Phase 2 (UNLOCKED — the mutex is never held across a paid call) ────────
      const transports = cloneChainTransports ?? makeCloneChainTransports(ws, projectId, requestId, operation.id, settingsHome, grant);
      let generated;
      try {
        generated = await runCloneChainPhase2({
          ws, projectId, requestId, operationId: operation.id, text,
          voiceId: snapshot.voiceId,
          cleanedAssetRel: resolution.cleanedAssetRel,
          assetStartSec: range.assetStart,
          assetEndSec: range.assetEnd,
          granularity,
          transports,
          ...(settingsHome ? { settingsHome } : {})
        });
      } catch (err) {
        const mapped = phase2ErrorResponse(err);
        // Every Phase-2 outcome — including the unknown-outcome and corruption classes — becomes
        // an exactly-once root terminal, so a retry replays it instead of re-billing.
        return await ctx.withProjectManifestMutex(projectId, async () => {
          const manifest = loadManifest(ws);
          const currentOp = manifest.operations.find((op: any) => op.id === operation.id);
          // The failure is OURS to record, but the operation may no longer be: the user can have
          // PATCHed its text/target, rejected it, or DELETEd it while the paid call was running.
          // Rejecting it then would overwrite their state with a decision about a different op —
          // and re-rejecting an op they already disabled is just as wrong. The snapshot is
          // re-checked for the same reason: a cleanup change mid-flight invalidates the link
          // between this failure and that op.
          const liveResolution = resolveCloneForPatch(ws, projectId, manifest, settingsHome);
          const stillOurs = matchesOpImage(currentOp, preimage)
            && liveResolution.ok
            && sameSnapshot(buildExecutionSnapshot(liveResolution), snapshot);
          const outcome = stillOurs ? 'reject' as const : 'preserve' as const;
          const errorCode = stillOurs ? mapped.body.errorCode : 'operation-conflict';
          const marker: VoicePatchCommitMarker = {
            requestId, projectId, operationId: operation.id, assetRel: '',
            intendedOutcome: outcome,
            httpStatus: mapped.code,
            serializedBody: JSON.stringify({
              ...mapped.body,
              errorCode,
              ...(stillOurs ? {} : { note: 'The generation failed, but the operation had already been changed and was left untouched.' }),
              providerRequestId: requestId,
              operationId: operation.id
            }),
            bodyHash, executionSnapshot: snapshot,
            expectedOpPreimage: preimage,
            expectedOpPostimage: stillOurs ? { ...preimage, status: 'rejected' } : preimage,
            createdAt: new Date().toISOString()
          };
          const committed = commitWithMarker(ws, marker, () => applyCommitMarker(ws, marker), commitCrashAt);
          if (!committed.ok) return { kind: 'early' as const, code: 409, body: { error: committed.reason, errorCode: 'commit-marker-conflict', providerRequestId: requestId, operationId: operation.id } };
          return { kind: 'early' as const, code: committed.terminal.httpStatus, body: JSON.parse(committed.terminal.serializedBody) };
        });
      }

      // ── Phase 3 (locked) ──────────────────────────────────────────────────────
      return await ctx.withProjectManifestMutex(projectId, async () => {
        const manifest = loadManifest(ws);
        const currentOp = manifest.operations.find((op: any) => op.id === operation.id);
        // Full-image comparison, not status-only: an op the user re-targeted or re-worded during
        // the paid call can still be 'proposed' and must NOT receive this audio.
        const bodyMatches = matchesOpImage(currentOp, preimage);
        // D5/D6: the snapshot guard covers what the hash deliberately cannot — mutable server
        // state. A cleanup re-run or a different prepared clone mid-flight invalidates the audio
        // even though the client's intent is unchanged.
        const liveCleanup = currentCleanupIdentity(ws, manifest);
        const liveResolution = resolveCloneForPatch(ws, projectId, manifest, settingsHome);
        const snapshotMatches = liveCleanup === snapshot.cleanupIdentity
          && liveResolution.ok
          && sameSnapshot(buildExecutionSnapshot(liveResolution), snapshot);
        // GEOMETRY, re-checked here and not only on resume: a trim_clip during Phase 2 changes
        // sourceStart/sourceEnd while leaving the op's clip-local target untouched, so the op
        // image and the snapshot both still match — and the audio we just paid for was seated
        // against asset coordinates that no longer describe this clip.
        const geometry = liveResolution.ok
          ? verifyResolvedRangeGeometry(range, manifest, liveResolution.clipId)
          : { ok: false as const, message: 'The eligible cleaned source is no longer resolvable.' };

        if (!bodyMatches || !snapshotMatches || !geometry.ok) {
          const reason = !bodyMatches
            ? `The operation no longer accepts this generation (current status: ${currentOp?.status ?? 'missing'}).`
            : !snapshotMatches
              ? 'Studio Sound or the prepared voice changed while the patch was generating, so the audio no longer matches this recording.'
              : (geometry as { message: string }).message;
          // If the op is no longer ours, PRESERVE it — the conflict is recorded as this
          // request's terminal, but the user's operation is not touched. Only a still-matching
          // op is rolled to 'rejected' (reversible, and it is our proposal to withdraw).
          const outcome = bodyMatches ? 'reject' as const : 'preserve' as const;
          const marker: VoicePatchCommitMarker = {
            requestId, projectId, operationId: operation.id, assetRel: generated.assetRel,
            intendedOutcome: outcome,
            httpStatus: 409,
            serializedBody: JSON.stringify({
              error: reason,
              errorCode: !bodyMatches ? 'operation-conflict' : !snapshotMatches ? 'snapshot-conflict' : 'range-conflict',
              providerRequestId: requestId, operationId: operation.id, asset: generated.assetRel
            }),
            bodyHash, executionSnapshot: snapshot,
            expectedOpPreimage: preimage,
            expectedOpPostimage: bodyMatches ? { ...preimage, status: 'rejected' } : preimage,
            createdAt: new Date().toISOString()
          };
          const committed = commitWithMarker(ws, marker, () => applyCommitMarker(ws, marker), commitCrashAt);
          if (!committed.ok) return { kind: 'early' as const, code: 409, body: { error: committed.reason, errorCode: 'commit-marker-conflict', providerRequestId: requestId, operationId: operation.id } };
          return { kind: 'early' as const, code: committed.terminal.httpStatus, body: JSON.parse(committed.terminal.serializedBody) };
        }

        const responseBody = {
          providerRequestId: requestId,
          operation: {
            id: operation.id,
            status: 'approved',
            clipId: range.clipId,
            start: range.opStart,
            end: range.opEnd,
            text,
            asset: generated.assetRel,
            durationGeneratedSec: generated.durationSec,
            durationRequestedSec: requestedSec,
            seamBaked: true
          },
          voiceId: snapshot.voiceId,
          steps: {
            tts: { ...generated.steps.tts.artifact, replayed: generated.steps.tts.replayed },
            sts: { ...generated.steps.sts.artifact, replayed: generated.steps.sts.replayed }
          }
        };
        const marker: VoicePatchCommitMarker = {
          requestId, projectId, operationId: operation.id, assetRel: generated.assetRel,
          intendedOutcome: 'approve',
          httpStatus: 200,
          // ⟨Q1⟩: the FINALIZED body, persisted before the mutation — the terminal is fully
          // reconstructable from the marker alone. (This is why the clone-chain response does
          // not embed the post-mutation manifest: a body that depends on the mutation could not
          // be finalized before it.)
          serializedBody: JSON.stringify(responseBody),
          bodyHash, executionSnapshot: snapshot,
          expectedOpPreimage: preimage,
          expectedOpPostimage: { ...preimage, status: 'approved', assetRel: generated.assetRel, durationGeneratedSec: generated.durationSec, durationRequestedSec: requestedSec, seamBaked: true },
          createdAt: new Date().toISOString()
        };
        // The success path goes through the SAME image-guarded, postimage-verified applier as
        // recovery. It previously used a bespoke inline mutation that returned nothing, so a
        // guard miss or a write that landed differently still published a 200 terminal.
        const committed = commitWithMarker(ws, marker, () => applyCommitMarker(ws, marker), commitCrashAt);
        if (!committed.ok) {
          // The marker is retained and no terminal was written: the manifest did not reach the
          // state this response would have claimed.
          return { kind: 'early' as const, code: 409, body: { error: committed.reason, errorCode: 'commit-marker-conflict', providerRequestId: requestId, operationId: operation.id, asset: generated.assetRel } };
        }
        return { kind: 'early' as const, code: committed.terminal.httpStatus, body: JSON.parse(committed.terminal.serializedBody) };
      });
    });

    return reply.code(result.code).send(result.body);
  }

  /**
   * Recover EVERY pending commit marker in a project at startup.
   *
   * Same-request replay is not enough: a crash mid-commit leaves a proposed operation and a
   * pending marker that only that exact requestId would ever clear, so a client that never
   * retries strands the op indefinitely. This completes the protocol for all of them, and is
   * the caller's job to run under the project mutex.
   *
   * Returns a per-marker outcome so the caller can log what it could not resolve; a corrupt or
   * conflicting marker is LEFT in place rather than forced.
   */
  function recoverProjectCommitMarkers(projectId: string): Array<{ requestId: string; outcome: string }> {
    const ws = workspace(projectId);
    let markers: Record<string, VoicePatchCommitMarker>;
    try { markers = readCommitMarkers(ws); }
    catch (err) { return [{ requestId: '(all)', outcome: `unreadable: ${ctx.errorMessage(err)}` }]; }
    return Object.keys(markers).map((requestId) => {
      try {
        const recovery = recoverCommitMarker(ws, requestId, (marker) => applyCommitMarker(ws, marker));
        return { requestId, outcome: recovery.kind };
      } catch (err) {
        return { requestId, outcome: `failed: ${ctx.errorMessage(err)}` };
      }
    });
  }

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/manifest', async (req) => {
    return await ctx.withProjectManifestMutex(req.params.projectId, async () => {
      const ws = workspace(req.params.projectId);
      const before = loadManifest(ws);
      const legacy = before.operations.filter((op: any) => op.type === 'voice_patch' && op.status === 'awaiting_approval');
      for (const op of legacy) {
        const pendingRequest = op.providerRequestId ? latestProviderRequest(ws, op.providerRequestId) : null;
        const updated = updateManifestOperation(ws, op.id, { status: 'rejected', reason: 'Approval gate removed in P4-1b. Re-trigger as a new voice_patch.' });
        if (pendingRequest && pendingRequest.status === 'pending') {
          appendProviderRequestEvent(ws, baseProviderEvent({
            ...providerExecutionShape(pendingRequest),
            requestId: pendingRequest.requestId,
            projectId: req.params.projectId,
            provider: pendingRequest.provider,
            voice: pendingRequest.voice,
            language: pendingRequest.language,
            text: updated.text,
            operationId: updated.id,
            status: 'rejected',
            completedAt: new Date().toISOString(),
            error: 'Approval gate removed in P4-1b',
            start: updated.target.start,
            end: updated.target.end,
            bodyHash: pendingRequest.bodyHash
          }));
        }
      }
      return { manifest: loadManifest(ws), validation: validateWorkspaceManifest(ws) };
    });
  });

  app.post<{ Params: { projectId: string }; Body: any }>('/api/projects/:projectId/manifest/operations', async (req, reply) => {
    try {
      const body = req.body as any;
      if (body?.type === 'voice_patch') return reply.code(400).send({ error: 'voice_patch must be created through /manifest/voice-patches' });
      return await ctx.withProjectManifestMutex(req.params.projectId, async () => {
        const ws = workspace(req.params.projectId);
        const operation = addManifestOperation(ws, { ...body, status: 'approved' });
        return { operation, manifest: loadManifest(ws), validation: validateWorkspaceManifest(ws) };
      });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch<{ Params: { projectId: string; operationId: string }; Body: { status?: 'proposed' | 'awaiting_approval' | 'approved' | 'rejected' | 'disabled'; start?: number; end?: number; reason?: string; text?: string; draftText?: string } }>('/api/projects/:projectId/manifest/operations/:operationId', async (req) => {
    return await ctx.withProjectManifestMutex(req.params.projectId, async () => {
      const ws = workspace(req.params.projectId);
      const patch = { ...(req.body.status ? { status: req.body.status } : {}), ...(req.body.start != null ? { start: req.body.start } : {}), ...(req.body.end != null ? { end: req.body.end } : {}), ...(req.body.reason != null ? { reason: req.body.reason } : {}), ...(req.body.text != null ? { text: req.body.text } : {}), ...(req.body.draftText != null ? { draftText: req.body.draftText } : {}) };
      const existing = loadManifest(ws).operations.find((op: any) => op.id === req.params.operationId);
      const pendingRequest = req.body.status === 'rejected' && existing?.type === 'voice_patch' && existing.providerRequestId
        ? latestProviderRequest(ws, existing.providerRequestId)
        : null;
      const operation = updateManifestOperation(ws, req.params.operationId, patch);
      if (existing?.type === 'voice_patch' && pendingRequest?.status === 'pending') {
        appendProviderRequestEvent(ws, baseProviderEvent({
          ...providerExecutionShape(pendingRequest),
          requestId: pendingRequest.requestId,
          projectId: req.params.projectId,
          provider: pendingRequest.provider,
          voice: pendingRequest.voice,
          language: pendingRequest.language,
          text: operation.text,
          operationId: operation.id,
          status: 'rejected',
          completedAt: new Date().toISOString(),
          start: operation.target.start,
          end: operation.target.end,
          bodyHash: pendingRequest.bodyHash
        }));
      }
      return { operation, manifest: loadManifest(ws), validation: validateWorkspaceManifest(ws) };
    });
  });

  app.delete<{ Params: { projectId: string; operationId: string }; Body: { reason?: string } }>('/api/projects/:projectId/manifest/operations/:operationId', async (req) => {
    return await ctx.withProjectManifestMutex(req.params.projectId, async () => {
      const ws = workspace(req.params.projectId);
      return { operation: updateManifestOperation(ws, req.params.operationId, { status: 'disabled', reason: req.body?.reason || 'Removed from web UI' }), manifest: loadManifest(ws), validation: validateWorkspaceManifest(ws) };
    });
  });

  app.post<{ Params: { projectId: string }; Body: { mode?: 'clone-chain' | 'legacy-tts'; clipId?: string; start: number; end: number; text?: string; provider?: string; voice?: string; model?: string; voiceRef?: { providerId: string; voiceId: string }; language?: string; reason?: string; requestId?: string; granularity?: 'word' | 'phrase' | 'sentence'; cloneScope?: 'local' | 'project'; referenceRange?: { clipId: string; start: number; end: number } } }>('/api/projects/:projectId/manifest/voice-patches', async (req, reply) => {
    // D9/⟨R6⟩: an OMITTED mode is legacy-tts, so every existing caller — the studio's old path,
    // the CLI, and the agent WS tool — is untouched. Studio sends 'clone-chain' explicitly.
    const mode = (req.body as any)?.mode ?? 'legacy-tts';
    if (mode !== 'legacy-tts' && mode !== 'clone-chain') return reply.code(400).send({ error: `Unsupported mode: ${String(mode)}`, errorCode: 'invalid-mode' });
    if (mode === 'clone-chain') return handleCloneChain(req, reply);
    // `|| 'mock'` would swallow `false`/`0` as "not specified" — they are malformed values, and
    // must reach assertSpeechProviderSupported so the request is answered as the 400 it is.
    // Only a genuinely absent provider defaults.
    const provider = isAbsentProviderId(req.body.provider) ? 'mock' : req.body.provider;
    try { assertSpeechProviderSupported(provider); } catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : `Unsupported speech provider: ${String(req.body.provider)}` }); }
    // LEDGER attribution must be the CANONICAL provider id, the same one the execution layer
    // writes (tts.ts normalizeProviderId → e.g. 'xai' becomes 'tts.xai'). The request body carries
    // the shorthand, and writing that verbatim split one request's lifecycle across two provider
    // names: the cost-bearing rows landed under 'tts.xai' while the phase-one row said 'xai', so
    // a cap on 'tts.xai' never saw the group. `provider` itself stays shorthand — synthesis
    // resolves it — only what we attribute spend to is canonicalized.
    //
    // Computed AFTER validation, via the same core primitive the execution layer uses
    // (canonicalProviderId): a malformed body value — including an array, which the old
    // `.includes('.')` expression silently coerced — is rejected by assertSpeechProviderSupported
    // above as a 400 rather than crashing here into a 500.
    const ledgerProvider = canonicalProviderId('tts', provider)!;
    if (!Number.isFinite(req.body.start) || !Number.isFinite(req.body.end) || req.body.start >= req.body.end) return reply.code(400).send({ error: 'Voice patch start/end must be finite and start < end' });
    if (typeof req.body.text !== 'string' || !req.body.text.trim()) return reply.code(400).send({ error: 'Replacement text is required' });
    const text = req.body.text.trim();
    const voice = req.body.voice || 'eve';
    const language = req.body.language || 'en';
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(voice)) return reply.code(400).send({ error: 'Invalid voice id' });
    if (!/^[a-zA-Z-]{2,16}$/.test(language)) return reply.code(400).send({ error: 'Invalid language code' });
    const parsedVoiceRef = req.body.voiceRef == null ? null : VoiceReferenceSchema.safeParse(req.body.voiceRef);
    if (parsedVoiceRef && !parsedVoiceRef.success) return reply.code(400).send({ error: `Invalid voiceRef: ${parsedVoiceRef.error.issues.map((issue) => issue.message).join('; ')}` });
    const voiceRef = parsedVoiceRef?.success ? parsedVoiceRef.data : { providerId: ledgerProvider, voiceId: voice };
    const requestId = req.body.requestId || crypto.randomUUID();
    if (!ProviderRequestIdSchema.safeParse(requestId).success) return reply.code(400).send({ error: 'Invalid requestId' });
    // W6: intake validation for the three intent fields.
    const granularity: SnapMode = (req.body.granularity as SnapMode) ?? 'phrase';
    if (!['word', 'phrase', 'sentence'].includes(granularity)) return reply.code(400).send({ error: 'Invalid granularity' });
    const cloneScope = req.body.cloneScope;
    if (cloneScope != null && cloneScope !== 'local' && cloneScope !== 'project') return reply.code(400).send({ error: 'Invalid cloneScope' });
    const refRangeParsed = req.body.referenceRange == null ? null : VoicePatchReferenceRangeSchema.safeParse(req.body.referenceRange);
    if (refRangeParsed && !refRangeParsed.success) return reply.code(400).send({ error: `Invalid referenceRange: ${refRangeParsed.error.issues.map((i) => i.message).join('; ')}` });
    const referenceRange = refRangeParsed?.success ? refRangeParsed.data : undefined;
    // P4-1c: dedup concurrent same-requestId POSTs onto one paid synthesis, and release the
    // project manifest mutex during the synthesis call so the project isn't locked for the
    // duration of a paid TTS round-trip. Phases:
    //   Phase 1 (locked): idempotency check, clip + preview validation, create the proposed
    //                     operation, append 'approved' provider event.
    //   Phase 2 (unlocked): synthesizeReplacementSpeech + ffprobe of the resulting asset.
    //                       The provider engine writes 'started'/'succeeded'/'failed' events
    //                       to the ledger from here; that's an append-only path that doesn't
    //                       need the manifest mutex.
    //   Phase 3 (locked): reload the op, verify it is still 'proposed' with our requestId
    //                     (the user could have PATCHed/DELETEd it during Phase 2), then
    //                     update to 'approved' with the asset. If the op has been modified
    //                     externally, the synthesis asset is left on disk and a conflict
    //                     ledger event is appended.
    const ws = workspace(req.params.projectId);
    // bodyHash is part of the dedup key so concurrent SAME-requestId DIFFERENT-body POSTs each
    // run their own Phase 1; the second one will surface the 409 from the body-hash check
    // instead of joining the first promise and returning the first's 200. The 'vp:' prefix
    // keeps the namespace separate from the generation route.
    const model = typeof req.body.model === 'string' && req.body.model.trim() ? req.body.model.trim() : undefined;
    // FIX 1b: include intent fields in the hash so different intent → different hash,
    // and a retry after a phrase-widening snap compares to the same hash stored at Phase 1.
    const incomingBodyHash = providerBodyHash({ text, start: req.body.start, end: req.body.end, provider, voice, language, model, granularity, ...(cloneScope ? { cloneScope } : {}), ...(referenceRange ? { referenceRange } : {}) });
    const result = await ctx.withInFlightProviderCall(`vp:${req.params.projectId}:${requestId}:${incomingBodyHash}`, async () => {
      const phase1 = await ctx.withProjectManifestMutex(req.params.projectId, async () => {
        // STRICT: this is the pre-call replay gate for a PAID synthesis. A skipped row here reads
        // as "no prior request" and re-executes the provider. Legacy rows are migrated by the
        // strict union rather than dropped, so old workspaces keep replaying correctly.
        const existingRequest = latestProviderRequest(ws, requestId, { strict: true });
        if (existingRequest) {
          if (providerRequestBodyHashStrict(ws, requestId) !== incomingBodyHash) return { kind: 'early' as const, code: 409, body: { error: 'requestId already exists with a different voice patch body' } };
          const manifest = loadManifest(ws);
          const operation = manifest.operations.find((op: any) => op.id === existingRequest.operationId);
          return { kind: 'early' as const, code: 200, body: { providerRequestId: requestId, request: existingRequest, operation, manifest, validation: validateWorkspaceManifest(ws) } };
        }
        const current = loadManifest(ws);
        const project = loadProject(ws);
        const clipId = req.body.clipId ?? current.tracks.flatMap((track: any) => track.clips).at(0)?.clipId ?? project.clipSources[0]?.clipId;
        if (!clipId) return { kind: 'early' as const, code: 400, body: { error: 'Voice patch preview requires at least one timeline clip' } };
        // W6: snap the raw selection to word/phrase/sentence boundaries.
        // FIX 5: snapSelection now returns BOTH axes.
        //   opStart/opEnd   — clip-local → used for op.target, clipTarget(), provider events, body-match guard.
        //   assetStart/assetEnd — asset-axis → used for extractSurroundingTranscriptText (word timestamps are asset-axis).
        const snap = snapSelection(ws, clipId, req.body.start, req.body.end, granularity, current);
        if (snap.outOfRange) return { kind: 'early' as const, code: 400, body: { error: 'Voice patch selection is outside the clip range' } };
        const { opStart: snapStart, opEnd: snapEnd, assetStart: snapAssetStart, assetEnd: snapAssetEnd } = snap;
        // clip-local coords for op.target.
        const preview = { type: 'voice_patch' as const, status: 'proposed' as const, target: clipTarget(current, clipId, snapStart, snapEnd), text, voiceRef, providerRequestId: requestId, id: '__preview__', proposedBy: 'user' as const, createdBy: 'user' as const, createdAt: new Date().toISOString() };
        const previewValidation = validateManifestDocument({ ...current, operations: [...current.operations, preview], updatedAt: new Date().toISOString() });
        if (!previewValidation.valid) return { kind: 'early' as const, code: 400, body: { error: `Voice patch rejected:\n${previewValidation.errors.join('\n')}` } };
        const operation = addVoicePatchOperation(ws, { clipId, start: snapStart, end: snapEnd, text, voiceRef, status: 'proposed', providerRequestId: requestId, granularity, ...(cloneScope ? { cloneScope } : {}), ...(referenceRange ? { referenceRange } : {}), reason: req.body.reason || `Replacement speech via ${provider}/${voice}` });
        // FIX 1c: store incomingBodyHash so a retry compares against the same hash written here.
        appendProviderRequestEvent(ws, baseProviderEvent({ requestId, projectId: req.params.projectId, provider: ledgerProvider, voice, language, text, operationId: operation.id, status: 'approved', start: snapStart, end: snapEnd, bodyHash: incomingBodyHash }));
        return { kind: 'continue' as const, operation, snapAssetStart, snapAssetEnd };
      });
      if (phase1.kind === 'early') return { kind: 'early' as const, code: phase1.code, body: phase1.body };
      const operation = phase1.operation;
      // FIX 5: asset-axis coords from Phase 1 for transcript lookups (word timestamps are asset-axis).
      const phaseAssetStart: number = phase1.snapAssetStart;
      const phaseAssetEnd: number = phase1.snapAssetEnd;
      try {
        const transcriptWords = loadTranscript(ws)?.words ?? [];
        const opTarget = (operation as any).target;
        // FIX 5: use asset-axis coords for extractSurroundingTranscriptText (word timestamps are asset-axis).
        // For sourceStart===0 this equals opTarget.start/end — provable no-op vs before.
        const { previousText, nextText } = extractSurroundingTranscriptText(transcriptWords, opTarget?.clipId ?? '', phaseAssetStart, phaseAssetEnd);
        const speech = await synthesizeReplacementSpeech(ws, { text, provider, voice, language, requestId, projectId: req.params.projectId, operationId: operation.id, ...(model ? { model } : {}), ...(previousText ? { previousText } : {}), ...(nextText ? { nextText } : {}) });
        // OrZero: a pure-silence payload silence-trims to a zero-sample WAV whose duration
        // ffprobe can't read — that's the degraded-payload band below, not a 500.
        const generated = ffprobeDurationSecOrZero(assertInside(ws, speech.asset));
        const requested = opTarget ? (opTarget.end - opTarget.start) : (req.body.end - req.body.start);
        const durationWarning = voicePatchDurationWarning(generated, requested);
        // TTS sometimes returns HTTP 200 with degraded/empty audio (observed with
        // ElevenLabs returning ~50 ms of silence for a 320 ms request). The asset
        // exists and ffprobes cleanly, but it isn't real speech. Reject these so
        // the user isn't left with an approved op that plays as a silent gap.
        // Threshold: hard 100 ms floor. Below this is the artifact band — real TTS
        // for any single word ("a", "uh", "no") clears it even at fast speaking
        // rates. A relative-to-slot threshold would false-positive on legitimately
        // short replacements in long slots, so we stick with the absolute floor.
        const tooShort = generated < 0.1;
        return await ctx.withProjectManifestMutex(req.params.projectId, async () => {
          const request = latestProviderRequest(ws, requestId)!;
          // P4-1c: the mutex was released during Phase 2, so the user may have PATCHed the op
          // (status to rejected/disabled, text, start/end) or DELETEd it. Don't approve a
          // synthesis that doesn't match the op the user is now seeing. Status + providerRequestId
          // alone are not enough — a PATCH to text or target keeps both unchanged but invalidates
          // the audio. Compare the full body against the op we synthesized for.
          const currentOp = loadManifest(ws).operations.find((op: any) => op.id === operation.id);
          // Body-match uses snapped values (snapStart/snapEnd = op.target.start/end for phase-1 ops).
          const bodyMatches = currentOp
            && currentOp.status === 'proposed'
            && currentOp.providerRequestId === requestId
            && currentOp.text === text
            && currentOp.target?.start === opTarget?.start
            && currentOp.target?.end === opTarget?.end;
          if (!bodyMatches) {
            // Use the engine-normalized provider id from the latest provider request row
            // (e.g. 'tts.xai') instead of the route's shorthand (e.g. 'xai'), so the
            // summarizeProviderRequests row attributes this conflict-tagged cost to the
            // same provider that the preceding 'succeeded' row was billed against.
            const conflictReason = `Voice patch operation no longer accepts the synthesis (current status: ${currentOp?.status ?? 'missing'}); asset orphaned at ${speech.asset}`;
            const conflict = appendProviderRequestEvent(ws, baseProviderEvent({ requestId, projectId: req.params.projectId, provider: request.provider, voice, language, text, operationId: operation.id, status: 'op_update_failed', completedAt: new Date().toISOString(), error: conflictReason, durationGeneratedSec: generated, durationRequestedSec: requested, durationWarning, start: opTarget?.start ?? 0, end: opTarget?.end ?? 0, ...providerExecutionShape(request) }));
            return { kind: 'early' as const, code: 409, body: { providerRequestId: requestId, request: conflict, error: conflictReason } };
          }
          if (tooShort) {
            const reason = `TTS returned implausibly short audio (${(generated * 1000).toFixed(0)} ms for a ${(requested * 1000).toFixed(0)} ms slot). The asset was not approved; you can retry.`;
            updateManifestOperation(ws, operation.id, { status: 'rejected', reason });
            const failed = appendProviderRequestEvent(ws, baseProviderEvent({ requestId, projectId: req.params.projectId, provider: request.provider, voice, language, text, operationId: operation.id, status: 'op_update_failed', completedAt: new Date().toISOString(), error: reason, durationGeneratedSec: generated, durationRequestedSec: requested, durationWarning, start: opTarget?.start ?? 0, end: opTarget?.end ?? 0, ...providerExecutionShape(request) }));
            return { kind: 'early' as const, code: 502, body: { providerRequestId: requestId, request: failed, error: reason } };
          }
          let updated;
          try { updated = updateManifestOperation(ws, operation.id, { status: 'approved', asset: speech.asset, providerRequestId: requestId, durationGeneratedSec: generated, durationRequestedSec: requested, ...(durationWarning ? { durationWarning } : {}), ...(speech.seamBaked ? { seamBaked: true } : {}) }); }
          catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // The approve failed (typically a validate-overlap error introduced while
            // synthesis was in-flight, e.g., the user cut the same range). The op is
            // still our proposed op — flip it to rejected so it doesn't strand as
            // 'proposed' forever and accumulate as visual cruft in the manifest.
            try { updateManifestOperation(ws, operation.id, { status: 'rejected', reason: message }); }
            catch { /* ignore — the rejection update can fail if the op was concurrently mutated; the ledger event below is still the truth */ }
            const failedUpdate = appendProviderRequestEvent(ws, baseProviderEvent({ requestId, projectId: req.params.projectId, provider: ledgerProvider, voice, language, text, operationId: operation.id, status: 'op_update_failed', completedAt: new Date().toISOString(), error: message, durationGeneratedSec: generated, durationRequestedSec: requested, durationWarning, start: opTarget?.start ?? 0, end: opTarget?.end ?? 0, ...providerExecutionShape(request) }));
            return { kind: 'early' as const, code: 500, body: { providerRequestId: requestId, request: failedUpdate, error: failedUpdate.error } };
          }
          return { kind: 'ok' as const, body: { providerRequestId: requestId, request, operation: updated, speech: { asset: speech.asset, provider: speech.provider, voice: speech.voice }, manifest: loadManifest(ws), validation: validateWorkspaceManifest(ws) } };
        });
      } catch (err) {
        await ctx.withProjectManifestMutex(req.params.projectId, async () => {
          // P4-1c: same body-match guard the success path uses. Only set the op to 'rejected'
          // if it is still the proposed op we synthesized for — same status, providerRequestId,
          // text, and target. If the user edited any of those mid-flight (changed text,
          // adjusted start/end, or moved status to rejected/disabled), preserve their state;
          // the rejected reason from this old request would be stale.
          const currentOp = loadManifest(ws).operations.find((op: any) => op.id === operation.id);
          // Use operation.target directly — opTarget is a Phase-2-only alias for the same values.
          const catchTarget = (operation as any).target;
          const bodyMatches = currentOp
            && currentOp.status === 'proposed'
            && currentOp.providerRequestId === requestId
            && currentOp.text === text
            && currentOp.target?.start === catchTarget?.start
            && currentOp.target?.end === catchTarget?.end;
          if (bodyMatches) {
            updateManifestOperation(ws, operation.id, { status: 'rejected', reason: err instanceof Error ? err.message : String(err) });
          }
        });
        throw err;
      }
    });
    if (result.kind === 'early') return reply.code(result.code).send(result.body);
    return result.body;
  });


  // S2S Phase 1/2/3: read audio from multipart, then follow the same mutex pattern as voice-patches.
  // Audio is read before Phase 1 so we never do I/O inside the manifest lock.
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/manifest/voice-patches/speech-to-speech', async (req, reply) => {
    let audioBuf: Buffer | null = null;
    const fields: Record<string, string> = {};
    for await (const part of (req as any).parts({ limits: { files: 1, fileSize: 50 * 1024 * 1024 } })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'audio' || audioBuf) { part.file.resume?.(); continue; }
        audioBuf = await readMultipartBuffer(part);
      } else {
        fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value ?? '');
      }
    }
    if (!audioBuf || audioBuf.byteLength === 0) return reply.code(400).send({ error: 'audio field is required' });
    const start = parseFloat(fields.start ?? '');
    const end = parseFloat(fields.end ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return reply.code(400).send({ error: 'start/end must be finite and start < end' });
    const voiceId = (fields.voiceId ?? '').trim();
    if (!voiceId || !/^[a-zA-Z0-9_-]{1,128}$/.test(voiceId)) return reply.code(400).send({ error: 'voiceId is required and must be a valid ElevenLabs voice ID' });
    const model = (fields.model ?? '').trim() || undefined;
    const requestId = (fields.requestId ?? '').trim() || crypto.randomUUID();
    if (!ProviderRequestIdSchema.safeParse(requestId).success) return reply.code(400).send({ error: 'Invalid requestId' });
    // W6: intake validation for the three intent fields (from multipart string fields).
    const s2sGranularity: SnapMode = (fields.granularity as SnapMode) || 'phrase';
    if (!['word', 'phrase', 'sentence'].includes(s2sGranularity)) return reply.code(400).send({ error: 'Invalid granularity' });
    // FIX 2: 400 on invalid cloneScope (non-empty, not 'local'|'project'); absent/empty → undefined.
    if (fields.cloneScope && fields.cloneScope !== 'local' && fields.cloneScope !== 'project') {
      return reply.code(400).send({ error: 'Invalid cloneScope' });
    }
    const s2sCloneScope = fields.cloneScope === 'local' || fields.cloneScope === 'project' ? (fields.cloneScope as 'local' | 'project') : undefined;
    let s2sReferenceRange: { clipId: string; start: number; end: number } | undefined;
    if (fields.referenceRange) {
      let parsedJson: unknown;
      try { parsedJson = JSON.parse(fields.referenceRange); } catch { return reply.code(400).send({ error: 'Invalid referenceRange JSON' }); }
      const r = VoicePatchReferenceRangeSchema.safeParse(parsedJson);
      if (!r.success) return reply.code(400).send({ error: `Invalid referenceRange: ${r.error.issues.map((i) => i.message).join('; ')}` });
      s2sReferenceRange = r.data;
    }

    const ws = workspace(req.params.projectId);
    // FIX 1d(b): include S2S intent fields so different intent → different hash.
    const incomingBodyHash = providerBodyHash({ text: 's2s', start, end, provider: 'tts.elevenlabs', voice: voiceId, language: 'en', ...(model ? { model } : {}), granularity: s2sGranularity, ...(s2sCloneScope ? { cloneScope: s2sCloneScope } : {}), ...(s2sReferenceRange ? { referenceRange: s2sReferenceRange } : {}) });

    const result = await ctx.withInFlightProviderCall(`s2s:${req.params.projectId}:${requestId}:${incomingBodyHash}`, async () => {
      const phase1 = await ctx.withProjectManifestMutex(req.params.projectId, async () => {
        // STRICT for the same reason as the text-to-speech route above: this decides whether a
        // paid speech-to-speech call runs again.
        const existingRequest = latestProviderRequest(ws, requestId, { strict: true });
        if (existingRequest) {
          if (providerRequestBodyHashStrict(ws, requestId) !== incomingBodyHash) return { kind: 'early' as const, code: 409, body: { error: 'requestId already exists with a different speech-to-speech body' } };
          const manifest = loadManifest(ws);
          const operation = manifest.operations.find((op: any) => op.id === existingRequest.operationId);
          return { kind: 'early' as const, code: 200, body: { providerRequestId: requestId, request: existingRequest, operation, manifest, validation: validateWorkspaceManifest(ws) } };
        }
        const current = loadManifest(ws);
        const project = loadProject(ws);
        const clipId = (fields.clipId ?? '').trim() || (current.tracks.flatMap((track: any) => track.clips).at(0)?.clipId ?? project.clipSources[0]?.clipId);
        if (!clipId) return { kind: 'early' as const, code: 400, body: { error: 'Speech-to-speech requires at least one timeline clip' } };
        // W6/FIX 5: snap to word/phrase/sentence boundaries; get both axes.
        //   opStart/opEnd   — clip-local → op.target, clipTarget(), body-match guard.
        //   assetStart/assetEnd — asset-axis → word filter (word timestamps are asset-axis).
        const s2sSnap = snapSelection(ws, clipId, start, end, s2sGranularity, current);
        if (s2sSnap.outOfRange) return { kind: 'early' as const, code: 400, body: { error: 'Speech-to-speech selection is outside the clip range' } };
        const { opStart: s2sSnapStart, opEnd: s2sSnapEnd, assetStart: s2sAssetStart, assetEnd: s2sAssetEnd } = s2sSnap;
        const words = loadTranscript(ws)?.words ?? [];
        // FIX 5: word filter uses asset-axis snapped values so the transcript lookup is correct
        // for trimmed clips. For sourceStart===0 this equals clip-local — no-op vs before.
        const inRange = (words as any[]).filter((w) => typeof w.start === 'number' && typeof w.end === 'number' && w.start < s2sAssetEnd && w.end > s2sAssetStart);
        const text = inRange.map((w) => w.word ?? w.text ?? '').join(' ').trim() || '[re-recorded]';
        const voiceRef = { providerId: 'tts.elevenlabs', voiceId };
        // clip-local coords for op.target.
        const preview = { type: 'voice_patch' as const, status: 'proposed' as const, target: clipTarget(current, clipId, s2sSnapStart, s2sSnapEnd), text, voiceRef, providerRequestId: requestId, id: '__preview__', proposedBy: 'user' as const, createdBy: 'user' as const, createdAt: new Date().toISOString() };
        const previewValidation = validateManifestDocument({ ...current, operations: [...current.operations, preview], updatedAt: new Date().toISOString() });
        if (!previewValidation.valid) return { kind: 'early' as const, code: 400, body: { error: `Speech-to-speech rejected:\n${previewValidation.errors.join('\n')}` } };
        const operation = addVoicePatchOperation(ws, { clipId, start: s2sSnapStart, end: s2sSnapEnd, text, voiceRef, status: 'proposed', providerRequestId: requestId, granularity: s2sGranularity, ...(s2sCloneScope ? { cloneScope: s2sCloneScope } : {}), ...(s2sReferenceRange ? { referenceRange: s2sReferenceRange } : {}), reason: `Speech-to-speech re-record via ElevenLabs/${voiceId}` });
        // FIX 1d(c): store incomingBodyHash so a retry compares against the same hash written here.
        appendProviderRequestEvent(ws, baseProviderEvent({ requestId, projectId: req.params.projectId, provider: 'tts.elevenlabs', voice: voiceId, language: 'en', text, operationId: operation.id, status: 'approved', start: s2sSnapStart, end: s2sSnapEnd, bodyHash: incomingBodyHash }));
        return { kind: 'continue' as const, operation, text };
      });
      if (phase1.kind === 'early') return { kind: 'early' as const, code: phase1.code, body: phase1.body };
      const { operation, text } = phase1;
      try {
        const settingsPaths = { homeDir: ctx.config.settingsHome };
        const secret = readSecrets(settingsPaths).secrets.elevenlabs;
        if (!secret) {
          await ctx.withProjectManifestMutex(req.params.projectId, async () => {
            const cur = loadManifest(ws).operations.find((op: any) => op.id === operation.id);
            if (cur?.status === 'proposed' && cur.providerRequestId === requestId) updateManifestOperation(ws, operation.id, { status: 'rejected', reason: 'No ElevenLabs API key configured' });
          });
          return { kind: 'early' as const, code: 400, body: { error: 'No ElevenLabs API key configured for speech-to-speech' } };
        }
        const s2sResult = await speechToSpeechElevenlabs({ audio: audioBuf!, voiceId, ...(model ? { model } : {}), secret, signal: new AbortController().signal });
        const assetRel = `assets/voice/s2s-${requestId}.wav`;
        const assetAbs = assertInside(ws, assetRel);
        mkdirSync(dirname(assetAbs), { recursive: true });
        writeFileSync(assetAbs, s2sResult.audio);
        // OrZero: an unreadable/empty result lands in the tooShort band below (degraded payload, not a 500).
        const generated = ffprobeDurationSecOrZero(assetAbs);
        // Use the snapped op.target span — operation.target carries the snapped values from Phase 1.
        const s2sOpTarget = (operation as any).target;
        const s2sTargetStart: number = s2sOpTarget?.start ?? start;
        const s2sTargetEnd: number = s2sOpTarget?.end ?? end;
        const requested = s2sTargetEnd - s2sTargetStart;
        const durationWarning = voicePatchDurationWarning(generated, requested);
        // Same hard 100 ms floor as the text-to-speech route. Speech-to-speech
        // is more likely to produce short outputs (the user's recording might be
        // brief), so we only catch the artifact band, not legitimately brief takes.
        const tooShort = generated < 0.1;
        return await ctx.withProjectManifestMutex(req.params.projectId, async () => {
          const request = latestProviderRequest(ws, requestId)!;
          const currentOp = loadManifest(ws).operations.find((op: any) => op.id === operation.id);
          // Body-match uses snapped values (operation.target.start/end = snapped clip-local coords from Phase 1).
          const bodyMatches = currentOp && currentOp.status === 'proposed' && currentOp.providerRequestId === requestId && currentOp.text === text && currentOp.target?.start === s2sTargetStart && currentOp.target?.end === s2sTargetEnd;
          if (!bodyMatches) {
            const conflictReason = `S2S operation no longer accepts the synthesis (current status: ${currentOp?.status ?? 'missing'}); asset orphaned at ${assetRel}`;
            const conflict = appendProviderRequestEvent(ws, baseProviderEvent({ requestId, projectId: req.params.projectId, provider: 'tts.elevenlabs', voice: voiceId, language: 'en', text, operationId: operation.id, status: 'op_update_failed', completedAt: new Date().toISOString(), error: conflictReason, durationGeneratedSec: generated, durationRequestedSec: requested, durationWarning, start: s2sTargetStart, end: s2sTargetEnd, ...providerExecutionShape(request) }));
            return { kind: 'early' as const, code: 409, body: { providerRequestId: requestId, request: conflict, error: conflictReason } };
          }
          if (tooShort) {
            const reason = `Speech-to-speech returned implausibly short audio (${(generated * 1000).toFixed(0)} ms for a ${(requested * 1000).toFixed(0)} ms slot). The asset was not approved; you can retry.`;
            updateManifestOperation(ws, operation.id, { status: 'rejected', reason });
            const failed = appendProviderRequestEvent(ws, baseProviderEvent({ requestId, projectId: req.params.projectId, provider: 'tts.elevenlabs', voice: voiceId, language: 'en', text, operationId: operation.id, status: 'op_update_failed', completedAt: new Date().toISOString(), error: reason, durationGeneratedSec: generated, durationRequestedSec: requested, durationWarning, start: s2sTargetStart, end: s2sTargetEnd, ...providerExecutionShape(request) }));
            return { kind: 'early' as const, code: 502, body: { providerRequestId: requestId, request: failed, error: reason } };
          }
          let updated;
          try { updated = updateManifestOperation(ws, operation.id, { status: 'approved', asset: assetRel, providerRequestId: requestId, durationGeneratedSec: generated, durationRequestedSec: requested, ...(durationWarning ? { durationWarning } : {}) }); }
          catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            try { updateManifestOperation(ws, operation.id, { status: 'rejected', reason: message }); }
            catch { /* see voice-patches route — concurrent mutation can race the rollback; ledger row is the truth */ }
            const failedUpdate = appendProviderRequestEvent(ws, baseProviderEvent({ requestId, projectId: req.params.projectId, provider: 'tts.elevenlabs', voice: voiceId, language: 'en', text, operationId: operation.id, status: 'op_update_failed', completedAt: new Date().toISOString(), error: message, durationGeneratedSec: generated, durationRequestedSec: requested, durationWarning, start: s2sTargetStart, end: s2sTargetEnd, ...providerExecutionShape(request) }));
            return { kind: 'early' as const, code: 500, body: { providerRequestId: requestId, request: failedUpdate, error: failedUpdate.error } };
          }
          return { kind: 'ok' as const, body: { providerRequestId: requestId, request, operation: updated, speech: { asset: assetRel, provider: 'tts.elevenlabs', voice: voiceId }, manifest: loadManifest(ws), validation: validateWorkspaceManifest(ws) } };
        });
      } catch (err) {
        await ctx.withProjectManifestMutex(req.params.projectId, async () => {
          const currentOp = loadManifest(ws).operations.find((op: any) => op.id === operation.id);
          // Use operation.target.start/end (snapped clip-local coords from Phase 1).
          const errTargetStart = (operation as any).target?.start ?? start;
          const errTargetEnd = (operation as any).target?.end ?? end;
          const bodyMatches = currentOp && currentOp.status === 'proposed' && currentOp.providerRequestId === requestId && currentOp.text === text && currentOp.target?.start === errTargetStart && currentOp.target?.end === errTargetEnd;
          if (bodyMatches) updateManifestOperation(ws, operation.id, { status: 'rejected', reason: err instanceof Error ? err.message : String(err) });
        });
        throw err;
      }
    });
    if (result.kind === 'early') return reply.code(result.code).send(result.body);
    return result.body;
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/provider-requests', async (req) => {
    const ws = workspace(req.params.projectId);
    return { providerRequests: readProviderRequests(ws), costSummary: summarizeProviderRequestsForWorkspace(ws) };
  });

  // Exposed for the server's awaited startup hook (which owns taking the project mutex).
  return { recoverProjectCommitMarkers };
}
