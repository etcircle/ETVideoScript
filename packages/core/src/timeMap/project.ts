import type { TimeMap } from './types';

const EPSILON = 1e-9;

export function outputTime(timeMap: TimeMap, clipId: string, sourceTime: number): number | null {
  for (const segment of [...timeMap.segments].sort((a, b) => a.outputStart - b.outputStart || a.outputEnd - b.outputEnd || a.trackId.localeCompare(b.trackId) || a.clipId.localeCompare(b.clipId))) {
    if (segment.clipId !== clipId) continue;
    if (sourceTime >= segment.sourceStart && sourceTime < segment.sourceEnd) {
      return segment.outputStart + ((sourceTime - segment.sourceStart) / segment.rate);
    }
    if (Math.abs(sourceTime - segment.sourceEnd) < EPSILON) return segment.outputEnd;
  }
  return null;
}

export function outputRangeForClipSourceSpan(timeMap: TimeMap, clipId: string, start: number, end: number): { start: number; end: number } | null {
  const outputStart = outputTime(timeMap, clipId, start);
  const outputEnd = outputTime(timeMap, clipId, end);
  if (outputStart == null || outputEnd == null) return null;
  // Reject inversions outright (outputEnd meaningfully less than outputStart).
  if (outputEnd < outputStart - EPSILON) return null;
  // Accept a degenerate (zero-width) output range ONLY when the source span is
  // itself degenerate. A non-degenerate source span (start < end) that collapsed
  // to zero output means the range was removed by an upstream op — typically a
  // cut — and treating it as content would leak a min-duration blip into the
  // render via `Math.max(end - start, 0.01)` in pipeline.ts for silence /
  // audio-insert / audio-bed stages. The seam case Chunk B needs is the
  // degenerate-source case, not this one. (Eng review P2 from Codex, 2026-05-22.)
  const sourceDegenerate = Math.abs(end - start) < EPSILON;
  const outputDegenerate = Math.abs(outputEnd - outputStart) < EPSILON;
  if (outputDegenerate && !sourceDegenerate) return null;
  return { start: outputStart, end: outputEnd };
}
