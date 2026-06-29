import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addAssetV3,
  addClipV3,
  addTrackV3,
  detachAudioInWorkspaceV3,
  detachAudioV3,
  loadManifestV3,
  moveClipV3,
  proposeOutputsV3,
  removeAssetV3,
  removeClipV3,
  removeTrackV3,
  renameTrackV3,
  reorderTracksV3,
  runAgentToolV3,
  saveManifestV3,
  setTrackFlagsV3,
  trimClipV3,
  updateAssetV3,
  type ManifestV3
} from '../index';
import type { TranscriptWords } from '../schemas';

const now = '2026-05-17T00:00:00.000Z';
const presets = { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: 'source', videoBitrate: 'source-or-auto', audioBitrate: '192k' } };

function manifest(): ManifestV3 {
  return {
    manifestVersion: 3,
    projectId: 'v3-ops',
    createdAt: now,
    updatedAt: now,
    assets: [
      { assetId: 'asset_video', kind: 'video', path: 'input/source.mp4', durationSec: 20, provenance: 'imported', video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000 } },
      { assetId: 'asset_audio', kind: 'audio', path: 'assets/audio/source.wav', durationSec: 20, provenance: 'imported', audio: { sampleRate: 48000 } }
    ],
    tracks: [{ trackId: 'track_video', kind: 'video', name: 'Video', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [{ clipId: 'clip_1', assetId: 'asset_video', sourceStart: 0, sourceEnd: 10, timelineStart: 0 }] }],
    operations: [],
    outputs: [{ outputId: 'output_full', kind: 'full', aspects: ['16:9'], status: 'manual' }],
    renderPresets: presets
  };
}

const transcript: TranscriptWords = {
  schemaVersion: 1,
  source: 'source.mp4',
  provider: { name: 'mock', model: 'mock', requestId: null, timing: 'mock' },
  language: 'en',
  durationSec: 20,
  words: [{ id: 'w1', text: 'hello', normalized: 'hello', start: 0, end: 1, speaker: 's', confidence: 1, segmentId: 's1', clipId: 'clip_1' }],
  segments: [
    { id: 's1', speaker: 's', start: 0, end: 12, text: 'how to make a deterministic clip proposal' },
    { id: 's2', speaker: 's', start: 12, end: 18, text: 'closing thought' }
  ]
};

describe('v3 manifest io', () => {
  it('round-trips with revision snapshots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'etvs-v3-io-'));
    mkdirSync(join(dir, 'edits/revisions'), { recursive: true });
    saveManifestV3(dir, manifest(), { revision: false });
    const m = loadManifestV3(dir);
    expect(m.manifestVersion).toBe(3);
    saveManifestV3(dir, { ...m, outputs: [...m.outputs, { outputId: 'output_clip', kind: 'clip', rangeSec: { start: 0, end: 1 }, aspects: ['9:16'], status: 'proposed' }] }, { revision: true });
    expect(existsSync(join(dir, 'edits/revisions/manifest-0001.json'))).toBe(true);
  });
});

