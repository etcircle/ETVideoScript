import { describe, expect, it } from 'vitest';
import type { ManifestV3 } from '@etvideoscript/core/browser';
import { WORD_LABEL_MIN_WIDTH_PX, buildWordLabelItems, buildWordLabelLayout, type WordLike } from './TimelineWordLabels';

function manifest(): ManifestV3 {
  return {
    schemaVersion: 3,
    projectId: 'p1',
    revision: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    assets: [],
    tracks: [
      { trackId: 'v1', kind: 'video', name: 'Video', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [
        { clipId: 'c1', assetId: 'a1', sourceStart: 0, sourceEnd: 10, timelineStart: 0, fx: {} }
      ] },
      { trackId: 'v2', kind: 'video', name: 'Other', order: 1, locked: false, muted: false, solo: false, hidden: false, clips: [
        { clipId: 'c2', assetId: 'a2', sourceStart: 0, sourceEnd: 5, timelineStart: 10, fx: {} }
      ] }
    ],
    operations: [],
    outputs: []
  } as unknown as ManifestV3;
}

function word(id: string, start: number, end: number, clipId = 'c1', text = id): WordLike {
  return { id, text, start, end, clipId };
}

describe('buildWordLabelItems', () => {
  const duration = 10;
  const pxWidth = 1000; // 100 px per second
  const baseInput = { manifest: manifest(), trackId: 'v1', duration, pxWidth, currentTime: 0 };

  it('returns empty when words/manifest/duration missing', () => {
    expect(buildWordLabelItems({ ...baseInput, words: null })).toEqual([]);
    expect(buildWordLabelItems({ ...baseInput, words: [], manifest: null })).toEqual([]);
    expect(buildWordLabelItems({ ...baseInput, words: [word('w', 0, 1)], duration: 0 })).toEqual([]);
    expect(buildWordLabelItems({ ...baseInput, words: [word('w', 0, 1)], pxWidth: 0 })).toEqual([]);
  });

  it('places words from the matching track and skips other-track words', () => {
    const words = [word('a', 0, 1, 'c1'), word('b', 0, 1, 'c2')];
    const items = buildWordLabelItems({ ...baseInput, words });
    expect(items.map((item) => item.id)).toEqual(['c1|a']);
  });

  it('drops words narrower than the minimum threshold', () => {
    // 0.2s wide at 100px/s = 20px → below 30px threshold
    const items = buildWordLabelItems({ ...baseInput, words: [word('w', 0, 0.2)] });
    expect(items).toEqual([]);
  });

  it('keeps words at or above the minimum threshold', () => {
    // 0.3s wide at 100px/s = 30px → at threshold
    const items = buildWordLabelItems({ ...baseInput, words: [word('w', 0, 0.3)] });
    expect(items).toHaveLength(1);
    expect(items[0].width).toBeCloseTo(WORD_LABEL_MIN_WIDTH_PX, 5);
  });

  it('marks the word the playhead is currently inside as current', () => {
    const items = buildWordLabelItems({
      ...baseInput,
      words: [word('a', 0, 0.5), word('b', 0.5, 1), word('c', 1, 1.5)],
      currentTime: 0.6
    });
    const byId = Object.fromEntries(items.map((item) => [item.id, item]));
    expect(byId['c1|a'].current).toBe(false);
    expect(byId['c1|b'].current).toBe(true);
    expect(byId['c1|c'].current).toBe(false);
  });

  it('positions words in timeline coordinates accounting for clip timelineStart offset', () => {
    // word at source 0.5–1.0 on clip c1 (timelineStart=0) → timeline 0.5–1.0 → left 50px, width 50px
    const items = buildWordLabelItems({ ...baseInput, words: [word('w', 0.5, 1.0)] });
    expect(items[0].left).toBeCloseTo(50, 5);
    expect(items[0].width).toBeCloseTo(50, 5);
    expect(items[0].start).toBeCloseTo(0.5, 5);
  });

  it('resolves empty-string clipId to the project default clip (legacy single-clip transcripts)', () => {
    // First clip in manifest is c1 on v1 → default. Word with clipId '' should
    // render on v1 only, not on v2.
    const w: WordLike = { id: 'w', text: 'hi', start: 0, end: 0.5, clipId: '' };
    expect(buildWordLabelItems({ ...baseInput, words: [w] })).toHaveLength(1);
    expect(buildWordLabelItems({ ...baseInput, trackId: 'v2', words: [w] })).toEqual([]);
  });

  it('accepts words with no clipId field at all (defaults to first clip)', () => {
    const w: WordLike = { id: 'w', text: 'hi', start: 0, end: 0.5 };
    expect(buildWordLabelItems({ ...baseInput, words: [w] })).toHaveLength(1);
  });

  it('skips words whose clipId points to no clip in the manifest', () => {
    const items = buildWordLabelItems({ ...baseInput, words: [word('orphan', 0, 0.5, 'ghost')] });
    expect(items).toEqual([]);
  });

  it('exposes buildWordLabelLayout as a pure (currentTime-free) memoizable input', () => {
    const layout = buildWordLabelLayout({ ...baseInput, words: [word('a', 0, 0.5, 'c1')] });
    expect(layout).toHaveLength(1);
    expect(layout[0]).not.toHaveProperty('current');
    expect(layout[0]).toMatchObject({ id: 'c1|a', start: 0, end: 0.5 });
  });

  it('projects an empty-clipId word through the default clip timelineStart (not raw transcript origin)', () => {
    // Build a manifest where the default clip starts at timelineStart=4 (not 0).
    // A legacy empty-clipId word at source time 1.0–1.5 should appear at
    // timeline 5.0–5.5, not 1.0–1.5.
    const m = manifest();
    m.tracks[0].clips[0].timelineStart = 4;
    const layout = buildWordLabelLayout({
      manifest: m, trackId: 'v1', duration: 20, pxWidth: 2000,
      words: [{ id: 'w', text: 'hi', start: 1.0, end: 1.5, clipId: '' }]
    });
    expect(layout).toHaveLength(1);
    expect(layout[0].start).toBeCloseTo(5.0, 5);
    expect(layout[0].end).toBeCloseTo(5.5, 5);
  });

  it('produces distinct keys for words with the same id on different clips (merge collision case)', () => {
    // After mergeTranscripts, per-clip transcripts can share word.id strings.
    // The layout id must disambiguate by clip so React keys stay unique.
    const m = manifest();
    m.tracks[0].clips.push({ clipId: 'c1b', assetId: 'a1b', sourceStart: 0, sourceEnd: 10, timelineStart: 10, fx: {} } as never);
    const layout = buildWordLabelLayout({
      manifest: m, trackId: 'v1', duration: 20, pxWidth: 2000,
      words: [
        { id: 'w000001', text: 'one', start: 0, end: 0.5, clipId: 'c1' },
        { id: 'w000001', text: 'two', start: 0, end: 0.5, clipId: 'c1b' }
      ]
    });
    expect(layout).toHaveLength(2);
    const ids = layout.map((item) => item.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('c1|w000001');
    expect(ids).toContain('c1b|w000001');
  });

  it('honours a custom minWidthPx override', () => {
    const items = buildWordLabelItems({ ...baseInput, words: [word('w', 0, 0.2)], minWidthPx: 10 });
    expect(items).toHaveLength(1);
  });

  it('skips degenerate words where end <= start (defensive)', () => {
    const items = buildWordLabelItems({ ...baseInput, words: [{ id: 'bad', text: 'bad', start: 1, end: 1, clipId: 'c1' }] });
    expect(items).toEqual([]);
  });
});
