/**
 * W5 post-match seam DSP tests.
 *
 * Gates:
 *  - describeIfFfmpeg: real-ffmpeg tests (lavfi fixtures)
 *  - Pure tests (schema, renderContribution) run unconditionally
 *
 * Fixture strategy: all audio built with ffmpeg lavfi (sine, anullsrc, concat)
 * — no external audio files. Workspace layout mirrors the production path for
 * the synthesizeSpeech integration test.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postMatchSeam } from '../postMatchSeam';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const describeIfFfmpeg = ffmpegAvailable ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers (mirrors audio-clip.test.ts pattern)
// ---------------------------------------------------------------------------

function probeDuration(path: string): number {
  const out = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path
  ], { encoding: 'utf8' });
  return Number(out.stdout.trim());
}

function probeAudioStream(path: string): { sampleRate: number; channels: number; codec: string } {
  const out = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels,codec_name',
    '-of', 'default=noprint_wrappers=1',
    path
  ], { encoding: 'utf8' });
  const fields = new Map<string, string>();
  for (const line of out.stdout.trim().split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return {
    sampleRate: Number(fields.get('sample_rate') ?? 0),
    channels: Number(fields.get('channels') ?? 0),
    codec: fields.get('codec_name') ?? ''
  };
}

/**
 * Build a reference WAV with this layout:
 *  [0, 0.3s): sine (speech before edit)
 *  [0.3s, 0.6s): silence (adjacent to edit — inside the left neighbor window)
 *  [0.6s, 1.2s): sine (edit region — the "replaced" speech)
 *  [1.2s, 2.2s): sine (speech after edit)
 *
 * With editStartSec=0.6, editEndSec=1.2 and granularity='phrase' (W=0.6s):
 *  left neighbor window = [0.0, 0.6s) → contains the silence at [0.3, 0.6s]
 *  right neighbor window = [1.2, 1.8s) → pure speech
 *
 * So silencedetect on the left neighbor WILL find the adjacent silence.
 */
function buildReferenceWavWithAdjacentSilence(path: string): void {
  spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.3',
    '-f', 'lavfi', '-i', 'aevalsrc=0:channel_layout=mono:sample_rate=48000:duration=0.3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.6',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1.0',
    '-filter_complex', '[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1[out]',
    '-map', '[out]', '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le',
    path
  ], { stdio: 'ignore' });
}

/**
 * Build a reference WAV: speechDurationSec of sine, then silenceDurationSec of
 * silence (anullsrc), then speechDurationSec of sine again — to simulate a real
 * recording with a detectable quiet region adjacent to the edit.
 */
function buildReferenceWav(
  path: string,
  opts: {
    speechDurationSec?: number;
    silenceDurationSec?: number;
    speechFreq?: number;
    silenceDb?: number;
  } = {}
): void {
  const speechDur = opts.speechDurationSec ?? 1.0;
  const silenceDur = opts.silenceDurationSec ?? 0.5;
  const freq = opts.speechFreq ?? 440;
  // Build: speechDur of sine + silenceDur of near-silence + speechDur of sine
  spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${speechDur}`,
    '-f', 'lavfi', '-i', `aevalsrc=0:channel_layout=mono:sample_rate=48000:duration=${silenceDur}`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq * 1.5}:sample_rate=48000:duration=${speechDur}`,
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]',
    '-map', '[out]', '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le',
    path
  ], { stdio: 'ignore' });
}

/**
 * Build a patch WAV at a specific loudness level (dB attenuation relative to sine).
 */
