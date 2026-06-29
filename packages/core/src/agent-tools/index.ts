import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { addAsset, removeAsset, updateAsset } from '../assets/operations';
import { AssetSchema } from '../assets/schema';
import { addOperation, updateOperation } from '../manifest/apply';
import { loadManifestV3, saveManifestV3 } from '../manifest/io';
import type { ManifestV3 } from '../manifest/schema';
import { validateManifestV3Document } from '../manifest/validate';
import { getOperationKind, hasOperationKind } from '../operations/registry';
import { proposeOutputs } from '../outputs/propose';
import { buildRenderPlan } from '../render/plan';
import { TranscriptWordsSchema } from '../schemas';
import { addClip, addTrack, detachAudioInWorkspace, moveClip, removeClip, removeTrack, renameTrack, reorderTracks, setTrackFlags, trimClip } from '../tracks/operations';
import { ClipSchema } from '../tracks/schema';

export interface AgentToolContext {
  workspacePath: string;
  loadManifest?: () => ManifestV3;
  saveManifest?: (manifest: ManifestV3, options?: { revision?: boolean }) => void;
}

export interface AgentToolHandlerResult<Result = unknown> {
  result: Result;
  changedOperationIds: string[];
}

export type AgentToolHandler<Params = unknown, Result = unknown> = (ctx: AgentToolContext, params: Params) => AgentToolHandlerResult<Result>;

function load(ctx: AgentToolContext): ManifestV3 {
  return ctx.loadManifest ? ctx.loadManifest() : loadManifestV3(ctx.workspacePath);
}

function save(ctx: AgentToolContext, manifest: ManifestV3): void {
  if (ctx.saveManifest) ctx.saveManifest(manifest, { revision: true });
  else saveManifestV3(ctx.workspacePath, manifest, { revision: true });
}

const OperationProposalParamsSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1).optional(),
  status: z.enum(['proposed', 'awaiting_approval', 'approved', 'rejected', 'disabled']).optional(),
  target: z.unknown(),
  reason: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  proposedBy: z.enum(['user', 'agent', 'system']).optional(),
  createdBy: z.enum(['user', 'agent', 'system']).optional(),
  createdAt: z.string().datetime().optional()
}).passthrough();

function operationInputFromParams(params: unknown): Record<string, unknown> & { type: string } {
  const parsed = OperationProposalParamsSchema.parse(params);
  getOperationKind(parsed.type);
  return {
    ...parsed,
    id: parsed.id ?? `op_${randomUUID()}`,
    status: parsed.status ?? 'proposed',
    proposedBy: parsed.proposedBy ?? 'agent',
    createdBy: parsed.createdBy ?? 'agent',
    createdAt: parsed.createdAt ?? new Date().toISOString()
  } as Record<string, unknown> & { type: string };
}

const AddTrackParamsSchema = z.object({
  trackId: z.string().min(1),
  kind: z.enum(['video', 'audio', 'caption']),
  subtype: z.enum(['dialog', 'music', 'sfx', 'voiceover']).optional(),
  name: z.string().min(1),
  order: z.number().int(),
  locked: z.boolean().default(false),
  muted: z.boolean().default(false),
  solo: z.boolean().default(false),
  hidden: z.boolean().default(false),
  fx: z.object({ enhance: z.boolean().default(false), denoise: z.boolean().default(false), dereverb: z.boolean().default(false) }).optional(),
  clips: z.array(ClipSchema).optional()
});

