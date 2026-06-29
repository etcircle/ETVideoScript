import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspace, extractWaveformPeaks } from '../index';

function sineWav(durationSec: number, sampleRate: number, frequencyHz: number): Buffer {
  const samples = Math.floor(durationSec * sampleRate);
  const dataBytes = samples * 2;
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
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * 32767);
    buffer.writeInt16LE(value, 44 + i * 2);
  }
  return buffer;
}

describe('waveform peaks', () => {
  it('writes bounded min/max peaks for a synthetic mono sine wave', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-peaks-'));
    try {
      const workspace = join(root, 'episode-001');
      await createWorkspace({ workspacePath: workspace, projectId: 'episode-001', title: 'Episode 001' });
      writeFileSync(join(workspace, 'media/extracted-audio.wav'), sineWav(1, 1000, 10));

      const peaks = extractWaveformPeaks(workspace, { resolutionHz: 100 });

      expect(peaks.resolutionHz).toBe(100);
      expect(peaks.durationSec).toBeCloseTo(1, 3);
      expect(peaks.channels).toBe(1);
      expect(peaks.peaks).toHaveLength(100);
      expect(peaks.peaks.every(([min, max]) => min >= -1 && max <= 1 && min <= max)).toBe(true);
      expect(Math.min(...peaks.peaks.map(([min]) => min))).toBeLessThan(-0.85);
      expect(Math.max(...peaks.peaks.map(([, max]) => max))).toBeGreaterThan(0.85);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
