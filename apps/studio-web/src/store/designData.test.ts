import { describe, expect, it } from 'vitest';
import {
  ASPECT_RATIOS,
  BRAND_PACKS,
  CAPTION_STYLES,
  SKILLS,
  deriveDesignData,
  deriveHighlights,
  deriveProposedClips,
  deriveSilences,
} from './designData';
import type { TranscriptWord } from '../lib/api';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function word(id: string, text: string, start: number, end: number, clipId?: string, confidence?: number): TranscriptWord {
  return { id, text, start, end, segmentId: 'seg-00', speaker: 'A', ...(clipId ? { clipId } : {}), ...(confidence != null ? { confidence } : {}) };
}

const tightWords: TranscriptWord[] = [
  word('w1', 'Hello', 0.0, 0.4),
  word('w2', 'world', 0.5, 0.9),
  word('w3', 'foo',   1.0, 1.3),
];

const wordWithSilence: TranscriptWord[] = [
  word('w1', 'Hello',   0.0, 0.4),
  // gap 0.4 → 1.1 = 0.7 s ≥ 0.6 threshold → silence
  word('w2', 'there',   1.1, 1.5),
  // gap 1.5 → 2.2 = 0.7 s → another silence
  word('w3', 'world',   2.2, 2.6),
  // gap 2.6 → 3.0 = 0.4 s (< threshold) → no silence
  word('w4', 'foo',     3.0, 3.4),
];

const segments = [
  { id: 'seg-00', speaker: 'A', start: 0,    end: 8,    text: 'Right now I am building Sweet Bakery OS a chat-first business operating system.' },
  { id: 'seg-01', speaker: 'A', start: 8,    end: 16,   text: 'Um so the way it works is you know customers can text the bakery and an agent intercepts the message.' },
  { id: 'seg-02', speaker: 'A', start: 16,   end: 24,   text: 'The agent is bounded to intake summarisation and routing it never touches the final price.' },
  { id: 'seg-03', speaker: 'A', start: 24,   end: 32,   text: 'We are in week three of six right now episode zero shipped last Tuesday episode one is in drafting.' },
  { id: 'seg-04', speaker: 'A', start: 32,   end: 40,   text: 'Like the whole point of ETVideoScript is that the agent orchestrates and the deterministic code is the source of truth.' },
  { id: 'seg-05', speaker: 'A', start: 40,   end: 50,   text: 'So manifest dot json is the timeline the agent proposes edits you approve them and only then does anything render.' },
  { id: 'seg-06', speaker: 'A', start: 50,   end: 58,   text: 'Yeah uh that is the core invariant source media is preserved every edit is reversible paid providers stay opt in.' },
  { id: 'seg-07', speaker: 'A', start: 58,   end: 66,   text: 'Next slice we will wire up tighten section so the agent can collapse a rambling intro into a tight forty seconds.' },
];

// ─── Static constants ─────────────────────────────────────────────────────────

describe('design data static constants', () => {
  it('exports 9 skills with correct tiers', () => {
    expect(SKILLS).toHaveLength(9);
    const tiers = new Set(SKILLS.map((s) => s.tier));
    expect(tiers).toEqual(new Set(['cleanup', 'edit', 'distribute']));
    expect(SKILLS.find((s) => s.name === 'find-fillers')?.tier).toBe('cleanup');
    expect(SKILLS.find((s) => s.name === 'find-clips')?.tier).toBe('distribute');
  });

  it('exports 5 caption styles each with a swatch', () => {
    expect(CAPTION_STYLES).toHaveLength(5);
    for (const style of CAPTION_STYLES) {
      expect(style.swatch).toBeDefined();
      expect(typeof style.swatch.bg).toBe('string');
    }
  });

  it('exports 4 brand packs with one installed', () => {
    expect(BRAND_PACKS).toHaveLength(4);
    expect(BRAND_PACKS.filter((b) => b.installed)).toHaveLength(1);
    expect(BRAND_PACKS[0]?.id).toBe('etcircle');
  });

  it('exports 4 aspect ratios including 16:9 and 9:16', () => {
    expect(ASPECT_RATIOS).toHaveLength(4);
    const ids = ASPECT_RATIOS.map((a) => a.id);
    expect(ids).toContain('16:9');
    expect(ids).toContain('9:16');
  });
});

// ─── deriveSilences ───────────────────────────────────────────────────────────

