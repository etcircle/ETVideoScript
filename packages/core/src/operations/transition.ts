import { z } from 'zod';
import { ClipBoundaryTargetSchema, defineOperationSchema, type OperationKind } from './base';

export const TransitionOperationSchema = defineOperationSchema('transition', ClipBoundaryTargetSchema, {
  transitionType: z.enum(['crossfade', 'fade', 'dip-to-black']).default('crossfade'),
  durationMs: z.number().int().positive()
});

export type TransitionOperation = z.infer<typeof TransitionOperationSchema>;

export const transitionOperationKind: OperationKind<typeof TransitionOperationSchema> = {
  type: 'transition',
  schema: TransitionOperationSchema,
  targetKind: 'clip-boundary',
  precedence: 50,
  affectsTimeline: false,
  validateLocal(op, ctx) {
    const errors: string[] = [];
    if (!ctx.clip) return [`${op.id}: transition target clip is missing`];
    const lastClip = [...ctx.track.clips].sort((a, b) => b.timelineStart - a.timelineStart)[0];
    if (lastClip?.clipId === ctx.clip.clipId) errors.push(`${op.id}: transition boundary after clip ${op.target.clipId} has no following clip`);
    const following = ctx.track.clips.filter((clip) => clip.timelineStart > ctx.clip!.timelineStart).sort((a, b) => a.timelineStart - b.timelineStart)[0];
    if (following) {
      const currentDurationMs = Math.max((ctx.clip.sourceEnd - ctx.clip.sourceStart) * 1000, 0);
      const nextDurationMs = Math.max((following.sourceEnd - following.sourceStart) * 1000, 0);
      if (op.durationMs > Math.max(currentDurationMs, nextDurationMs) * 2) errors.push(`${op.id}: transition duration ${op.durationMs}ms is too large for adjoining clips`);
    }
    return errors;
  },
  renderContribution(op, ctx) {
    const segments = ctx.timeMap.segments.filter((segment) => segment.clipId === op.target.clipId);
    if (!segments.length) return null; // target clip was cut — transition is a no-op
    const boundary = Math.max(...segments.map((segment) => segment.outputEnd));
    return { kind: 'transition', boundary, transitionType: op.transitionType, durationMs: op.durationMs };
  },
  transcriptView() {
    return null;
  },
  timelineView(op) {
    return { kind: 'transition', label: op.transitionType, tone: 'info', operationId: op.id, trackId: op.target.trackId, clipId: op.target.clipId, details: { transitionType: op.transitionType, durationMs: op.durationMs } };
  }
};
