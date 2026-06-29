import { z } from 'zod';
import { TrackTargetSchema, defineOperationSchema, type OperationKind } from './base';

export const CaptionStyleOperationSchema = defineOperationSchema('caption_style', TrackTargetSchema, {
  styleId: z.string().min(1),
  fontFamily: z.string().min(1).optional(),
  fontSize: z.number().positive().optional(),
  color: z.string().min(1).optional()
});

export type CaptionStyleOperation = z.infer<typeof CaptionStyleOperationSchema>;

export const captionStyleOperationKind: OperationKind<typeof CaptionStyleOperationSchema> = {
  type: 'caption_style',
  schema: CaptionStyleOperationSchema,
  targetKind: 'track',
  precedence: 60,
  affectsTimeline: false,
  validateLocal(op, ctx) {
    return ctx.track.kind === 'caption' ? [] : [`${op.id}: caption_style applies only to caption tracks`];
  },
  renderContribution(op, ctx) {
    const end = Math.max(0, ...ctx.timeMap.segments.map((segment) => segment.outputEnd));
    return { kind: 'caption-burn', styleId: op.styleId, range: { start: 0, end } };
  },
  transcriptView() {
    return null;
  },
  timelineView(op) {
    return { kind: 'caption_style', label: `Captions: ${op.styleId}`, tone: 'neutral', operationId: op.id, trackId: op.target.trackId, details: { styleId: op.styleId, fontFamily: op.fontFamily, fontSize: op.fontSize, color: op.color } };
  }
};
