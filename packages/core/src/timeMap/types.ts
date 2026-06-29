export interface TimeMapSegment {
  trackId: string;
  clipId: string;
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  rate: number;
  freezeTailSec?: number;
}

export interface TimeMap {
  segments: TimeMapSegment[];
}
