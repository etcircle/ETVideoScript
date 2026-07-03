import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addAssetV3, addClipV3, applyChannelFix, createWorkspace, extractAudio, extractClipAudio, extractFullBandReference, importSource, loadManifestV3, parseAstatsChannelRms, saveManifestV3 } from '../index';

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

// Mono RMS of a wav via astats (parseAstatsChannelRms returns [channel0]).
function rmsDb(path: string): number {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-i', path, '-af', 'astats=measure_perchannel=RMS_level:measure_overall=none', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`astats failed: ${result.stderr}`);
  const rms = parseAstatsChannelRms(result.stderr);
  if (rms[0] === undefined) throw new Error('no RMS parsed');
  return rms[0];
}

describe('extraction honors audioChannelFix', () => {
  let dir: string;
  let workspace: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'etv-chanfix-extract-'));
    workspace = join(dir, 'ws');
    await createWorkspace({ workspacePath: workspace, projectId: 'chanfix-extract', title: 'Channel fix extract test' });
    await importSource(workspace, makeOneSidedVideo(dir));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('extracts only the live channel when the fix is approved (≈6 dB louder than averaging)', async () => {
    // Baseline: no fix → -ac 1 averages the silent channel in.
    await extractAudio(workspace, { overwrite: true, logJob: false });
    const averagedRms = rmsDb(join(workspace, 'media/extracted-audio.wav'));

    const outcome = applyChannelFix(workspace);
    expect(outcome.action).toBe('applied');
    if (outcome.action === 'applied') expect(outcome.fix.sourceChannel).toBe('left');

    await extractAudio(workspace, { overwrite: true, logJob: false });
    const fixedRms = rmsDb(join(workspace, 'media/extracted-audio.wav'));

    // Averaging a dead channel costs 6.02 dB; allow encoder slack.
    expect(fixedRms - averagedRms).toBeGreaterThan(4);
  }, 60_000);

  it('a disabled fix falls back to plain -ac 1 averaging', async () => {
    applyChannelFix(workspace, { disable: true });
    await extractAudio(workspace, { overwrite: true, logJob: false });
    const disabledRms = rmsDb(join(workspace, 'media/extracted-audio.wav'));
    applyChannelFix(workspace, { channel: 'left' }); // restore for any later test
    await extractAudio(workspace, { overwrite: true, logJob: false });
    const fixedRms = rmsDb(join(workspace, 'media/extracted-audio.wav'));
    expect(fixedRms - disabledRms).toBeGreaterThan(4);
  }, 60_000);

  // Issue #1: extraction previously cached on existence alone, so a fix applied/changed
  // AFTER the last extraction was silently ignored unless the caller passed --yes/overwrite.
  it('regenerates stale extracted audio when the fix changes, even without overwrite:true', async () => {
    applyChannelFix(workspace, { disable: true });
    await extractAudio(workspace, { overwrite: true, logJob: false });
    const averagedRms = rmsDb(join(workspace, 'media/extracted-audio.wav'));

    const outcome = applyChannelFix(workspace, { channel: 'left' });
    expect(outcome.action).toBe('applied');

    // No overwrite requested: an existence-only cache would wrongly reuse the averaged file.
    await extractAudio(workspace, { logJob: false });
    const fixedRms = rmsDb(join(workspace, 'media/extracted-audio.wav'));
    expect(fixedRms - averagedRms).toBeGreaterThan(4);

    // Fix unchanged since the last extraction → cache correctly reused (no regeneration needed,
    // proven by re-extraction producing the identical fixed RMS again with no overwrite).
    await extractAudio(workspace, { logJob: false });
    expect(rmsDb(join(workspace, 'media/extracted-audio.wav'))).toBeCloseTo(fixedRms, 1);
  }, 60_000);
});

describe('a missing sidecar forces exactly one regeneration, then caches again (issue #6/#10)', () => {
  let dir: string;
  let workspace: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'etv-chanfix-missing-sidecar-'));
    workspace = join(dir, 'ws');
    await createWorkspace({ workspacePath: workspace, projectId: 'chanfix-missing-sidecar', title: 'missing sidecar test' });
    await importSource(workspace, makeOneSidedVideo(dir));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('re-extracts once when the sidecar is missing (interrupted write / pre-feature derivative), then reuses the cache once the sidecar exists', async () => {
    await extractAudio(workspace, { logJob: false });
    const outputPath = join(workspace, 'media/extracted-audio.wav');
    const sidecarPath = `${outputPath}.channelfix`;
    expect(existsSync(sidecarPath)).toBe(true);
    // Simulate a process killed between ffmpeg writing the derivative and the sidecar
    // write, or a pre-feature derivative that predates the sidecar mechanism entirely.
    rmSync(sidecarPath);

    const beforeMtime = statSync(outputPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    // No overwrite requested: a missing sidecar must NOT be treated as an implicit
    // 'none' match against the current (also-'none') fix state — it must force exactly
    // one regeneration.
    await extractAudio(workspace, { logJob: false });
    const afterMtime = statSync(outputPath).mtimeMs;
    expect(afterMtime).toBeGreaterThan(beforeMtime);
    expect(existsSync(sidecarPath)).toBe(true);

    // Sidecar now present and fix state unchanged → cache reused (mtime stable).
    await new Promise((r) => setTimeout(r, 10));
    await extractAudio(workspace, { logJob: false });
    expect(statSync(outputPath).mtimeMs).toBe(afterMtime);
  }, 60_000);
});

