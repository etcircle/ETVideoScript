import { z } from 'zod';
import type { TimeMapSegment } from '../timeMap/types';
import { ClipSpanTargetSchema, defineOperationSchema, type OperationKind } from './base';

export const CutOperationSchema = defineOperationSchema('cut', ClipSpanTargetSchema, {});

export type CutOperation = z.infer<typeof CutOperationSchema>;

const EPSILON = 1e-9;

function sortSegments(segments: TimeMapSegment[]): TimeMapSegment[] {
  return [...segments].sort((a, b) => a.outputStart - b.outputStart || a.outputEnd - b.outputEnd || a.trackId.localeCompare(b.trackId) || a.clipId.localeCompare(b.clipId));
}

function sourceAtOutput(segment: TimeMapSegment, outputTime: number): number {
  return segment.sourceStart + ((outputTime - segment.outputStart) * segment.rate);
}

function applyCutToSegment(segments: TimeMapSegment[], target: TimeMapSegment, cutStart: number, cutEnd: number): TimeMapSegment[] {
  const clippedStart = Math.max(cutStart, target.sourceStart);
  const clippedEnd = Math.min(cutEnd, target.sourceEnd);
  const cutOutStart = target.outputStart + ((clippedStart - target.sourceStart) / target.rate);
  const cutOutEnd = target.outputStart + ((clippedEnd - target.sourceStart) / target.rate);
  const removed = cutOutEnd - cutOutStart;

  const next: TimeMapSegment[] = [];
  for (const segment of segments) {
    if (segment === target) {
      if (target.sourceStart < clippedStart) next.push({ ...target, sourceEnd: clippedStart, outputEnd: cutOutStart });
      if (clippedEnd < target.sourceEnd) {
        next.push({
          ...target,
          sourceStart: clippedEnd,
          outputStart: cutOutStart,
          outputEnd: cutOutStart + ((target.sourceEnd - clippedEnd) / target.rate)
        });
      }
      continue;
    }

    if (segment.outputStart >= cutOutEnd - EPSILON) {
      next.push({ ...segment, outputStart: segment.outputStart - removed, outputEnd: segment.outputEnd - removed });
      continue;
    }

    if (segment.outputEnd <= cutOutStart + EPSILON || segment.outputStart >= cutOutEnd - EPSILON) {
      next.push(segment);
      continue;
    }

    const overlapStart = Math.max(segment.outputStart, cutOutStart);
    const overlapEnd = Math.min(segment.outputEnd, cutOutEnd);
    if (segment.outputStart < overlapStart - EPSILON) {
      next.push({ ...segment, sourceEnd: sourceAtOutput(segment, overlapStart), outputEnd: overlapStart });
    }
    if (segment.outputEnd > overlapEnd + EPSILON) {
      next.push({
        ...segment,
        sourceStart: sourceAtOutput(segment, overlapEnd),
        outputStart: cutOutStart,
        outputEnd: cutOutStart + (segment.outputEnd - overlapEnd)
      });
    }
  }
  return sortSegments(next);
}

export const cutOperationKind: OperationKind<typeof CutOperationSchema> = {
  type: 'cut',
  schema: CutOperationSchema,
  targetKind: 'clip-span',
  precedence: 40,
  affectsTimeline: true,
  validateLocal(op, ctx) {
    const duration = (ctx.clip?.sourceEnd ?? 0) - (ctx.clip?.sourceStart ?? 0);
    const errors: string[] = [];
    if (op.target.end > duration) errors.push(`${op.id}: operation ends after clip ${op.target.clipId} duration ${duration}`);
    return errors;
  },
  projectTimeMap(op, map) {
    const cutStart = op.target.start;
    const cutEnd = op.target.end;
    let segments = sortSegments(map.segments);
    while (true) {
      const target = segments.find((segment) =>
        segment.trackId === op.target.trackId &&
        segment.clipId === op.target.clipId &&
        cutStart < segment.sourceEnd &&
        cutEnd > segment.sourceStart
      );
      if (!target) return { segments };
      segments = applyCutToSegment(segments, target, cutStart, cutEnd);
    }
  },
  transcriptView(op) {
    return { kind: 'cut', label: 'Cut', tone: 'danger', operationId: op.id, status: op.status, start: op.target.start, end: op.target.end };
  },
  timelineView(op) {
    return { kind: 'cut', label: 'Cut', tone: 'danger', operationId: op.id, trackId: op.target.trackId, clipId: op.target.clipId, start: op.target.start, end: op.target.end };
  }
};
