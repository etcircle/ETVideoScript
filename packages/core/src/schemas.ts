import { z } from 'zod';

export const IsoDateString = z.string().datetime().or(z.string().min(1));

export const ClipSourceMetadataSchema = z.object({
  clipId: z.string().min(1),
  path: z.string(),
  originalFilename: z.string().optional(),
  sha256: z.string(),
  durationSec: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  audioSampleRate: z.number().int().nonnegative(),
  videoCodec: z.string(),
  audioCodec: z.string(),
  pixelFormat: z.string()
});

export const SourceMetadataSchemaV1 = ClipSourceMetadataSchema.omit({
  clipId: true,
  videoCodec: true,
  audioCodec: true,
  pixelFormat: true
}).extend({
  originalFilename: z.string()
});

export const ProjectSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/),
  title: z.string().min(1),
  createdAt: IsoDateString,
  updatedAt: IsoDateString,
  workspacePath: z.string().min(1),
  source: SourceMetadataSchemaV1.nullable(),
  status: z.object({
    imported: z.boolean(),
    audioExtracted: z.boolean(),
    transcribed: z.boolean(),
    manifestValid: z.boolean(),
    lastRender: z.string().nullable()
  })
});

export const ProjectSchema = z.object({
  schemaVersion: z.literal(1),
  manifestVersion: z.union([z.literal(2), z.literal(3)]).default(3),
  projectId: z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/),
  title: z.string().min(1),
  createdAt: IsoDateString,
  updatedAt: IsoDateString,
  workspacePath: z.string().min(1),
  clipSources: z.array(ClipSourceMetadataSchema).default([]),
  status: z.object({
    imported: z.boolean(),
    audioExtracted: z.boolean(),
    transcribed: z.boolean(),
    manifestValid: z.boolean(),
    lastRender: z.string().nullable()
  })
});

const BaseOperationSchemaV1 = z.object({
  id: z.string().min(1),
  status: z.enum(['proposed', 'awaiting_approval', 'approved', 'rejected', 'disabled']).default('approved'),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  reason: z.string().optional(),
  createdBy: z.enum(['user', 'agent', 'system']).default('user'),
  createdAt: IsoDateString
});

const BaseOperationSchemaV2 = BaseOperationSchemaV1.extend({
  clipId: z.string().min(1)
});

export const AudioEnhanceProfileSchema = z.enum(['clean_voice', 'podcast', 'meeting', 'tutorial']);
export const AudioEnhanceProviderSchema = z.enum(['ffmpeg-local', 'adobe-enhance', 'elevenlabs-isolation']);

function operationSchemas<T extends typeof BaseOperationSchemaV1 | typeof BaseOperationSchemaV2>(base: T) {
  const CutOperationSchema = base.extend({ type: z.literal('cut') });
  const MuteOperationSchema = base.extend({ type: z.literal('mute') });
  const KeepOperationSchema = base.extend({ type: z.literal('keep') });
  const CaptionOverrideOperationSchema = base.extend({ type: z.literal('caption_override'), text: z.string() });
  const DurationWarningSchema = z.object({
    generated: z.number().nonnegative(),
    requested: z.number().nonnegative(),
    deltaSec: z.number()
  });
  const VoicePatchOperationSchema = base.extend({
    type: z.literal('voice_patch'),
    text: z.string().min(1),
    asset: z.string().min(1).optional(),
    providerRequestId: z.string().nullable().optional(),
    durationGeneratedSec: z.number().nonnegative().optional(),
    durationRequestedSec: z.number().nonnegative().optional(),
    durationWarning: DurationWarningSchema.optional()
  });
  const LipSyncPatchOperationSchema = base.extend({
    type: z.literal('lipsync_patch'),
    videoAsset: z.string().min(1),
    providerRequestId: z.string().nullable().optional()
  });
  const AudioEnhanceOperationSchema = base.extend({
    type: z.literal('audio_enhance'),
    provider: AudioEnhanceProviderSchema,
    profile: AudioEnhanceProfileSchema,
    filterChainVersion: z.number().int().nonnegative(),
    ffmpegVersion: z.string().optional(),
    providerVersion: z.string().optional(),
    cachedAsset: z.string().optional(),
    intensity: z.number().min(0).max(1).default(0.6).optional(),
    costEstimateUsd: z.number().nonnegative().optional()
  });
  const ManifestOperationSchema = z.discriminatedUnion('type', [
    CutOperationSchema,
    MuteOperationSchema,
    KeepOperationSchema,
    VoicePatchOperationSchema,
    LipSyncPatchOperationSchema,
    CaptionOverrideOperationSchema,
    AudioEnhanceOperationSchema
  ]).refine((op) => op.start < op.end, { message: 'operation start must be < end', path: ['end'] });
  return {
    CutOperationSchema,
    MuteOperationSchema,
    KeepOperationSchema,
    CaptionOverrideOperationSchema,
    DurationWarningSchema,
    VoicePatchOperationSchema,
    LipSyncPatchOperationSchema,
    AudioEnhanceOperationSchema,
    ManifestOperationSchema
  };
}

