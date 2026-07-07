import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRenderPlanV3, renderPlanV3, type ManifestV3 } from '../index';

// Integration test for the 2026-05-25 voice_patch anchor-freeze fix (follow-up to the
// shorter-semantics slice in 822f94d). Renders a real .mp4 through ffmpeg, samples
// pixel RGB in the overflow band, and proves via:
//   1. PRIMARY pixel-RGB sampling — mean R, G, B all > 200 across [5.050, 5.450] proves
//      the held frame is the source's last WHITE frame (RGB≈255,255,255), distinguishing
//      it from both:
//        - the pre-fix gap-filler black (mean RGB ≈ 0,0,0); and
//        - a wrong-sourceTime that holds the downstream RED frame (G/B ≈ 0).
//   2. blackdetect supplemental — `blackdetect=d=0.1:pix_th=0.10` reports zero black
//      intervals across the patched render (catches gap-filler black at the FFmpeg level).
//   3. Audio invariants from the prior slice — Goertzel at 1760 Hz onset stable ±30 ms
//      against baseline; 880 Hz energy present in [4.5, 5.5] (replacement plays through
//      overflow); ffprobe duration ≈ baseline + 0.5 s.
//
// Fixture design rationale (Codex + Hermes P3, 2026-05-25): a solid-white source could
// prove "not black" but cannot catch a sourceTime off-by-one that holds the downstream
// frame. The white→red boundary at t=5.000 lets the test distinguish all three failure
// modes. Frame extraction uses output-side `select='between(t,5.050,5.450)'` (NOT
// input-side `-ss`, which fast-seeks on keyframes and can land on the wrong sample).

// Gate on BOTH ffmpeg and ffprobe — the duration invariant shells out to ffprobe and the
// frame extraction shells out to ffmpeg, so a skip-on-ffmpeg gate alone would still try
// to spawn ffprobe if only that one was missing (Hermes P3, 2026-05-25).
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const ffprobeAvailable = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const describeIfFfmpeg = ffmpegAvailable && ffprobeAvailable ? describe : describe.skip;

const SAMPLE_RATE = 48_000;

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

