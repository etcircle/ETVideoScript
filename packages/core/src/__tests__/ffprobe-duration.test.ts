import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffprobeDurationSec, ffprobeDurationSecOrZero, MediaDurationUnreadableError } from '../media';

// 1s of digital silence, mono 24 kHz PCM — the shape a degenerate TTS payload arrives in.
function silentWav(): Buffer {
  const sampleRate = 24000;
  const dataBytes = sampleRate * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

describe('ffprobeDurationSecOrZero maps ONLY unreadable-duration probes to 0', () => {
  let dir: string;
  let zeroSampleWav: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'etv-ffprobe-duration-'));
    // Real product path: silence-trim a pure-silence WAV with the same ffmpeg filter
    // tts.ts trimSilenceInPlace uses — the output is a valid container with ZERO samples,
    // which ffprobe reads fine but reports duration=N/A for.
    const silent = join(dir, 'silent.wav');
    writeFileSync(silent, silentWav());
    zeroSampleWav = join(dir, 'zero-samples.wav');
    const result = spawnSync('ffmpeg', [
      '-y', '-v', 'error', '-i', silent,
      '-af', 'silenceremove=start_periods=1:start_silence=0:start_threshold=-40dB:stop_periods=1:stop_silence=0.05:stop_threshold=-40dB',
      zeroSampleWav
    ], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr}`);
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns 0 for a zero-sample WAV (probe ran, duration=N/A) and the throwing variant raises the typed error', () => {
    expect(ffprobeDurationSecOrZero(zeroSampleWav)).toBe(0);
    expect(() => ffprobeDurationSec(zeroSampleWav)).toThrowError(MediaDurationUnreadableError);
  });

  it('still propagates process-level failures (missing file) instead of masking them as 0 ms', () => {
    const missing = join(dir, 'does-not-exist.wav');
    expect(() => ffprobeDurationSecOrZero(missing)).toThrow();
    expect(() => ffprobeDurationSecOrZero(missing)).not.toThrowError(MediaDurationUnreadableError);
  });
});
