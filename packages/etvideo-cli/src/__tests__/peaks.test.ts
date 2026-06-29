import { describe, expect, it } from 'vitest';
import { handlePeaksCommand, type CliHandlerDeps } from '../index';

describe('handlePeaksCommand', () => {
  function deps(overrides: Partial<CliHandlerDeps> & { extractAllClipWaveformPeaks?: any } = {}) {
    const calls: string[] = [];
    const printed: unknown[] = [];
    const base = {
      extractClipAudio: (() => { throw new Error('not used'); }) as any,
      extractAllClipAudio: (() => { throw new Error('not used'); }) as any,
      extractClipWaveformPeaks: ((workspace: string, clipId: string) => { calls.push(`clip:${workspace}:${clipId}`); return { resolutionHz: 100, peaks: [[0, 0]] }; }) as any,
      extractAllClipWaveformPeaks: ((workspace: string, options: { resolutionHz?: number }) => {
        calls.push(`all:${workspace}:${options.resolutionHz}`);
        return [
          { clipId: 'clip_001', peaks: 2 },
          { clipId: 'clip_002', peaks: 3 }
        ];
      }) as any,
      print: ((value: unknown) => { printed.push(value); }) as any,
      ...overrides
    } as CliHandlerDeps & { extractAllClipWaveformPeaks: (workspace: string, options: { resolutionHz?: number }) => Array<{ clipId: string; peaks: number }> };
    return { deps: base, calls, printed };
  }

  it('defaults to all per-clip peaks instead of legacy global peaks', () => {
    const ctx = deps();

    const result = handlePeaksCommand({ resolution: '25' }, { workspace: '/tmp/ws', json: false }, ctx.deps as any);

    expect(result).toEqual([{ clipId: 'clip_001', peaks: 2 }, { clipId: 'clip_002', peaks: 3 }]);
    expect(ctx.calls).toEqual(['all:/tmp/ws:25']);
    expect(ctx.printed[0]).toBe('Peaks ready: media/clip_001/peaks.json, media/clip_002/peaks.json');
  });

  it('uses the shared all-clips core helper for --all', () => {
    const ctx = deps({ extractClipWaveformPeaks: (() => { throw new Error('inline per-clip iteration should not be used'); }) as any });

    const result = handlePeaksCommand({ resolution: '50', all: true }, { workspace: '/tmp/ws', json: true }, ctx.deps as any);

    expect(result).toEqual([{ clipId: 'clip_001', peaks: 2 }, { clipId: 'clip_002', peaks: 3 }]);
    expect(ctx.calls).toEqual(['all:/tmp/ws:50']);
    expect(ctx.printed[0]).toEqual(result);
  });
});