// Extract frames in [startSec, endSec) as raw RGB24 bytes via output-side select filter.
// Uses output-side `select` (NOT input-side `-ss`) to avoid keyframe-seek inaccuracy
// (gotcha #2 from the 2026-05-25 handoff). Returns an array of per-frame RGB triplets.
function extractFrameRgbMeans(filePath: string, startSec: number, endSec: number, width: number, height: number): { r: number; g: number; b: number }[] {
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', filePath,
    '-vf', `select='between(t,${startSec},${endSec})'`,
    '-vsync', '0',
    '-pix_fmt', 'rgb24',
    '-f', 'rawvideo',
    '-'
  ], { maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg frame extraction failed: ${result.stderr?.toString() || '(no stderr)'}`);
  }
  const buf = result.stdout as Buffer;
  const frameBytes = width * height * 3;
  const frameCount = Math.floor(buf.length / frameBytes);
  const means: { r: number; g: number; b: number }[] = [];
  for (let f = 0; f < frameCount; f++) {
    const offset = f * frameBytes;
    let rTotal = 0;
    let gTotal = 0;
    let bTotal = 0;
    const pixels = width * height;
    for (let p = 0; p < pixels; p++) {
      const pixelOffset = offset + p * 3;
      rTotal += buf[pixelOffset] ?? 0;
      gTotal += buf[pixelOffset + 1] ?? 0;
      bTotal += buf[pixelOffset + 2] ?? 0;
    }
    means.push({ r: rTotal / pixels, g: gTotal / pixels, b: bTotal / pixels });
  }
  return means;
}

function blackdetectIntervals(filePath: string): { start: number; end: number; duration: number }[] {
  // ffmpeg blackdetect writes to stderr; parse the `[blackdetect ... black_start:X black_end:Y black_duration:Z]` lines.
  // Throw on non-zero status so a silently-failed blackdetect cannot be misread as "no black intervals
  // detected" (Hermes P3, 2026-05-25). Supplemental to the pixel-RGB primary assertion, but worth gating cleanly.
  const result = spawnSync('ffmpeg', [
    '-hide_banner',
    '-i', filePath,
    '-vf', 'blackdetect=d=0.1:pix_th=0.10',
    '-an',
    '-f', 'null',
    '-'
  ], { stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`ffmpeg blackdetect failed: ${result.stderr?.toString() || '(no stderr)'}`);
  }
  const stderr = result.stderr?.toString() ?? '';
  const intervals: { start: number; end: number; duration: number }[] = [];
  const regex = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stderr)) !== null) {
    intervals.push({ start: Number(match[1]), end: Number(match[2]), duration: Number(match[3]) });
  }
  return intervals;
}

function ffprobeDuration(filePath: string): number {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ], { stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`ffprobe failed: ${result.stderr?.toString() || '(no stderr)'}`);
  }
  return Number(result.stdout.toString().trim());
}

function fixtureManifest(operations: ManifestV3['operations']): ManifestV3 {
  return {
    manifestVersion: 3,
    projectId: 'voice-patch-longer-integration',
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
    assets: [
      { assetId: 'asset_video_001', kind: 'video', path: 'assets/video/source.mp4', durationSec: 6, provenance: 'imported', video: { width: 160, height: 90, fps: 30 }, audio: { sampleRate: 48000 } },
      { assetId: 'asset_voice_001', kind: 'audio', path: 'assets/voice/tone-c.wav', durationSec: 1.5, provenance: 'generated', audio: { sampleRate: 48000 } }
    ],
    tracks: [
      { trackId: 'track_video_001', kind: 'video', name: 'Base', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 6, timelineStart: 0 }] }
    ],
    operations,
    outputs: [{ outputId: 'output_001', kind: 'full', aspects: ['16:9'], status: 'manual' }],
    takeGroups: [],
    renderPresets: {
      draft: { resolution: '160x90', videoBitrate: '250k', audioBitrate: '64k' },
      youtube: { resolution: '320x180', videoBitrate: '500k', audioBitrate: '128k' }
    }
  };
}

describeIfFfmpeg('voice_patch longer-semantics — visual anchor-freeze render proof', () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'etv-voice-patch-longer-render-'));
    mkdirSync(join(workspace, 'assets', 'video'), { recursive: true });
    mkdirSync(join(workspace, 'assets', 'voice'), { recursive: true });
    mkdirSync(join(workspace, 'renders'), { recursive: true });

    // Source video with color boundary at t=5: white [0..5] + red [5..6]. The white→red
    // edge lets the test distinguish "held last source frame" (white) from "held downstream
    // frame" (red) and from "fell through to gap-filler black" (RGB≈0). 30 fps to match the
    // pipeline's default sourceFps; ultrafast preset keeps the build cheap.
    const sourceVideoPath = join(workspace, 'assets', 'video', 'source.mp4');
    const sourceAudioPath = join(workspace, 'assets', 'video', 'source-audio.wav');
    runFfmpeg([
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=1760:sample_rate=48000:duration=1',
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]',
      '-map', '[a]', '-c:a', 'pcm_s16le', '-y', sourceAudioPath
    ], 'source audio');
    runFfmpeg([
      '-f', 'lavfi', '-i', 'color=c=white:s=160x90:duration=5:rate=30',
      '-f', 'lavfi', '-i', 'color=c=red:s=160x90:duration=1:rate=30',
      '-i', sourceAudioPath,
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map', '[v]', '-map', '2:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest', '-y', sourceVideoPath
    ], 'source video');

    // Replacement asset: 1.5 s 880 Hz sine. Longer than the 1 s slot → +0.5 s overflow.
    const replacementPath = join(workspace, 'assets', 'voice', 'tone-c.wav');
    runFfmpeg([
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1.5',
      '-c:a', 'pcm_s16le', '-y', replacementPath
    ], 'tone-c.wav');
  }, 60_000);

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it('holds the last white source frame across the overflow band (no black, no downstream red)', async () => {
    // Baseline render: no voice_patch.
    const baselineManifest = fixtureManifest([]);
    await renderPlanV3(workspace, buildRenderPlanV3(baselineManifest), { output: 'renders/baseline.mp4', overwrite: true });

    // Patched render: voice_patch on [4.0, 5.0] with a 1.5 s asset → +0.5 s overflow.
    const patchedManifest = fixtureManifest([
      {
        id: 'op_voice_001',
        type: 'voice_patch',
        status: 'approved',
        target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 4.0, end: 5.0 },
        text: 'replacement-tone-c-longer',
        assetId: 'asset_voice_001',
        durationGeneratedSec: 1.5,
        proposedBy: 'agent',
        createdBy: 'user',
        createdAt: '2026-05-25T00:00:00.000Z'
      }
    ] as ManifestV3['operations']);
    await renderPlanV3(workspace, buildRenderPlanV3(patchedManifest), { output: 'renders/patched.mp4', overwrite: true });

    const baseline = decodeMonoPcm(join(workspace, 'renders', 'baseline.mp4'));
    const patched = decodeMonoPcm(join(workspace, 'renders', 'patched.mp4'));

    // (1) PRIMARY VISUAL PROOF — pixel-RGB sampling on extracted frames in [5.050, 5.450]
    //     (10–490 ms inside the overflow band, away from boundary keyframe ambiguity).
    //     The held frame must be the source's last white frame, NOT the gap-filler black
    //     (R/G/B ≈ 0) and NOT the downstream red frame (G/B ≈ 0).
    const patchedPath = join(workspace, 'renders', 'patched.mp4');
    const frameMeans = extractFrameRgbMeans(patchedPath, 5.050, 5.450, 160, 90);
    expect(frameMeans.length).toBeGreaterThan(0);
    for (const frame of frameMeans) {
      expect(frame.r).toBeGreaterThan(200);
      expect(frame.g).toBeGreaterThan(200);
      expect(frame.b).toBeGreaterThan(200);
    }

    // (2) SUPPLEMENTAL — blackdetect reports zero black intervals. Catches gap-filler
    //     black at the ffmpeg level (the pre-fix mode).
    const blackIntervals = blackdetectIntervals(patchedPath);
    expect(blackIntervals).toHaveLength(0);

    // (3) Audio invariant — 880 Hz (Tone C) energy must be present in [4.5, 5.5] so the
    //     replacement audio plays through the overflow band, including the 0.5 s overflow.
    const cWindow = bandPower(patched, 4.5, 5.5, 880);
    expect(cWindow).toBeGreaterThan(0);

    // (4) Audio invariant — 1760 Hz (downstream Tone B) onset shifts later by ≈0.5 s vs
    //     baseline (the overflow ripple) but the SHAPE/relative offset stays stable.
    //     Baseline 1760 Hz starts at ~5.0; patched should start near ~5.5.
    const baselineBOnset = findBandOnset(baseline, 4.5, 7.0, 1760);
    const patchedBOnset = findBandOnset(patched, 4.5, 7.0, 1760);
    expect(Math.abs((patchedBOnset - baselineBOnset) - 0.5)).toBeLessThan(0.050);

    // (5) Structural invariant — ffprobe duration ≈ baseline + 0.5 s (the overflow). The
    //     prior outputDurationSec fix is what extends the timeline; verify end-to-end.
    const baselineDur = ffprobeDuration(join(workspace, 'renders', 'baseline.mp4'));
    const patchedDur = ffprobeDuration(patchedPath);
    expect(Math.abs((patchedDur - baselineDur) - 0.5)).toBeLessThan(0.080);
  }, 180_000);
});