const v1Ops = operationSchemas(BaseOperationSchemaV1);
const v2Ops = operationSchemas(BaseOperationSchemaV2);

export const DurationWarningSchema = v1Ops.DurationWarningSchema;
export const CutOperationSchema = v1Ops.CutOperationSchema;
export const MuteOperationSchema = v1Ops.MuteOperationSchema;
export const KeepOperationSchema = v1Ops.KeepOperationSchema;
export const CaptionOverrideOperationSchema = v1Ops.CaptionOverrideOperationSchema;
export const VoicePatchOperationSchema = v1Ops.VoicePatchOperationSchema;
export const LipSyncPatchOperationSchema = v1Ops.LipSyncPatchOperationSchema;
export const AudioEnhanceOperationSchema = v1Ops.AudioEnhanceOperationSchema;
export const ManifestOperationSchemaV1 = v1Ops.ManifestOperationSchema;
export const ManifestOperationSchemaV2 = v2Ops.ManifestOperationSchema;
export const ManifestOperationSchema = ManifestOperationSchemaV1.or(ManifestOperationSchemaV2);

export const RenderPresetSchema = z.object({
  resolution: z.string(),
  videoBitrate: z.string(),
  audioBitrate: z.string()
});

export const RenderPresetsSchema = z.object({
  draft: RenderPresetSchema,
  youtube: RenderPresetSchema
});

export const TransitionAfterSchema = z.object({
  type: z.string(),
  durationMs: z.number().int().nonnegative()
});

export const ClipSchema = z.object({
  clipId: z.string().min(1),
  assetPath: z.string().min(1),
  sourceStart: z.number().nonnegative(),
  sourceEnd: z.number().nonnegative(),
  transitionAfter: TransitionAfterSchema.optional()
}).refine((clip) => clip.sourceStart < clip.sourceEnd, { message: 'clip sourceStart must be < sourceEnd', path: ['sourceEnd'] });

export const TrackSchema = z.object({
  trackId: z.string().min(1),
  kind: z.literal('video'),
  clips: z.array(ClipSchema)
});

export const ManifestSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().min(1),
  source: z.string().min(1),
  createdAt: IsoDateString,
  updatedAt: IsoDateString,
  timelineBase: z.literal('source-time'),
  operations: z.array(ManifestOperationSchemaV1),
  renderPresets: RenderPresetsSchema
});

export const ManifestSchemaV2 = z.object({
  manifestVersion: z.literal(2),
  projectId: z.string().min(1),
  tracks: z.array(TrackSchema),
  createdAt: IsoDateString,
  updatedAt: IsoDateString,
  operations: z.array(ManifestOperationSchemaV2),
  renderPresets: RenderPresetsSchema
});

export const ManifestSchema = ManifestSchemaV1.or(ManifestSchemaV2);

export const TranscriptProviderSchema = z.object({
  name: z.string(),
  model: z.string(),
  requestId: z.string().nullable(),
  /**
   * exact: provider returned real word timestamps.
   * approximate: text-only provider output was distributed across duration for demo use.
   * mock: deterministic local placeholder transcript.
   */
  timing: z.enum(['exact', 'approximate', 'mock']).default('exact')
});

export const TranscriptWordSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  normalized: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  speaker: z.string().default('speaker_1'),
  confidence: z.number().min(0).max(1).default(1),
  segmentId: z.string().min(1),
  clipId: z.string().default('')
}).refine((word) => word.start < word.end, { message: 'word start must be < end', path: ['end'] });

export const TranscriptSegmentSchema = z.object({
  id: z.string().min(1),
  speaker: z.string().default('speaker_1'),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string()
}).refine((segment) => segment.start <= segment.end, { message: 'segment start must be <= end', path: ['end'] });

