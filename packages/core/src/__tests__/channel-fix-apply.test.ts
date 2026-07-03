import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyChannelFix, createWorkspace, importSource, loadManifestV3, saveManifestV3, type ChannelBalance } from '../index';

const now = '2026-07-03T00:00:00.000Z';
const presets = { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: '1920x1080', videoBitrate: '6000k', audioBitrate: '192k' } };

function manifestFixture() {
  return {
    manifestVersion: 3 as const,
    projectId: 'chanfix-apply-test',
    createdAt: now,
    updatedAt: now,
    assets: [{ assetId: 'asset_video_001', kind: 'video' as const, path: 'input/source.mp4', durationSec: 10, provenance: 'imported' as const, video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } }],
    tracks: [{ trackId: 'track_video_001', kind: 'video' as const, name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 10, timelineStart: 0 }] }],
    operations: [],
    outputs: [{ outputId: 'out_001', kind: 'full' as const, aspects: ['16:9' as const], status: 'manual' as const }],
    renderPresets: presets
  };
}

const oneSided: ChannelBalance = { channels: 2, leftRmsDb: -18, rightRmsDb: -92, recommendation: 'left' };
const balanced: ChannelBalance = { channels: 2, leftRmsDb: -18, rightRmsDb: -19, recommendation: null };
const mono: ChannelBalance = { channels: 1, leftRmsDb: null, rightRmsDb: null, recommendation: null };

describe('applyChannelFix', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'etv-chanfix-'));
    mkdirSync(join(workspace, 'input'), { recursive: true });
    writeFileSync(join(workspace, 'input/source.mp4'), 'stub'); // analyze is injected; content never read
    saveManifestV3(workspace, manifestFixture(), { revision: false });
  });
  afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

  it('auto mode applies a recommended fix and persists it', () => {
    const outcome = applyChannelFix(workspace, { analyze: () => oneSided });
    expect(outcome.action).toBe('applied');
    const manifest = loadManifestV3(workspace);
    expect(manifest.audioChannelFix?.status).toBe('approved');
    expect(manifest.audioChannelFix?.sourceChannel).toBe('left');
    expect(manifest.audioChannelFix?.detection).toEqual({ leftRmsDb: -18, rightRmsDb: -92, auto: true });
  });

  it('auto mode is a no-op on balanced stereo', () => {
    const outcome = applyChannelFix(workspace, { analyze: () => balanced });
    expect(outcome.action).toBe('none');
    expect(loadManifestV3(workspace).audioChannelFix).toBeUndefined();
  });

  it('auto mode never overwrites an existing fix, even a disabled one', () => {
    applyChannelFix(workspace, { analyze: () => oneSided });
    applyChannelFix(workspace, { disable: true });
    const outcome = applyChannelFix(workspace, { analyze: () => ({ ...oneSided, recommendation: 'right' as const }) });
    expect(outcome.action).toBe('unchanged');
    expect(loadManifestV3(workspace).audioChannelFix?.status).toBe('disabled');
    expect(loadManifestV3(workspace).audioChannelFix?.sourceChannel).toBe('left');
  });

  it('explicit channel overrides an existing fix with auto:false', () => {
    applyChannelFix(workspace, { analyze: () => oneSided });
    const outcome = applyChannelFix(workspace, { channel: 'right', analyze: () => balanced });
    expect(outcome.action).toBe('applied');
    const fix = loadManifestV3(workspace).audioChannelFix;
    expect(fix?.sourceChannel).toBe('right');
    expect(fix?.detection.auto).toBe(false);
  });

  it('explicit channel on a non-stereo source throws', () => {
    expect(() => applyChannelFix(workspace, { channel: 'left', analyze: () => mono })).toThrow(/stereo/i);
  });

  it('disable flips status and preserves the record; disable with no fix is unchanged', () => {
    expect(applyChannelFix(workspace, { disable: true }).action).toBe('unchanged');
    applyChannelFix(workspace, { analyze: () => oneSided });
    const outcome = applyChannelFix(workspace, { disable: true });
    expect(outcome.action).toBe('disabled');
    expect(loadManifestV3(workspace).audioChannelFix?.status).toBe('disabled');
  });

  it('disable refreshes appliedAt so downstream caches (reference-48k) can detect the change', () => {
    applyChannelFix(workspace, { analyze: () => oneSided });
    // Back-date appliedAt to simulate time passing since the original apply.
    const manifest = loadManifestV3(workspace);
    const staleAppliedAt = '2020-01-01T00:00:00.000Z';
    saveManifestV3(workspace, { ...manifest, audioChannelFix: { ...manifest.audioChannelFix!, appliedAt: staleAppliedAt } }, { revision: false });

    const outcome = applyChannelFix(workspace, { disable: true });
    expect(outcome.action).toBe('disabled');
    if (outcome.action === 'disabled') expect(outcome.fix.appliedAt).not.toBe(staleAppliedAt);
    expect(loadManifestV3(workspace).audioChannelFix?.appliedAt).not.toBe(staleAppliedAt);
  });

  it('throws when input/source.mp4 is missing and analysis is needed', () => {
    rmSync(join(workspace, 'input/source.mp4'));
    expect(() => applyChannelFix(workspace, { analyze: () => oneSided })).toThrow(/source\.mp4/);
  });

  it('rejects --channel combined with --disable (explicit channel always wins, never silently)', () => {
    expect(() => applyChannelFix(workspace, { channel: 'right', disable: true, analyze: () => oneSided })).toThrow(/mutually exclusive/i);
    // Rejected before any write: no fix was created.
    expect(loadManifestV3(workspace).audioChannelFix).toBeUndefined();
  });

  it('backfills the base asset audio.channels on explicit apply, so a stale/missing count does not later block the render guard', () => {
    // Fixture starts with channels: 2 already; simulate a legacy asset with missing metadata.
    const stripped = { ...manifestFixture(), assets: manifestFixture().assets.map((asset) => ({ ...asset, audio: { sampleRate: 48000 } })) };
    saveManifestV3(workspace, stripped, { revision: false });
    expect(loadManifestV3(workspace).assets[0]?.audio?.channels).toBeUndefined();

    applyChannelFix(workspace, { channel: 'left', analyze: () => oneSided });
    expect(loadManifestV3(workspace).assets[0]?.audio?.channels).toBe(2);
  });

  it('backfills the base asset audio.channels on auto apply too', () => {
    const stripped = { ...manifestFixture(), assets: manifestFixture().assets.map((asset) => ({ ...asset, audio: { sampleRate: 48000 } })) };
    saveManifestV3(workspace, stripped, { revision: false });

    applyChannelFix(workspace, { analyze: () => oneSided });
    expect(loadManifestV3(workspace).assets[0]?.audio?.channels).toBe(2);
  });

  // Issue #9: a same-value re-apply/re-disable must be a TRUE no-op — no appliedAt bump —
  // otherwise a value-fingerprinted downstream cache (studioCleanup) would flip to "stale"
  // for a cleanup that is actually still correct, purely from timestamp churn.
  it('re-applying the SAME explicit channel with unchanged metadata is a true no-op: no appliedAt bump', () => {
    const first = applyChannelFix(workspace, { channel: 'left', analyze: () => oneSided });
    expect(first.action).toBe('applied');
    const appliedAtBefore = loadManifestV3(workspace).audioChannelFix!.appliedAt;

    const second = applyChannelFix(workspace, { channel: 'left', analyze: () => oneSided });
    expect(second.action).toBe('unchanged');
    expect(loadManifestV3(workspace).audioChannelFix?.appliedAt).toBe(appliedAtBefore);
  });

  it('re-applying the same channel STILL writes when base asset metadata needs backfilling (legacy record, not a true no-op)', () => {
    applyChannelFix(workspace, { channel: 'left', analyze: () => oneSided });
    // Simulate metadata loss on the base asset without touching the fix record.
    const manifest = loadManifestV3(workspace);
    saveManifestV3(workspace, { ...manifest, assets: manifest.assets.map((asset) => ({ ...asset, audio: { sampleRate: 48000 } })) }, { revision: false });
    expect(loadManifestV3(workspace).assets[0]?.audio?.channels).toBeUndefined();

    const outcome = applyChannelFix(workspace, { channel: 'left', analyze: () => oneSided });
    expect(outcome.action).toBe('applied'); // a real write happened (backfill), not suppressed
    expect(loadManifestV3(workspace).assets[0]?.audio?.channels).toBe(2);
  });

  it('re-disabling an already-disabled fix is a true no-op: no appliedAt bump', () => {
    applyChannelFix(workspace, { analyze: () => oneSided });
    const first = applyChannelFix(workspace, { disable: true });
    expect(first.action).toBe('disabled');
    const appliedAtBefore = loadManifestV3(workspace).audioChannelFix!.appliedAt;

    const second = applyChannelFix(workspace, { disable: true });
    expect(second.action).toBe('unchanged');
    expect(loadManifestV3(workspace).audioChannelFix?.appliedAt).toBe(appliedAtBefore);
  });
});

