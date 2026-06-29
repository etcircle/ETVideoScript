export type PeakPair = [number, number];

export type PeakPixel = {
  x: number;
  yMin: number;
  yMax: number;
  timeSec: number;
};

export function peaksToPixels(input: {
  peaks: PeakPair[];
  resolutionHz: number;
  viewportStartSec: number;
  visibleDurationSec: number;
  width: number;
  height: number;
}): PeakPixel[] {
  const { peaks, resolutionHz, viewportStartSec, visibleDurationSec, width, height } = input;
  if (!peaks.length || resolutionHz <= 0 || visibleDurationSec <= 0 || width <= 0 || height <= 0) return [];
  const startIndex = Math.max(0, Math.floor(viewportStartSec * resolutionHz));
  const endIndex = Math.min(peaks.length, Math.ceil((viewportStartSec + visibleDurationSec) * resolutionHz));
  const centerY = height / 2;
  const halfHeight = height * 0.42;
  const pixels: PeakPixel[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const [min, max] = peaks[index]!;
    const timeSec = index / resolutionHz;
    const x = Math.round(((timeSec - viewportStartSec) / visibleDurationSec) * width);
    pixels.push({ x, yMin: Math.round(centerY - max * halfHeight), yMax: Math.round(centerY - min * halfHeight), timeSec });
  }
  return pixels;
}
