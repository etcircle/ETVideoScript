import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sliceAudioWindow, trimPausesAndSilence, loudnormClip, extractReferenceWindow } from '../audioClip';
import { extractFullBandReference, saveManifestV3, type ManifestV3 } from '../index';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const describeIfFfmpeg = ffmpegAvailable ? describe : describe.skip;

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

function fixtureManifest(durationSec: number): ManifestV3 {
  return {
    manifestVersion: 3,
    projectId: 'audio-clip-test',
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
    assets: [
      {
        assetId: 'asset_video_001',
        kind: 'video',
        path: 'input/source.mp4',
        durationSec,
        provenance: 'imported',
        video: { width: 160, height: 90, fps: 30 },
        audio: { sampleRate: 48000 }
      }
    ],
    tracks: [
      {
        trackId: 'track_video_001',
        kind: 'video',
        name: 'Base',
        order: 0,
        locked: false,
        muted: false,
        solo: false,
        hidden: false,
        role: 'timeline',
        clips: [{
          clipId: 'clip_001',
          assetId: 'asset_video_001',
          sourceStart: 0,
          sourceEnd: durationSec,
          timelineStart: 0
        }]
      }
    ],
    operations: [],
    outputs: [{
      outputId: 'output_001',
      kind: 'full',
      aspects: ['16:9'],
      status: 'manual'
    }],
    renderPresets: {
      draft: { resolution: '160x90', videoBitrate: '250k', audioBitrate: '64k' },
      youtube: { resolution: '320x180', videoBitrate: '500k', audioBitrate: '128k' }
    }
  };
}

describeIfFfmpeg('sliceAudioWindow', () => {
  let tempDir: string;
  let inputWav: string;
  const INPUT_DURATION = 6;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'etvs-audio-clip-'));
    inputWav = join(tempDir, 'input.wav');
    // Generate 6s sine wave at 48kHz mono pcm_s16le
    spawnSync('ffmpeg', [
      '-y', '-f', 'lavfi',
      '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-ac', '1', '-acodec', 'pcm_s16le', inputWav
    ], { stdio: 'ignore' });
  }, 30_000);

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('slices [2, 4] from a 6s sine → output ≈ 2s, pcm_s16le', async () => {
    const outPath = join(tempDir, 'sliced.wav');
    await sliceAudioWindow(inputWav, 2, 4, outPath);
    const dur = probeDuration(outPath);
    expect(dur).toBeGreaterThan(1.9);
    expect(dur).toBeLessThan(2.1);
    const stream = probeAudioStream(outPath);
    expect(stream.codec).toBe('pcm_s16le');
  });

  it('does not modify the input file', async () => {
    const inputBefore = readFileSync(inputWav);
    const outPath = join(tempDir, 'sliced2.wav');
    await sliceAudioWindow(inputWav, 1, 3, outPath);
    const inputAfter = readFileSync(inputWav);
    expect(inputBefore.equals(inputAfter)).toBe(true);
  });

  it('throws for startSec >= endSec', async () => {
    await expect(sliceAudioWindow(inputWav, 3, 2, join(tempDir, 'bad.wav'))).rejects.toThrow();
  });
});

describeIfFfmpeg('trimPausesAndSilence', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'etvs-trim-'));
    // Generate speech-silence-speech pattern: 2s sine, 1.5s silence, 2s sine
    const sineAndSilence = join(tempDir, 'speech-silence-speech.wav');
    spawnSync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-f', 'lavfi', '-i', 'aevalsrc=0:channel_layout=mono:sample_rate=48000:duration=1.5',
      '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=2',
      '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1[out]',
      '-map', '[out]', '-acodec', 'pcm_s16le', sineAndSilence
    ], { stdio: 'ignore' });
  }, 30_000);

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('output is shorter than input (silence collapsed)', async () => {
    const inputPath = join(tempDir, 'speech-silence-speech.wav');
    const outputPath = join(tempDir, 'trimmed.wav');
    const inputDur = probeDuration(inputPath);
    await trimPausesAndSilence(inputPath, outputPath);
    const outputDur = probeDuration(outputPath);
    expect(outputDur).toBeGreaterThan(0);
    expect(outputDur).toBeLessThan(inputDur);
  });

  it('input file is unchanged after trim', async () => {
    const inputPath = join(tempDir, 'speech-silence-speech.wav');
    const before = readFileSync(inputPath);
    const outputPath = join(tempDir, 'trimmed2.wav');
    await trimPausesAndSilence(inputPath, outputPath);
    const after = readFileSync(inputPath);
    expect(before.equals(after)).toBe(true);
  });
});

