import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHANNEL_FIX_SILENCE_FLOOR_DB,
  analyzeChannelBalance,
  parseAstatsChannelRms
} from '../index';

// Synthesize a 1s stereo WAV where the right channel is the left scaled by `rightGain`.
// rightGain 0 → digital silence on the right (the single-channel-mic case).
function makeStereoWav(dir: string, name: string, rightGain: number): string {
  const path = join(dir, name);
  const result = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000', '-af', `pan=stereo|c0=c0|c1=${rightGain}*c0`, '-acodec', 'pcm_s16le', path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr}`);
  return path;
}

function makeMonoWav(dir: string, name: string): string {
  const path = join(dir, name);
  const result = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000', '-ac', '1', '-acodec', 'pcm_s16le', path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr}`);
  return path;
}

describe('parseAstatsChannelRms', () => {
  it('parses per-channel RMS lines and maps -inf to the silence floor', () => {
    const stderr = [
      '[Parsed_astats_0 @ 0x1] Channel: 1',
      '[Parsed_astats_0 @ 0x1] RMS level dB: -18.234567',
      '[Parsed_astats_0 @ 0x1] Channel: 2',
      '[Parsed_astats_0 @ 0x1] RMS level dB: -inf',
      '[Parsed_astats_0 @ 0x1] Overall',
      '[Parsed_astats_0 @ 0x1] RMS level dB: -21.0'
    ].join('\n');
    const rms = parseAstatsChannelRms(stderr);
    expect(rms).toHaveLength(2);
    expect(rms[0]).toBeCloseTo(-18.234567, 3);
    expect(rms[1]).toBe(CHANNEL_FIX_SILENCE_FLOOR_DB);
  });

  it('ignores the Overall block RMS (no preceding Channel line)', () => {
    const rms = parseAstatsChannelRms('[x] Overall\n[x] RMS level dB: -20.0');
    expect(rms).toHaveLength(0);
  });
});

describe('analyzeChannelBalance', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'etv-chanbal-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('recommends left when the right channel is digitally silent', () => {
    const balance = analyzeChannelBalance(makeStereoWav(dir, 'left-only.wav', 0));
    expect(balance.channels).toBe(2);
    expect(balance.recommendation).toBe('left');
    expect(balance.leftRmsDb).not.toBeNull();
    // The lavfi sine source's default amplitude is well below 0 dBFS (observed ~-21 dB on
    // ffmpeg 8.0.1); assert comfortably above the dead-channel threshold rather than near 0.
    expect(balance.leftRmsDb! > -30).toBe(true);
    expect(balance.rightRmsDb! <= -55).toBe(true);
  });

  it('recommends nothing for balanced stereo', () => {
    const balance = analyzeChannelBalance(makeStereoWav(dir, 'balanced.wav', 1));
    expect(balance.recommendation).toBeNull();
  });

  it('recommends nothing when the quiet channel is merely quieter, not dead', () => {
    // 0.5x gain ≈ -6 dB relative: well inside the 20 dB delta threshold.
    const balance = analyzeChannelBalance(makeStereoWav(dir, 'quieter.wav', 0.5));
    expect(balance.recommendation).toBeNull();
  });

  it('returns null RMS and no recommendation for mono sources', () => {
    const balance = analyzeChannelBalance(makeMonoWav(dir, 'mono.wav'));
    expect(balance.channels).toBe(1);
    expect(balance.leftRmsDb).toBeNull();
    expect(balance.rightRmsDb).toBeNull();
    expect(balance.recommendation).toBeNull();
  });

  it('throws on a nonexistent file', () => {
    expect(() => analyzeChannelBalance(join(dir, 'missing.wav'))).toThrow();
  });
});
