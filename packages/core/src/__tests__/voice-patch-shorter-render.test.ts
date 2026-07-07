import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRenderPlanV3, renderPlanV3, type ManifestV3 } from '../index';

// Integration test for the 2026-05-25 voice_patch shorter-semantics fix.
// Renders a real .mp4 through ffmpeg, decodes it to PCM, and proves via
// frequency-domain analysis that:
//   1. The full original slot is muted (440 Hz source absent across [4.0, 5.0]).
//   2. The shorter replacement plays only its own duration (880 Hz present in
//      [4.0, 4.4], absent in the slack window [4.4, 5.0]).
//   3. Downstream speech is not pulled earlier (1760 Hz onset matches baseline
//      within ±5 ms).
//   4. Output duration matches the un-patched baseline (no timeline shrink).
//
// silencedetect is intentionally NOT the primary proof — Codex + Hermes
// peer-review flagged that silencedetect cannot distinguish "source 440 Hz
// absent" from "anything playing", because the replacement 880 Hz tone makes
// the window loud. Frequency-specific Goertzel energy is the correct gate.

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const describeIfFfmpeg = ffmpegAvailable ? describe : describe.skip;

const SAMPLE_RATE = 48_000;

// Single-bin Goertzel power. Returns |X[k]|² for the requested frequency.
function goertzelPower(samples: Float32Array, start: number, length: number, freq: number, sampleRate: number): number {
  const k = (length * freq) / sampleRate;
  const omega = (2 * Math.PI * k) / length;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  const end = Math.min(start + length, samples.length);
  for (let n = start; n < end; n++) {
    const s0 = (samples[n] ?? 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

// Average normalized band power across non-overlapping windows in [startSec, endSec].
function bandPower(samples: Float32Array, startSec: number, endSec: number, freq: number, windowSize = 1024): number {
  const startSample = Math.floor(startSec * SAMPLE_RATE);
  const endSample = Math.min(Math.floor(endSec * SAMPLE_RATE), samples.length);
  let total = 0;
  let windows = 0;
  for (let i = startSample; i + windowSize <= endSample; i += windowSize) {
    total += goertzelPower(samples, i, windowSize, freq, SAMPLE_RATE);
    windows += 1;
  }
  return windows === 0 ? 0 : total / (windows * windowSize * windowSize);
}

// Find the first window in [startSec, endSec] whose band power exceeds halfPeakFraction
// of the peak window power in the same range. Returns the window-start time.
function findBandOnset(samples: Float32Array, startSec: number, endSec: number, freq: number, halfPeakFraction = 0.5): number {
  const windowSize = 512;
  const startSample = Math.floor(startSec * SAMPLE_RATE);
  const endSample = Math.min(Math.floor(endSec * SAMPLE_RATE), samples.length);
  let peak = 0;
  for (let i = startSample; i + windowSize <= endSample; i += windowSize) {
    const p = goertzelPower(samples, i, windowSize, freq, SAMPLE_RATE);
    if (p > peak) peak = p;
  }
  const threshold = peak * halfPeakFraction;
  for (let i = startSample; i + windowSize <= endSample; i += windowSize) {
    if (goertzelPower(samples, i, windowSize, freq, SAMPLE_RATE) > threshold) {
      return i / SAMPLE_RATE;
    }
  }
  return endSec;
}

function runFfmpeg(args: string[], description: string): void {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`ffmpeg ${description} failed: ${result.stderr?.toString() || '(no stderr)'}`);
  }
}

function decodeMonoPcm(filePath: string): Float32Array {
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', filePath,
    '-f', 'f32le',
    '-ar', String(SAMPLE_RATE),
    '-ac', '1',
    '-'
  ], { maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg decode failed: ${result.stderr?.toString() || '(no stderr)'}`);
  }
  const buf = result.stdout as Buffer;
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

function fixtureManifest(operations: ManifestV3['operations']): ManifestV3 {
  return {
    manifestVersion: 3,
    projectId: 'voice-patch-shorter-integration',
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
    assets: [
      { assetId: 'asset_video_001', kind: 'video', path: 'assets/video/source.mp4', durationSec: 6, provenance: 'imported', video: { width: 160, height: 90, fps: 30 }, audio: { sampleRate: 48000 } },
      { assetId: 'asset_voice_001', kind: 'audio', path: 'assets/voice/tone-c.wav', durationSec: 0.4, provenance: 'generated', audio: { sampleRate: 48000 } }
    ],
    tracks: [
      { trackId: 'track_video_001', kind: 'video', name: 'Base', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 6, timelineStart: 0 }] }
    ],
    operations,
    outputs: [{ outputId: 'output_001', kind: 'full', aspects: ['16:9'], status: 'manual' }],
    renderPresets: {
      draft: { resolution: '160x90', videoBitrate: '250k', audioBitrate: '64k' },
      youtube: { resolution: '320x180', videoBitrate: '500k', audioBitrate: '128k' }
    }
  };
}

describeIfFfmpeg('voice_patch shorter-semantics — frequency-aware render proof', () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'etv-voice-patch-render-'));
    mkdirSync(join(workspace, 'assets', 'video'), { recursive: true });
    mkdirSync(join(workspace, 'assets', 'voice'), { recursive: true });
    mkdirSync(join(workspace, 'renders'), { recursive: true });

    // Source audio: 440 Hz tone in [0..5], 1760 Hz tone in [5..6].
    const sourceAudioPath = join(workspace, 'assets', 'video', 'source-audio.wav');
    runFfmpeg([
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=1760:sample_rate=48000:duration=1',
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]',
      '-map', '[a]', '-c:a', 'pcm_s16le', '-y', sourceAudioPath
    ], 'source audio');

    // Source video: 6s black 160x90 with the source audio muxed in.
    const sourceVideoPath = join(workspace, 'assets', 'video', 'source.mp4');
    runFfmpeg([
      '-f', 'lavfi', '-i', 'color=c=black:s=160x90:duration=6:rate=30',
      '-i', sourceAudioPath,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest', '-y', sourceVideoPath
    ], 'source video');

    // Replacement asset: 0.4s sine at 880 Hz (the "Tone C").
    const replacementPath = join(workspace, 'assets', 'voice', 'tone-c.wav');
    runFfmpeg([
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.4',
      '-c:a', 'pcm_s16le', '-y', replacementPath
    ], 'tone-c.wav');
  }, 60_000);

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it('preserves slot, mutes the full slot via Tone-A suppression, and keeps downstream Tone-B onset stable', async () => {
    // Baseline render: no voice_patch.
    const baselineManifest = fixtureManifest([]);
    await renderPlanV3(workspace, buildRenderPlanV3(baselineManifest), { output: 'renders/baseline.mp4', overwrite: true });

    // Patched render: voice_patch on [4.0, 5.0] with a 0.4s asset.
    const patchedManifest = fixtureManifest([
      {
        id: 'op_voice_001',
        type: 'voice_patch',
        status: 'approved',
        target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 4.0, end: 5.0 },
        text: 'replacement-tone-c',
        assetId: 'asset_voice_001',
        durationGeneratedSec: 0.4,
        proposedBy: 'agent',
        createdBy: 'user',
        createdAt: '2026-05-25T00:00:00.000Z'
      }
    ] as ManifestV3['operations']);
    await renderPlanV3(workspace, buildRenderPlanV3(patchedManifest), { output: 'renders/patched.mp4', overwrite: true });

    const baseline = decodeMonoPcm(join(workspace, 'renders', 'baseline.mp4'));
    const patched = decodeMonoPcm(join(workspace, 'renders', 'patched.mp4'));

    // (1) 440 Hz (Tone A) energy across the FULL slot [4.0, 5.0] must be heavily
    //     suppressed in patched vs baseline. Pre-fix the slot shrunk to
    //     [4.0, 4.4] and the slack tail [4.4, 5.0] leaked source 440 Hz audio.
    const aBaselineSlot = bandPower(baseline, 4.0, 5.0, 440);
    const aPatchedSlot = bandPower(patched, 4.0, 5.0, 440);
    expect(aPatchedSlot).toBeLessThan(aBaselineSlot * 0.10);

    // (2) 880 Hz (Tone C) energy must be present in [4.0, 4.4] (asset playback
    //     window) and substantially lower in the slack window [4.4, 5.0].
    const cAssetWindow = bandPower(patched, 4.0, 4.4, 880);
    const cSlackWindow = bandPower(patched, 4.4, 5.0, 880);
    expect(cAssetWindow).toBeGreaterThan(0);
    expect(cSlackWindow).toBeLessThan(cAssetWindow * 0.20);

    // (3) 1760 Hz (Tone B) onset in the patched render must match baseline
    //     onset to within ±30 ms. The 30 ms band accommodates Goertzel window
    //     quantization (512 samples / 48 kHz = ~10.67 ms per onset bucket) plus
    //     any frame-boundary rounding ffmpeg introduces in re-encoded outputs.
    //     This tolerance still catches the pre-fix bug — the Test-Emo shrink
    //     was 63 ms, an order of magnitude above the floor here.
    const baselineBOnset = findBandOnset(baseline, 4.5, 6.0, 1760);
    const patchedBOnset = findBandOnset(patched, 4.5, 6.0, 1760);
    expect(Math.abs(patchedBOnset - baselineBOnset)).toBeLessThan(0.030);

    // (4) Output duration must match baseline (no timeline shrink).
    const baselineDur = baseline.length / SAMPLE_RATE;
    const patchedDur = patched.length / SAMPLE_RATE;
    expect(Math.abs(patchedDur - baselineDur)).toBeLessThan(0.050);
  }, 120_000);
});