// One-sided test video: 320x240 testsrc video + 440 Hz sine on the LEFT channel only.
// (Duplicated from channel-fix-extract.test.ts's fixture — this describe block needs
// REAL playable media because issue #7's backfill path probes the file directly with
// probeRecordingMedia, unmocked by the `analyze` injection used everywhere else above.)
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

describe('applyChannelFix backfills legacy channel metadata on the auto-mode early-return (issue #7)', () => {
  let dir: string;
  let workspace: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'etv-chanfix-backfill-'));
    workspace = join(dir, 'ws');
    await createWorkspace({ workspacePath: workspace, projectId: 'chanfix-backfill', title: 'legacy backfill test' });
    await importSource(workspace, makeOneSidedVideo(dir));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('backfills assets[].audio.channels when an approved fix already exists but its metadata was lost (e.g. a partial update_asset patch)', async () => {
    const first = applyChannelFix(workspace);
    expect(first.action).toBe('applied');
    expect(loadManifestV3(workspace).assets.find((a) => a.path === 'input/source.mp4')?.audio?.channels).toBe(2);

    // Simulate metadata loss on the base asset WITHOUT touching the fix record itself.
    const manifest = loadManifestV3(workspace);
    const stripped = { ...manifest, assets: manifest.assets.map((asset) => asset.path === 'input/source.mp4' ? { ...asset, audio: { sampleRate: asset.audio?.sampleRate } } : asset) };
    saveManifestV3(workspace, stripped, { revision: false });
    expect(loadManifestV3(workspace).assets.find((a) => a.path === 'input/source.mp4')?.audio?.channels).toBeUndefined();
    const appliedAtBefore = loadManifestV3(workspace).audioChannelFix!.appliedAt;

    // Auto mode with an existing approved fix hits the early-return path — but it must
    // self-heal the base asset's channel metadata so buildRenderPlan's exact channels===2
    // guard doesn't permanently reject an otherwise-valid, approved fix.
    const outcome = applyChannelFix(workspace);
    expect(outcome.action).toBe('unchanged');
    expect(loadManifestV3(workspace).assets.find((a) => a.path === 'input/source.mp4')?.audio?.channels).toBe(2);
    // The fix record itself is untouched — auto mode never overwrites a decision.
    expect(loadManifestV3(workspace).audioChannelFix?.appliedAt).toBe(appliedAtBefore);
  }, 60_000);
});
