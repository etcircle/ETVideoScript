import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspace, detachAudioInWorkspaceV3, extractAudio, importSource, loadManifestV3 } from '../index';

// Small test video: 320x240 testsrc + 440 Hz stereo sine.
function makeVideo(dir: string): string {
  const path = join(dir, 'source.mp4');
  const result = spawnSync('ffmpeg', ['-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr}`);
  return path;
}

// A pre-planted symlink at a derivative path must be REPLACED by regeneration, never
// written through: ffmpeg -y at the destination follows the link and clobbers its
// target — and sidecar-staleness regeneration runs automatically, without any --yes
// gate. writeDerivativeStaged (stage in a private temp dir + renameSync) closes this.
describe('derivative regeneration replaces pre-planted symlinks instead of writing through them', () => {
  let dir: string;
  let workspace: string;
  let victim: string;
  const VICTIM_BYTES = 'precious source bytes that must never be clobbered';
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'etv-symlink-defense-'));
    workspace = join(dir, 'ws');
    victim = join(dir, 'victim.bin');
    writeFileSync(victim, VICTIM_BYTES);
    await createWorkspace({ workspacePath: workspace, projectId: 'symlink-defense', title: 'Symlink defense test' });
    await importSource(workspace, makeVideo(dir));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('extractAudio: media/extracted-audio.wav symlink is replaced, victim untouched', async () => {
    const derivative = join(workspace, 'media/extracted-audio.wav');
    if (existsSync(derivative)) unlinkSync(derivative);
    symlinkSync(victim, derivative);

    await extractAudio(workspace, { overwrite: true, logJob: false });

    expect(readFileSync(victim, 'utf8')).toBe(VICTIM_BYTES);
    expect(lstatSync(derivative).isSymbolicLink()).toBe(false);
    // Real extracted audio, not the victim's content: a RIFF/WAVE header.
    expect(readFileSync(derivative).subarray(0, 4).toString()).toBe('RIFF');
  }, 60_000);

  it('detach-audio: assets/audio/<assetId>.wav symlink is replaced, victim untouched', async () => {
    // The detached WAV lands at assets/audio/<sourceAssetId>.wav (extractAudioAssetInWorkspace).
    const manifest = loadManifestV3(workspace);
    const clip = manifest.tracks.flatMap((track) => track.clips).find((candidate) => candidate.clipId === 'clip_001')!;
    const derivative = join(workspace, `assets/audio/${clip.assetId}.wav`);
    mkdirSync(join(workspace, 'assets/audio'), { recursive: true });
    if (existsSync(derivative)) unlinkSync(derivative);
    symlinkSync(victim, derivative);

    detachAudioInWorkspaceV3(workspace, { clipId: 'clip_001' });

    expect(readFileSync(victim, 'utf8')).toBe(VICTIM_BYTES);
    expect(lstatSync(derivative).isSymbolicLink()).toBe(false);
    expect(readFileSync(derivative).subarray(0, 4).toString()).toBe('RIFF');
  }, 60_000);
});