function buildPatchWav(path: string, durationSec = 0.6, volumeDb = 0): void {
  const audioFilter = volumeDb !== 0 ? `volume=${volumeDb}dB` : 'anull';
  spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${durationSec}`,
    '-af', audioFilter,
    '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le',
    path
  ], { stdio: 'ignore' });
}

// ---------------------------------------------------------------------------
// 1. Truthful duration: post-bake ffprobe matches result.durationSec
// ---------------------------------------------------------------------------

describeIfFfmpeg('postMatchSeam — truthful duration', () => {
  let tempDir: string;
  let patchPath: string;
  let refPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'etvs-seam-dur-'));
    patchPath = join(tempDir, 'patch.wav');
    refPath = join(tempDir, 'reference-48k.wav');
    buildReferenceWav(refPath, { speechDurationSec: 1.0, silenceDurationSec: 0.5 });
    buildPatchWav(patchPath, 0.6);
  }, 60_000);

  afterAll(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it('result.baked is true and result.durationSec matches the on-disk ffprobed duration', async () => {
    const result = await postMatchSeam(patchPath, {
      referenceAbsPath: refPath,
      editStartSec: 1.0,  // silence region starts at 1.0s in the reference
      editEndSec: 1.5,
      granularity: 'phrase'
    });

    expect(result.baked).toBe(true);
    expect(result.durationSec).toBeDefined();
    expect(result.durationSec!).toBeGreaterThan(0);

    // The key invariant: persisted durationSec equals what the caller would ffprobe
    const onDiskDur = probeDuration(patchPath);
    expect(result.durationSec!).toBeCloseTo(onDiskDur, 2);

    // Re-architecture invariant: the bake PRESERVES the patch length (level-match +
    // bed + edge fades don't change duration) — it does NOT shorten by a crossfade
    // overlap (the old neighbor-crossfade + re-extract approach lost ~2*qsinD here).
    expect(result.durationSec!).toBeCloseTo(0.6, 1);
  }, 60_000);

  it('baked asset is 48 kHz mono pcm_s16le', async () => {
    const stream = probeAudioStream(patchPath);
    expect(stream.sampleRate).toBe(48000);
    expect(stream.channels).toBe(1);
    expect(stream.codec).toBe('pcm_s16le');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2. Loudness moved toward the neighbor
// ---------------------------------------------------------------------------

describeIfFfmpeg('postMatchSeam — loudness match', () => {
  let tempDir: string;
  let patchPath: string;
  let refPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'etvs-seam-loud-'));
    patchPath = join(tempDir, 'patch.wav');
    refPath = join(tempDir, 'reference-48k.wav');
    // Reference: louder sine (~-3 dB typical for a full sine wave)
    buildReferenceWav(refPath, { speechDurationSec: 1.0, silenceDurationSec: 0.5, speechFreq: 440 });
    // Patch: deliberately quiet (−12 dB)
    buildPatchWav(patchPath, 0.6, -12);
  }, 60_000);

  afterAll(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it('loudness step toward the neighbor after bake', async () => {
    // Measure the neighbor's loudness
    const neighborResult = spawnSync('ffmpeg', [
      '-hide_banner', '-nostats',
      '-i', refPath,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
      '-f', 'null', '-'
    ], { encoding: 'utf8' });
    const neighborStderr = neighborResult.stderr ?? '';
    const nStart = neighborStderr.indexOf('{');
    const nEnd = neighborStderr.lastIndexOf('}');
    const neighborJson = JSON.parse(neighborStderr.slice(nStart, nEnd + 1));
    const neighborI = Number(neighborJson.input_i);

    // Measure patch loudness BEFORE bake
    // (save current bytes before bake)
    const beforeBytes = readFileSync(patchPath);

    // Measure BEFORE loudness by probing the saved bytes via a temp copy
    const prePath = join(tempDir, 'patch-pre.wav');
    spawnSync('ffmpeg', ['-y', '-hide_banner', '-v', 'error', '-i', patchPath, '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le', prePath], { stdio: 'ignore' });
    const preMeasure = spawnSync('ffmpeg', [
      '-hide_banner', '-nostats', '-i', prePath,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
      '-f', 'null', '-'
    ], { encoding: 'utf8' });
    const preStderr = preMeasure.stderr ?? '';
    const ps = preStderr.indexOf('{');
    const pe = preStderr.lastIndexOf('}');
    const preI = Number(JSON.parse(preStderr.slice(ps, pe + 1)).input_i);

    const result = await postMatchSeam(patchPath, {
      referenceAbsPath: refPath,
      editStartSec: 1.0,
      editEndSec: 1.5,
      granularity: 'phrase'
    });

    expect(result.baked).toBe(true);

    // Measure patch loudness AFTER bake
    const postMeasure = spawnSync('ffmpeg', [
      '-hide_banner', '-nostats', '-i', patchPath,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
      '-f', 'null', '-'
    ], { encoding: 'utf8' });
    const postStderr = postMeasure.stderr ?? '';
    const qs = postStderr.indexOf('{');
    const qe = postStderr.lastIndexOf('}');
    const postI = Number(JSON.parse(postStderr.slice(qs, qe + 1)).input_i);

    // Post-bake loudness is closer to the neighbor than the pre-bake loudness
    const distBefore = Math.abs(preI - neighborI);
    const distAfter = Math.abs(postI - neighborI);
    expect(distAfter).toBeLessThan(distBefore);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// 3a. Adjacent room-tone path
// ---------------------------------------------------------------------------

describeIfFfmpeg('postMatchSeam — adjacent room-tone', () => {
  let tempDir: string;
  let patchPath: string;
  let refPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'etvs-seam-adj-'));
    patchPath = join(tempDir, 'patch.wav');
    refPath = join(tempDir, 'reference-48k.wav');
    // Reference layout: [0, 0.3s) speech, [0.3s, 0.6s) silence, [0.6s, 1.2s) edit region,
    // [1.2s, 2.2s) speech. With editStartSec=0.6, editEndSec=1.2, granularity='phrase' (W=0.6s)
    // the left neighbor window [0.0, 0.6s) contains the silence at [0.3, 0.6s].
    buildReferenceWavWithAdjacentSilence(refPath);
    buildPatchWav(patchPath, 0.6);
  }, 60_000);

  afterAll(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it('report.roomToneSource is adjacent when clear silence exists in the neighbor window', async () => {
    const result = await postMatchSeam(patchPath, {
      referenceAbsPath: refPath,
      editStartSec: 0.6,   // left neighbor = [0.0, 0.6s) which contains silence at [0.3, 0.6s]
      editEndSec: 1.2,
      granularity: 'phrase'
    });

    expect(result.baked).toBe(true);
    expect(result.report).toBeDefined();
    expect(result.report!.roomToneSource).toBe('adjacent');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3b. Synthetic fallback
// ---------------------------------------------------------------------------

describeIfFfmpeg('postMatchSeam — synthetic room-tone fallback', () => {
  let tempDir: string;
  let patchPath: string;
  let refPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'etvs-seam-syn-'));
    patchPath = join(tempDir, 'patch.wav');
    refPath = join(tempDir, 'reference-48k.wav');
    // Reference with NO silence — pure continuous sine. silencedetect will find nothing.
    spawnSync('ffmpeg', [
      '-y', '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le', refPath
    ], { stdio: 'ignore' });
    buildPatchWav(patchPath, 0.6);
  }, 60_000);

  afterAll(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it('bake succeeds with roomToneSource=synthetic when no adjacent silence exists', async () => {
    const result = await postMatchSeam(patchPath, {
      referenceAbsPath: refPath,
      editStartSec: 1.0,
      editEndSec: 1.5,
      granularity: 'phrase'
    });

    // The bake MUST still succeed even without adjacent silence
    expect(result.baked).toBe(true);
    expect(result.report).toBeDefined();
    expect(result.report!.roomToneSource).toBe('synthetic');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. Silencedetect-style seam check — no hard dropout at asset edges
// ---------------------------------------------------------------------------

describeIfFfmpeg('postMatchSeam — no dropout at seam edges', () => {
  let tempDir: string;
  let patchPath: string;
  let refPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'etvs-seam-drop-'));
    patchPath = join(tempDir, 'patch.wav');
    refPath = join(tempDir, 'reference-48k.wav');
    buildReferenceWav(refPath, { speechDurationSec: 1.0, silenceDurationSec: 0.5 });
    buildPatchWav(patchPath, 0.6);
  }, 60_000);

  afterAll(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it('no hard digital-silence gap at head or tail of the baked asset', async () => {
    const result = await postMatchSeam(patchPath, {
      referenceAbsPath: refPath,
      editStartSec: 1.0,
      editEndSec: 1.5,
      granularity: 'phrase'
    });

    expect(result.baked).toBe(true);

    const dur = probeDuration(patchPath);
    expect(dur).toBeGreaterThan(0.1);

    // Run silencedetect on the baked asset — assert no hard silence longer than 50ms
    // at the very head (first 100ms) or tail (last 100ms).
    const silResult = spawnSync('ffmpeg', [
      '-hide_banner', '-nostats',
      '-i', patchPath,
      '-af', 'silencedetect=noise=-50dB:d=0.05',
      '-f', 'null', '-'
    ], { encoding: 'utf8' });
    const silStderr = silResult.stderr ?? '';

    // Parse silence regions
    const lines = silStderr.split('\n');
    const silenceRegions: Array<{ start: number; end: number; dur: number }> = [];
    let pendingStart: number | null = null;
    for (const line of lines) {
      const sm = line.match(/silence_start:\s*([\d.]+)/);
      const em = line.match(/silence_end:\s*([\d.]+).*silence_duration:\s*([\d.]+)/);
      if (sm) pendingStart = Number(sm[1]);
      if (em && pendingStart !== null) {
        silenceRegions.push({ start: pendingStart, end: Number(em[1]), dur: Number(em[2]) });
        pendingStart = null;
      }
    }

    // Check that no long silence occupies the head (first 100ms) or tail (last 100ms)
    const HEAD_END = 0.10;
    const TAIL_START = dur - 0.10;
    for (const sr of silenceRegions) {
      const inHead = sr.start < HEAD_END && sr.dur > 0.05;
      const inTail = sr.end > TAIL_START && sr.dur > 0.05;
      // The baked seam carries room-tone so neither edge should be a hard dropout
      expect(inHead).toBe(false);
      expect(inTail).toBe(false);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4b. Silent neighbor (loudnorm "-inf") must NOT abort the bake
// ---------------------------------------------------------------------------

describeIfFfmpeg('postMatchSeam — silent neighbor does not abort the bake', () => {
  let tempDir: string;
  let patchPath: string;
  let refPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'etvs-seam-silent-'));
    patchPath = join(tempDir, 'patch.wav');
    refPath = join(tempDir, 'reference-48k.wav');
    // Reference is pure silence around the edit → loudnorm reports input_i:"-inf".
    spawnSync('ffmpeg', [
      '-y', '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', 'aevalsrc=0:channel_layout=mono:sample_rate=48000:duration=2.5',
      '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le', refPath
    ], { stdio: 'ignore' });
    buildPatchWav(patchPath, 0.6);
  }, 60_000);

  afterAll(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it('bakes via the no-gain fallback instead of aborting when the neighbor is pure silence', async () => {
    // The prior parse bug (Number("-inf") === NaN → throw) made this return baked:false.
    const result = await postMatchSeam(patchPath, {
      referenceAbsPath: refPath,
      editStartSec: 0.6,
      editEndSec: 1.2,
      granularity: 'phrase'
    });
    expect(result.baked).toBe(true);
    expect(result.durationSec!).toBeGreaterThan(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. Non-fatal contract — bogus reference leaves patch unchanged
// ---------------------------------------------------------------------------

describeIfFfmpeg('postMatchSeam — non-fatal on bogus reference', () => {
  let tempDir: string;
  let patchPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'etvs-seam-nonfatal-'));
    patchPath = join(tempDir, 'patch.wav');
    buildPatchWav(patchPath, 0.6);
  }, 30_000);

  afterAll(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it('returns baked:false and leaves the WAV bytes unchanged when referenceAbsPath does not exist', async () => {
    const beforeBytes = readFileSync(patchPath);

    const result = await postMatchSeam(patchPath, {
      referenceAbsPath: join(tempDir, 'nonexistent-reference.wav'),
      editStartSec: 0.5,
      editEndSec: 1.0,
      granularity: 'phrase'
    });

    const afterBytes = readFileSync(patchPath);

    expect(result.baked).toBe(false);
    expect(result.durationSec).toBeUndefined();
    // Exact byte-for-byte unchanged (mirrors audio-clip.test.ts:122-127 pattern)
    expect(beforeBytes.equals(afterBytes)).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5b. Non-fatal when patch itself does not exist
// ---------------------------------------------------------------------------

// Not gated on ffmpeg — postMatchSeam returns baked:false before any spawn
describe('postMatchSeam — non-fatal when patch does not exist', () => {
  it('returns baked:false immediately for a non-existent patchAbsPath', async () => {
    const result = await postMatchSeam('/nonexistent/path/patch.wav', {
      referenceAbsPath: '/nonexistent/reference.wav',
      editStartSec: 0,
      editEndSec: 1
    });
    expect(result.baked).toBe(false);
    expect(result.durationSec).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. mode:'level-feather' — skips room-tone bed, still bakes successfully
// ---------------------------------------------------------------------------

describeIfFfmpeg('postMatchSeam — mode:level-feather', () => {
  let tempDir: string;
  let patchPath: string;
  let refPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'etvs-seam-lf-'));
    patchPath = join(tempDir, 'patch.wav');
    refPath = join(tempDir, 'reference-48k.wav');
    buildReferenceWav(refPath, { speechDurationSec: 1.0, silenceDurationSec: 0.5 });
    buildPatchWav(patchPath, 0.6, -6); // moderately quiet to test level-match still runs
  }, 60_000);

  afterAll(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it('baked:true and roomToneSource is none (bed skipped)', async () => {
    const result = await postMatchSeam(patchPath, {
      referenceAbsPath: refPath,
      editStartSec: 1.0,
      editEndSec: 1.5,
      granularity: 'phrase',
      mode: 'level-feather'
    });

    expect(result.baked).toBe(true);
    expect(result.durationSec).toBeDefined();
    expect(result.durationSec!).toBeGreaterThan(0);
    expect(result.report).toBeDefined();
    // The key assertion: no bed was applied in level-feather mode
    expect(result.report!.roomToneSource).toBe('none');
    // Duration is preserved (level-match + feather don't change duration)
    expect(result.durationSec!).toBeCloseTo(0.6, 1);
  }, 60_000);

  it('report.leftLevelStepDb is null or a finite number (never ambiguously 0)', async () => {
    const result = await postMatchSeam(patchPath, {
      referenceAbsPath: refPath,
      editStartSec: 1.0,
      editEndSec: 1.5,
      granularity: 'phrase',
      mode: 'level-feather'
    });
    expect(result.baked).toBe(true);
    // leftLevelStepDb is either null (measurement failed) or a finite number
    if (result.report!.leftLevelStepDb !== null) {
      expect(Number.isFinite(result.report!.leftLevelStepDb)).toBe(true);
    }
  }, 60_000);
});
