import { z } from 'zod';
import { ClipSpanTargetSchema, defineOperationSchema, type OperationKind } from './base';

export const TranscriptAmendOperationSchema = defineOperationSchema('transcript_amend', ClipSpanTargetSchema, {
  amendedText: z.string().min(1)
});

export type TranscriptAmendOperation = z.infer<typeof TranscriptAmendOperationSchema>;

export const transcriptAmendOperationKind: OperationKind<typeof TranscriptAmendOperationSchema> = {
  type: 'transcript_amend',
  schema: TranscriptAmendOperationSchema,
  targetKind: 'clip-span',
  precedence: 5,
  conflictsWith: ['cut'] as const,
  affectsTimeline: false,
  validateLocal(op, ctx) {
    const duration = (ctx.clip?.sourceEnd ?? 0) - (ctx.clip?.sourceStart ?? 0);
    return op.target.end > duration ? [`${op.id}: operation ends after clip ${op.target.clipId} duration ${duration}`] : [];
  },
  transcriptView(op) {
    return { kind: 'transcript_amend', label: 'Amended', tone: 'neutral', operationId: op.id, status: op.status, start: op.target.start, end: op.target.end, details: { text: op.amendedText } };
  },
  timelineView(op) {
    return { kind: 'transcript_amend', label: 'Amended', tone: 'neutral', operationId: op.id, trackId: op.target.trackId, clipId: op.target.clipId, start: op.target.start, end: op.target.end, details: { amendedText: op.amendedText } };
  }
};
