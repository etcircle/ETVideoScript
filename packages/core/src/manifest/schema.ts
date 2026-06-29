import { z } from 'zod';
import { AssetSchema } from '../assets/schema';
import { OperationSchema } from '../operations/registry';
import { OutputSchema } from '../outputs/schema';
import { TrackSchema } from '../tracks/schema';

export const RenderPresetSchema = z.object({
  resolution: z.string(),
  videoBitrate: z.string(),
  audioBitrate: z.string()
});

export const RenderPresetsSchema = z.object({
  draft: RenderPresetSchema,
  youtube: RenderPresetSchema
});

/**
 * Project-level studio-sound cleanup record.  A top-level FIELD (not an
 * OperationKind) because no op target spans the whole recording; using a
 * field avoids the heavy registry/renderContribution/pipeline machinery.
 *
 * When status is 'approved', buildRenderPlan swaps the base audio source to
 * assetPath. Set status to 'disabled' to revert without losing the record.
 * The cleaned asset is additive — original asset record is always retained.
 */
export const StudioCleanupSchema = z.object({
  /** 'approved' → render uses cleaned audio. 'disabled' → reverted, original used. */
  status: z.enum(['approved', 'disabled', 'pending', 'rejected']),
  /** Workspace-relative path to the cleaned WAV, e.g. "assets/studio-clean/<cacheKey>.wav". */
  assetPath: z.string().min(1),
  /** SHA-256 hex of the source audio at the time of cleaning. Dedup key. */
  cacheKey: z.string().min(1),
  /** Provider id, e.g. "studio-sound.elevenlabs-isolation". */
  provider: z.string().min(1),
  /** Provider-specific request/result id, if available. */
  providerId: z.string().optional(),
  /** ISO timestamp of when this record was created. */
  createdAt: z.string().datetime(),
  /** Estimated USD cost of the isolation call. */
  costUsd: z.number().nonnegative().optional()
});

export type StudioCleanup = z.infer<typeof StudioCleanupSchema>;

export const ManifestV3Schema = z.object({
  manifestVersion: z.literal(3),
  projectId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  assets: z.array(AssetSchema),
  tracks: z.array(TrackSchema),
  operations: z.array(OperationSchema),
  outputs: z.array(OutputSchema),
  renderPresets: RenderPresetsSchema,
  brandPackId: z.string().min(1).optional(),
  /** Optional project-level studio-sound cleanup. Absent = no cleanup applied. */
  studioCleanup: StudioCleanupSchema.optional()
});

export type ManifestV3 = z.infer<typeof ManifestV3Schema>;