export const TranscriptWordsSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.string().min(1),
  provider: TranscriptProviderSchema,
  language: z.string().default('en'),
  durationSec: z.number().nonnegative(),
  words: z.array(TranscriptWordSchema),
  segments: z.array(TranscriptSegmentSchema)
});

export const JobStageSchema = z.object({
  name: z.string(),
  status: z.enum(['queued', 'waiting_for_approval', 'running', 'succeeded', 'failed', 'cancelled']),
  startedAt: IsoDateString.optional(),
  completedAt: IsoDateString.optional(),
  error: z.string().optional(),
  clipId: z.string().optional(),
  phase: z.string().optional(),
  percent: z.number().min(0).max(100).optional()
});

export const JobRecordSchema = z.object({
  jobId: z.string(),
  projectId: z.string().optional(),
  type: z.string(),
  status: z.enum(['queued', 'waiting_for_approval', 'running', 'succeeded', 'failed', 'cancelled']),
  createdAt: IsoDateString,
  startedAt: IsoDateString.optional(),
  completedAt: IsoDateString.optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  input: z.record(z.unknown()).optional(),
  stages: z.array(JobStageSchema).optional(),
  outputs: z.array(z.string()).optional(),
  error: z.string().optional(),
  log: z.string().optional(),
  /** Non-fatal advisory surfaced alongside a succeeded job, e.g. a render that fell back off a stale studioCleanup. */
  warning: z.string().optional(),
  /**
   * Machine-readable failure discriminator (S1b ⟨R5⟩/D1). ADDITIVE — the `status` enum is
   * deliberately NOT widened: an interrupted/reconciled job is `status:'failed'` +
   * `errorCode:'interrupted'`, so no schema or UI that switches on status has to change.
   * Known S1b values: 'interrupted' | 'unknown-outcome' | 'insufficient-clean-windows' |
   * 'cleaned-source-unavailable' | 'transcript-not-word-accurate' | 'multi-clip-unsupported' |
   * 'voice-slot-limit' | 'cancelled'. Kept an open slug rather than an enum so a new failure
   * mode never makes older job logs unreadable.
   */
  errorCode: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/).optional(),
  /**
   * BOUNDED structured detail for errorCode (e.g. usableSec/requiredSec for
   * insufficient-clean-windows). Bounded because jobs.jsonl is append-only and read on every
   * status poll — an unbounded provider payload here would grow the log without limit.
   */
  errorDetails: z.record(z.unknown()).optional().refine(
    (value) => value === undefined || JSON.stringify(value).length <= 2048,
    { message: 'errorDetails must serialize to at most 2048 characters' }
  )
});

export const ProviderRequestIdSchema = z.string().min(8).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

export const ProviderRequestCostSchema = z.object({
  currency: z.string().min(3).max(8),
  estimated: z.number().nonnegative().nullable().optional(),
  actual: z.number().nonnegative().nullable().optional()
});

/**
 * Provider attribution, normalized AT PARSE TIME for every record family.
 *
 * Spend caps are enforced by matching this string against a set of provider ids, so a blank or
 * whitespace-only value belongs to no group and is therefore counted as zero by all of them —
 * money that exists in the ledger but against no ceiling. `.min(1)` did not catch it (a space is
 * length 1), and normalizing in only one schema left the same hole in the others. Trimming here,
 * and mapping blank to the explicit `unknown` marker, means every downstream consumer sees one
 * canonical form and the unattributed case is nameable rather than invisible.
 */
export const NormalizedProviderName = z.string().transform((value) => value.trim() || 'unknown');

export const LegacyProviderRequestSchema = z.object({
  requestId: ProviderRequestIdSchema,
  projectId: z.string(),
  provider: NormalizedProviderName,
  voice: z.string(),
  language: z.string(),
  textHash: z.string(),
  bodyHash: z.string(),
  operationId: z.string(),
  status: z.enum(['pending', 'approved', 'called', 'succeeded', 'failed', 'rejected', 'op_update_failed']),
  createdAt: IsoDateString,
  completedAt: IsoDateString.optional(),
  error: z.string().optional(),
  durationGeneratedSec: z.number().optional(),
  durationRequestedSec: z.number().optional(),
  durationWarning: DurationWarningSchema.optional()
});

