import { z } from 'zod';

// Protocol v2 makes clipId required on transcript words, operation payloads, and timed proposal params.
// Protocol v3 adds the registry-driven v3 tool surface while keeping v2 tools intact.
export const ProtocolVersionSchema = z.union([z.literal(2), z.literal(3)]);
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;

export const RequestIdSchema = z.string().min(8).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const OperationIdSchema = z.string().min(1);
export const ManifestVersionSchema = z.string().min(1);
export const IsoDateStringSchema = z.string().datetime().or(z.string().min(1));

export const RangeSecSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().positive()
}).refine((range) => range.start < range.end, { message: 'range start must be < end', path: ['end'] });
export type RangeSec = z.infer<typeof RangeSecSchema>;

export const TranscriptTimingSchema = z.enum(['exact', 'approximate', 'mock']);
export const TranscriptWordSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  normalized: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  speaker: z.string().default('speaker_1'),
  confidence: z.number().min(0).max(1).default(1),
  segmentId: z.string().min(1),
  clipId: z.string().min(1)
}).refine((word) => word.start < word.end, { message: 'word start must be < end', path: ['end'] });
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;

export const OperationStatusSchema = z.enum(['proposed', 'awaiting_approval', 'approved', 'rejected', 'disabled']);
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

export const OperationTypeSchema = z.enum(['cut', 'mute', 'keep', 'voice_patch', 'lipsync_patch', 'caption_override']);
export type OperationType = z.infer<typeof OperationTypeSchema>;

export const DurationWarningSchema = z.object({
  generated: z.number().nonnegative(),
  requested: z.number().nonnegative(),
  deltaSec: z.number()
});
export type DurationWarning = z.infer<typeof DurationWarningSchema>;

export const BaseOperationSchema = z.object({
  id: OperationIdSchema,
  clipId: z.string().min(1),
  status: OperationStatusSchema,
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  reason: z.string().optional(),
  createdBy: z.enum(['user', 'agent', 'system']),
  createdAt: IsoDateStringSchema
});

export const CutOperationSchema = BaseOperationSchema.extend({ type: z.literal('cut') });
export const MuteOperationSchema = BaseOperationSchema.extend({ type: z.literal('mute') });
export const VoicePatchOperationSchema = BaseOperationSchema.extend({
  type: z.literal('voice_patch'),
  text: z.string().min(1),
  asset: z.string().min(1).optional(),
  providerRequestId: RequestIdSchema.nullable().optional(),
  durationWarning: DurationWarningSchema.optional()
});
export const KeepOperationSchema = BaseOperationSchema.extend({ type: z.literal('keep') });
export const LipsyncPatchOperationSchema = BaseOperationSchema.extend({
  type: z.literal('lipsync_patch'),
  videoAsset: z.string().min(1),
  providerRequestId: RequestIdSchema.nullable().optional()
});
export const CaptionOverrideOperationSchema = BaseOperationSchema.extend({
  type: z.literal('caption_override'),
  text: z.string().min(1)
});

export const ManifestOperationSchema = z.discriminatedUnion('type', [
  CutOperationSchema,
  MuteOperationSchema,
  KeepOperationSchema,
  VoicePatchOperationSchema,
  LipsyncPatchOperationSchema,
  CaptionOverrideOperationSchema
]);
export type CutOperation = z.infer<typeof CutOperationSchema>;
export type MuteOperation = z.infer<typeof MuteOperationSchema>;
export type VoicePatchOperation = z.infer<typeof VoicePatchOperationSchema>;
export type KeepOperation = z.infer<typeof KeepOperationSchema>;
export type LipsyncPatchOperation = z.infer<typeof LipsyncPatchOperationSchema>;
export type CaptionOverrideOperation = z.infer<typeof CaptionOverrideOperationSchema>;
export type ManifestOperation = z.infer<typeof ManifestOperationSchema>;

export const ProviderRequestStatusSchema = z.enum(['pending', 'approved', 'called', 'succeeded', 'failed', 'rejected', 'op_update_failed']);
export type ProviderRequestStatus = z.infer<typeof ProviderRequestStatusSchema>;

