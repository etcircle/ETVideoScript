import type { TimeMapSegment } from './types';

export function sortSegments(segments: TimeMapSegment[]): TimeMapSegment[] {
  return [...segments].sort((a, b) => a.outputStart - b.outputStart || a.outputEnd - b.outputEnd || a.trackId.localeCompare(b.trackId) || a.clipId.localeCompare(b.clipId));
}