export const GenericProviderRequestSchema = z.object({
  requestId: ProviderRequestIdSchema,
  type: z.string().min(1),
  projectId: z.string().optional().default(''),
  provider: NormalizedProviderName,
  voice: z.string().default(''),
  language: z.string().default(''),
  bodyHash: z.string().default(''),
  model: z.string().optional(),
  operationId: z.string().optional().default(''),
  status: z.enum(['pending', 'approved', 'started', 'called', 'succeeded', 'failed', 'rejected', 'op_update_failed']),
  input: z.record(z.unknown()).optional(),
  output: z.record(z.unknown()).optional(),
  cost: ProviderRequestCostSchema,
  createdAt: IsoDateString,
  completedAt: IsoDateString.optional(),
  error: z.string().optional(),
  providerStatus: z.number().int().optional(),
  durationGeneratedSec: z.number().optional(),
  durationRequestedSec: z.number().optional(),
  durationWarning: DurationWarningSchema.optional()
});

// ── Voice-patch step records (S1b ⟨Q4⟩/⟨R1⟩/⟨R8⟩) ───────────────────────────────
// A step record is the DURABLE idempotency terminal for one paid step of the clone-chain
// (`tts` then `sts`). It has its OWN schema rather than being smuggled through
// GenericProviderRequestSchema's free-form input/output: replay eligibility depends on
// verified artifact metadata, and a shape that "might" carry it is not a contract.
//
// Its `requestId` is the DERIVED storage key (voicePatchStepRecordId); `parentRequestId` and
// `step` are persisted as explicit fields so the record is self-describing without reversing
// the hash. Accounting ids (written by the provider engine for the actual paid call) are
// SEPARATE ids — a step record never doubles as a cost row.

export const VoicePatchStepArtifactSchema = z.object({
  /** Canonical workspace-relative path, always under assets/voice/steps/. */
  relPath: z.string().min(1).max(512),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  durationSec: z.number().nonnegative()
});

export const VoicePatchStepRecordSchema = z.object({
  /** Discriminator: keeps step records out of the cost summary and out of the other members. */
  recordKind: z.literal('voice-patch-step'),
  requestId: ProviderRequestIdSchema,
  parentRequestId: ProviderRequestIdSchema,
  step: z.enum(['tts', 'sts']),
  projectId: z.string().default(''),
  operationId: z.string().default(''),
  provider: NormalizedProviderName,
  /** 'started' is the pre-call marker; the two terminals are 'succeeded' and 'failed'. */
  status: z.enum(['started', 'succeeded', 'failed']),
  createdAt: IsoDateString,
  completedAt: IsoDateString.optional(),
  artifact: VoicePatchStepArtifactSchema.optional(),
  /**
   * The paid call's real HTTP status, preserved for the root terminal's error payload.
   *
   * Named `stepProviderStatus`, not `providerStatus`, so it belongs to the STEP field family
   * alone. `providerStatus` is a generic-accounting discriminator, and a step record carrying it
   * would span two families — which the classifier must reject as corruption. Keeping the value
   * under a step-owned name preserves the information without making every legitimate step
   * terminal ambiguous.
   */
  stepProviderStatus: z.number().int().optional(),
  error: z.string().max(4096).optional(),
  /** The engine requestId that actually billed this step — the accounting cross-reference. */
  accountingRequestId: ProviderRequestIdSchema.optional()
}).superRefine((record, ctx) => {
  // {response XOR error} terminals — the invariant every ledger record in this codebase holds.
  if (record.status === 'succeeded') {
    if (!record.artifact) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['artifact'], message: 'a succeeded step record must carry its artifact metadata' });
    if (record.error) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['error'], message: 'a succeeded step record must not carry an error' });
  }
  if (record.status === 'failed') {
    if (!record.error) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['error'], message: 'a failed step record must carry an error' });
    if (record.artifact) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['artifact'], message: 'a failed step record must not carry artifact metadata' });
  }
  if (record.status === 'started' && (record.artifact || record.error)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'a started step marker carries neither artifact nor error' });
  }
});

// Step schema FIRST: it is the only member with `recordKind`, and it must never be swallowed
// by a looser member. (Legacy requires textHash; Generic requires `type` + `cost` — neither
// matches a step record, so the ordering is belt-and-braces.)
export const ProviderRequestSchema = z.union([VoicePatchStepRecordSchema, LegacyProviderRequestSchema, GenericProviderRequestSchema]);