export const JobSummarySchema = z.object({
  jobId: z.string().min(1),
  type: z.string().min(1),
  status: z.enum(['queued', 'waiting_for_approval', 'running', 'succeeded', 'failed', 'cancelled']),
  createdAt: IsoDateStringSchema,
  startedAt: IsoDateStringSchema.optional(),
  completedAt: IsoDateStringSchema.optional(),
  outputs: z.array(z.string()).optional(),
  error: z.string().optional()
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

const ExpectedManifestVersionSchema = z.object({
  expectedManifestVersion: ManifestVersionSchema.optional()
});
const MutatingToolBaseSchema = ExpectedManifestVersionSchema.extend({
  requestId: RequestIdSchema
});
const TimedProposalBaseSchema = MutatingToolBaseSchema.extend({
  clipId: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  reason: z.string().min(1)
}).refine((params) => params.start < params.end, { message: 'operation start must be < end', path: ['end'] });

export const GetTranscriptParamsSchema = z.object({ rangeSec: RangeSecSchema.optional() });
export const ListOperationsParamsSchema = z.object({
  status: z.array(OperationStatusSchema).optional(),
  type: z.array(OperationTypeSchema).optional()
});
export const ProposeCutParamsSchema = TimedProposalBaseSchema;
export const ProposeMuteParamsSchema = TimedProposalBaseSchema;
export const ProposeVoicePatchParamsSchema = MutatingToolBaseSchema.extend({
  clipId: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  text: z.string().min(1),
  provider: z.string().min(1),
  voice: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  language: z.string().min(2).max(16).regex(/^[a-zA-Z-]+$/).optional(),
  reason: z.string().optional()
}).refine((params) => params.start < params.end, { message: 'operation start must be < end', path: ['end'] });
export const ProposeLipsyncPatchParamsSchema = MutatingToolBaseSchema.extend({
  clipId: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  reason: z.string().min(1),
  videoAsset: z.string().min(1),
  providerRequestId: RequestIdSchema.nullable().optional()
}).refine((params) => params.start < params.end, { message: 'operation start must be < end', path: ['end'] });
export const ProposeCaptionOverrideParamsSchema = MutatingToolBaseSchema.extend({
  clipId: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  reason: z.string().min(1),
  text: z.string().min(1)
}).refine((params) => params.start < params.end, { message: 'operation start must be < end', path: ['end'] });
export const ApproveOperationParamsSchema = MutatingToolBaseSchema.extend({ operationId: OperationIdSchema });
export const RejectOperationParamsSchema = MutatingToolBaseSchema.extend({ operationId: OperationIdSchema, reason: z.string().optional() });
export const GetRenderStateParamsSchema = z.object({});
export const RenderDraftParamsSchema = MutatingToolBaseSchema;

export const V3OperationTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clip-span'), trackId: z.string().min(1), clipId: z.string().min(1), start: z.number().nonnegative(), end: z.number().nonnegative() }),
  z.object({ kind: z.literal('clip-boundary'), trackId: z.string().min(1), clipId: z.string().min(1) }),
  z.object({ kind: z.literal('track'), trackId: z.string().min(1) })
]).refine((target) => target.kind !== 'clip-span' || target.start < target.end, { message: 'operation start must be < end', path: ['end'] });
export const ProposeOperationParamsSchema = MutatingToolBaseSchema.extend({
  type: z.string().min(1),
  id: OperationIdSchema.optional(),
  target: V3OperationTargetSchema,
  status: OperationStatusSchema.optional(),
  reason: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  text: z.string().min(1).optional(),
  assetId: z.string().min(1).optional(),
  providerRequestId: RequestIdSchema.nullable().optional()
}).passthrough();
const V3TrackParamsSchema = MutatingToolBaseSchema.extend({
  trackId: z.string().min(1), kind: z.enum(['video', 'audio', 'caption']), subtype: z.enum(['dialog', 'music', 'sfx', 'voiceover']).optional(), name: z.string().min(1), order: z.number().int(),
  locked: z.boolean().optional(), muted: z.boolean().optional(), solo: z.boolean().optional(), hidden: z.boolean().optional(), clips: z.array(z.unknown()).optional()
});
const V3TrackIdParamsSchema = MutatingToolBaseSchema.extend({ trackId: z.string().min(1) }).strict();
const V3ClipIdParamsSchema = MutatingToolBaseSchema.extend({ clipId: z.string().min(1) }).strict();
const V3DetachAudioParamsSchema = MutatingToolBaseSchema.extend({ clipId: z.string().min(1), detachedClipId: z.string().min(1).optional() }).strict();
export const StructuralToolParamsSchema = MutatingToolBaseSchema.passthrough();

