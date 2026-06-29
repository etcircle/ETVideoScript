import { z } from 'zod';
import { sortSegments } from '../timeMap/sort';
import type { TimeMapSegment } from '../timeMap/types';
import { outputRangeForClipSourceSpan } from '../timeMap/project';
import { VoiceReferenceSchema } from '../voiceReference';
import { ClipSpanTargetSchema, defineOperationSchema, type OperationKind } from './base';

const EPSILON = 1e-9;

function sourceAtOutput(segment: TimeMapSegment, outputTime: number): number {
  return segment.sourceStart + ((outputTime - segment.outputStart) * segment.rate);
}

function maybeFreeze(segment: TimeMapSegment, shouldFreeze: boolean, delta: number): TimeMapSegment {
  return shouldFreeze && delta > EPSILON ? { ...segment, freezeTailSec: delta } : segment;
}

export const DurationWarningSchema = z.object({
  generated: z.number().nonnegative(),
  requested: z.number().nonnegative(),
  deltaSec: z.number()
});

// W6: exported standalone so manifestRoutes can validate referenceRange from multipart/JSON body
// without importing the full VoicePatchOperationSchema. Shape is structurally identical to
// VoiceRecord.sourceAudioRange (providerSettings.ts:125-129) — keep in sync.
export const VoicePatchReferenceRangeSchema = z
  .object({
    clipId: z.string().min(1).max(128),
    start: z.number().nonnegative(),
    end: z.number().nonnegative()
  })
  .refine((r) => r.end > r.start, { message: 'referenceRange.end must be greater than start', path: ['end'] });

export const VoicePatchOperationSchema = defineOperationSchema('voice_patch', ClipSpanTargetSchema, {
  text: z.string().min(1),
  // The (providerId, voiceId) pair used to synthesize this patch — providerId is the registry
  // id (e.g. 'tts.xai' or 'tts.elevenlabs') and voiceId is the provider-native handle (a stock
  // voice name for xAI, a cloned voice ID for ElevenLabs). Persisting both makes the manifest
  // panel render per-voice and re-renders deterministic without ledger lookups. Named voiceRef
  // (not "voice") to avoid colliding with the agent/manifest transport layer which uses a bare
  // `voice: string` field; Lane F resolves the string to a voiceRef pair before saving.
  // Optional so manifests written before the field existed still parse.
  voiceRef: VoiceReferenceSchema.optional(),
  assetId: z.string().min(1).optional(),
  providerRequestId: z.string().nullable().optional(),
  durationGeneratedSec: z.number().nonnegative().optional(),
  durationRequestedSec: z.number().nonnegative().optional(),
  durationWarning: DurationWarningSchema.optional(),
  // W5 seam-bake: true once the asset has been re-mastered with measured-loudnorm +
  // room-tone bed + equal-power qsin crossfades baked into the WAV. Signals
  // renderContribution to emit crossfadeSec:0 so the pipeline does NOT apply its own
  // adaptive afade on top of the already-faded seam (double-fade = audible dip).
  // Optional + absent-default: legacy/un-baked approved ops behave exactly as today.
  seamBaked: z.boolean().optional(),
  // ── W6: op-level INTENT (forward-looking, captured at op-creation) ──────────────
  // Distinct from VoiceRecord.cloneScope / VoiceRecord.sourceAudioRange
  // (providerSettings.ts:124-129), which are the RESULT (what was actually cloned).
  // These say what the USER asked for; the record says what happened. All optional →
  // legacy manifests parse unchanged. W7 reads these straight into cloneCleanClip:
  //   cloneCleanClip(ws, { scope: op.cloneScope ?? 'local', referenceRange: op.referenceRange, target: op.target, ... })
  // and writes the resulting voiceId back onto op.voiceRef.

  // Snapping granularity the user chose for THIS edit (default 'phrase' applied at the route).
  granularity: z.enum(['word', 'phrase', 'sentence']).optional(),

  // 'local' = clone from clean speech near the edit (default); 'project' = stable project-wide clone.
  // Same literals as CloneCleanClipParams.scope (voiceClone.ts:72) and VoiceRecord.cloneScope.
  cloneScope: z.enum(['local', 'project']).optional(),

  // Explicit reference-audio override: "clone from exactly this span" (bypasses selectCleanClip).
  // Shape is IDENTICAL to VoiceRecord.sourceAudioRange (providerSettings.ts:125-129) so the same
  // object threads into cloneCleanClip({ referenceRange }) (voiceClone.ts:73) without reshaping.
  // Uses VoicePatchReferenceRangeSchema (defined above) so routes can reuse the same validator.
  referenceRange: VoicePatchReferenceRangeSchema.optional()
});