/**
 * A row written by an OLDER version of this app: it carries the fields a paid decision actually
 * needs (which request, what state, when) but is missing newer required ones — `cost`, `type`,
 * `textHash`, or the voice/language pair — so the three schemas above reject it.
 *
 * This exists so the STRICT reader can ACCEPT and normalize such rows instead of failing on
 * them. The distinction matters: strictness is there to stop a row from being SKIPPED (a skipped
 * 'started' record is what lets a paid call be charged twice), not to declare every workspace
 * written before the current schema unusable. A row that cannot even produce a requestId, a
 * status and a timestamp is genuinely unusable for a paid gate and still fails.
 *
 * Normalization is conservative: no cost is invented (estimated/actual stay null, so a migrated
 * row can never inflate a spend total), and the provider falls back to a marker string rather
 * than a plausible-looking id.
 */
/**
 * The three DISJOINT record families, identified by fields only that family's writer emits.
 *
 * Membership is EXCLUSIVE: a row carrying discriminators from more than one family is corruption,
 * not a member of whichever family happens to be checked first. That matters because the schemas
 * are non-strict — a row valid as both a step record and a generic one parses as a step and
 * silently loses `type`/`cost`/`output`, which removes a real charge from spend accounting; the
 * Legacy/Generic pair loses the same fields the same way.
 */
const ROW_FAMILIES = {
  /** Voice-patch step records (paid-step idempotency). */
  step: ['recordKind', 'parentRequestId', 'step', 'artifact', 'accountingRequestId', 'stepProviderStatus'],
  /** The provider engine's accounting rows. */
  'generic-accounting': ['type', 'cost', 'output', 'providerStatus'],
  /** The original voice-patch ledger rows. */
  legacy: ['textHash']
} as const satisfies Record<string, readonly string[]>;

type RowFamily = keyof typeof ROW_FAMILIES;

/** Chain payloads that live under `input` and mark a row as generic-accounting. */
const GENERIC_INPUT_PAYLOADS = ['executionSnapshot', 'resolvedRange'] as const;

export const LegacyMigratedProviderRequestSchema = z.object({
  requestId: z.string().min(1),
  status: z.enum(['pending', 'approved', 'started', 'called', 'succeeded', 'failed', 'rejected', 'op_update_failed']),
  createdAt: IsoDateString,
  projectId: z.string().optional(),
  provider: z.string().optional(),
  operationId: z.string().optional(),
  bodyHash: z.string().optional(),
  completedAt: IsoDateString.optional(),
  error: z.string().optional()
}).transform((row) => ({
  requestId: row.requestId,
  type: 'legacy-migrated',
  projectId: row.projectId ?? '',
  provider: (row.provider ?? '').trim() || 'unknown',
  voice: '',
  language: '',
  bodyHash: row.bodyHash ?? '',
  operationId: row.operationId ?? '',
  status: row.status,
  cost: { currency: 'USD', estimated: null, actual: null },
  createdAt: row.createdAt,
  ...(row.completedAt ? { completedAt: row.completedAt } : {}),
  ...(row.error ? { error: row.error } : {})
}));

export type ProviderRequestRowParse =
  | { ok: true; value: ProviderRequest }
  | { ok: false; reason: string };

/**
 * A row's declared family, decided from its fields alone — never from union ordering, and never
 * from "first family that matches". A row spanning families is `conflict`.
 */
function classifyProviderRequestRow(raw: Record<string, unknown>):
  | { kind: 'family'; family: RowFamily; fields: string[] }
  | { kind: 'conflict'; detail: string }
  | { kind: 'undeclared' } {
  const present = new Map<RowFamily, string[]>();
  for (const [family, keys] of Object.entries(ROW_FAMILIES) as Array<[RowFamily, readonly string[]]>) {
    const fields = keys.filter((key) => raw[key] !== undefined);
    if (fields.length > 0) present.set(family, [...fields]);
  }
  const input = raw.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const payloads = GENERIC_INPUT_PAYLOADS.filter((key) => key in (input as Record<string, unknown>));
    if (payloads.length > 0) {
      present.set('generic-accounting', [...(present.get('generic-accounting') ?? []), ...payloads.map((key) => `input.${key}`)]);
    }
  }
  if (present.size > 1) {
    return {
      kind: 'conflict',
      detail: Array.from(present.entries()).map(([family, fields]) => `${family} [${fields.join(', ')}]`).join(' + ')
    };
  }
  const only = Array.from(present.entries())[0];
  return only ? { kind: 'family', family: only[0], fields: only[1] } : { kind: 'undeclared' };
}