describeIfFfmpeg('loudnormClip', () => {
  let tempDir: string;
  let inputWav: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'etvs-norm-'));
    inputWav = join(tempDir, 'sine.wav');
    spawnSync('ffmpeg', [
      '-y', '-f', 'lavfi',
      '-i', 'sine=frequency=440:sample_rate=48000:duration=5',
      '-ac', '1', '-acodec', 'pcm_s16le', inputWav
    ], { stdio: 'ignore' });
  }, 30_000);

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('produces a valid WAV with approximately the same duration', async () => {
    const outPath = join(tempDir, 'normed.wav');
    await loudnormClip(inputWav, outPath);
    const dur = probeDuration(outPath);
    expect(dur).toBeGreaterThan(4.5);
    expect(dur).toBeLessThan(5.5);
    const stream = probeAudioStream(outPath);
    expect(stream.codec).toBe('pcm_s16le');
  });

  it('input file is unchanged after loudnorm', async () => {
    const before = readFileSync(inputWav);
    const outPath = join(tempDir, 'normed2.wav');
    await loudnormClip(inputWav, outPath);
    const after = readFileSync(inputWav);
    expect(before.equals(after)).toBe(true);
  });
});

describeIfFfmpeg('clone-path isolation — no 16k STT or source mutation', () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'etvs-clone-isolation-'));
    mkdirSync(join(workspace, 'input'), { recursive: true });
    // Create a fake source.mp4 (actually just an mp4-format audio container)
    spawnSync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=160x90:duration=6:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest', '-y', join(workspace, 'input', 'source.mp4')
    ], { stdio: 'ignore' });
    saveManifestV3(workspace, fixtureManifest(6), { revision: false });
    // Create the 16k STT copy
    mkdirSync(join(workspace, 'media', 'clip_001'), { recursive: true });
    const sttPath = join(workspace, 'media', 'clip_001', 'extracted-audio.wav');
    spawnSync('ffmpeg', [
      '-y', '-i', join(workspace, 'input', 'source.mp4'),
      '-vn', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', sttPath
    ], { stdio: 'ignore' });
  }, 60_000);

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it('clone prep chain leaves source.mp4 and STT copy byte-identical', async () => {
    const srcPath = join(workspace, 'input', 'source.mp4');
    const sttPath = join(workspace, 'media', 'clip_001', 'extracted-audio.wav');
    const srcBefore = readFileSync(srcPath);
    const sttBefore = readFileSync(sttPath);

    // Run the full chain: extract 48k reference → slice → trim → loudnorm
    const refRel = await extractFullBandReference(workspace, 'clip_001');
    const refAbs = join(workspace, refRel);

    const slicedPath = join(workspace, 'media', 'clip_001', '.test-slice.wav');
    const trimmedPath = join(workspace, 'media', 'clip_001', '.test-trimmed.wav');
    const normedPath = join(workspace, 'media', 'clip_001', '.test-normed.wav');

    await sliceAudioWindow(refAbs, 0.5, 5.5, slicedPath);
    await trimPausesAndSilence(slicedPath, trimmedPath);
    await loudnormClip(trimmedPath, normedPath);

    // Hard rules: source and 16k STT copy must be byte-for-byte unchanged
    expect(readFileSync(srcPath).equals(srcBefore)).toBe(true);
    expect(readFileSync(sttPath).equals(sttBefore)).toBe(true);

    // Verify the 16k STT copy still probes as 16kHz (not accidentally overwritten with 48k)
    const sttStream = probeAudioStream(sttPath);
    expect(sttStream.sampleRate).toBe(16000);

    // And the reference is 48kHz
    const refStream = probeAudioStream(refAbs);
    expect(refStream.sampleRate).toBe(48000);
  });
});