describe('deriveSilences', () => {
  it('returns empty array when no words', () => {
    expect(deriveSilences([])).toEqual([]);
  });

  it('returns empty array when all gaps are below threshold', () => {
    expect(deriveSilences(tightWords)).toEqual([]);
  });

  it('detects gaps >= 0.6s as silences and skips sub-threshold gaps', () => {
    const silences = deriveSilences(wordWithSilence);
    expect(silences).toHaveLength(2);
    expect(silences[0]!.start).toBeCloseTo(0.4, 5);
    expect(silences[0]!.end).toBeCloseTo(1.1, 5);
    expect(silences[1]!.start).toBeCloseTo(1.5, 5);
    expect(silences[1]!.end).toBeCloseTo(2.2, 5);
  });

  it('assigns sequential ids starting at sil-001', () => {
    const silences = deriveSilences(wordWithSilence);
    expect(silences[0]!.id).toBe('sil-001');
    expect(silences[1]!.id).toBe('sil-002');
  });

  it('assigns higher confidence to longer gaps', () => {
    // gap of exactly 0.6 s should be near 0.6; a 2-second gap should be near 0.99
    const longGap: TranscriptWord[] = [
      word('a', 'A', 0, 0.5),
      word('b', 'B', 2.5, 3.0), // gap = 2.0s
    ];
    const silences = deriveSilences(longGap);
    expect(silences).toHaveLength(1);
    expect(silences[0]!.conf).toBeGreaterThan(0.8);
    expect(silences[0]!.conf).toBeLessThanOrEqual(0.99);
  });

  it('confidence is rounded to 2 decimal places', () => {
    const silences = deriveSilences(wordWithSilence);
    for (const s of silences) {
      expect(s.conf).toBe(Math.round(s.conf * 100) / 100);
    }
  });
});

// ─── deriveHighlights ─────────────────────────────────────────────────────────

describe('deriveHighlights', () => {
  it('returns empty array for empty segments', () => {
    expect(deriveHighlights([])).toEqual([]);
  });

  it('returns at most 4 highlights', () => {
    const highlights = deriveHighlights(segments);
    expect(highlights.length).toBeLessThanOrEqual(4);
  });

  it('assigns unique sequential ids starting at hl-001', () => {
    const highlights = deriveHighlights(segments);
    expect(highlights[0]!.id).toBe('hl-001');
  });

  it('uses segment id for segmentId field', () => {
    const highlights = deriveHighlights(segments);
    const validIds = new Set(segments.map((s) => s.id));
    for (const hl of highlights) {
      expect(validIds.has(hl.segmentId)).toBe(true);
    }
  });

  it('emits a label and reason for each highlight', () => {
    const highlights = deriveHighlights(segments);
    for (const hl of highlights) {
      expect(typeof hl.label).toBe('string');
      expect(hl.label.length).toBeGreaterThan(0);
      expect(typeof hl.reason).toBe('string');
      expect(hl.reason.length).toBeGreaterThan(0);
    }
  });

  it('scores between 0 and 1', () => {
    const highlights = deriveHighlights(segments);
    for (const hl of highlights) {
      expect(hl.score).toBeGreaterThanOrEqual(0);
      expect(hl.score).toBeLessThanOrEqual(1);
    }
  });

  it('handles single-segment input gracefully', () => {
    const result = deriveHighlights([segments[0]!]);
    expect(result).toHaveLength(1);
  });
});

// ─── deriveProposedClips ──────────────────────────────────────────────────────

describe('deriveProposedClips', () => {
  it('returns empty array for empty segments', () => {
    expect(deriveProposedClips([])).toEqual([]);
  });

  it('returns at most 4 proposed clips', () => {
    const clips = deriveProposedClips(segments);
    expect(clips.length).toBeLessThanOrEqual(4);
  });

  it('each clip has start < end and a non-empty title', () => {
    const clips = deriveProposedClips(segments);
    for (const clip of clips) {
      expect(clip.end).toBeGreaterThan(clip.start);
      expect(clip.title.length).toBeGreaterThan(0);
    }
  });

  it('first clip is 16:9 aspect', () => {
    const clips = deriveProposedClips(segments);
    if (clips.length > 0) {
      expect(clips[0]!.aspect).toBe('16:9');
    }
  });

  it('scores between 0 and 1', () => {
    const clips = deriveProposedClips(segments);
    for (const clip of clips) {
      expect(clip.score).toBeGreaterThanOrEqual(0);
      expect(clip.score).toBeLessThanOrEqual(1);
    }
  });

  it('hookText is a non-empty string', () => {
    const clips = deriveProposedClips(segments);
    for (const clip of clips) {
      expect(clip.hookText.length).toBeGreaterThan(0);
    }
  });

  it('clips include segment ids from the input', () => {
    const clips = deriveProposedClips(segments);
    const allSegIds = new Set(segments.map((s) => s.id));
    for (const clip of clips) {
      for (const segId of clip.segments) {
        expect(allSegIds.has(segId)).toBe(true);
      }
    }
  });
});

// ─── deriveDesignData (bundle) ────────────────────────────────────────────────

describe('deriveDesignData', () => {
  it('returns empty arrays when transcript is null', () => {
    const result = deriveDesignData(null);
    expect(result.silences).toEqual([]);
    expect(result.highlights).toEqual([]);
    expect(result.proposedClips).toEqual([]);
  });

  it('returns populated arrays from a real transcript-shaped doc', () => {
    const doc = {
      words: wordWithSilence,
      segments,
      durationSec: 66,
    };
    const result = deriveDesignData(doc);
    expect(result.silences.length).toBeGreaterThan(0);
    expect(result.highlights.length).toBeGreaterThan(0);
    expect(result.proposedClips.length).toBeGreaterThan(0);
  });
});
