import { describe, expect, it } from 'vitest';
import { deriveChapters } from '../takes/chapters';

const plan = [
  { order: 1, clipId: 'clip_comp_001', assetId: 'a1', sourceStart: 1, sourceEnd: 5, timelineStart: 0, durationSec: 4, spanIds: ['s001'], chapterTitle: 'Intro' },
  { order: 2, clipId: 'clip_comp_002', assetId: 'a2', sourceStart: 5, sourceEnd: 9, timelineStart: 4, durationSec: 4, spanIds: ['s002'] }
];

describe('deriveChapters', () => {
  it('one chapter per selection with a chapterTitle', () => {
    expect(deriveChapters({} as never, {} as never, plan as never)).toEqual([{ title: 'Intro', startSec: 0 }]);
  });
  it('empty when no titles set', () => {
    expect(deriveChapters({} as never, {} as never, [{ ...plan[1] }] as never)).toEqual([]);
  });
});
