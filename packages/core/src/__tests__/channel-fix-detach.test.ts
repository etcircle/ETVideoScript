import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addClipV3, applyChannelFix, createWorkspace, detachAudioInWorkspaceV3, importSource, loadManifestV3, parseAstatsChannelRms, saveManifestV3 } from '../index';

// One-sided test video: 320x240 testsrc video + 440 Hz sine on the LEFT channel only.
function makeOneSidedVideo(dir: string): string {
  const path = join(dir, 'one-sided.mp4');
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

function channelRms(path: string): number[] {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-i', path, '-af', 'astats=measure_perchannel=RMS_level:measure_overall=none', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`astats failed: ${result.stderr}`);
  return parseAstatsChannelRms(result.stderr);
}

describe('detaching audio honors audioChannelFix (issue #2)', () => {
  let dir: string;
  let workspace: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'etv-chanfix-detach-'));
    workspace = join(dir, 'ws');
    await createWorkspace({ workspacePath: workspace, projectId: 'chanfix-detach', title: 'Channel fix detach test' });
    await importSource(workspace, makeOneSidedVideo(dir));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('duplicates the live channel to both stereo channels when the fix is approved, instead of preserving the dead channel', async () => {
    const outcome = applyChannelFix(workspace);
    expect(outcome.action).toBe('applied');
    if (outcome.action === 'applied') expect(outcome.fix.sourceChannel).toBe('left');

    const result = detachAudioInWorkspaceV3(workspace, { clipId: 'clip_001' });
    const rms = channelRms(join(workspace, result.asset.path));
    expect(rms[0]).toBeDefined();
    expect(rms[1]).toBeDefined();
    // Right channel used to be silent (~ -120 dB floor per CHANNEL_FIX_SILENCE_FLOOR_DB);
    // after the fix it mirrors the live left channel almost exactly.
    expect(Math.abs(rms[0]! - rms[1]!)).toBeLessThan(1);
    expect(rms[1]!).toBeGreaterThan(-60);
  }, 60_000);
});

describe('detach re-extracts when the fix changes after a prior detach (issue #2 freshness)', () => {
  let dir: string;
  let workspace: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'etv-chanfix-detach-fresh-'));
    workspace = join(dir, 'ws');
    await createWorkspace({ workspacePath: workspace, projectId: 'chanfix-detach-fresh', title: 'Channel fix detach freshness test' });
    await importSource(workspace, makeOneSidedVideo(dir));
    // A second clip on the SAME source asset, so both detaches share the underlying
    // assets/audio/asset_video_001.wav extraction and we can exercise cache freshness.
    const manifest = loadManifestV3(workspace);
    const videoTrack = manifest.tracks.find((track) => track.kind === 'video')!;
    const next = addClipV3(manifest, { trackId: videoTrack.trackId, clip: { clipId: 'clip_002', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 0.5, timelineStart: 5 } }).manifest;
    saveManifestV3(workspace, next, { revision: false });
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('a detach performed before the fix was applied is not stuck wrong-channel forever once the fix is approved', async () => {
    // Detach clip_001 with NO fix yet: the raw one-sided stereo, dead channel preserved.
    const first = detachAudioInWorkspaceV3(workspace, { clipId: 'clip_001' });
    const staleRms = channelRms(join(workspace, first.asset.path));
    expect(staleRms[1]!).toBeLessThan(-60); // still dead

    applyChannelFix(workspace);

    // Detaching clip_002 (same source asset) must re-extract rather than reuse the
    // asset record created for clip_001's detach, even though extractedAssetFor()
    // would otherwise find a matching manifest asset.
    const second = detachAudioInWorkspaceV3(workspace, { clipId: 'clip_002' });
    expect(second.asset.assetId).toBe(first.asset.assetId); // same shared asset record
    const freshRms = channelRms(join(workspace, second.asset.path));
    expect(Math.abs(freshRms[0]! - freshRms[1]!)).toBeLessThan(1);
    expect(freshRms[1]!).toBeGreaterThan(-60); // no longer dead
  }, 60_000);
});

describe('detachAudioInWorkspace refresh flag revisits an already-detached clip (issue #4)', () => {
  let dir: string;
  let workspace: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'etv-chanfix-detach-refresh-'));
    workspace = join(dir, 'ws');
    await createWorkspace({ workspacePath: workspace, projectId: 'chanfix-detach-refresh', title: 'detach refresh flag test' });
    await importSource(workspace, makeOneSidedVideo(dir));
    detachAudioInWorkspaceV3(workspace, { clipId: 'clip_001' });
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('without refresh, a repeat detach on an already-detached clip still throws (default unchanged)', () => {
    expect(() => detachAudioInWorkspaceV3(workspace, { clipId: 'clip_001' })).toThrow('Clip audio already detached');
  });

  it('refresh:true re-extracts the detached audio in place once the fix changes, returning the SAME clip/track/asset records', () => {
    // Detached above with no fix yet: the raw one-sided stereo, dead channel preserved.
    const before = detachAudioInWorkspaceV3(workspace, { clipId: 'clip_001', refresh: true }); // no fix change yet: still stale
    const staleRms = channelRms(join(workspace, before.asset.path));
    expect(staleRms[1]!).toBeLessThan(-60);

    applyChannelFix(workspace);

    const after = detachAudioInWorkspaceV3(workspace, { clipId: 'clip_001', refresh: true });
    expect(after.audioClip.clipId).toBe(before.audioClip.clipId);
    expect(after.audioTrack.trackId).toBe(before.audioTrack.trackId);
    expect(after.asset.assetId).toBe(before.asset.assetId);
    const freshRms = channelRms(join(workspace, after.asset.path));
    expect(Math.abs(freshRms[0]! - freshRms[1]!)).toBeLessThan(1);
    expect(freshRms[1]!).toBeGreaterThan(-60); // no longer dead
  }, 60_000);
});