describe('extraction is scoped to the fix\'s own asset (issue #4)', () => {
  let dir: string;
  let workspace: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'etv-chanfix-scope-'));
    workspace = join(dir, 'ws');
    await createWorkspace({ workspacePath: workspace, projectId: 'chanfix-scope', title: 'Channel fix scope test' });
    await importSource(workspace, makeOneSidedVideo(dir));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('does not pan an unrelated video asset even when the base recording fix is approved', async () => {
    // Baseline: -ac 1 averaged extraction of the one-sided audio, with no fix at all.
    const baseline = await extractClipAudio(workspace, 'clip_001', { overwrite: true, logJob: false });
    const averagedRms = rmsDb(join(workspace, baseline));

    const outcome = applyChannelFix(workspace);
    expect(outcome.action).toBe('applied');

    // A second video asset with the SAME one-sided audio bytes, registered under a
    // different path than input/source.mp4 — the fix must not describe it (issue #4).
    copyFileSync(join(workspace, 'input/source.mp4'), join(workspace, 'input/other.mp4'));
    let manifest = loadManifestV3(workspace);
    manifest = addAssetV3(manifest, { assetId: 'asset_video_other', kind: 'video', path: 'input/other.mp4', durationSec: 1, provenance: 'imported', video: { width: 320, height: 240, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } }).manifest;
    const videoTrack = manifest.tracks.find((track) => track.kind === 'video')!;
    manifest = addClipV3(manifest, { trackId: videoTrack.trackId, clip: { clipId: 'clip_other', assetId: 'asset_video_other', sourceStart: 0, sourceEnd: 1, timelineStart: 5 } }).manifest;
    saveManifestV3(workspace, manifest, { revision: false });

    // The base recording IS correctly boosted (fix applies where it should)...
    const fixedBaseRel = await extractClipAudio(workspace, 'clip_001', { overwrite: true, logJob: false });
    const fixedBaseRms = rmsDb(join(workspace, fixedBaseRel));
    expect(fixedBaseRms - averagedRms).toBeGreaterThan(4);

    // ...but the unrelated asset stays plain-averaged — no pan applied out of scope.
    const otherRel = await extractClipAudio(workspace, 'clip_other', { overwrite: true, logJob: false });
    const otherRms = rmsDb(join(workspace, otherRel));
    expect(Math.abs(otherRms - averagedRms)).toBeLessThan(1);
  }, 60_000);
});

describe('extractFullBandReference cache observes audioChannelFix state', () => {
  let dir: string;
  let workspace: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'etv-chanfix-ref-'));
    workspace = join(dir, 'ws');
    await createWorkspace({ workspacePath: workspace, projectId: 'chanfix-ref', title: 'Channel fix reference cache test' });
    await importSource(workspace, makeOneSidedVideo(dir));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('re-extracts (not reuses) the reference when a fix is applied after the first extraction, then caches while unchanged', async () => {
    // Baseline: no fix → -ac 1 averages the silent channel in.
    const rel = await extractFullBandReference(workspace, 'clip_001');
    const refPath = join(workspace, rel);
    const averagedRms = rmsDb(refPath);
    const averagedMtime = statSync(refPath).mtimeMs;

    await new Promise((r) => setTimeout(r, 10));
    const outcome = applyChannelFix(workspace);
    expect(outcome.action).toBe('applied');
    if (outcome.action === 'applied') expect(outcome.fix.sourceChannel).toBe('left');

    // No overwrite requested: the stale mtime-vs-source check alone would wrongly reuse the cache.
    await extractFullBandReference(workspace, 'clip_001');
    const fixedRms = rmsDb(refPath);
    const fixedMtime = statSync(refPath).mtimeMs;
    expect(fixedMtime).toBeGreaterThan(averagedMtime);
    // Averaging a dead channel costs 6.02 dB; allow encoder slack.
    expect(fixedRms - averagedRms).toBeGreaterThan(4);

    // Fix unchanged since the last extraction → cache reused (mtime stable).
    await new Promise((r) => setTimeout(r, 10));
    await extractFullBandReference(workspace, 'clip_001');
    expect(statSync(refPath).mtimeMs).toBe(fixedMtime);
  }, 60_000);
});
