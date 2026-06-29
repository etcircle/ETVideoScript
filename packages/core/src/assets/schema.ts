import { z } from 'zod';

export const AssetProvenanceSchema = z.enum(['imported', 'recorded', 'generated']);

export const VideoMetadataSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  codec: z.string().min(1).optional(),
  pixelFormat: z.string().min(1).optional()
});

export const AudioMetadataSchema = z.object({
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  codec: z.string().min(1).optional()
});

export const AssetSchema = z.object({
  assetId: z.string().min(1),
  kind: z.enum(['video', 'audio', 'image']),
  path: z.string().min(1),
  durationSec: z.number().nonnegative(),
  provenance: AssetProvenanceSchema,
  providerRequestId: z.string().min(1).optional(),
  video: VideoMetadataSchema.optional(),
  audio: AudioMetadataSchema.optional()
});

export type Asset = z.infer<typeof AssetSchema>;
