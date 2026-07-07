import type { Operation } from '../operations/registry';
import { getOperationKind } from '../operations/registry';
import type { Track } from '../tracks/schema';
import type { TimeMap, TimeMapSegment } from './types';
import { sortSegments } from './sort';
export { sortSegments } from './sort';
export { outputRangeForClipSourceSpan, outputTime } from './project';

const EPSILON = 1e-9;

export function buildBaseTimeline(tracks: Track[]): TimeMap {
  const renderable = tracks.filter((track) => track.role !== 'staging');
  const segments = renderable.flatMap((track) => track.clips.map((clip) => {
    const duration = clip.sourceEnd - clip.sourceStart;
    return {
      trackId: track.trackId,
      clipId: clip.clipId,
      sourceStart: 0,
      sourceEnd: duration,
      outputStart: clip.timelineStart,
      outputEnd: clip.timelineStart + duration,
      rate: 1
    } satisfies TimeMapSegment;
  }));
  return { segments: sortSegments(segments) };
}


export function composeTimeMap(tracks: Track[], operations: Operation[]): TimeMap {
  let map = buildBaseTimeline(tracks);
  const timelineOps = operations
    .filter((op) => op.status === 'approved')
    .map((op) => ({ op, kind: getOperationKind(op.type) }))
    .filter(({ kind }) => kind.affectsTimeline)
    .sort((a, b) => {
      const at = a.op.target;
      const bt = b.op.target;
      const aStart = at.kind === 'clip-span' ? at.start : 0;
      const bStart = bt.kind === 'clip-span' ? bt.start : 0;
      return at.trackId.localeCompare(bt.trackId) ||
        ('clipId' in at ? at.clipId : '').localeCompare('clipId' in bt ? bt.clipId : '') ||
        aStart - bStart ||
        b.kind.precedence - a.kind.precedence ||
        a.op.id.localeCompare(b.op.id);
    });

  for (const { op, kind } of timelineOps) {
    if (!kind.projectTimeMap) throw new Error(`${kind.type} affects timeline but has no projectTimeMap hook`);
    map = kind.projectTimeMap(op, map);
  }
  return map;
}

export function sourceTimeAt(timeMap: TimeMap, output: number): { trackId: string; clipId: string; sourceTime: number } | null {
  for (const segment of sortSegments(timeMap.segments)) {
    if (output >= segment.outputStart && output < segment.outputEnd) {
      return {
        trackId: segment.trackId,
        clipId: segment.clipId,
        sourceTime: segment.sourceStart + ((output - segment.outputStart) * segment.rate)
      };
    }
    if (Math.abs(output - segment.outputEnd) < EPSILON) {
      return { trackId: segment.trackId, clipId: segment.clipId, sourceTime: segment.sourceEnd };
    }
  }
  return null;
}