describe('v3 structural and asset operations', () => {
  it('edits tracks and clips directly with validation', () => {
    let m = manifest();
    m = addTrackV3(m, { trackId: 'track_music', kind: 'audio', subtype: 'music', name: 'Music', order: 1, locked: false, muted: false, solo: false, hidden: false }).manifest;
    m = renameTrackV3(m, { trackId: 'track_music', name: 'Bed' }).manifest;
    m = setTrackFlagsV3(m, { trackId: 'track_music', muted: true }).manifest;
    m = reorderTracksV3(m, { order: [{ trackId: 'track_music', order: 10 }] }).manifest;
    m = addClipV3(m, { trackId: 'track_music', clip: { clipId: 'clip_music', assetId: 'asset_audio', sourceStart: 0, sourceEnd: 5, timelineStart: 1 } }).manifest;
    m = moveClipV3(m, { clipId: 'clip_music', timelineStart: 2 }).manifest;
    m = trimClipV3(m, { clipId: 'clip_music', sourceStart: 1, sourceEnd: 4 }).manifest;
    expect(m.tracks.find((track) => track.trackId === 'track_music')?.clips[0]).toMatchObject({ timelineStart: 2, sourceStart: 1, sourceEnd: 4 });
    m = removeClipV3(m, { clipId: 'clip_music' }).manifest;
    m = removeTrackV3(m, { trackId: 'track_music' }).manifest;
    expect(m.tracks.map((track) => track.trackId)).toEqual(['track_video']);
  });

  it('guards media-bin removal and updates assets', () => {
    let m = manifest();
    m = addAssetV3(m, { assetId: 'asset_unused', kind: 'image', path: 'assets/broll/card.png', durationSec: 0, provenance: 'generated' }).manifest;
    m = updateAssetV3(m, { assetId: 'asset_unused', patch: { path: 'assets/broll/card-v2.png' } }).manifest;
    expect(m.assets.find((asset) => asset.assetId === 'asset_unused')?.path).toBe('assets/broll/card-v2.png');
    expect(() => removeAssetV3(m, { assetId: 'asset_video' })).toThrow('referenced by clip');
    m = removeAssetV3(m, { assetId: 'asset_unused' }).manifest;
    expect(m.assets.some((asset) => asset.assetId === 'asset_unused')).toBe(false);
  });

  it('rejects duplicate and missing ids on structural ops', () => {
    const m = manifest();
    expect(() => addTrackV3(m, { trackId: 'track_video', kind: 'video', name: 'Duplicate', order: 1, locked: false, muted: false, solo: false, hidden: false })).toThrow('Track already exists');
    expect(() => renameTrackV3(m, { trackId: 'track_missing', name: 'Missing' })).toThrow('Track not found');
    expect(() => addClipV3(m, { trackId: 'track_video', clip: { clipId: 'clip_1', assetId: 'asset_video', sourceStart: 0, sourceEnd: 1, timelineStart: 0 } })).toThrow('Clip already exists');
    expect(() => moveClipV3(m, { clipId: 'clip_missing', timelineStart: 1 })).toThrow('Clip not found');
    expect(() => addAssetV3(m, { assetId: 'asset_video', kind: 'video', path: 'input/other.mp4', durationSec: 1, provenance: 'imported', video: { width: 1, height: 1, fps: 30 } })).toThrow('Asset already exists');
    expect(() => removeAssetV3(m, { assetId: 'asset_missing' })).toThrow('Asset not found');
  });

  it('rejects removing a non-empty track', () => {
    expect(() => removeTrackV3(manifest(), { trackId: 'track_video' })).toThrow('Cannot remove non-empty track');
  });

  it('detaches audio as a pure mutation', () => {
    const next = detachAudioV3(manifest(), { clipId: 'clip_1', assetId: 'asset_audio', detachedClipId: 'clip_audio' });
    expect(next.videoClip.audioDetached).toBe(true);
    expect(next.audioClip).toMatchObject({ clipId: 'clip_audio', assetId: 'asset_audio', detachedFrom: 'clip_1', sourceStart: 0, sourceEnd: 10, timelineStart: 0 });
    expect(next.audioTrack.kind).toBe('audio');
  });

  it('rejects detachAudio for non-video source clips', () => {
    let m = addTrackV3(manifest(), { trackId: 'track_dialog', kind: 'audio', subtype: 'dialog', name: 'Dialog', order: 1, locked: false, muted: false, solo: false, hidden: false }).manifest;
    m = addClipV3(m, { trackId: 'track_dialog', clip: { clipId: 'clip_dialog', assetId: 'asset_audio', sourceStart: 0, sourceEnd: 1, timelineStart: 0 } }).manifest;
    expect(() => detachAudioV3(m, { clipId: 'clip_dialog', assetId: 'asset_audio', detachedClipId: 'clip_detached' })).toThrow('Cannot detach audio: source clip clip_dialog is not on a video track');
  });

  it('rejects detachAudio for video assets placed on audio tracks', () => {
    let m = addTrackV3(manifest(), { trackId: 'track_dialog', kind: 'audio', subtype: 'dialog', name: 'Dialog', order: 1, locked: false, muted: false, solo: false, hidden: false }).manifest;
    m = addClipV3(m, { trackId: 'track_dialog', clip: { clipId: 'clip_video_on_audio', assetId: 'asset_video', sourceStart: 0, sourceEnd: 1, timelineStart: 0 } }).manifest;
    expect(() => detachAudioV3(m, { clipId: 'clip_video_on_audio', assetId: 'asset_audio', detachedClipId: 'clip_detached' })).toThrow('Cannot detach audio: source clip clip_video_on_audio is not on a video track');
  });

  it('creates deterministic extracted audio once and reuses it for later detaches from the same source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'etvs-v3-detach-'));
    mkdirSync(join(dir, 'edits'), { recursive: true });
    mkdirSync(join(dir, 'input'), { recursive: true });
    writeFileSync(join(dir, 'input/source.mp4'), 'fake');
    const base = manifest();
    saveManifestV3(dir, {
      ...base,
      assets: base.assets.filter((asset) => asset.assetId !== 'asset_audio'),
      tracks: [{ ...base.tracks[0], clips: [...base.tracks[0].clips, { clipId: 'clip_2', assetId: 'asset_video', sourceStart: 10, sourceEnd: 20, timelineStart: 10 }] }]
    }, { revision: false });
    const fakeFfmpeg = join(dir, 'ffmpeg');
    const countFile = join(dir, 'ffmpeg-count.txt');
    writeFileSync(fakeFfmpeg, '#!/bin/sh\nfor last do :; done\nprintf x >> "$FFMPEG_COUNT_FILE"\nprintf audio > "$last"\n');
    chmodSync(fakeFfmpeg, 0o755);
    const old = process.env.FFMPEG_PATH;
    const oldCount = process.env.FFMPEG_COUNT_FILE;
    process.env.FFMPEG_PATH = fakeFfmpeg;
    process.env.FFMPEG_COUNT_FILE = countFile;
    try {
      const first = detachAudioInWorkspaceV3(dir, { clipId: 'clip_1', detachedClipId: 'clip_detached_1' });
      expect(first.asset).toMatchObject({ assetId: 'asset_audio_asset_video', path: 'assets/audio/asset_video.wav' });
      expect(readFileSync(countFile, 'utf8')).toBe('x');
      expect(() => detachAudioInWorkspaceV3(dir, { clipId: 'clip_1', detachedClipId: 'clip_detached_repeat' })).toThrow('Clip audio already detached');
      expect(readFileSync(countFile, 'utf8')).toBe('x');
      const second = detachAudioInWorkspaceV3(dir, { clipId: 'clip_2', detachedClipId: 'clip_detached_2' });
      expect(second.asset.assetId).toBe('asset_audio_asset_video');
      expect(readFileSync(countFile, 'utf8')).toBe('x');
      const saved = loadManifestV3(dir);
      expect(saved.assets.filter((asset) => asset.kind === 'audio' && asset.assetId === 'asset_audio_asset_video')).toHaveLength(1);
      expect(saved.tracks.flatMap((track) => track.clips).filter((clip) => clip.assetId === 'asset_audio_asset_video')).toHaveLength(2);
    } finally {
      if (old === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = old;
      if (oldCount === undefined) delete process.env.FFMPEG_COUNT_FILE;
      else process.env.FFMPEG_COUNT_FILE = oldCount;
    }
  });
});

