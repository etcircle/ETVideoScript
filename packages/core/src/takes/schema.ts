import { z } from 'zod';

export const TAKES_CONSTANTS = {
  MIN_CANDIDATE_COVERAGE: 0.5,
  MIN_ORPHAN_WORDS: 8,
  LOW_CONFIDENCE_MATCH_FRACTION: 0.3,
  BOUNDARY_WARN_THRESHOLD: 0.5,
  SENTENCE_GAP_SEC: 0.8,
  SPAN_MAX_WORDS: 40,
  SPAN_MIN_WORDS: 3
} as const;

export type TakesErrorCode =
  | 'TAKES_MISSING_TRANSCRIPTS' | 'TAKES_UNKNOWN_GROUP' | 'TAKES_EMPTY_GROUP'
  | 'COMPOSE_VALIDATION' | 'ALIGNMENT_STALE' | 'CHAPTERS_STALE' | 'BRIEF_INVALID';

export class TakesError extends Error {
  constructor(public readonly code: TakesErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'TakesError';
  }
}

export const TakeGroupReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('take'), clipId: z.string().min(1) }),
  z.object({ kind: z.literal('file'), path: z.string().min(1) })
]);

export const TakeGroupSchema = z.object({
  groupId: z.string().min(1),
  label: z.string().min(1),
  clipIds: z.array(z.string().min(1)).min(1),
  reference: TakeGroupReferenceSchema.optional()
});
export type TakeGroup = z.infer<typeof TakeGroupSchema>;

export const ComposeStateSchema = z.object({
  appliedAt: z.string().datetime(),
  compositionHash: z.string().min(1)
});
export type ComposeState = z.infer<typeof ComposeStateSchema>;
