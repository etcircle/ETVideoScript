import { describe, expect, it, vi } from 'vitest';
import { handleExtractAudioCommand, type CliHandlerDeps } from '../index';

// The core channel-fix/balance logic is exhaustively tested at the @etvideo/core
// level (channel-fix-apply.test.ts et al). This file exercises the CLI WIRING
// around it — the actual call-site logic that decided nothing tested it before:
// warning text on auto-detect, JSON payload shape, and non-fatal detection failure.
describe('handleExtractAudioCommand channel-fix wiring', () => {
  function deps(overrides: Partial<CliHandlerDeps> = {}) {
    const printed: unknown[] = [];
    const base: CliHandlerDeps = {
      extractClipAudio: (async () => 'media/clip_001/extracted-audio.wav') as any,
      extractAllClipAudio: (async () => ['media/clip_001/extracted-audio.wav']) as any,
      extractClipWaveformPeaks: (() => { throw new Error('not used'); }) as any,
      extractAllClipWaveformPeaks: (() => { throw new Error('not used'); }) as any,
      applyChannelFix: (() => { throw new Error('override applyChannelFix per test'); }) as any,
      analyzeChannelBalance: (() => { throw new Error('not used'); }) as any,
      print: ((value: unknown) => { printed.push(value); }) as any,
      ...overrides
    };
    return { deps: base, printed };
  }

  it('warns and includes channelFix in JSON output when a fix is auto-applied', async () => {
    const ctx = deps({
      applyChannelFix: (() => ({
        action: 'applied',
        fix: { status: 'approved', sourceChannel: 'left', detection: { leftRmsDb: -18, rightRmsDb: -70, auto: true }, appliedAt: '2026-07-04T00:00:00.000Z' },
        balance: { channels: 2, leftRmsDb: -18, rightRmsDb: -70, recommendation: 'left' },
        manifest: { schemaVersion: 3 } as any
      })) as any
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warnCalls: unknown[][];
    try {
      await handleExtractAudioCommand({ format: 'wav', sampleRate: '16000' }, { workspace: '/tmp/ws', json: true }, ctx.deps);
      warnCalls = warnSpy.mock.calls;
    } finally {
      warnSpy.mockRestore();
    }

    expect(warnCalls.some((call) => String(call[0]).includes('Detected single-channel recording'))).toBe(true);
    const printedJson = ctx.printed[0] as { outputs: string[]; channelFix?: unknown };
    expect(printedJson.channelFix).toBeDefined();
    // manifest must never leak into printed CLI output (it's for internal wiring only).
    expect((printedJson.channelFix as any).manifest).toBeUndefined();
  });

  it('omits channelFix from JSON output when the outcome is unchanged', async () => {
    const ctx = deps({
      applyChannelFix: (() => ({ action: 'unchanged', reason: 'existing audioChannelFix preserved', manifest: {} as any })) as any
    });

    await handleExtractAudioCommand({ format: 'wav', sampleRate: '16000' }, { workspace: '/tmp/ws', json: true }, ctx.deps);

    const printedJson = ctx.printed[0] as { outputs: string[]; channelFix?: unknown };
    expect(printedJson.channelFix).toBeUndefined();
  });

  it('does not block extraction when channel-balance detection throws', async () => {
    const ctx = deps({
      applyChannelFix: (() => { throw new Error('ffprobe unavailable'); }) as any
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let outputs: string[] | undefined;
    let warnCalls: unknown[][];
    try {
      outputs = await handleExtractAudioCommand({ format: 'wav', sampleRate: '16000' }, { workspace: '/tmp/ws', json: false }, ctx.deps);
      warnCalls = warnSpy.mock.calls;
    } finally {
      warnSpy.mockRestore();
    }

    expect(outputs).toEqual(['media/clip_001/extracted-audio.wav']);
    expect(warnCalls.some((call) => String(call[0]).includes('Channel-balance detection skipped'))).toBe(true);
  });
});
