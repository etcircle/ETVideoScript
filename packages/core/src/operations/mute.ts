import { z } from 'zod';
import { outputRangeForClipSourceSpan } from '../timeMap/project';
import { ClipSpanTargetSchema, defineOperationSchema, type OperationKind } from './base';

export const MuteOperationSchema = defineOperationSchema('mute', ClipSpanTargetSchema, {
  draftText: z.string().optional()
});

export type MuteOperation = z.infer<typeof MuteOperationSchema>;

export const muteOperationKind: OperationKind<typeof MuteOperationSchema> = {
  type: 'mute',
  schema: MuteOperationSchema,
  targetKind: 'clip-span',
  precedence: 30,
  affectsTimeline: false,
  validateLocal(op, ctx) {
    const duration = (ctx.clip?.sourceEnd ?? 0) - (ctx.clip?.sourceStart ?? 0);
    return op.target.end > duration ? [`${op.id}: operation ends after clip ${op.target.clipId} duration ${duration}`] : [];
  },
  renderContribution(op, ctx) {
    const range = outputRangeForClipSourceSpan(ctx.timeMap, op.target.clipId, op.target.start, op.target.end);
    if (!range) return null; // target was cut out of the timeline — mute is a no-op
    return { kind: 'silence', range };
  },
  transcriptView(op) {
    const draftText = op.draftText?.trim();
    return {
      kind: 'mute',
      label: draftText ? 'Draft' : 'Mute',
      tone: 'warning',
      operationId: op.id,
      status: op.status,
      start: op.target.start,
      end: op.target.end,
      ...(draftText ? { details: { text: draftText } } : {})
    };
  },
  timelineView(op) {
    return { kind: 'mute', label: 'Mute', tone: 'warning', operationId: op.id, trackId: op.target.trackId, clipId: op.target.clipId, start: op.target.start, end: op.target.end };
  }
};
