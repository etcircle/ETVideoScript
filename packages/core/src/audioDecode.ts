import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { int16ToFloat32 } from './pitch';

// NODE-ONLY (ADR-0001). This module spawns ffmpeg and must never be reachable from
// packages/core/src/browser.ts — selectCleanWindows (pure) takes the decoded PCM as INPUT
// precisely so the decode step can live here, outside the browser-safe graph.

/**
 * Decode any audio file to the 16 kHz mono Float32 [-1,1] PCM that the YIN pitch tracker and
 * `selectCleanWindows` consume. The time axis of the returned buffer is the file's own axis
 * (sample 0 = t 0), which for the workspace's cleaned bed / 48k reference is the ASSET axis.
 *
 * Resampling is done by ffmpeg (`-ar 16000 -ac 1 -f s16le`) rather than in TS: the selector's
 * register scoring compares F0 medians across windows of the SAME decode, so what matters is
 * that one deterministic resampler produces the whole buffer.
 */
export function decodeWavToPcm16kMono(filePath: string): Float32Array {
  if (!existsSync(filePath)) throw new Error(`decodeWavToPcm16kMono: input not found: ${filePath}`);
  const result = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 }
  );
  if (result.error) throw new Error(`decodeWavToPcm16kMono: ffmpeg could not be spawned: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString('utf8') : '';
    throw new Error(`decodeWavToPcm16kMono: ffmpeg failed (status ${result.status}): ${stderr.slice(0, 400) || '(no output)'}`);
  }
  const raw = result.stdout ?? Buffer.alloc(0);
  // Drop a trailing odd byte rather than misaligning every sample after it (a truncated
  // final frame is a decoder artifact, not a reason to fail a 90-second decode).
  const sampleCount = Math.floor(raw.byteLength / 2);
  const int16 = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) int16[i] = raw.readInt16LE(i * 2);
  return int16ToFloat32(int16);
}
