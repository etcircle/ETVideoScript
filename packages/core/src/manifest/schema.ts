import { z } from 'zod';
import { AssetSchema } from '../assets/schema';
import { OperationSchema } from '../operations/registry';
import { OutputSchema } from '../outputs/schema';
import { TrackSchema } from '../tracks/schema';
import { ComposeStateSchema, TakeGroupSchema } from '../takes/schema';

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
  costUsd: z.number().nonnegative().optional(),
  /**
   * Value fingerprint (channelFixFingerprint of input/source.mp4's audioChannelFix) of
   * the channel-mix state the SOURCE AUDIO was in when this cleanup was generated.
   * buildRenderPlan compares this against the CURRENT fingerprint to detect staleness —
   * a value comparison, not appliedAt/createdAt timestamp ordering, so it can't be fooled
   * by a same-value re-apply churning a timestamp or a same-millisecond race. Optional
   * for back-compat: a record from before this field existed is treated as stale only
   * when an audioChannelFix record actually exists (see render/plan.ts).
   */
  audioChannelFixFingerprint: z.string().optional()
});

export type StudioCleanup = z.infer<typeof StudioCleanupSchema>;

/**
 * Project-level single-channel-mic fix. Some recordings land the mic on only
 * one stereo channel (speech on L or R, silence on the other). A top-level
 * FIELD (not an OperationKind) for the same reason as studioCleanup: it is a
 * property of the whole recording, not of a clip span.
 *
 * When status is 'approved':
 *   - extraction reads ONLY the live channel (pan=mono) instead of -ac 1
 *     averaging the dead channel in,
 *   - buildRenderPlan sets audioSourceChannel so the pipeline duplicates the
 *     live channel to both L and R (pan=stereo).
 * Set status to 'disabled' to revert without losing the record.
 */
export const AudioChannelFixSchema = z.object({
  /** 'approved' → extraction + render use sourceChannel. 'disabled' → inert, record retained. */
  status: z.enum(['approved', 'disabled']),
  /** Which input channel carries the real audio. */
  sourceChannel: z.enum(['left', 'right']),
  /** Measured per-channel RMS at decision time; auto=false means the user forced the channel. */
  detection: z.object({ leftRmsDb: z.number(), rightRmsDb: z.number(), auto: z.boolean() }),
  /** ISO timestamp of when this record was created OR last changed (apply, re-apply, disable). */
  appliedAt: z.string().datetime()
});

export type AudioChannelFix = z.infer<typeof AudioChannelFixSchema>;

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
  studioCleanup: StudioCleanupSchema.optional(),
  /** Optional project-level single-channel-mic fix. Absent = stereo source untouched. */
  audioChannelFix: AudioChannelFixSchema.optional(),
  /** Candidate take groups awaiting composition into the timeline. Empty = no multi-take workflow in progress. */
  takeGroups: z.array(TakeGroupSchema).default([]),
  /** Fingerprint of the last successful take-group composition, if any. */
  composeState: ComposeStateSchema.optional()
});

export type ManifestV3 = z.infer<typeof ManifestV3Schema>;
