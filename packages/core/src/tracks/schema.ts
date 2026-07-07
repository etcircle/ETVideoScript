import { z } from 'zod';

export const TransitionAfterSchema = z.object({
  type: z.string().min(1),
  durationMs: z.number().int().nonnegative()
});

export const ClipSchema = z.object({
  clipId: z.string().min(1),
  assetId: z.string().min(1),
  sourceStart: z.number().nonnegative(),
  sourceEnd: z.number().nonnegative(),
  timelineStart: z.number().nonnegative(),
  audioDetached: z.boolean().optional(),
  detachedFrom: z.string().min(1).optional(),
  transitionAfter: TransitionAfterSchema.optional()
}).refine((clip) => clip.sourceStart < clip.sourceEnd, {
  message: 'clip sourceStart must be < sourceEnd',
  path: ['sourceEnd']
});

export const TrackFxSchema = z.object({
  enhance: z.boolean().default(false),
  denoise: z.boolean().default(false),
  dereverb: z.boolean().default(false)
});

export const TrackSchema = z.object({
  trackId: z.string().min(1),
  kind: z.enum(['video', 'audio', 'caption']),
  subtype: z.enum(['dialog', 'music', 'sfx', 'voiceover']).optional(),
  name: z.string().min(1),
  order: z.number().int(),
  locked: z.boolean().default(false),
  muted: z.boolean().default(false),
  solo: z.boolean().default(false),
  hidden: z.boolean().default(false),
  role: z.enum(['timeline', 'staging']).default('timeline'),
  fx: TrackFxSchema.optional(),
  clips: z.array(ClipSchema)
}).superRefine((track, ctx) => {
  if (track.kind !== 'audio' && track.subtype) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subtype'], message: 'subtype is only valid for audio tracks' });
  }
});

export type Clip = z.infer<typeof ClipSchema>;
export type Track = z.infer<typeof TrackSchema>;