export type VoicePatchOperation = z.infer<typeof VoicePatchOperationSchema>;

export const voicePatchOperationKind: OperationKind<typeof VoicePatchOperationSchema> = {
  type: 'voice_patch',
  schema: VoicePatchOperationSchema,
  targetKind: 'clip-span',
  precedence: 10,
  conflictsWith: ['cut'] as const,
  affectsTimeline: true,
  validateLocal(op, ctx) {
    const duration = (ctx.clip?.sourceEnd ?? 0) - (ctx.clip?.sourceStart ?? 0);
    const errors: string[] = [];
    if (op.target.end > duration) errors.push(`${op.id}: operation ends after clip ${op.target.clipId} duration ${duration}`);
    if (op.status === 'approved') {
      if (!op.assetId) errors.push(`${op.id}: approved voice patch is missing assetId`);
      else if (ctx.assetExists && !ctx.assetExists(op.assetId)) errors.push(`${op.id}: approved voice patch asset does not exist: ${op.assetId}`);
      // Degraded-payload guard: a PRESENT near-zero generated duration is the
      // artifact band (ElevenLabs was seen returning ~50 ms for a real word) — it
      // renders as a silent gap, so reject it. The synthesis route already catches
      // this, but validation makes the state unrepresentable for a hand-edited or
      // future-code-path manifest. A MISSING value is deliberately NOT rejected:
      // older/migrated approved ops predate the field, and projectTimeMap treats a
      // missing duration as delta=0 (slot preserved, asset plays inside it — safe),
      // so failing them here would retroactively invalidate legacy manifests and
      // v2->v3 migration. Floor at 100 ms matches the API guard.
      if (op.durationGeneratedSec !== undefined && op.durationGeneratedSec < 0.1) {
        errors.push(`${op.id}: approved voice patch has implausibly short audio (${(op.durationGeneratedSec * 1000).toFixed(0)} ms)`);
      }
      // seamBaked disables the pipeline's own afade (crossfadeSec:0). That is only safe when
      // the play length is known — otherwise renderContribution would emit no fade AND fall
      // back to the requested slot duration, risking a click/truncation. Require the duration.
      if (op.seamBaked === true && op.durationGeneratedSec === undefined) {
        errors.push(`${op.id}: seamBaked voice patch requires durationGeneratedSec`);
      }
    }
    return errors;
  },
  projectTimeMap(op, map) {
    // Phase-1 rule (2026-05-25): voice_patch is a replacement, not a timing op.
    // Shorter generated audio (delta < 0) leaves the time map untouched — the
    // original slot duration is preserved and the asset plays inside it. Timing
    // tightening is an explicit cut / ripple-trim, never a side effect of a
    // shorter TTS asset. Only positive delta shifts downstream segments.
    const requestedDuration = op.target.end - op.target.start;
    const assetDuration = op.durationGeneratedSec ?? requestedDuration;
    const delta = assetDuration - requestedDuration;
    if (delta <= EPSILON) return map;

    // Find the anchor segment — the segment containing op.target.start on the
    // patch's clip+track. validate already rejects out-of-clip targets, but
    // guard defensively: if the segment can't be found (e.g. an earlier op
    // mutated the map past the patch's source range), return map unchanged.
    const anchor = map.segments.find((segment) =>
      segment.trackId === op.target.trackId &&
      segment.clipId === op.target.clipId &&
      op.target.start >= segment.sourceStart &&
      op.target.start < segment.sourceEnd
    );
    if (!anchor) return map;

    const sourceSpanOutputEnd = anchor.outputStart + ((op.target.end - anchor.sourceStart) / anchor.rate);

    const segments: TimeMapSegment[] = [];
    for (const segment of map.segments) {
      if (segment.outputEnd <= sourceSpanOutputEnd + EPSILON) {
        // Anchor-freeze rule (2026-05-25 follow-up): every segment ending at the
        // patch's source-span output end gets freezeTailSec=delta, including the
        // anchor track itself. Without this, single-video-track projects show
        // black frames in the overflow band because no VideoBaseSegment or
        // freeze-frame stage covers it. The audio-insert mute window already
        // suppresses base audio through the overflow.
        segments.push(maybeFreeze(segment, Math.abs(segment.outputEnd - sourceSpanOutputEnd) <= EPSILON, delta));
      } else if (segment.outputStart >= sourceSpanOutputEnd - EPSILON) {
        segments.push({ ...segment, outputStart: segment.outputStart + delta, outputEnd: segment.outputEnd + delta });
      } else {
        // Patch falls in the interior of a single time-map segment: the first half
        // (ending at sourceSpanOutputEnd) also gets the freeze tag.
        segments.push(maybeFreeze({ ...segment, sourceEnd: sourceAtOutput(segment, sourceSpanOutputEnd), outputEnd: sourceSpanOutputEnd }, true, delta));
        segments.push({
          ...segment,
          sourceStart: sourceAtOutput(segment, sourceSpanOutputEnd),
          outputStart: sourceSpanOutputEnd + delta,
          outputEnd: segment.outputEnd + delta
        });
      }
    }
    return { segments: sortSegments(segments) };
  },
  renderContribution(op, ctx) {
    if (!op.assetId) throw new Error(`${op.id}: approved voice patch is missing assetId`);
    const asset = ctx.manifest.assets.find((candidate) => candidate.assetId === op.assetId);
    if (!asset) throw new Error(`${op.id}: voice patch asset does not exist: ${op.assetId}`);
    const range = outputRangeForClipSourceSpan(ctx.timeMap, op.target.clipId, op.target.start, op.target.end);
    if (!range) return null; // target was cut out of the timeline — patch is a no-op
    const playSec = op.durationGeneratedSec;
    // Double-fade guard (W5): when the seam is already baked into the WAV with equal-power
    // qsin edge fades, emit crossfadeSec:0 so the pipeline does NOT apply another afade on
    // top — two consecutive fades produce an audible dip at the seam. The 0 collapses
    // through pipeline.ts (xf = Math.min(0, ...) = 0) → no afade emitted. Guarded on playSec
    // being known: without it the pipeline can't bound playback, so keep the default fade
    // (validateLocal also rejects an approved seamBaked op with no durationGeneratedSec).
    const seamBakedFadeOff = op.seamBaked === true && playSec !== undefined;
    return { kind: 'audio-insert' as const, asset: asset.path, range, crossfadeSec: seamBakedFadeOff ? 0 : 0.05, ...(playSec !== undefined ? { opId: op.id, playSec } : {}) };
  },
  transcriptView(op) {
    return { kind: 'voice_patch', label: 'Voice patch', tone: 'info', operationId: op.id, status: op.status, start: op.target.start, end: op.target.end, details: { text: op.text, ...(op.voiceRef ? { voiceRef: op.voiceRef } : {}) } };
  },
  timelineView(op) {
    return { kind: 'voice_patch', label: 'Voice patch', tone: 'info', operationId: op.id, trackId: op.target.trackId, clipId: op.target.clipId, start: op.target.start, end: op.target.end, details: { assetId: op.assetId, ...(op.voiceRef ? { voiceRef: op.voiceRef } : {}) } };
  }
};