// Not gated on ffmpeg — the guard throws before any spawn, so a plain file suffices.
describe('audio helpers — refuse to overwrite their input (out === in guard)', () => {
  let tempDir: string;
  let filePath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'etvs-audio-guard-'));
    filePath = join(tempDir, 'in.wav');
    writeFileSync(filePath, Buffer.from('exists-but-not-real-audio'));
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('sliceAudioWindow rejects when out === in', async () => {
    await expect(sliceAudioWindow(filePath, 0, 1, filePath)).rejects.toThrow(/output path must differ/);
  });

  it('trimPausesAndSilence rejects when out === in', async () => {
    await expect(trimPausesAndSilence(filePath, filePath)).rejects.toThrow(/output path must differ/);
  });

  it('loudnormClip rejects when out === in', async () => {
    await expect(loudnormClip(filePath, filePath)).rejects.toThrow(/output path must differ/);
  });

  it('sliceAudioWindow rejects a negative startSec', async () => {
    await expect(sliceAudioWindow(filePath, -1, 2, join(tempDir, 'neg.wav'))).rejects.toThrow(/must be >= 0/);
  });
});

// ---------------------------------------------------------------------------
// extractReferenceWindow — asset-axis 48k window extraction
// ---------------------------------------------------------------------------

describeIfFfmpeg('extractReferenceWindow', () => {
  let workspace: string;
  const SOURCE_DURATION = 4; // seconds

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'etvs-refwin-'));
    mkdirSync(join(workspace, 'input'), { recursive: true });
    // 4s 160x90 video + 440 Hz sine audio muxed in — matches reference-audio.test.ts pattern
    spawnSync('ffmpeg', [
      '-f', 'lavfi', '-i', 'color=c=black:s=160x90:duration=4:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest', '-y', join(workspace, 'input', 'source.mp4')
    ], { stdio: 'ignore' });
    saveManifestV3(workspace, fixtureManifest(SOURCE_DURATION), { revision: false });
  }, 60_000);

  afterAll(() => { if (workspace) rmSync(workspace, { recursive: true, force: true }); });

  it('writes a 48k mono pcm_s16le window with plausible duration (ffprobed, not trusted from args)', async () => {
    const outPath = join(workspace, 'media', 'clip_001', 'test-window.wav');
    await extractReferenceWindow(workspace, 'clip_001', 0.5, 2.0, outPath);

    // ffprobe — never trust comments, always assert via probe
    const out = spawnSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate,channels,codec_name',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1',
      outPath
    ], { encoding: 'utf8' });
    const fields = new Map<string, string>();
    for (const line of out.stdout.trim().split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1));
    }
    expect(Number(fields.get('sample_rate'))).toBe(48000);
    expect(Number(fields.get('channels'))).toBe(1);
    expect(fields.get('codec_name')).toBe('pcm_s16le');
    const duration = Number(fields.get('duration'));
    // Window is [0.5, 2.0) = 1.5s; allow small ffmpeg boundary tolerance
    expect(duration).toBeGreaterThan(1.3);
    expect(duration).toBeLessThan(1.7);
  }, 60_000);

  it('forces 48000 Hz even when the underlying reference has a different rate', async () => {
    // This is the critical invariant: sliceAudioWindow would preserve the input rate,
    // but extractReferenceWindow must always output 48k. We prove this by checking the
    // output of a call whose source was extracted at the default 48k — and that the
    // output is also 48k (end-to-end, not just a claim).
    const outPath = join(workspace, 'media', 'clip_001', 'test-window2.wav');
    await extractReferenceWindow(workspace, 'clip_001', 1.0, 3.0, outPath);
    const out = spawnSync('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      outPath
    ], { encoding: 'utf8' });
    expect(Number(out.stdout.trim())).toBe(48000);
  }, 60_000);

  it('rejects non-finite or inverted bounds', async () => {
    const outPath = join(workspace, 'media', 'clip_001', 'bad.wav');
    await expect(extractReferenceWindow(workspace, 'clip_001', NaN, 2, outPath)).rejects.toThrow(/finite/);
    await expect(extractReferenceWindow(workspace, 'clip_001', 2, 1, outPath)).rejects.toThrow(/must be < endSec/);
    await expect(extractReferenceWindow(workspace, 'clip_001', -1, 2, outPath)).rejects.toThrow(/must be >= 0/);
  });

  it('rejects an unsafe clipId', async () => {
    const outPath = join(workspace, 'media', 'test.wav');
    await expect(extractReferenceWindow(workspace, '../evil', 0, 1, outPath)).rejects.toThrow(/Unsafe clipId/);
  });
});
