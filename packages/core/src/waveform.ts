import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertInside, atomicWriteJson } from './filesystem';
import { loadManifestV3 } from './manifest/io';

export type WaveformPeaks = { resolutionHz: number; durationSec: number; channels: 1; peaks: Array<[number, number]>; };
type WavInfo = { channels: number; sampleRate: number; bitsPerSample: number; audioFormat: number; dataOffset: number; dataBytes: number; };

function findWavChunks(buffer: Buffer): WavInfo {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('media/extracted-audio.wav is not a RIFF/WAVE file');
  let offset = 12;
  let fmt: Partial<WavInfo> | null = null;
  let dataOffset = -1;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (id === 'fmt ') fmt = { audioFormat: buffer.readUInt16LE(chunkStart), channels: buffer.readUInt16LE(chunkStart + 2), sampleRate: buffer.readUInt32LE(chunkStart + 4), bitsPerSample: buffer.readUInt16LE(chunkStart + 14) };
    else if (id === 'data') { dataOffset = chunkStart; dataBytes = size; break; }
    offset = chunkStart + size + (size % 2);
  }
  if (!fmt || dataOffset < 0) throw new Error('WAV fmt/data chunks not found');
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) throw new Error('Only PCM 16-bit WAV peaks are supported');
  if (!fmt.channels || !fmt.sampleRate) throw new Error('Invalid WAV metadata');
  return { channels: fmt.channels, sampleRate: fmt.sampleRate, bitsPerSample: fmt.bitsPerSample, audioFormat: fmt.audioFormat, dataOffset, dataBytes };
}
function clampUnit(value: number) { return Math.max(-1, Math.min(1, value)); }
function validatePeaks(parsed: WaveformPeaks, path: string): WaveformPeaks {
  if (!Array.isArray(parsed.peaks) || parsed.channels !== 1 || !Number.isFinite(parsed.resolutionHz)) throw new Error(`Invalid ${path}`);
  return parsed;
}

export function readWaveformPeaks(workspacePath: string): WaveformPeaks | null {
  const path = assertInside(resolve(workspacePath), 'media/peaks.json');
  return existsSync(path) ? validatePeaks(JSON.parse(readFileSync(path, 'utf8')) as WaveformPeaks, 'media/peaks.json') : null;
}
export function readClipWaveformPeaks(workspacePath: string, clipId: string): WaveformPeaks | null {
  const rel = `media/${clipId}/peaks.json`;
  const path = assertInside(resolve(workspacePath), rel);
  return existsSync(path) ? validatePeaks(JSON.parse(readFileSync(path, 'utf8')) as WaveformPeaks, rel) : null;
}

export function extractWaveformPeaks(workspacePath: string, options: { resolutionHz?: number; input?: string; output?: string } = {}): WaveformPeaks {
  const workspace = resolve(workspacePath);
  const inputRel = options.input || 'media/extracted-audio.wav';
  const input = assertInside(workspace, inputRel);
  if (!existsSync(input)) throw new Error(`${inputRel} not found; run ets extract-audio first`);
  const resolutionHz = Math.max(1, Math.floor(options.resolutionHz || 100));
  const buffer = readFileSync(input);
  const wav = findWavChunks(buffer);
  const bytesPerSample = wav.bitsPerSample / 8;
  const frameBytes = bytesPerSample * wav.channels;
  const frameCount = Math.floor(wav.dataBytes / frameBytes);
  const durationSec = frameCount / wav.sampleRate;
  const peakCount = Math.max(1, Math.ceil(durationSec * resolutionHz));
  const peaks: Array<[number, number]> = [];
  for (let bucket = 0; bucket < peakCount; bucket += 1) {
    const startFrame = Math.floor((bucket * wav.sampleRate) / resolutionHz);
    const endFrame = Math.min(frameCount, Math.max(startFrame + 1, Math.floor(((bucket + 1) * wav.sampleRate) / resolutionHz)));
    let min = 1;
    let max = -1;
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      let mixed = 0;
      for (let channel = 0; channel < wav.channels; channel += 1) mixed += buffer.readInt16LE(wav.dataOffset + frame * frameBytes + channel * bytesPerSample) / 32768;
      const sample = clampUnit(mixed / wav.channels);
      min = Math.min(min, sample);
      max = Math.max(max, sample);
    }
    peaks.push(max < min ? [0, 0] : [Number(min.toFixed(6)), Number(max.toFixed(6))]);
  }
  const doc: WaveformPeaks = { resolutionHz, durationSec: Number(durationSec.toFixed(6)), channels: 1, peaks };
  const outputRel = options.output || 'media/peaks.json';
  const output = assertInside(workspace, outputRel);
  mkdirSync(join(workspace, outputRel.split('/').slice(0, -1).join('/')), { recursive: true });
  atomicWriteJson(output, doc);
  return doc;
}

export function extractClipWaveformPeaks(workspacePath: string, clipId: string, options: { resolutionHz?: number } = {}): WaveformPeaks {
  return extractWaveformPeaks(workspacePath, { resolutionHz: options.resolutionHz, input: `media/${clipId}/extracted-audio.wav`, output: `media/${clipId}/peaks.json` });
}

export function extractAllClipWaveformPeaks(workspacePath: string, options: { resolutionHz?: number } = {}): Array<{ clipId: string; peaks: number }> {
  const workspace = resolve(workspacePath);
  const manifest = loadManifestV3(workspace);
  const clips = manifest.tracks.flatMap((track) => track.clips);
  return clips.map((clip) => {
    const peaks = extractClipWaveformPeaks(workspace, clip.clipId, options);
    return { clipId: clip.clipId, peaks: peaks.peaks.length };
  });
}
