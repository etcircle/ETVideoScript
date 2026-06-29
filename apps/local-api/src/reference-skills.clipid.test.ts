import { describe, expect, it } from 'vitest';
import type { TranscriptWord } from '@etvideoscript/agent-protocol';
import { findFillerMuteProposals } from '../../../skills/find-fillers/index';
import { polishNarrationProposals } from '../../../skills/polish-narration/index';
import { tightenSectionProposals } from '../../../skills/tighten-section/index';

function word(id: string, clipId: string, text: string, start: number, end: number): TranscriptWord {
  return { id, clipId, text, normalized: text.toLowerCase(), start, end, speaker: 'speaker_1', confidence: 1, segmentId: `${clipId}-seg` };
}

describe('reference skills emit clip-aware operations', () => {
  it('find-fillers scopes each mute to the filler word clipId', () => {
    const proposals = findFillerMuteProposals([
      word('w1', 'clip_001', 'Um', 0.1, 0.3),
      word('w2', 'clip_001', 'hello', 0.4, 0.8),
      word('w3', 'clip_002', 'like', 1.0, 1.2)
    ]);
    expect(proposals.map((op) => ({ clipId: op.clipId, start: op.start, end: op.end }))).toEqual([
      { clipId: 'clip_001', start: 0.1, end: 0.3 },
      { clipId: 'clip_002', start: 1.0, end: 1.2 }
    ]);
  });

  it('polish-narration splits cross-clip ranges into per-clip voice patches', () => {
    const proposals = polishNarrationProposals([
      word('w1', 'clip_001', 'hello', 0, 0.5),
      word('w2', 'clip_001', 'world', 0.5, 1),
      word('w3', 'clip_002', 'next', 0, 0.4),
      word('w4', 'clip_002', 'clip', 0.4, 0.8)
    ]);
    expect(proposals.map((op) => ({ clipId: op.clipId, start: op.start, end: op.end, text: op.text }))).toEqual([
      { clipId: 'clip_001', start: 0, end: 1, text: 'HELLO WORLD' },
      { clipId: 'clip_002', start: 0, end: 0.8, text: 'NEXT CLIP' }
    ]);
  });

  it('tighten-section scopes the repeated phrase cut to the duplicate phrase clipId', () => {
    const proposals = tightenSectionProposals([
      word('w1', 'clip_001', 'go', 0, 0.2),
      word('w2', 'clip_001', 'now', 0.2, 0.4),
      word('w3', 'clip_002', 'go', 1, 1.2),
      word('w4', 'clip_002', 'now', 1.2, 1.4)
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ clipId: 'clip_002', start: 1, end: 1.4 });
  });
});
