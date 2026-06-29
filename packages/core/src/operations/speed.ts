import { z } from 'zod';
import { outputRangeForClipSourceSpan } from '../timeMap/project';
import type { TimeMapSegment } from '../timeMap/types';
import { ClipSpanTargetSchema, defineOperationSchema, type OperationKind } from './base';

export const SpeedRateSchema = z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]);

export const SpeedOperationSchema = defineOperationSchema('speed', ClipSpanTargetSchema, {
  rate: SpeedRateSchema,
  bed: z.enum(['music', 'silence', 'pitched']).default('pitched')
});

export type SpeedOperation = z.infer<typeof SpeedOperationSchema>;

const EPSILON = 1e-9;

function sortSegments(segments: TimeMapSegment[]): TimeMapSegment[] {
  return [...segments].sort((a, b) => a.outputStart - b.outputStart || a.outputEnd - b.outputEnd || a.trackId.localeCompare(b.trackId) || a.clipId.localeCompare(b.clipId));
}

function applySpeedToSegment(segments: TimeMapSegment[], target: TimeMapSegment, speedStart: number, speedEnd: number, rate: number): TimeMapSegment[] {
  const clippedStart = Math.max(speedStart, target.sourceStart);
  const clippedEnd = Math.min(speedEnd, target.sourceEnd);
  const originalOutStart = target.outputStart + ((clippedStart - target.sourceStart) / target.rate);
  const originalOutEnd = target.outputStart + ((clippedEnd - target.sourceStart) / target.rate);
  const originalDuration = originalOutEnd - originalOutStart;
  const spedRate = target.rate * rate;
  const spedDuration = (clippedEnd - clippedStart) / spedRate;
  const saved = originalDuration - spedDuration;

  const next: TimeMapSegment[] = [];
  for (const segment of segments) {
    if (segment.trackId !== target.trackId) {
      next.push(segment);
      continue;
    }

    if (segment === target) {
      if (target.sourceStart < clippedStart) next.push({ ...target, sourceEnd: clippedStart, outputEnd: originalOutStart });
      next.push({ ...target, sourceStart: clippedStart, sourceEnd: clippedEnd, outputStart: originalOutStart, outputEnd: originalOutStart + spedDuration, rate: spedRate });
      if (clippedEnd < target.sourceEnd) {
        next.push({
          ...target,
          sourceStart: clippedEnd,
          outputStart: originalOutStart + spedDuration,
          outputEnd: originalOutStart + spedDuration + ((target.sourceEnd - clippedEnd) / target.rate)
        });
      }
      continue;
    }

    if (segment.outputStart >= originalOutEnd - EPSILON) {
      next.push({ ...segment, outputStart: segment.outputStart - saved, outputEnd: segment.outputEnd - saved });
    } else {
      next.push(segment);
    }
  }
  return sortSegments(next);
}

export const speedOperationKind: OperationKind<typeof SpeedOperationSchema> = {
  type: 'speed',
  schema: SpeedOperationSchema,
  targetKind: 'clip-span',
  precedence: 20,
  conflictsWith: ['voice_patch'],
  affectsTimeline: true,
  validateLocal(op, ctx) {
    const duration = (ctx.clip?.sourceEnd ?? 0) - (ctx.clip?.sourceStart ?? 0);
    return op.target.end > duration ? [`${op.id}: operation ends after clip ${op.target.clipId} duration ${duration}`] : [];
  },
  projectTimeMap(op, map) {
    let segments = sortSegments(map.segments);
    const processed: Array<{ sourceStart: number; sourceEnd: number }> = [];
    while (true) {
      const target = segments.find((segment) =>
        segment.trackId === op.target.trackId &&
        segment.clipId === op.target.clipId &&
        op.target.start < segment.sourceEnd &&
        op.target.end > segment.sourceStart &&
        !processed.some((span) => segment.sourceStart >= span.sourceStart - EPSILON && segment.sourceEnd <= span.sourceEnd + EPSILON)
      );
      if (!target) return { segments };
      processed.push({ sourceStart: Math.max(op.target.start, target.sourceStart), sourceEnd: Math.min(op.target.end, target.sourceEnd) });
      segments = applySpeedToSegment(segments, target, op.target.start, op.target.end, op.rate);
    }
  },
  renderContribution(op, ctx) {
    const range = outputRangeForClipSourceSpan(ctx.timeMap, op.target.clipId, op.target.start, op.target.end);
    if (!range) return null; // target was cut out of the timeline — speed bed is a no-op
    return { kind: 'audio-bed', bed: op.bed, range };
  },
  transcriptView(op) {
    return { kind: 'speed', label: `${op.rate}×`, tone: 'info', operationId: op.id, status: op.status, start: op.target.start, end: op.target.end, details: { rate: op.rate, bed: op.bed } };
  },
  timelineView(op) {
    return { kind: 'speed', label: `Speed ${op.rate}×`, tone: 'info', operationId: op.id, trackId: op.target.trackId, clipId: op.target.clipId, start: op.target.start, end: op.target.end, details: { rate: op.rate, bed: op.bed } };
  }
};