export type GetTranscriptParams = z.infer<typeof GetTranscriptParamsSchema>;
export type ListOperationsParams = z.infer<typeof ListOperationsParamsSchema>;
export type ProposeCutParams = z.infer<typeof ProposeCutParamsSchema>;
export type ProposeMuteParams = z.infer<typeof ProposeMuteParamsSchema>;
export type ProposeVoicePatchParams = z.infer<typeof ProposeVoicePatchParamsSchema>;
export type ProposeLipsyncPatchParams = z.infer<typeof ProposeLipsyncPatchParamsSchema>;
export type ProposeCaptionOverrideParams = z.infer<typeof ProposeCaptionOverrideParamsSchema>;
export type ApproveOperationParams = z.infer<typeof ApproveOperationParamsSchema>;
export type RejectOperationParams = z.infer<typeof RejectOperationParamsSchema>;
export type GetRenderStateParams = z.infer<typeof GetRenderStateParamsSchema>;
export type RenderDraftParams = z.infer<typeof RenderDraftParamsSchema>;
export type V3OperationTarget = z.infer<typeof V3OperationTargetSchema>;
export type ProposeOperationParams = z.infer<typeof ProposeOperationParamsSchema>;

export const ToolNameSchema = z.enum([
  'get_transcript',
  'list_operations',
  'propose_cut',
  'propose_mute',
  'propose_voice_patch',
  'approve_operation',
  'reject_operation',
  'get_render_state',
  'render_draft',
  'propose_operation',
  'add_track',
  'remove_track',
  'reorder_tracks',
  'set_track_flags',
  'rename_track',
  'add_clip',
  'move_clip',
  'trim_clip',
  'remove_clip',
  'detach_audio',
  'add_asset',
  'remove_asset',
  'update_asset',
  'propose_outputs'
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const ToolParamsSchemaByName = {
  get_transcript: GetTranscriptParamsSchema,
  list_operations: ListOperationsParamsSchema,
  propose_cut: ProposeCutParamsSchema,
  propose_mute: ProposeMuteParamsSchema,
  propose_voice_patch: ProposeVoicePatchParamsSchema,
  approve_operation: ApproveOperationParamsSchema,
  reject_operation: RejectOperationParamsSchema,
  get_render_state: GetRenderStateParamsSchema,
  render_draft: RenderDraftParamsSchema,
  propose_operation: ProposeOperationParamsSchema,
  add_track: V3TrackParamsSchema,
  remove_track: V3TrackIdParamsSchema,
  reorder_tracks: StructuralToolParamsSchema,
  set_track_flags: StructuralToolParamsSchema,
  rename_track: StructuralToolParamsSchema,
  add_clip: StructuralToolParamsSchema,
  move_clip: StructuralToolParamsSchema,
  trim_clip: StructuralToolParamsSchema,
  remove_clip: V3ClipIdParamsSchema,
  detach_audio: V3DetachAudioParamsSchema,
  add_asset: StructuralToolParamsSchema,
  remove_asset: StructuralToolParamsSchema,
  update_asset: StructuralToolParamsSchema,
  propose_outputs: StructuralToolParamsSchema
} as const;

export type ToolParamsByName = {
  get_transcript: GetTranscriptParams;
  list_operations: ListOperationsParams;
  propose_cut: ProposeCutParams;
  propose_mute: ProposeMuteParams;
  propose_voice_patch: ProposeVoicePatchParams;
  approve_operation: ApproveOperationParams;
  reject_operation: RejectOperationParams;
  get_render_state: GetRenderStateParams;
  render_draft: RenderDraftParams;
  propose_operation: ProposeOperationParams;
  add_track: z.infer<typeof V3TrackParamsSchema>;
  remove_track: z.infer<typeof V3TrackIdParamsSchema>;
  reorder_tracks: Record<string, unknown>;
  set_track_flags: Record<string, unknown>;
  rename_track: Record<string, unknown>;
  add_clip: Record<string, unknown>;
  move_clip: Record<string, unknown>;
  trim_clip: Record<string, unknown>;
  remove_clip: z.infer<typeof V3ClipIdParamsSchema>;
  detach_audio: z.infer<typeof V3DetachAudioParamsSchema>;
  add_asset: Record<string, unknown>;
  remove_asset: Record<string, unknown>;
  update_asset: Record<string, unknown>;
  propose_outputs: Record<string, unknown>;
};
export type ToolParams = ToolParamsByName[ToolName];

export const GetTranscriptResultSchema = z.object({
  words: z.array(TranscriptWordSchema),
  rangeSec: RangeSecSchema.optional(),
  provider: z.object({ name: z.string(), timing: TranscriptTimingSchema }),
  durationSec: z.number().nonnegative()
});
export const ListOperationsResultSchema = z.object({ operations: z.array(ManifestOperationSchema) });
export const ProposeCutResultSchema = z.object({ operation: CutOperationSchema });
export const ProposeMuteResultSchema = z.object({ operation: MuteOperationSchema });
export const ProposeVoicePatchResultSchema = z.object({
  operation: VoicePatchOperationSchema,
  providerRequestId: RequestIdSchema,
  approvalRequired: z.boolean()
});
export const ApproveOperationResultSchema = z.object({
  operation: ManifestOperationSchema,
  providerRequestId: RequestIdSchema.optional(),
  providerRequestStatus: ProviderRequestStatusSchema.optional(),
  jobId: z.string().min(1).optional()
});
export const RejectOperationResultSchema = z.object({ operation: ManifestOperationSchema });
export const GetRenderStateResultSchema = z.object({
  manifestValid: z.boolean(),
  manifestErrors: z.array(z.string()),
  draft: z.object({
    exists: z.boolean(),
    fresh: z.boolean(),
    path: z.string().optional(),
    updatedAt: IsoDateStringSchema.optional()
  }),
  jobs: z.array(JobSummarySchema)
});
export const V3GetRenderStateResultSchema = z.object({
  manifestValid: z.boolean(),
  manifestErrors: z.array(z.string()),
  renderPlan: z.unknown().nullable()
});
export const RenderDraftResultSchema = z.object({ job: JobSummarySchema });
export const V3OperationResultSchema = z.object({ operation: z.object({ id: OperationIdSchema, type: z.string().min(1), status: OperationStatusSchema, target: V3OperationTargetSchema }).passthrough() });
export const V3StructuralResultSchema = z.record(z.unknown());

export type GetTranscriptResult = z.infer<typeof GetTranscriptResultSchema>;
export type ListOperationsResult = z.infer<typeof ListOperationsResultSchema>;
export type ProposeCutResult = z.infer<typeof ProposeCutResultSchema>;
export type ProposeMuteResult = z.infer<typeof ProposeMuteResultSchema>;
export type ProposeVoicePatchResult = z.infer<typeof ProposeVoicePatchResultSchema>;
export type ApproveOperationResult = z.infer<typeof ApproveOperationResultSchema>;
export type RejectOperationResult = z.infer<typeof RejectOperationResultSchema>;
export type GetRenderStateResult = z.infer<typeof GetRenderStateResultSchema>;
export type V3GetRenderStateResult = z.infer<typeof V3GetRenderStateResultSchema>;
export type RenderDraftResult = z.infer<typeof RenderDraftResultSchema>;
export type V3OperationResult = z.infer<typeof V3OperationResultSchema>;
export type V3StructuralResult = z.infer<typeof V3StructuralResultSchema>;

export type ToolResultByName = {
  get_transcript: GetTranscriptResult;
  list_operations: ListOperationsResult;
  propose_cut: ProposeCutResult;
  propose_mute: ProposeMuteResult;
  propose_voice_patch: ProposeVoicePatchResult;
  approve_operation: ApproveOperationResult;
  reject_operation: RejectOperationResult;
  get_render_state: GetRenderStateResult;
  render_draft: RenderDraftResult;
  propose_operation: V3OperationResult;
  add_track: V3StructuralResult;
  remove_track: V3StructuralResult;
  reorder_tracks: V3StructuralResult;
  set_track_flags: V3StructuralResult;
  rename_track: V3StructuralResult;
  add_clip: V3StructuralResult;
  move_clip: V3StructuralResult;
  trim_clip: V3StructuralResult;
  remove_clip: V3StructuralResult;
  detach_audio: V3StructuralResult;
  add_asset: V3StructuralResult;
  remove_asset: V3StructuralResult;
  update_asset: V3StructuralResult;
  propose_outputs: V3StructuralResult;
};
export type ToolResult = ToolResultByName[ToolName];
export type V3ToolResultByName = Omit<ToolResultByName, 'get_render_state'> & {
  get_render_state: V3GetRenderStateResult;
};
export type ToolResultByProtocolVersion<V extends ProtocolVersion = 2> = V extends 3 ? V3ToolResultByName : ToolResultByName;
export type ToolResultForProtocolVersion<V extends ProtocolVersion, N extends ToolName = ToolName> = ToolResultByProtocolVersion<V>[N];
export type V3ToolResult = V3ToolResultByName[ToolName];

export const ToolResponseSchema = z.object({
  result: z.unknown(),
  manifestVersion: ManifestVersionSchema,
  warnings: z.array(z.string()).optional()
});
export type ToolResponse<T = ToolResult> = {
  result: T;
  manifestVersion: string;
  warnings?: string[];
};

export const ToolErrorCodeSchema = z.enum([
  'unsupported_protocol_version',
  'transcript_not_found',
  'invalid_range',
  'range_out_of_bounds',
  'manifest_not_found',
  'manifest_invalid',
  'overlap_warning',
  'stale_manifest',
  'request_id_conflict',
  'invalid_voice',
  'invalid_language',
  'unsupported_provider',
  'provider_request_invalid',
  'operation_not_found',
  'operation_not_approvable',
  'operation_not_rejectable',
  'provider_request_not_found',
  'provider_request_not_pending',
  'paid_provider_failed',
  'project_not_found',
  'source_missing',
  'render_already_running',
  'internal_error'
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

export const ToolErrorSchema = z.object({
  code: ToolErrorCodeSchema,
  message: z.string(),
  status: z.number().int().min(400).max(599).optional(),
  manifestVersion: ManifestVersionSchema.optional(),
  details: z.unknown().optional()
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

export const StatePushSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manifest_changed'), manifestVersion: ManifestVersionSchema, operationIds: z.array(OperationIdSchema).optional() }),
  z.object({ type: z.literal('render_state_changed'), manifestVersion: ManifestVersionSchema, job: JobSummarySchema.optional() }),
  z.object({ type: z.literal('provider_request_changed'), manifestVersion: ManifestVersionSchema, providerRequestId: RequestIdSchema, status: ProviderRequestStatusSchema })
]);
export type StatePush = z.infer<typeof StatePushSchema>;

export const HelloMessageSchema = z.object({
  kind: z.literal('hello'),
  id: z.string().min(1),
  protocolVersion: ProtocolVersionSchema,
  agent: z.object({ name: z.string().min(1), version: z.string().optional(), skill: z.string().optional() }),
  supports: z.object({ statePush: z.boolean().optional() }).optional()
});
export const ToolCallMessageSchema = z.object({
  kind: z.literal('tool_call'),
  id: z.string().min(1),
  protocolVersion: ProtocolVersionSchema,
  tool: ToolNameSchema,
  params: z.unknown()
});
export const CancelMessageSchema = z.object({
  kind: z.literal('cancel'),
  id: z.string().min(1),
  protocolVersion: ProtocolVersionSchema,
  callId: z.string().min(1)
});
export const ClientMessageSchema = z.discriminatedUnion('kind', [HelloMessageSchema, ToolCallMessageSchema, CancelMessageSchema]);
export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type ToolCallMessage = z.infer<typeof ToolCallMessageSchema>;
export type CancelMessage = z.infer<typeof CancelMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const ReadyMessageSchema = z.object({
  kind: z.literal('ready'),
  id: z.string().min(1),
  protocolVersion: ProtocolVersionSchema,
  sessionId: z.string().min(1),
  projectId: z.string().min(1),
  manifestVersion: ManifestVersionSchema
});
export const ToolResultMessageSchema = z.object({
  kind: z.literal('tool_result'),
  id: z.string().min(1),
  protocolVersion: ProtocolVersionSchema,
  callId: z.string().min(1),
  ok: z.literal(true),
  result: ToolResponseSchema
});
export const ToolErrorMessageSchema = z.object({
  kind: z.literal('tool_error'),
  id: z.string().min(1),
  protocolVersion: ProtocolVersionSchema,
  callId: z.string().min(1).optional(),
  ok: z.literal(false),
  error: ToolErrorSchema
});
export const StatePushMessageSchema = z.object({
  kind: z.literal('state_push'),
  id: z.string().min(1),
  protocolVersion: ProtocolVersionSchema,
  event: StatePushSchema
});
export const ServerMessageSchema = z.discriminatedUnion('kind', [ReadyMessageSchema, ToolResultMessageSchema, ToolErrorMessageSchema, StatePushMessageSchema]);
export type ReadyMessage = z.infer<typeof ReadyMessageSchema>;
export type ToolResultMessage = z.infer<typeof ToolResultMessageSchema>;
export type ToolErrorMessage = z.infer<typeof ToolErrorMessageSchema>;
export type StatePushMessage = z.infer<typeof StatePushMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