/**
 * THE single entry point for turning a raw ledger line into a record. Dispatch is by
 * DISCRIMINATOR FIRST, never by union order.
 *
 * Union ordering is not a safe dispatch mechanism here, and three separate defects proved it:
 * zod strips unknown keys, so whichever member happens to accept a row wins and silently
 * discards the fields that identified it. A row with `recordKind` + `parentRequestId` + an
 * invalid `step` but an otherwise valid `type`/`cost` body parsed as a GENERIC record with its
 * step fields erased — and the paid-step readers, which filter on exactly those fields, then saw
 * an existing 'started' marker as ABSENT and let the step run (and bill) again.
 *
 * The rule is therefore exhaustive, order-independent and EXCLUSIVE:
 *   • exactly one family's discriminators → MUST satisfy that family's schema, else corruption;
 *   • more than one family's             → corruption (no schema may claim it and strip the rest);
 *   • none at all                        → pre-schema history: migrate when the caller allows.
 * No schema may ever "rescue" a row that declared itself something else, so reordering or adding
 * members cannot reopen this class of bug.
 *
 * Used by BOTH the read and the write path, so a row that cannot be classified cleanly can never
 * even be appended.
 */
export function parseProviderRequestRow(raw: unknown, options: { migrateLegacy?: boolean } = {}): ProviderRequestRowParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'row is not a JSON object' };
  const row = raw as Record<string, unknown>;
  const classified = classifyProviderRequestRow(row);

  if (classified.kind === 'conflict') {
    return { ok: false, reason: `row carries fields from more than one record family (${classified.detail}) — no schema may claim it and strip the rest` };
  }

  const issues = (error: z.ZodError) => error.issues.map((issue) => `${issue.path.join('.') || 'row'}: ${issue.message}`).join('; ');

  if (classified.kind === 'family') {
    const schema = classified.family === 'step' ? VoicePatchStepRecordSchema
      : classified.family === 'legacy' ? LegacyProviderRequestSchema
      : GenericProviderRequestSchema;
    const parsed = schema.safeParse(row);
    if (parsed.success) return { ok: true, value: parsed.data };
    return { ok: false, reason: `row declares itself a "${classified.family}" record (via ${classified.fields.join(', ')}) but does not satisfy that schema: ${issues(parsed.error)}` };
  }

  if (!options.migrateLegacy) return { ok: false, reason: 'row carries no recognised record fields' };
  const migrated = LegacyMigratedProviderRequestSchema.safeParse(row);
  if (migrated.success) return { ok: true, value: migrated.data as ProviderRequest };
  return { ok: false, reason: `row is neither a current-schema record nor a migratable historical one: ${issues(migrated.error)}` };
}

export type ProjectV1 = z.infer<typeof ProjectSchemaV1>;
export type ProjectV2 = z.infer<typeof ProjectSchema>;
export type Project = ProjectV2;
export type ManifestV1 = z.infer<typeof ManifestSchemaV1>;
export type ManifestV2 = z.infer<typeof ManifestSchemaV2>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestOperationV1 = z.infer<typeof ManifestOperationSchemaV1>;
export type ManifestOperationV2 = z.infer<typeof ManifestOperationSchemaV2>;
export type ManifestOperation = ManifestOperationV1 | ManifestOperationV2;
export type CutOperation = z.infer<typeof CutOperationSchema>;
export type MuteOperation = z.infer<typeof MuteOperationSchema>;
export type AudioEnhanceOperation = z.infer<typeof AudioEnhanceOperationSchema>;
export type ClipSourceMetadata = z.infer<typeof ClipSourceMetadataSchema>;
export type TranscriptWords = z.infer<typeof TranscriptWordsSchema>;
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;
export type JobRecord = z.infer<typeof JobRecordSchema>;
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;
export type VoicePatchStepRecord = z.infer<typeof VoicePatchStepRecordSchema>;
export type VoicePatchStepArtifact = z.infer<typeof VoicePatchStepArtifactSchema>;

export function isVoicePatchStepRecord(event: ProviderRequest): event is VoicePatchStepRecord {
  return 'recordKind' in event && (event as { recordKind?: unknown }).recordKind === 'voice-patch-step';
}

export function isManifestV2(manifest: Manifest): manifest is ManifestV2 {
  return 'manifestVersion' in manifest && manifest.manifestVersion === 2;
}

export function isManifestV1(manifest: Manifest): manifest is ManifestV1 {
  return 'schemaVersion' in manifest && manifest.schemaVersion === 1;
}
