import { describe, expect, it } from 'vitest';
import { ManifestV3Schema, OperationSchemaV3, OperationTargetSchemaV3, TrackSchemaV3, AssetSchemaV3, OutputSchemaV3 } from '../index';

const now = '2026-05-17T00:00:00.000Z';
const presets = { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: 'source', videoBitrate: 'source-or-auto', audioBitrate: '192k' } };
const clipSpanTarget = { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 1, end: 2 };

function manifestV3(overrides = {}) {
  return {
    manifestVersion: 3,
    projectId: 'v3-schema',
    createdAt: now,
    updatedAt: now,
    assets: [{ assetId: 'asset_video_001', kind: 'video', path: 'assets/video/source.mp4', durationSec: 10, provenance: 'imported', video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000 } }],
    tracks: [{ trackId: 'track_video_001', kind: 'video', name: 'Video 1', order: 0, clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 10, timelineStart: 0 }] }],
    operations: [{ id: 'op_cut_0001', type: 'cut', status: 'approved', target: clipSpanTarget, proposedBy: 'agent', createdBy: 'user', createdAt: now }],
    outputs: [{ outputId: 'output_full_001', kind: 'full', aspects: ['16:9'], status: 'manual' }],
    renderPresets: presets,
    ...overrides
  };
}

describe('v3 schemas', () => {
  it('parses the frozen v3 manifest shape', () => {
    const parsed = ManifestV3Schema.parse(manifestV3());
    expect(parsed.manifestVersion).toBe(3);
    expect(parsed.tracks[0]!.clips[0]!.timelineStart).toBe(0);
    expect(parsed.operations[0]!.target).toMatchObject({ kind: 'clip-span', clipId: 'clip_001' });
  });

  it('parses every operation target variant and rejects a bad kind', () => {
    expect(OperationTargetSchemaV3.parse(clipSpanTarget).kind).toBe('clip-span');
    expect(OperationTargetSchemaV3.parse({ kind: 'clip-boundary', trackId: 'track_video_001', clipId: 'clip_001' }).kind).toBe('clip-boundary');
    expect(OperationTargetSchemaV3.parse({ kind: 'track', trackId: 'track_caption_001' }).kind).toBe('track');
    expect(OperationTargetSchemaV3.safeParse({ kind: 'clip', trackId: 'track_video_001', clipId: 'clip_001' }).success).toBe(false);
  });

  it('rejects invalid structural leaves', () => {
    expect(TrackSchemaV3.safeParse({ trackId: 't', kind: 'audio', name: 'Audio', order: 0, clips: [] }).success).toBe(true);
    expect(TrackSchemaV3.safeParse({ trackId: 't', kind: 'caption', subtype: 'dialog', name: 'Caption', order: 0, clips: [] }).success).toBe(false);
    expect(AssetSchemaV3.safeParse({ assetId: 'a', kind: 'video', path: '', durationSec: 1, provenance: 'imported' }).success).toBe(false);
    expect(OutputSchemaV3.safeParse({ outputId: 'o', kind: 'clip', aspects: ['16:9'], status: 'manual' }).success).toBe(false);
  });

  it('rejects genuinely unregistered operations through the registry-built union', () => {
    expect(OperationSchemaV3.safeParse({ id: 'op_reframe_0001', type: 'reframe', status: 'approved', target: clipSpanTarget, proposedBy: 'agent', createdBy: 'user', createdAt: now }).success).toBe(false);
  });

  it('requires strict ISO datetimes for manifest and operations', () => {
    expect(ManifestV3Schema.safeParse(manifestV3({ createdAt: 'not-a-date' })).success).toBe(false);
    expect(OperationSchemaV3.safeParse({ id: 'op_cut_0001', type: 'cut', status: 'approved', target: clipSpanTarget, proposedBy: 'agent', createdBy: 'user', createdAt: 'not-a-date' }).success).toBe(false);
  });

  it('round-trips a clip-span operation', () => {
    const parsed = OperationSchemaV3.parse({ id: 'op_cut_0001', type: 'cut', status: 'approved', target: clipSpanTarget, proposedBy: 'agent', createdBy: 'user', createdAt: now });
    expect(parsed.target).toEqual(clipSpanTarget);
  });

  it('rejects degenerate clip-span operation ranges at operation-schema parse time', () => {
    const result = OperationSchemaV3.safeParse({ id: 'op_cut_0001', type: 'cut', status: 'approved', target: { ...clipSpanTarget, start: 2, end: 2 }, proposedBy: 'agent', createdBy: 'user', createdAt: now });
    expect(result.success).toBe(false);
  });

  it('keeps Output.status to the single-concept lifecycle enum', () => {
    expect(OutputSchemaV3.safeParse({ outputId: 'o', kind: 'full', aspects: ['16:9'], status: 'manual' }).success).toBe(true);
    expect(OutputSchemaV3.safeParse({ outputId: 'o', kind: 'full', aspects: ['16:9'], status: 'rendered' }).success).toBe(false);
    expect(OutputSchemaV3.safeParse({ outputId: 'o', kind: 'full', aspects: ['16:9'], status: 'failed' }).success).toBe(false);
  });

  it('accepts any positive W:H output aspect ratio format', () => {
    expect(OutputSchemaV3.safeParse({ outputId: 'o', kind: 'full', aspects: ['5:4'], status: 'manual' }).success).toBe(true);
    expect(OutputSchemaV3.safeParse({ outputId: 'o', kind: 'full', aspects: ['0:9'], status: 'manual' }).success).toBe(false);
    expect(OutputSchemaV3.safeParse({ outputId: 'o', kind: 'full', aspects: ['16x9'], status: 'manual' }).success).toBe(false);
  });

  it('allows unknown audio sampleRate to be omitted but rejects magic zero', () => {
    expect(AssetSchemaV3.safeParse({ assetId: 'a', kind: 'audio', path: 'assets/a.wav', durationSec: 1, provenance: 'generated', audio: {} }).success).toBe(true);
    expect(AssetSchemaV3.safeParse({ assetId: 'a', kind: 'audio', path: 'assets/a.wav', durationSec: 1, provenance: 'generated', audio: { sampleRate: 0 } }).success).toBe(false);
  });
});
