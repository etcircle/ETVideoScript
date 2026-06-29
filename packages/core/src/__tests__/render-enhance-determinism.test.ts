import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cacheKeyFor, buildLocalEnhanceArgv } from '../audioEnhance';

describe('audio enhance cache determinism', () => {
  it('uses the same local cache key on rerun for the same source bytes and argv inputs', () => {
    const sourceBytes = Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt deterministic fixture');
    const clipSha = createHash('sha256').update(sourceBytes).digest('hex');
    const op = {
      id: 'op_audio_enhance_0001',
      type: 'audio_enhance' as const,
      status: 'approved' as const,
      clipId: 'clip_001',
      start: 0,
      end: 3,
      provider: 'ffmpeg-local' as const,
      profile: 'clean_voice' as const,
      filterChainVersion: 0,
      intensity: 0.6,
      createdBy: 'user' as const,
      createdAt: '2026-05-15T00:00:00.000Z'
    };

    const firstArgvHash = createHash('sha256').update(JSON.stringify(buildLocalEnhanceArgv({ inputPath: 'in.wav', outputPath: 'out.wav', profile: op.profile, filterChainVersion: op.filterChainVersion }))).update(sourceBytes).digest('hex');
    const secondArgvHash = createHash('sha256').update(JSON.stringify(buildLocalEnhanceArgv({ inputPath: 'in.wav', outputPath: 'out.wav', profile: op.profile, filterChainVersion: op.filterChainVersion }))).update(sourceBytes).digest('hex');

    expect(cacheKeyFor(op, clipSha)).toBe(cacheKeyFor(op, clipSha));
    expect(cacheKeyFor({ ...op, ffmpegVersion: '6.1' }, clipSha))
      .not.toBe(cacheKeyFor({ ...op, ffmpegVersion: '7.0' }, clipSha));
    expect(firstArgvHash).toBe(secondArgvHash);
  });
});
