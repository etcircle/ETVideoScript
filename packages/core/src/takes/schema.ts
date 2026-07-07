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

export const CandidateMetricsSchema = z.object({
  fillerCount: z.number().int().nonnegative(),
  falseStartCount: z.number().int().nonnegative(),
  wordsPerSec: z.number().nonnegative(),
  silenceRatio: z.number().min(0).max(1),
  durationSec: z.number().nonnegative(),
  headBoundaryScore: z.number().min(0).max(1),
  tailBoundaryScore: z.number().min(0).max(1)
});

export const SpanCandidateSchema = z.object({
  spanId: z.string().min(1),
  clipId: z.string().min(1),
  takeWordStart: z.number().int().nonnegative(),
  takeWordEnd: z.number().int().nonnegative(),
  tStart: z.number().nonnegative(),
  tEnd: z.number().nonnegative(),
  coverage: z.number().min(0).max(1),
  matchQuality: z.number().min(0).max(1),
  truncated: z.boolean(),
  metrics: CandidateMetricsSchema
});
export type SpanCandidate = z.infer<typeof SpanCandidateSchema>;

export const OrphanSpanSchema = z.object({
  orphanId: z.string().min(1),
  clipId: z.string().min(1),
  takeWordStart: z.number().int().nonnegative(),
  takeWordEnd: z.number().int().nonnegative(),
  tStart: z.number().nonnegative(),
  tEnd: z.number().nonnegative(),
  text: z.string().min(1)
});
export type OrphanSpan = z.infer<typeof OrphanSpanSchema>;

export const AlignmentArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  groupId: z.string().min(1),
  generatedAt: z.string().datetime(),
  reference: z.object({ kind: z.enum(['take', 'file']), clipId: z.string().min(1).optional(), path: z.string().min(1).optional() }),
  takes: z.array(z.object({
    clipId: z.string().min(1), assetId: z.string().min(1), label: z.string().min(1),
    wordCount: z.number().int().nonnegative(), matchedFraction: z.number().min(0).max(1), lowConfidence: z.boolean()
  })),
  spans: z.array(z.object({ spanId: z.string().min(1), ordinal: z.number().int().positive(), text: z.string().min(1) })),
  candidates: z.array(SpanCandidateSchema),
  orphans: z.array(OrphanSpanSchema)
});
export type AlignmentArtifact = z.infer<typeof AlignmentArtifactSchema>;

export const SelectionSchema = z.object({
  order: z.number().int().positive(),
  clipId: z.string().min(1),
  spanIds: z.array(z.string().min(1)).optional(),
  orphanId: z.string().min(1).optional(),
  trim: z.object({ headWords: z.number().int().nonnegative().default(0), tailWords: z.number().int().nonnegative().default(0) }).optional(),
  chapterTitle: z.string().min(1).optional(),
  rationale: z.string().min(1)
}).refine((s) => (s.spanIds !== undefined) !== (s.orphanId !== undefined), { message: 'exactly one of spanIds or orphanId' });
export type Selection = z.infer<typeof SelectionSchema>;

export const CompositionFileSchema = z.object({
  schemaVersion: z.literal(1),
  groupId: z.string().min(1),
  selections: z.array(SelectionSchema).min(1),
  gaps: z.array(z.object({
    spanIds: z.array(z.string().min(1)).min(1),
    action: z.enum(['voice_patch', 'drop']),
    text: z.string().optional(),
    rationale: z.string().min(1)
  })).default([])
});
export type CompositionFile = z.infer<typeof CompositionFileSchema>;
