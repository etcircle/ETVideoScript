import { describe, expect, it } from 'vitest';
import type { ManifestV3 } from '@etvideoscript/core/browser';
import { CLIP_BOUNDARY_TOLERANCE_SEC, clipAtTime, clipBoundaryAtTime, clipSpanTargetForRange, clipSpanTargetsForRange, clipSpanTargetsForWords, videoClipAtTime, videoClipBoundaryAtTime } from './editTargets';

const manifest: ManifestV3 = {
  manifestVersion: 3,
  projectId: 'p',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  assets: [],
  tracks: [{ trackId: 'v1', kind: 'video', name: 'V1', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [
    { clipId: 'c1', assetId: 'a1', sourceStart: 10, sourceEnd: 20, timelineStart: 0 },
    { clipId: 'c2', assetId: 'a1', sourceStart: 0, sourceEnd: 8, timelineStart: 10 }
  ] }],
  operations: [],
  outputs: [],
  renderPresets: { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: 'source', videoBitrate: 'source-or-auto', audioBitrate: '192k' } }
};

describe('edit target helpers', () => {
  it('converts a single-clip timeline range to one clip-relative source span', () => {
    expect(clipSpanTargetsForRange(manifest, 2, 4)).toEqual([{ kind: 'clip-span', trackId: 'v1', clipId: 'c1', start: 2, end: 4 }]);
    expect(clipSpanTargetForRange(manifest, 2, 4)).toEqual({ kind: 'clip-span', trackId: 'v1', clipId: 'c1', start: 2, end: 4 });
  });

  it('splits a cross-clip timeline range into one target per overlapped clip', () => {
    expect(clipSpanTargetsForRange(manifest, 8, 12)).toEqual([
      { kind: 'clip-span', trackId: 'v1', clipId: 'c1', start: 8, end: 10 },
      { kind: 'clip-span', trackId: 'v1', clipId: 'c2', start: 0, end: 2 }
    ]);
  });

  it('resolves only seam boundary targets near the playhead', () => {
    expect(clipBoundaryAtTime(manifest, 10 + CLIP_BOUNDARY_TOLERANCE_SEC)).toEqual({ kind: 'clip-boundary', trackId: 'v1', clipId: 'c1' });
    expect(clipBoundaryAtTime(manifest, 10 + CLIP_BOUNDARY_TOLERANCE_SEC + 0.01)).toBeNull();
    expect(clipBoundaryAtTime(manifest, 11)).toBeNull();
  });

  it('filters playhead clips and timeline-range targets to video tracks when requested', () => {
    const multiTrack: ManifestV3 = {
      ...manifest,
      tracks: [
        { trackId: 'a1', kind: 'audio', name: 'A1', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [{ clipId: 'a-clip', assetId: 'a1', sourceStart: 0, sourceEnd: 10, timelineStart: 0 }] },
        manifest.tracks[0]!
      ]
    };
    expect(clipAtTime(multiTrack, 2)?.clip.clipId).toBe('a-clip');
    expect(videoClipAtTime(multiTrack, 2)?.clip.clipId).toBe('c1');
    expect(clipSpanTargetForRange(multiTrack, 2, 4, 'video')).toEqual({ kind: 'clip-span', trackId: 'v1', clipId: 'c1', start: 2, end: 4 });
  });

  it('filters boundary targets to video seams for visual transitions', () => {
    const multiTrack: ManifestV3 = {
      ...manifest,
      tracks: [
        { trackId: 'a1', kind: 'audio', name: 'A1', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [
          { clipId: 'a1c1', assetId: 'a1', sourceStart: 0, sourceEnd: 10, timelineStart: 0 },
          { clipId: 'a1c2', assetId: 'a1', sourceStart: 0, sourceEnd: 5, timelineStart: 10 }
        ] },
        manifest.tracks[0]!
      ]
    };
    expect(clipBoundaryAtTime(multiTrack, 10)).toEqual({ kind: 'clip-boundary', trackId: 'a1', clipId: 'a1c1' });
    expect(videoClipBoundaryAtTime(multiTrack, 10)).toEqual({ kind: 'clip-boundary', trackId: 'v1', clipId: 'c1' });
  });

  it('builds transcript selection targets from the selected words own clips only', () => {
    const multiTrack: ManifestV3 = {
      ...manifest,
      tracks: [
        manifest.tracks[0]!,
        { trackId: 'a1', kind: 'audio', name: 'A1', order: 1, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [{ clipId: 'a-clip', assetId: 'a1', sourceStart: 0, sourceEnd: 18, timelineStart: 0 }] },
        { trackId: 'cap1', kind: 'caption', name: 'Captions', order: 2, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [{ clipId: 'cap-clip', assetId: 'a1', sourceStart: 0, sourceEnd: 18, timelineStart: 0 }] }
      ]
    };
    expect(clipSpanTargetsForWords(multiTrack, [
      { clipId: 'c1', start: 1, end: 2 },
      { clipId: 'c1', start: 2.5, end: 4 },
      { clipId: 'c2', start: 0.5, end: 1.5 }
    ])).toEqual([
      { kind: 'clip-span', trackId: 'v1', clipId: 'c1', start: 1, end: 4 },
      { kind: 'clip-span', trackId: 'v1', clipId: 'c2', start: 0.5, end: 1.5 }
    ]);
  });

  it('falls back to timeline-range target resolution for untagged transcript words', () => {
    expect(clipSpanTargetsForWords(manifest, [{ start: 8, end: 9 }, { start: 10.5, end: 12 }])).toEqual([
      { kind: 'clip-span', trackId: 'v1', clipId: 'c1', start: 8, end: 10 },
      { kind: 'clip-span', trackId: 'v1', clipId: 'c2', start: 0, end: 2 }
    ]);
  });

  it('ignores clip trailing edges when the next clip is separated by a gap or overlap', () => {
    const withGap: ManifestV3 = {
      ...manifest,
      tracks: [{ ...manifest.tracks[0]!, clips: [manifest.tracks[0]!.clips[0]!, { ...manifest.tracks[0]!.clips[1]!, timelineStart: 12 }] }]
    };
    const withOverlap: ManifestV3 = {
      ...manifest,
      tracks: [{ ...manifest.tracks[0]!, clips: [manifest.tracks[0]!.clips[0]!, { ...manifest.tracks[0]!.clips[1]!, timelineStart: 9 }] }]
    };
    expect(clipBoundaryAtTime(withGap, 10)).toBeNull();
    expect(clipBoundaryAtTime(withOverlap, 10)).toBeNull();
  });
});
