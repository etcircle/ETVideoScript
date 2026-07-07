import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFullBandReference, saveManifestV3, type ManifestV3 } from '../index';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const describeIfFfmpeg = ffmpegAvailable ? describe : describe.skip;

function probeAudioStream(path: string): { sampleRate: number; channels: number } {
  const out = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels', '-of', 'default=noprint_wrappers=1:nokey=1', path], { encoding: 'utf8' });
  const [sampleRate, channels] = out.stdout.trim().split('\n').map(Number);
  return { sampleRate: sampleRate ?? 0, channels: channels ?? 0 };
}

function probeDuration(path: string): number {
  const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], { encoding: 'utf8' });
  return Number(out.stdout.trim());
}

function fixtureManifest(durationSec: number): ManifestV3 {
  return {
    manifestVersion: 3,
    projectId: 'reference-audio-integration',
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
    assets: [
      { assetId: 'asset_video_001', kind: 'video', path: 'input/source.mp4', durationSec, provenance: 'imported', video: { width: 160, height: 90, fps: 30 }, audio: { sampleRate: 48000 } }
    ],
    tracks: [
      { trackId: 'track_video_001', kind: 'video', name: 'Base', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: durationSec, timelineStart: 0 }] }
    ],
    operations: [],
    outputs: [{ outputId: 'output_001', kind: 'full', aspects: ['16:9'], status: 'manual' }],
    takeGroups: [],
    renderPresets: {
      draft: { resolution: '160x90', videoBitrate: '250k', audioBitrate: '64k' },
      youtube: { resolution: '320x180', videoBitrate: '500k', audioBitrate: '128k' }
    }
  };
}

describeIfFfmpeg('full-band 48k reference derivative', () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'etvs-ref48k-'));
    mkdirSync(join(workspace, 'input'), { recursive: true });
    // 2s 160x90 video + 440 Hz sine audio muxed in.
    spawnSync('ffmpeg', [
      '-f', 'lavfi', '-i', 'color=c=black:s=160x90:duration=2:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
      '-shortest', '-y', join(workspace, 'input', 'source.mp4')
    ], { stdio: 'ignore' });
    saveManifestV3(workspace, fixtureManifest(2), { revision: false });
  }, 60_000);

  afterAll(() => { if (workspace) rmSync(workspace, { recursive: true, force: true }); });

  it('writes a 48k mono derivative at a dedicated path, leaving source and the 16k STT copy untouched', async () => {
    // Create the 16k STT copy first (same shape extractClipAudio produces: 16k mono pcm_s16le)
    // so we can prove the derivative never clobbers it. Generated directly to avoid the
    // project.json that extractClipAudio's loadProject requires.
    const sttPath = join(workspace, 'media', 'clip_001', 'extracted-audio.wav');
    const srcPath = join(workspace, 'input', 'source.mp4');
    mkdirSync(join(workspace, 'media', 'clip_001'), { recursive: true });
    spawnSync('ffmpeg', ['-y', '-i', srcPath, '-vn', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', sttPath], { stdio: 'ignore' });
    const sttBefore = readFileSync(sttPath);
    const srcBefore = readFileSync(srcPath);
    const sttSr = probeAudioStream(sttPath).sampleRate;
    expect(sttSr).toBe(16000); // sanity: the STT copy is narrowband

    const rel = await extractFullBandReference(workspace, 'clip_001');
    expect(rel).toBe('media/clip_001/reference-48k.wav');
    const refPath = join(workspace, rel);

    // Derivative is full-band mono.
    const ref = probeAudioStream(refPath);
    expect(ref.sampleRate).toBe(48000);
    expect(ref.channels).toBe(1);

    // Hard rules: source and the 16k STT copy are byte-for-byte unchanged.
    expect(readFileSync(srcPath).equals(srcBefore)).toBe(true);
    expect(readFileSync(sttPath).equals(sttBefore)).toBe(true);
    expect(refPath).not.toBe(sttPath);
  });

  it('returns the cached derivative without re-running ffmpeg unless overwrite is set', async () => {
    const rel = await extractFullBandReference(workspace, 'clip_001');
    const refPath = join(workspace, rel);
    const mtimeBefore = statSync(refPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    await extractFullBandReference(workspace, 'clip_001'); // overwrite defaults false → cached
    expect(statSync(refPath).mtimeMs).toBe(mtimeBefore);
    await extractFullBandReference(workspace, 'clip_001', { overwrite: true }); // re-runs
    expect(statSync(refPath).mtimeMs).toBeGreaterThan(mtimeBefore);
  });

  it('rejects an unknown clipId', async () => {
    await expect(extractFullBandReference(workspace, 'clip_nope')).rejects.toThrow(/Unknown clipId/);
  });

  it('rejects an unsafe clipId (path traversal) before any manifest/path work', async () => {
    await expect(extractFullBandReference(workspace, '../input')).rejects.toThrow(/Unsafe clipId/);
    await expect(extractFullBandReference(workspace, 'a/b')).rejects.toThrow(/Unsafe clipId/);
  });

  it('never writes THROUGH a symlink at the output path — source stays untouched on overwrite', async () => {
    const refPath = join(workspace, 'media', 'clip_001', 'reference-48k.wav');
    const srcPath = join(workspace, 'input', 'source.mp4');
    // Plant a hostile symlink at the derivative path, pointing AT the source media.
    rmSync(refPath, { force: true });
    symlinkSync(srcPath, refPath);
    const srcBefore = readFileSync(srcPath);

    await extractFullBandReference(workspace, 'clip_001', { overwrite: true });

    // ffmpeg wrote to a temp file and rename replaced the symlink: source is byte-for-byte intact,
    // and the derivative is now a REAL 48k file (not a symlink).
    expect(readFileSync(srcPath).equals(srcBefore)).toBe(true);
    expect(lstatSync(refPath).isSymbolicLink()).toBe(false);
    expect(probeAudioStream(refPath).sampleRate).toBe(48000);
  });

  it('rejects a truncated valid-header cache (duration completeness) and re-extracts the full derivative', async () => {
    const refPath = join(workspace, 'media', 'clip_001', 'reference-48k.wav');
    // Plant a SHORT (0.2s) but otherwise-valid 48k mono pcm_s16le file at the cache path — the
    // exact format-valid-but-truncated case a format-only check would wrongly accept.
    spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.2', '-ac', '1', '-acodec', 'pcm_s16le', refPath], { stdio: 'ignore' });
    expect(probeDuration(refPath)).toBeLessThan(0.5);
    // No overwrite: the truncated cache must be rejected (duration far from the ~2s source),
    // forcing a re-extract to the full derivative.
    await extractFullBandReference(workspace, 'clip_001');
    expect(probeDuration(refPath)).toBeGreaterThan(1.5);
  });
});
