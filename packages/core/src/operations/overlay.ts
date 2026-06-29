import { z } from 'zod';
import { outputRangeForClipSourceSpan } from '../timeMap/project';
import type { OverlaySource, Rect } from '../render/types';
import { ClipSpanTargetSchema, defineOperationSchema, type OperationKind } from './base';

export const OverlaySourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('asset'), asset: z.string().min(1) }),
  z.object({ kind: z.literal('text'), text: z.string().min(1) }),
  z.object({ kind: z.literal('shape'), shape: z.string().min(1) })
]);

export const OverlayRectSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative()
});

export const OverlayOperationSchema = defineOperationSchema('overlay', ClipSpanTargetSchema, {
  source: OverlaySourceSchema,
  zIndex: z.number().int().default(0),
  rect: OverlayRectSchema,
  opacity: z.number().min(0).max(1).default(1)
});

export type OverlayOperation = z.infer<typeof OverlayOperationSchema>;

export const overlayOperationKind: OperationKind<typeof OverlayOperationSchema> = {
  type: 'overlay',
  schema: OverlayOperationSchema,
  targetKind: 'clip-span',
  precedence: 25,
  affectsTimeline: false,
  validateLocal(op, ctx) {
    const duration = (ctx.clip?.sourceEnd ?? 0) - (ctx.clip?.sourceStart ?? 0);
    const errors: string[] = [];
    if (op.target.end > duration) errors.push(`${op.id}: operation ends after clip ${op.target.clipId} duration ${duration}`);
    if (op.source.kind === 'asset' && ctx.assetExists && !ctx.assetExists(op.source.asset)) errors.push(`${op.id}: overlay asset does not exist: ${op.source.asset}`);
    return errors;
  },
  renderContribution(op, ctx) {
    const range = outputRangeForClipSourceSpan(ctx.timeMap, op.target.clipId, op.target.start, op.target.end);
    if (!range) return null; // target was cut out of the timeline — overlay is a no-op
    const source: OverlaySource = op.source.kind === 'asset'
      ? { kind: 'asset', asset: ctx.manifest.assets.find((candidate) => candidate.assetId === (op.source as { asset: string }).asset)?.path ?? (op.source as { asset: string }).asset }
      : op.source as OverlaySource;
    return { kind: 'visual-overlay', source, zIndex: op.zIndex, rect: op.rect as Rect, opacity: op.opacity, range };
  },
  transcriptView(op) {
    return { kind: 'overlay', label: 'Overlay', tone: 'neutral', operationId: op.id, status: op.status, start: op.target.start, end: op.target.end, details: { source: op.source, zIndex: op.zIndex } };
  },
  timelineView(op) {
    return { kind: 'overlay', label: 'Overlay', tone: 'neutral', operationId: op.id, trackId: op.target.trackId, clipId: op.target.clipId, start: op.target.start, end: op.target.end, details: { source: op.source, zIndex: op.zIndex, rect: op.rect, opacity: op.opacity } };
  }
};
