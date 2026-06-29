import { describe, expect, it, vi } from 'vitest';
import { buildClipTimeline, loadWaveformPeaks, projectWordToOutput } from './waveform';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}
function notFound(): Response { return new Response('not found', { status: 404 }); }

const clipDoc = { resolutionHz: 100, durationSec: 0.4, channels: 1 as const, peaks: [[-0.2, 0.2] as [number, number]] };

describe('timeline waveform helpers', () => {
  it('builds a two-clip output timeline with labels/divider positions and projects words across the boundary', () => {
    const timeline = buildClipTimeline([
      { clipId: 'clip_001', sourceStart: 0, sourceEnd: 30 },
      { clipId: 'clip_002', sourceStart: 0, sourceEnd: 12 }
    ], [
      { clipId: 'clip_001', sha256: 'abcdef123456', durationSec: 30, fps: 30, width: 1920, height: 1080, videoCodec: 'h264' },
      { clipId: 'clip_002', sha256: '0123456789ab', durationSec: 12, fps: 60, width: 1280, height: 720, videoCodec: 'vp9' }
    ]);

    expect(timeline.map((clip) => `${clip.clipId} · ${clip.durationSec.toFixed(0)}s`)).toEqual(['clip_001 · 30s', 'clip_002 · 12s']);
    expect(timeline[1].outputStartOffset).toBe(30);
    expect(timeline[0].outputEndOffset).toBe(timeline[1].outputStartOffset);
    expect(projectWordToOutput({ id: 'w1', text: 'last', start: 29.8, end: 30, clipId: 'clip_001' }, timeline).end).toBe(30);
    expect(projectWordToOutput({ id: 'w2', text: 'first', start: 0, end: 0.2, clipId: 'clip_002' }, timeline).start).toBe(30);
  });

  it('returns empty without fetching when projectId is blank', async () => {
    const fetchFn = vi.fn();
    await expect(loadWaveformPeaks(fetchFn as unknown as typeof fetch, 'http://api', '   ', ['clip_a'])).resolves.toEqual({ kind: 'empty' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns per-clip peaks without hitting legacy when any per-clip succeeds', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(clipDoc)).mockResolvedValueOnce(notFound());
    const result = await loadWaveformPeaks(fetchFn as unknown as typeof fetch, 'http://api', 'p1', ['clip_a', 'clip_b']);
    expect(result).toEqual({ kind: 'per-clip', clipPeaks: { clip_a: clipDoc } });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('reports empty when there are no clips', async () => {
    const fetchFn = vi.fn();
    await expect(loadWaveformPeaks(fetchFn as unknown as typeof fetch, 'http://api', 'p1', [])).resolves.toEqual({ kind: 'empty' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reports empty when all per-clip requests 404', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(notFound());
    await expect(loadWaveformPeaks(fetchFn as unknown as typeof fetch, 'http://api', 'p1', ['clip_a'])).resolves.toEqual({ kind: 'empty' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('encodes project and clip ids in peak URLs', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(notFound());
    await expect(loadWaveformPeaks(fetchFn as unknown as typeof fetch, 'http://api', 'project/one', ['clip one/α'])).resolves.toEqual({ kind: 'empty' });
    expect(fetchFn).toHaveBeenNthCalledWith(1, 'http://api/api/projects/project%2Fone/peaks/clip%20one%2F%CE%B1');
  });
});
