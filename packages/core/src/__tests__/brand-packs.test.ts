import { describe, expect, it } from 'vitest';
import { BRAND_PACKS, BrandPackSchema, getBrandPack, isKnownBrandPackId, ManifestV3Schema, setBrandPackId, type ManifestV3 } from '../index';

const now = '2026-05-17T00:00:00.000Z';
const presets = { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: 'source', videoBitrate: 'source-or-auto', audioBitrate: '192k' } };

function manifestV3(overrides: Partial<ManifestV3> = {}): ManifestV3 {
  return {
    manifestVersion: 3,
    projectId: 'brand-packs',
    createdAt: now,
    updatedAt: now,
    assets: [{ assetId: 'asset_video_001', kind: 'video', path: 'assets/video/source.mp4', durationSec: 10, provenance: 'imported', video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000 } }],
    tracks: [{ trackId: 'track_video_001', kind: 'video', name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 10, timelineStart: 0 }] }],
    operations: [],
    outputs: [{ outputId: 'output_full_001', kind: 'full', aspects: ['16:9'], status: 'manual' }],
    renderPresets: presets,
    ...overrides
  };
}

describe('brand packs', () => {
  it('ships a valid four-pack catalog with unique ids', () => {
    expect(BRAND_PACKS).toHaveLength(4);
    expect(new Set(BRAND_PACKS.map((pack) => pack.id)).size).toBe(BRAND_PACKS.length);
    for (const pack of BRAND_PACKS) expect(BrandPackSchema.parse(pack)).toEqual(pack);
  });

  it('looks up brand packs by id', () => {
    expect(getBrandPack('etcircle')?.id).toBe('etcircle');
    expect(getBrandPack('nope')).toBeUndefined();
  });

  it('checks known brand-pack ids', () => {
    expect(isKnownBrandPackId('shorts')).toBe(true);
    expect(isKnownBrandPackId('bogus')).toBe(false);
  });

  it('sets brandPackId and validates the manifest', () => {
    const result = setBrandPackId(manifestV3(), 'shorts');
    expect(result.manifest.brandPackId).toBe('shorts');
    expect(result.manifest.updatedAt).not.toBe(now);
    expect(ManifestV3Schema.parse(result.manifest)).toEqual(result.manifest);
  });

  it('clears brandPackId by omitting the key and validates the manifest', () => {
    const result = setBrandPackId(manifestV3({ brandPackId: 'shorts' }), null);
    expect('brandPackId' in result.manifest).toBe(false);
    expect(ManifestV3Schema.parse(result.manifest)).toEqual(result.manifest);
  });

  it('rejects unknown brand packs', () => {
    expect(() => setBrandPackId(manifestV3(), 'bogus')).toThrow(/Unknown brand pack: bogus/);
  });
});
