import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyChannelFix, createWorkspace, extractAudio, importSource, loadManifestV3, loadProject, sha256File } from '../index';

// One-sided stereo: 440 Hz sine on the LEFT channel only, silence on the right.
function makeOneSidedVideo(dir: string, name: string): string {
  const path = join(dir, name);
  const result = spawnSync('ffmpeg', ['-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000',
    '-filter_complex', '[1:a]pan=stereo|c0=c0|c1=0*c0[a]',
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr}`);
  return path;
}

// Genuinely different recording: mono audio (1 channel), distinct video content, so its
// sha256 (and probed channel count) differ from the one-sided stereo fixture above.
function makeMonoVideo(dir: string, name: string): string {
  const path = join(dir, name);
  const result = spawnSync('ffmpeg', ['-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1:sample_rate=48000',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', '-shortest', path
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr}`);
  return path;
}

// Same one-sided fixture as above, but with a configurable duration — used to reproduce
// the shorter-replace split-brain (issue #1 blocker).
function makeOneSidedVideoWithDuration(dir: string, name: string, durationSec: number): string {
  const path = join(dir, name);
  const result = spawnSync('ffmpeg', ['-y',
    '-f', 'lavfi', '-i', `testsrc=duration=${durationSec}:size=320x240:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSec}:sample_rate=48000`,
    '-filter_complex', '[1:a]pan=stereo|c0=c0|c1=0*c0[a]',
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr}`);
  return path;
}

describe('importSource --replace validates BEFORE promoting (issue #1 blocker)', () => {
  let dir: string;
  let workspace: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'etv-chanfix-shorter-'));
    workspace = join(dir, 'ws');
    await createWorkspace({ workspacePath: workspace, projectId: 'chanfix-shorter', title: 'shorter replace blocker test' });
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('rejects a shorter replacement before touching source bytes, project.json, or the manifest; a retry throws identically', async () => {
    const longVideo = makeOneSidedVideoWithDuration(dir, 'long.mp4', 3);
    await importSource(workspace, longVideo);
    const applied = applyChannelFix(workspace);
    expect(applied.action).toBe('applied');

    const target = join(workspace, 'input/source.mp4');
    const beforeHash = sha256File(target);
    const beforeProject = loadProject(workspace);
    const beforeManifest = loadManifestV3(workspace);
    expect(beforeManifest.audioChannelFix?.status).toBe('approved');

    const shortVideo = makeOneSidedVideoWithDuration(dir, 'short.mp4', 1);
    await expect(importSource(workspace, shortVideo, { replace: true })).rejects.toThrow();

    // Workspace state is byte-for-byte unchanged: source bytes, project.json, AND the
    // manifest (clip span + approved fix) all survive the rejected replace intact.
    expect(sha256File(target)).toBe(beforeHash);
    expect(loadProject(workspace)).toEqual(beforeProject);
    expect(loadManifestV3(workspace)).toEqual(beforeManifest);

    // Retry with the same shorter file throws identically, and the workspace is still
    // untouched — no split-brain state accumulates across repeated attempts.
    await expect(importSource(workspace, shortVideo, { replace: true })).rejects.toThrow();
    expect(sha256File(target)).toBe(beforeHash);
    expect(loadProject(workspace)).toEqual(beforeProject);
    expect(loadManifestV3(workspace)).toEqual(beforeManifest);
  }, 60_000);
});

describe('extraction re-extracts after a source replace even when the fix state does not change (issue #2 mtime axis)', () => {
  let dir: string;
  let workspace: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'etv-chanfix-mtime-'));
    workspace = join(dir, 'ws');
    await createWorkspace({ workspacePath: workspace, projectId: 'chanfix-mtime', title: 'mtime freshness axis test' });
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('extract-audio without --yes re-extracts new bytes after --replace, even though audioChannelFix stays "none" throughout', async () => {
    await importSource(workspace, makeOneSidedVideo(dir, 'one-sided.mp4'));
    await extractAudio(workspace, { logJob: false });
    const outputPath = join(workspace, 'media/extracted-audio.wav');
    const beforeMtime = statSync(outputPath).mtimeMs;
    const beforeBytes = readFileSync(outputPath);

    await new Promise((r) => setTimeout(r, 10));
    // Different content (mono, different tone) but NO channel fix is ever applied here —
    // an extraction cache keyed only on the fix fingerprint ('none' both before and after)
    // would wrongly keep serving the OLD recording's audio forever.
    await importSource(workspace, makeMonoVideo(dir, 'mono.mp4'), { replace: true });

    // No overwrite requested: only the source-mtime freshness dimension can catch this.
    await extractAudio(workspace, { logJob: false });
    const afterMtime = statSync(outputPath).mtimeMs;
    const afterBytes = readFileSync(outputPath);
    expect(afterMtime).toBeGreaterThan(beforeMtime);
    expect(Buffer.compare(afterBytes, beforeBytes)).not.toBe(0);
  }, 60_000);
});

describe('importSource --replace invalidates a stale audioChannelFix (issue #3)', () => {
  let dir: string;
  let workspace: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'etv-chanfix-import-replace-'));
    workspace = join(dir, 'ws');
    await createWorkspace({ workspacePath: workspace, projectId: 'chanfix-import-replace', title: 'Channel fix import-replace test' });
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('disables (not deletes) an approved fix when the replacement content actually differs, and refreshes asset audio metadata', async () => {
    await importSource(workspace, makeOneSidedVideo(dir, 'one-sided.mp4'));
    const outcome = applyChannelFix(workspace);
    expect(outcome.action).toBe('applied');
    const beforeReplace = loadManifestV3(workspace);
    expect(beforeReplace.audioChannelFix?.status).toBe('approved');
    expect(beforeReplace.assets.find((a) => a.assetId === 'asset_video_001')?.audio?.channels).toBe(2);
    const appliedAtBefore = beforeReplace.audioChannelFix!.appliedAt;

    await new Promise((r) => setTimeout(r, 10));
    await importSource(workspace, makeMonoVideo(dir, 'mono.mp4'), { replace: true });

    const afterReplace = loadManifestV3(workspace);
    // Record retained (reversible), not deleted, and NOT silently left approved for the
    // new recording — it described the OLD bytes.
    expect(afterReplace.audioChannelFix).toBeDefined();
    expect(afterReplace.audioChannelFix?.status).toBe('disabled');
    expect(afterReplace.audioChannelFix?.sourceChannel).toBe('left'); // history untouched
    expect(afterReplace.audioChannelFix?.appliedAt).not.toBe(appliedAtBefore);
    // Asset metadata refreshed to describe the NEW (mono) recording, not the old stereo one.
    expect(afterReplace.assets.find((a) => a.assetId === 'asset_video_001')?.audio?.channels).toBe(1);
  }, 60_000);

  it('does not churn the fix on a no-op replace of identical bytes', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'etv-chanfix-import-noop-'));
    const workspace2 = join(dir2, 'ws');
    try {
      await createWorkspace({ workspacePath: workspace2, projectId: 'chanfix-import-noop', title: 'no-op replace test' });
      const video = makeOneSidedVideo(dir2, 'one-sided.mp4');
      await importSource(workspace2, video);
      applyChannelFix(workspace2);
      const before = loadManifestV3(workspace2);
      expect(before.audioChannelFix?.status).toBe('approved');

      await importSource(workspace2, video, { replace: true });
      const after = loadManifestV3(workspace2);
      expect(after.audioChannelFix?.status).toBe('approved');
      expect(after.audioChannelFix?.appliedAt).toBe(before.audioChannelFix?.appliedAt);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  }, 60_000);
});
