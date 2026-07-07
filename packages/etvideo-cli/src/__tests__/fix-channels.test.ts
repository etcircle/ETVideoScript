import { describe, expect, it } from 'vitest';
import { handleFixChannelsCommand, type CliHandlerDeps } from '../index';

// applyChannelFix/analyzeChannelBalance's own logic is exhaustively tested at the
// @etvideo/core level. This exercises the CLI wiring: summary text per outcome,
// detachedClipIds computation, and that the manifest never leaks into printed JSON.
describe('handleFixChannelsCommand', () => {
  function deps(overrides: Partial<CliHandlerDeps> = {}) {
    const printed: unknown[] = [];
    const base: CliHandlerDeps = {
      extractClipAudio: (() => { throw new Error('not used'); }) as any,
      extractAllClipAudio: (() => { throw new Error('not used'); }) as any,
      extractClipWaveformPeaks: (() => { throw new Error('not used'); }) as any,
      extractAllClipWaveformPeaks: (() => { throw new Error('not used'); }) as any,
      applyChannelFix: (() => { throw new Error('override applyChannelFix per test'); }) as any,
      analyzeChannelBalance: (() => { throw new Error('override analyzeChannelBalance per test'); }) as any,
      print: ((value: unknown) => { printed.push(value); }) as any,
      ...overrides
    };
    return { deps: base, printed };
  }

  const manifestWithDetachedClip = {
    tracks: [
      { clips: [{ clipId: 'clip_001', audioDetached: true }, { clipId: 'clip_002', audioDetached: false }] }
    ]
  } as any;

  it('prints the applied summary and lists clips needing a detach-audio refresh', () => {
    const ctx = deps({
      applyChannelFix: (() => ({
        action: 'applied',
        fix: { status: 'approved', sourceChannel: 'left', detection: { leftRmsDb: -18, rightRmsDb: -70, auto: true }, appliedAt: '2026-07-07T00:00:00.000Z' },
        balance: { channels: 2, leftRmsDb: -18, rightRmsDb: -70, recommendation: 'left' },
        manifest: manifestWithDetachedClip
      })) as any
    });

    handleFixChannelsCommand({}, { workspace: '/tmp/ws', json: false }, ctx.deps);

    expect(ctx.printed[0]).toContain('Channel fix applied: left');
    expect(ctx.printed[0]).toContain('detach-audio');
    expect(ctx.printed[0]).toContain('clip_001');
    expect(ctx.printed[0]).not.toContain('clip_002');
  });

  it('JSON output includes detachedClipsNeedingRefresh but never leaks the manifest', () => {
    const ctx = deps({
      applyChannelFix: (() => ({ action: 'disabled', fix: { status: 'disabled', sourceChannel: 'left', detection: { leftRmsDb: -18, rightRmsDb: -70, auto: true }, appliedAt: 'x' }, manifest: manifestWithDetachedClip })) as any
    });

    handleFixChannelsCommand({ disable: true }, { workspace: '/tmp/ws', json: true }, ctx.deps);

    const payload = ctx.printed[0] as { action: string; manifest?: unknown; detachedClipsNeedingRefresh?: string[] };
    expect(payload.action).toBe('disabled');
    expect(payload.manifest).toBeUndefined();
    expect(payload.detachedClipsNeedingRefresh).toEqual(['clip_001']);
  });

  it('reports unchanged/none outcomes without computing detachedClipIds', () => {
    const ctx = deps({
      applyChannelFix: (() => ({ action: 'unchanged', reason: 'existing audioChannelFix preserved', manifest: manifestWithDetachedClip })) as any
    });

    handleFixChannelsCommand({}, { workspace: '/tmp/ws', json: true }, ctx.deps);

    const payload = ctx.printed[0] as { detachedClipsNeedingRefresh?: string[] };
    expect(payload.detachedClipsNeedingRefresh).toBeUndefined();
  });

  it('--detect-only prints balance without calling applyChannelFix', () => {
    const ctx = deps({
      analyzeChannelBalance: (() => ({ channels: 2, leftRmsDb: -18, rightRmsDb: -80, recommendation: 'left' })) as any
    });

    const result = handleFixChannelsCommand({ detectOnly: true }, { workspace: '/tmp/ws', json: true }, ctx.deps);

    expect(result).toEqual({ channels: 2, leftRmsDb: -18, rightRmsDb: -80, recommendation: 'left' });
    expect(ctx.printed[0]).toEqual(result);
  });

  it('rejects an invalid --channel value before calling applyChannelFix', () => {
    const ctx = deps();
    expect(() => handleFixChannelsCommand({ channel: 'up' }, { workspace: '/tmp/ws' }, ctx.deps)).toThrow('--channel must be left or right');
  });
});