describe('v3 output proposals and agent tools', () => {
  it('proposes deterministic clip outputs from transcript segments', () => {
    const outputs = proposeOutputsV3(manifest(), transcript);
    expect(outputs[0]).toMatchObject({ kind: 'clip', status: 'proposed', rangeSec: { start: 0, end: 10 }, aspects: ['9:16', '1:1', '16:9'] });
  });

  it('dispatches generic operations through the registry and wraps read tools', () => {
    const dir = mkdtempSync(join(tmpdir(), 'etvs-v3-tools-'));
    mkdirSync(join(dir, 'edits'), { recursive: true });
    mkdirSync(join(dir, 'transcript'), { recursive: true });
    saveManifestV3(dir, manifest(), { revision: false });
    writeFileSync(join(dir, 'transcript/words.json'), JSON.stringify(transcript));
    const ctx = { workspacePath: dir };
    for (const [type, extra] of [
      ['cut', {}],
      ['mute', {}],
      ['voice_patch', { text: 'patched', status: 'awaiting_approval' }]
    ] as const) {
      const response = runAgentToolV3(ctx, 'propose_operation', { requestId: `req_${type}_001`, id: `op_${type}`, type, target: { kind: 'clip-span', trackId: 'track_video', clipId: 'clip_1', start: 1, end: 2 }, ...extra });
      expect(response.changedOperationIds).toEqual([`op_${type}`]);
    }
    expect(runAgentToolV3(ctx, 'list_operations', { type: ['voice_patch'] }).result).toMatchObject({ operations: [{ id: 'op_voice_patch', status: 'awaiting_approval' }] });
    expect(() => runAgentToolV3(ctx, 'list_operations', { type: ['bogus'] })).toThrow('Unknown operation type');
    expect(() => runAgentToolV3(ctx, 'list_operations', { status: ['bogus'] })).toThrow();
    const approved = runAgentToolV3(ctx, 'approve_operation', { requestId: 'req_approve_001', operationId: 'op_cut' }).result;
    expect(approved).toMatchObject({ operation: { id: 'op_cut', status: 'approved' } });
    const rejected = runAgentToolV3(ctx, 'reject_operation', { requestId: 'req_reject_001', operationId: 'op_mute', reason: 'skip' }).result;
    expect(rejected).toMatchObject({ operation: { id: 'op_mute', status: 'rejected', reason: 'skip' } });
    expect(() => runAgentToolV3(ctx, 'propose_operation', { requestId: 'req_bad_001', type: 'cut', target: { kind: 'clip-span', trackId: 'track_video', clipId: 'clip_1', start: 2, end: 1 } })).toThrow();
    expect(runAgentToolV3(ctx, 'get_transcript', { rangeSec: { start: 0, end: 2 } }).result).toMatchObject({ words: [{ id: 'w1' }] });
    expect(runAgentToolV3(ctx, 'get_render_state', {}).result).toMatchObject({ manifestValid: true, manifestErrors: [] });
  });

  it('dispatches structural handlers through runAgentTool', () => {
    const dir = mkdtempSync(join(tmpdir(), 'etvs-v3-struct-tools-'));
    mkdirSync(join(dir, 'edits'), { recursive: true });
    mkdirSync(join(dir, 'input'), { recursive: true });
    writeFileSync(join(dir, 'input/source.mp4'), 'fake');
    saveManifestV3(dir, manifest(), { revision: false });
    const ctx = { workspacePath: dir };

    expect(runAgentToolV3(ctx, 'add_track', { trackId: 'track_music', kind: 'audio', subtype: 'music', name: 'Music', order: 1 }).result).toMatchObject({ track: { trackId: 'track_music' } });
    expect(runAgentToolV3(ctx, 'add_clip', { trackId: 'track_music', clip: { clipId: 'clip_music', assetId: 'asset_audio', sourceStart: 0, sourceEnd: 2, timelineStart: 1 } }).result).toMatchObject({ clip: { clipId: 'clip_music' } });
    expect(runAgentToolV3(ctx, 'move_clip', { clipId: 'clip_music', timelineStart: 2 }).result).toMatchObject({ clip: { timelineStart: 2 } });
    expect(runAgentToolV3(ctx, 'trim_clip', { clipId: 'clip_music', sourceStart: 0.5, sourceEnd: 1.5 }).result).toMatchObject({ clip: { sourceStart: 0.5, sourceEnd: 1.5 } });
    expect(runAgentToolV3(ctx, 'rename_track', { trackId: 'track_music', name: 'Bed' }).result).toMatchObject({ track: { name: 'Bed' } });
    expect(runAgentToolV3(ctx, 'set_track_flags', { trackId: 'track_music', muted: true }).result).toMatchObject({ track: { muted: true } });
    expect(runAgentToolV3(ctx, 'reorder_tracks', { order: [{ trackId: 'track_music', order: 5 }] }).result).toMatchObject({ tracks: expect.arrayContaining([expect.objectContaining({ trackId: 'track_music', order: 5 })]) });
    expect(runAgentToolV3(ctx, 'remove_clip', { clipId: 'clip_music' }).result).toMatchObject({ clip: { clipId: 'clip_music' } });
    expect(runAgentToolV3(ctx, 'remove_track', { trackId: 'track_music' }).result).toMatchObject({ track: { trackId: 'track_music' } });
    expect(runAgentToolV3(ctx, 'add_asset', { assetId: 'asset_unused', kind: 'image', path: 'assets/card.png', durationSec: 0, provenance: 'generated' }).result).toMatchObject({ asset: { assetId: 'asset_unused' } });
    expect(runAgentToolV3(ctx, 'update_asset', { assetId: 'asset_unused', patch: { path: 'assets/card-v2.png' } }).result).toMatchObject({ asset: { path: 'assets/card-v2.png' } });
    expect(runAgentToolV3(ctx, 'remove_asset', { assetId: 'asset_unused' }).result).toMatchObject({ asset: { assetId: 'asset_unused' } });

    const fakeFfmpeg = join(dir, 'ffmpeg');
    writeFileSync(fakeFfmpeg, '#!/bin/sh\nfor last do :; done\nprintf audio > "$last"\n');
    chmodSync(fakeFfmpeg, 0o755);
    const old = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = fakeFfmpeg;
    try {
      expect(runAgentToolV3(ctx, 'detach_audio', { clipId: 'clip_1', detachedClipId: 'clip_detached_tool' }).result).toMatchObject({ audioClip: { clipId: 'clip_detached_tool', assetId: 'asset_audio_asset_video' } });
    } finally {
      if (old === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = old;
    }
  });
});
