import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { probeRecordingMedia } from '../media';
import { wavTone } from '../providers/tts/mock';

function makeVideo(path: string) {
  const result = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

describe('probeRecordingMedia', () => {
  it('returns lenient video/audio stream metadata for a video file', () => {
    const root = mkdtempSync(join(tmpdir(), 'etvs-probe-'));
    try {
      const mp4 = join(root, 'video.mp4');
      makeVideo(mp4);
      const probe = probeRecordingMedia(mp4);
      expect(probe.hasVideo).toBe(true);
      expect(probe.hasAudio).toBe(true);
      expect(probe.video?.width).toBeGreaterThan(0);
      expect(probe.durationSec).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts audio-only recordings without requiring a video stream', () => {
    const root = mkdtempSync(join(tmpdir(), 'etvs-probe-'));
    try {
      const wav = join(root, 'voice.wav');
      writeFileSync(wav, wavTone('hello from recording'));
      const probe = probeRecordingMedia(wav);
      expect(probe.hasVideo).toBe(false);
      expect(probe.hasAudio).toBe(true);
      expect(probe.audio?.sampleRate).toBeGreaterThan(0);
      expect(probe.durationSec).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
