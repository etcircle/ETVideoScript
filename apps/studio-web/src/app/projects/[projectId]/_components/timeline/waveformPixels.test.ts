import { describe, expect, it } from 'vitest';
import { peaksToPixels } from './waveformPixels';

describe('peaksToPixels', () => {
  it('projects visible peak pairs to x/y bars', () => {
    const pixels = peaksToPixels({ peaks: [[-1, 1], [-0.5, 0.5], [0, 0.25]], resolutionHz: 1, viewportStartSec: 0, visibleDurationSec: 3, width: 300, height: 100 });
    expect(pixels).toEqual([
      { x: 0, yMin: 8, yMax: 92, timeSec: 0 },
      { x: 100, yMin: 29, yMax: 71, timeSec: 1 },
      { x: 200, yMin: 40, yMax: 50, timeSec: 2 }
    ]);
  });

  it('clips to the requested viewport and rejects invalid dimensions', () => {
    expect(peaksToPixels({ peaks: [[-1, 1], [-1, 1], [-1, 1]], resolutionHz: 1, viewportStartSec: 1, visibleDurationSec: 1, width: 100, height: 100 }).map((p) => p.timeSec)).toEqual([1]);
    expect(peaksToPixels({ peaks: [], resolutionHz: 1, viewportStartSec: 0, visibleDurationSec: 1, width: 100, height: 100 })).toEqual([]);
  });
});
