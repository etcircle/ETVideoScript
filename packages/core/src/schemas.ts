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
  log: z.string().optional()
});

export const ProviderRequestIdSchema = z.string().min(8).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

export const ProviderRequestCostSchema = z.object({
  currency: z.string().min(3).max(8),
  estimated: z.number().nonnegative().nullable().optional(),
  actual: z.number().nonnegative().nullable().optional()
});

export const LegacyProviderRequestSchema = z.object({
  requestId: ProviderRequestIdSchema,
  projectId: z.string(),
  provider: z.string(),
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
  provider: z.string().min(1),
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

export const ProviderRequestSchema = z.union([LegacyProviderRequestSchema, GenericProviderRequestSchema]);

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

export function isManifestV2(manifest: Manifest): manifest is ManifestV2 {
  return 'manifestVersion' in manifest && manifest.manifestVersion === 2;
}

export function isManifestV1(manifest: Manifest): manifest is ManifestV1 {
  return 'schemaVersion' in manifest && manifest.schemaVersion === 1;
}
