import { appendProviderRequestEvent, assertInside, assertSpeechProviderSupported, extractSurroundingTranscriptText, ffprobeDurationSecOrZero, latestProviderRequest, loadProject, loadTranscript, ProviderRequestIdSchema, readProviderRequests, readSecrets, summarizeProviderRequestsForWorkspace, synthesizeReplacementSpeech, VoiceReferenceSchema, snapSpanToBoundaries, VoicePatchReferenceRangeSchema, type SnapMode } from '@etvideoscript/core';
import { speechToSpeechElevenlabs } from '@etvideoscript/core/providers/tts/elevenlabs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LocalApiRouteContext } from './routeContext';

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

export function registerManifestRoutes(ctx: LocalApiRouteContext) {
  const { app, workspace, loadManifest, validateWorkspaceManifest, validateManifestDocument, addManifestOperation, addVoicePatchOperation, updateManifestOperation, clipTarget, providerBodyHash, baseProviderEvent, providerExecutionShape, voicePatchDurationWarning } = ctx;

  function providerRequestBodyHash(ws: string, requestId: string): string | undefined {
    return readProviderRequests(ws).find((event: any) => event.requestId === requestId && typeof event.bodyHash === 'string')?.bodyHash;
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

  app.post<{ Params: { projectId: string }; Body: { clipId?: string; start: number; end: number; text?: string; provider?: string; voice?: string; model?: string; voiceRef?: { providerId: string; voiceId: string }; language?: string; reason?: string; requestId?: string; granularity?: 'word' | 'phrase' | 'sentence'; cloneScope?: 'local' | 'project'; referenceRange?: { clipId: string; start: number; end: number } } }>('/api/projects/:projectId/manifest/voice-patches', async (req, reply) => {
    const provider = req.body.provider || 'mock';
    try { assertSpeechProviderSupported(provider); } catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : `Unsupported speech provider: ${String(req.body.provider)}` }); }
    if (!Number.isFinite(req.body.start) || !Number.isFinite(req.body.end) || req.body.start >= req.body.end) return reply.code(400).send({ error: 'Voice patch start/end must be finite and start < end' });
    if (typeof req.body.text !== 'string' || !req.body.text.trim()) return reply.code(400).send({ error: 'Replacement text is required' });
    const text = req.body.text.trim();
    const voice = req.body.voice || 'eve';
    const language = req.body.language || 'en';
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(voice)) return reply.code(400).send({ error: 'Invalid voice id' });
    if (!/^[a-zA-Z-]{2,16}$/.test(language)) return reply.code(400).send({ error: 'Invalid language code' });
    const parsedVoiceRef = req.body.voiceRef == null ? null : VoiceReferenceSchema.safeParse(req.body.voiceRef);
    if (parsedVoiceRef && !parsedVoiceRef.success) return reply.code(400).send({ error: `Invalid voiceRef: ${parsedVoiceRef.error.issues.map((issue) => issue.message).join('; ')}` });
    const voiceRef = parsedVoiceRef?.success ? parsedVoiceRef.data : { providerId: provider.includes('.') ? provider : `tts.${provider}`, voiceId: voice };
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
        const existingRequest = latestProviderRequest(ws, requestId);
        if (existingRequest) {
          if (providerRequestBodyHash(ws, requestId) !== incomingBodyHash) return { kind: 'early' as const, code: 409, body: { error: 'requestId already exists with a different voice patch body' } };
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
        appendProviderRequestEvent(ws, baseProviderEvent({ requestId, projectId: req.params.projectId, provider, voice, language, text, operationId: operation.id, status: 'approved', start: snapStart, end: snapEnd, bodyHash: incomingBodyHash }));
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
            const failedUpdate = appendProviderRequestEvent(ws, baseProviderEvent({ requestId, projectId: req.params.projectId, provider, voice, language, text, operationId: operation.id, status: 'op_update_failed', completedAt: new Date().toISOString(), error: message, durationGeneratedSec: generated, durationRequestedSec: requested, durationWarning, start: opTarget?.start ?? 0, end: opTarget?.end ?? 0, ...providerExecutionShape(request) }));
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
        const existingRequest = latestProviderRequest(ws, requestId);
        if (existingRequest) {
          if (providerRequestBodyHash(ws, requestId) !== incomingBodyHash) return { kind: 'early' as const, code: 409, body: { error: 'requestId already exists with a different speech-to-speech body' } };
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
}