export const agentToolHandlers = {
  propose_operation(ctx: AgentToolContext, params: unknown) {
    const manifest = load(ctx);
    const next = addOperation(manifest, operationInputFromParams(params));
    save(ctx, next.manifest);
    return { result: { operation: next.operation }, changedOperationIds: [next.operation.id] };
  },

  approve_operation(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ operationId: z.string().min(1) }).parse(params);
    const next = updateOperation(load(ctx), parsed.operationId, { status: 'approved' });
    save(ctx, next.manifest);
    return { result: { operation: next.operation }, changedOperationIds: [next.operation.id] };
  },

  reject_operation(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ operationId: z.string().min(1), reason: z.string().optional() }).parse(params);
    const next = updateOperation(load(ctx), parsed.operationId, { status: 'rejected', reason: parsed.reason });
    save(ctx, next.manifest);
    return { result: { operation: next.operation }, changedOperationIds: [next.operation.id] };
  },

  list_operations(ctx: AgentToolContext, params: unknown = {}) {
    const parsed = z.object({
      status: z.array(z.enum(['proposed', 'awaiting_approval', 'approved', 'rejected', 'disabled'])).optional(),
      type: z.array(z.string().min(1)).optional()
    }).parse(params);
    for (const type of parsed.type ?? []) {
      if (!hasOperationKind(type)) throw new Error(`Unknown operation type: ${type}`);
    }
    const operations = load(ctx).operations.filter((op) => (!parsed.status || parsed.status.includes(op.status)) && (!parsed.type || parsed.type.includes(op.type)));
    return { result: { operations }, changedOperationIds: [] };
  },

  get_transcript(ctx: AgentToolContext, params: unknown = {}) {
    const parsed = z.object({ rangeSec: z.object({ start: z.number().nonnegative(), end: z.number().positive() }).optional() }).parse(params);
    const transcript = TranscriptWordsSchema.parse(JSON.parse(readFileSync(join(ctx.workspacePath, 'transcript/words.json'), 'utf8')));
    const words = parsed.rangeSec ? transcript.words.filter((word) => word.start < parsed.rangeSec!.end && word.end > parsed.rangeSec!.start) : transcript.words;
    return { result: { ...transcript, words, rangeSec: parsed.rangeSec }, changedOperationIds: [] };
  },

  get_render_state(ctx: AgentToolContext) {
    const manifest = load(ctx);
    const validation = validateManifestV3Document(manifest);
    const renderPlan = validation.valid ? buildRenderPlan(manifest) : null;
    return { result: { manifestValid: validation.valid, manifestErrors: validation.errors, renderPlan }, changedOperationIds: [] };
  },

  add_track(ctx: AgentToolContext, params: unknown) {
    const parsed = AddTrackParamsSchema.parse(params);
    const next = addTrack(load(ctx), parsed);
    save(ctx, next.manifest);
    return { result: { track: next.track }, changedOperationIds: [] };
  },

  remove_track(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ trackId: z.string().min(1) }).parse(params);
    const next = removeTrack(load(ctx), parsed as { trackId: string });
    save(ctx, next.manifest);
    return { result: { track: next.track }, changedOperationIds: [] };
  },

  reorder_tracks(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ order: z.array(z.object({ trackId: z.string().min(1), order: z.number().int() })) }).parse(params);
    const next = reorderTracks(load(ctx), parsed as { order: { trackId: string; order: number }[] });
    save(ctx, next.manifest);
    return { result: { tracks: next.tracks }, changedOperationIds: [] };
  },

  set_track_flags(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ trackId: z.string().min(1), locked: z.boolean().optional(), muted: z.boolean().optional(), solo: z.boolean().optional(), hidden: z.boolean().optional() }).parse(params);
    const next = setTrackFlags(load(ctx), parsed as { trackId: string; locked?: boolean; muted?: boolean; solo?: boolean; hidden?: boolean });
    save(ctx, next.manifest);
    return { result: { track: next.track }, changedOperationIds: [] };
  },

  rename_track(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ trackId: z.string().min(1), name: z.string().min(1) }).parse(params);
    const next = renameTrack(load(ctx), parsed as { trackId: string; name: string });
    save(ctx, next.manifest);
    return { result: { track: next.track }, changedOperationIds: [] };
  },

  add_clip(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ trackId: z.string().min(1), clip: ClipSchema }).parse(params);
    const next = addClip(load(ctx), parsed as { trackId: string; clip: z.infer<typeof ClipSchema> });
    save(ctx, next.manifest);
    return { result: { clip: next.clip }, changedOperationIds: [] };
  },

  move_clip(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ clipId: z.string().min(1), timelineStart: z.number().nonnegative() }).parse(params);
    const next = moveClip(load(ctx), parsed as { clipId: string; timelineStart: number });
    save(ctx, next.manifest);
    return { result: { clip: next.clip }, changedOperationIds: [] };
  },

  trim_clip(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ clipId: z.string().min(1), sourceStart: z.number().nonnegative(), sourceEnd: z.number().nonnegative() }).parse(params);
    const next = trimClip(load(ctx), parsed as { clipId: string; sourceStart: number; sourceEnd: number });
    save(ctx, next.manifest);
    return { result: { clip: next.clip }, changedOperationIds: [] };
  },

  remove_clip(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ clipId: z.string().min(1) }).parse(params);
    const next = removeClip(load(ctx), parsed as { clipId: string });
    save(ctx, next.manifest);
    return { result: { clip: next.clip }, changedOperationIds: [] };
  },

  detach_audio(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ clipId: z.string().min(1), detachedClipId: z.string().min(1).optional() }).parse(params);
    const next = detachAudioInWorkspace(ctx.workspacePath, parsed as { clipId: string; detachedClipId?: string });
    return { result: { videoClip: next.videoClip, audioClip: next.audioClip, audioTrack: next.audioTrack, asset: next.asset }, changedOperationIds: [] };
  },

  add_asset(ctx: AgentToolContext, params: unknown) {
    const asset = AssetSchema.parse(params);
    const next = addAsset(load(ctx), asset);
    save(ctx, next.manifest);
    return { result: { asset: next.asset }, changedOperationIds: [] };
  },

  remove_asset(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ assetId: z.string().min(1) }).parse(params);
    const next = removeAsset(load(ctx), parsed as { assetId: string });
    save(ctx, next.manifest);
    return { result: { asset: next.asset }, changedOperationIds: [] };
  },

  update_asset(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ assetId: z.string().min(1), patch: AssetSchema.omit({ assetId: true }).partial() }).parse(params);
    const next = updateAsset(load(ctx), parsed as { assetId: string; patch: Partial<z.infer<typeof AssetSchema>> });
    save(ctx, next.manifest);
    return { result: { asset: next.asset }, changedOperationIds: [] };
  },

  propose_outputs(ctx: AgentToolContext, params: unknown = {}) {
    z.object({}).parse(params);
    const transcript = TranscriptWordsSchema.parse(JSON.parse(readFileSync(join(ctx.workspacePath, 'transcript/words.json'), 'utf8')));
    return { result: { outputs: proposeOutputs(load(ctx), transcript) }, changedOperationIds: [] };
  }
} satisfies Record<string, AgentToolHandler>;

export type AgentToolName = keyof typeof agentToolHandlers;

export function runAgentTool(ctx: AgentToolContext, tool: AgentToolName, params: unknown): AgentToolHandlerResult {
  const handler = agentToolHandlers[tool];
  if (!handler) throw new Error(`Unknown agent tool: ${tool}`);
  return handler(ctx, params);
}
