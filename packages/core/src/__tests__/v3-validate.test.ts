import { describe, expect, it } from 'vitest';
import { getOperationKind, operationPrecedence, validateManifestV3Document, validateOperationOverlaps } from '../index';

const now = '2026-05-17T00:00:00.000Z';
const presets = { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: 'source', videoBitrate: 'source-or-auto', audioBitrate: '192k' } };

function op(id: string, type: 'cut' | 'mute' | 'voice_patch', start: number, end: number, extras = {}) {
  return { id, type, status: 'approved', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start, end }, proposedBy: 'agent', createdBy: 'user', createdAt: now, ...(type === 'voice_patch' ? { text: 'patched', assetId: 'asset_voice_001' } : {}), ...extras };
}

function manifest(operations: unknown[]) {
  return {
    manifestVersion: 3,
    projectId: 'v3-validate',
    createdAt: now,
    updatedAt: now,
    assets: [
      { assetId: 'asset_video_001', kind: 'video', path: 'assets/video/source.mp4', durationSec: 10, provenance: 'imported', video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000 } },
      { assetId: 'asset_voice_001', kind: 'audio', path: 'assets/voice/patch.wav', durationSec: 1, provenance: 'generated', audio: { sampleRate: 48000 } }
    ],
    tracks: [{ trackId: 'track_video_001', kind: 'video', name: 'Video 1', order: 0, clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 10, timelineStart: 0 }] }],
    operations,
    outputs: [{ outputId: 'output_full_001', kind: 'full', aspects: ['16:9'], status: 'manual' }],
    renderPresets: presets
  };
}

describe('v3 manifest validation', () => {
  it('carries forward structural validation', () => {
    const result = validateManifestV3Document(manifest([
      op('op_cut_0001', 'cut', 2, 3),
      op('op_cut_0001', 'cut', 3, 4, { target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'missing', start: 3, end: 4 } }),
      op('op_voice_patch_0001', 'voice_patch', 5, 6, { assetId: 'missing_asset' })
    ]));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('Operation id is duplicated');
    expect(result.errors.join('\n')).toContain('unknown clipId');
    expect(result.errors.join('\n')).toContain('asset does not exist');
  });

  it('rejects degenerate operation ranges through manifest schema parsing', () => {
    const result = validateManifestV3Document(manifest([op('op_cut_0001', 'cut', 2, 2)]));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('operation start must be < end');
  });

  it('allows different-precedence overlaps according to the registry order', () => {
    const result = validateManifestV3Document(manifest([
      op('op_cut_0001', 'cut', 1, 2),
      op('op_mute_0001', 'mute', 2, 5),
      op('op_voice_patch_0001', 'voice_patch', 3, 6)
    ]));
    expect(result.valid).toBe(true);
  });

  it('rejects same-precedence approved overlaps', () => {
    const result = validateManifestV3Document(manifest([op('op_mute_0001', 'mute', 1, 4), op('op_mute_0002', 'mute', 2, 5)]));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('same precedence');
  });

  it('sources precedence only from the registered operation kinds', () => {
    expect(operationPrecedence('cut')).toBe(getOperationKind('cut').precedence);
    expect(operationPrecedence('mute')).toBe(getOperationKind('mute').precedence);
    expect(operationPrecedence('voice_patch')).toBe(getOperationKind('voice_patch').precedence);
    expect(operationPrecedence('speed')).toBe(getOperationKind('speed').precedence);
  });

  it('keeps clip-span overlap behaviour and explicit conflicts', () => {
    expect(validateOperationOverlaps([
      { id: 'mute', type: 'mute', status: 'approved', target: { kind: 'clip-span', trackId: 't', clipId: 'c', start: 1, end: 3 } },
      { id: 'voice', type: 'voice_patch', status: 'approved', target: { kind: 'clip-span', trackId: 't', clipId: 'c', start: 2, end: 4 } }
    ])).toEqual([]);
    expect(validateOperationOverlaps([
      { id: 'speed', type: 'speed', status: 'approved', target: { kind: 'clip-span', trackId: 't', clipId: 'c', start: 1, end: 3 } },
      { id: 'voice', type: 'voice_patch', status: 'approved', target: { kind: 'clip-span', trackId: 't', clipId: 'c', start: 2, end: 4 } }
    ]).join('\n')).toContain('may not overlap');
  });

  it('rejects same-precedence clip-boundary and track target conflicts', () => {
    expect(validateOperationOverlaps([
      { id: 'transition_a', type: 'transition', status: 'approved', target: { kind: 'clip-boundary', trackId: 't', clipId: 'c' } },
      { id: 'transition_b', type: 'transition', status: 'approved', target: { kind: 'clip-boundary', trackId: 't', clipId: 'c' } }
    ]).join('\n')).toContain('same boundary');
    expect(validateOperationOverlaps([
      { id: 'caption_a', type: 'caption_style', status: 'approved', target: { kind: 'track', trackId: 'captions' } },
      { id: 'caption_b', type: 'caption_style', status: 'approved', target: { kind: 'track', trackId: 'captions' } }
    ]).join('\n')).toContain('same track');
  });

  it('does not warn about providerRequestId when no existence callback is supplied', () => {
    const result = validateManifestV3Document(manifest([
      op('op_voice_patch_0001', 'voice_patch', 1, 2, { providerRequestId: 'req_001' })
    ]));
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('warns about providerRequestId only when a supplied callback returns false', () => {
    const result = validateManifestV3Document(manifest([
      op('op_voice_patch_0001', 'voice_patch', 1, 2, { providerRequestId: 'req_001' })
    ]), { providerRequestExists: () => false });
    expect(result.valid).toBe(true);
    expect(result.warnings.join('\n')).toContain('provider request id not found');
  });
});
