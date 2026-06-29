import { describe, expect, it } from 'vitest';
import { parseTimedWhisperResponse, plainTextFromWhisperResponse, wordsFromPlainText } from '../index';

describe('transcript provider parsing', () => {
  it('extracts text from text-only Whisper JSON before approximate word timing', () => {
    const raw = JSON.stringify({ text: 'Screen, you hear me well, right?\nYeah, all good.' });
    const text = plainTextFromWhisperResponse(raw);
    const doc = wordsFromPlainText(text, 8, 'homelab-whisper', 'approximate', 'req_1');

    expect(text).toBe('Screen, you hear me well, right?\nYeah, all good.');
    expect(doc.words[0]?.text).toBe('Screen,');
    expect(doc.words.map((word) => word.text).join(' ')).not.toContain('{"text"');
  });

  it('parses homelab Whisper segments[].words shape into TranscriptWords', () => {
    const raw = JSON.stringify({
      text: 'hello world', language: 'en', duration: 1.2,
      segments: [{ start: 0, end: 1.2, text: 'hello world', words: [{ word: 'hello', start: 0, end: 0.5, probability: 0.9 }, { word: 'world', start: 0.6, end: 1.1, probability: 0.8 }] }]
    });
    const doc = parseTimedWhisperResponse(raw, 1.2, 'req_homelab');
    expect(doc).not.toBeNull();
    expect(doc!.words.map((word) => word.text)).toEqual(['hello', 'world']);
    expect(doc!.segments).toHaveLength(1);
  });

  it('parses OpenAI verbose_json top-level words shape into TranscriptWords', () => {
    // OpenAI returns words at the top level when timestamp_granularities=word — segments still
    // appear but carry no per-word data. The parser must fold these into the segment buckets.
    const raw = JSON.stringify({
      text: 'hello world', language: 'en', duration: 1.2,
      segments: [{ start: 0, end: 1.2, text: 'hello world' }],
      words: [{ word: 'hello', start: 0, end: 0.5 }, { word: 'world', start: 0.6, end: 1.1 }]
    });
    const doc = parseTimedWhisperResponse(raw, 1.2, 'req_openai');
    expect(doc).not.toBeNull();
    expect(doc!.words.map((word) => word.text)).toEqual(['hello', 'world']);
    expect(doc!.words[0]?.start).toBe(0);
    expect(doc!.words[1]?.end).toBe(1.1);
  });

  it('synthesizes a segment for top-level words when no segments are returned', () => {
    const raw = JSON.stringify({ text: 'hi', duration: 0.4, words: [{ word: 'hi', start: 0, end: 0.4 }] });
    const doc = parseTimedWhisperResponse(raw, 0.4, 'req_synth');
    expect(doc).not.toBeNull();
    expect(doc!.words).toHaveLength(1);
    expect(doc!.segments).toHaveLength(1);
  });

  it('returns null when there are no timestamps anywhere', () => {
    const raw = JSON.stringify({ text: 'hello world', segments: [{ start: 0, end: 1.2, text: 'hello world' }] });
    expect(parseTimedWhisperResponse(raw, 1.2, 'req_none')).toBeNull();
  });

  it('folds pure-punctuation whisper tokens onto the preceding word', () => {
    const raw = JSON.stringify({
      text: 'Screen, hi.', language: 'en', duration: 1.5,
      segments: [{ start: 0, end: 1.5, text: 'Screen, hi.', words: [
        { word: 'Screen', start: 0, end: 0.4, probability: 0.9 },
        { word: ',', start: 0.4, end: 0.45, probability: 0.9 },
        { word: 'hi', start: 0.6, end: 0.9, probability: 0.9 },
        { word: '.', start: 0.9, end: 1.0, probability: 0.9 }
      ] }]
    });
    const doc = parseTimedWhisperResponse(raw, 1.5, 'req_punct');
    expect(doc).not.toBeNull();
    expect(doc!.words.map((word) => word.text)).toEqual(['Screen,', 'hi.']);
    // Punctuation extends the end of the preceding word so a voice_patch over the word also
    // covers its trailing comma.
    expect(doc!.words[0]?.end).toBe(0.45);
    expect(doc!.words[1]?.end).toBe(1);
  });

  it('merges adjacent same-speaker segments with short gaps into a single paragraph', () => {
    // Three whisper-style sentence segments separated by ~0.1s and ~0.05s. Same speaker.
    // Combined word count well under the 80-word cap.
    const raw = JSON.stringify({
      text: 'one two. three four. five six.', language: 'en', duration: 6,
      segments: [
        { start: 0, end: 1.0, text: 'one two.', words: [
          { word: 'one', start: 0.0, end: 0.4, probability: 0.9 },
          { word: 'two', start: 0.5, end: 0.9, probability: 0.9 }
        ] },
        { start: 1.1, end: 2.5, text: 'three four.', words: [
          { word: 'three', start: 1.1, end: 1.6, probability: 0.9 },
          { word: 'four', start: 1.8, end: 2.3, probability: 0.9 }
        ] },
        { start: 2.55, end: 4.0, text: 'five six.', words: [
          { word: 'five', start: 2.55, end: 3.0, probability: 0.9 },
          { word: 'six', start: 3.2, end: 3.8, probability: 0.9 }
        ] }
      ]
    });
    const doc = parseTimedWhisperResponse(raw, 6, 'req_paragraph');
    expect(doc).not.toBeNull();
    expect(doc!.segments).toHaveLength(1);
    expect(doc!.segments[0]?.text).toBe('one two. three four. five six.');
    // All 6 words point to the merged segment id.
    const segIds = new Set(doc!.words.map((word) => word.segmentId));
    expect(segIds.size).toBe(1);
    expect([...segIds][0]).toBe(doc!.segments[0]?.id);
  });

  it('does NOT merge segments separated by a long pause', () => {
    // Two segments with a 3-second gap (> PARAGRAPH_MAX_GAP_SEC of 1.5). Should stay separate.
    const raw = JSON.stringify({
      text: 'hello. world.', language: 'en', duration: 10,
      segments: [
        { start: 0, end: 1.0, text: 'hello.', words: [{ word: 'hello', start: 0.0, end: 0.8, probability: 0.9 }] },
        { start: 4.0, end: 5.0, text: 'world.', words: [{ word: 'world', start: 4.0, end: 4.8, probability: 0.9 }] }
      ]
    });
    const doc = parseTimedWhisperResponse(raw, 10, 'req_gap');
    expect(doc).not.toBeNull();
    expect(doc!.segments).toHaveLength(2);
  });

  it('paragraph soft-cap (~80 words) breaks the merge even with short gaps', () => {
    // 90 same-speaker short segments at 0.2s gaps, each with 1 word. The soft cap should
    // trigger a paragraph break around word 80, producing at least 2 segments.
    const segments = Array.from({ length: 90 }, (_, i) => {
      const start = i * 1.0;
      return { start, end: start + 0.8, text: `w${i}`, words: [{ word: `w${i}`, start, end: start + 0.8, probability: 0.9 }] };
    });
    const raw = JSON.stringify({ text: '...', language: 'en', duration: 100, segments });
    const doc = parseTimedWhisperResponse(raw, 100, 'req_cap');
    expect(doc).not.toBeNull();
    expect(doc!.segments.length).toBeGreaterThanOrEqual(2);
    expect(doc!.words).toHaveLength(90);
  });

  it('preserves leading symbol tokens that carry meaning ($5, #tag, @name)', () => {
    // Currency, hashtag, and at-sign are NOT trailing punctuation — dropping them would
    // mangle transcripts like "$5", "#sap", "@alice". Regression guard for the narrow
    // PUNCT_ONLY regex (the broad \p{P}\p{S} version would have swallowed these).
    const raw = JSON.stringify({
      text: '$5 #sap @alice', language: 'en', duration: 2,
      segments: [{ start: 0, end: 2, text: '$5 #sap @alice', words: [
        { word: '$5', start: 0.0, end: 0.4, probability: 0.9 },
        { word: '#sap', start: 0.5, end: 0.9, probability: 0.9 },
        { word: '@alice', start: 1.0, end: 1.4, probability: 0.9 }
      ] }]
    });
    const doc = parseTimedWhisperResponse(raw, 2, 'req_symbols');
    expect(doc).not.toBeNull();
    expect(doc!.words.map((word) => word.text)).toEqual(['$5', '#sap', '@alice']);
  });

  it('soft-cap is intentionally soft: a 79-word prev plus a 30-word next merges into 109', () => {
    // Document intentional overshoot. The merge logic only checks prev word count < cap, not
    // prev+next ≤ cap, because hard-splitting mid-thought would be jarring. If the user wants
    // tighter paragraphs we can lower the cap; this test catches any accidental hard-split.
    const segments: Array<{ start: number; end: number; text: string; words: Array<{ word: string; start: number; end: number; probability: number }> }> = [];
    // 79 single-word segments at 0.1s gaps so they all merge into one paragraph.
    for (let i = 0; i < 79; i++) {
      const start = i * 0.5;
      segments.push({ start, end: start + 0.4, text: `a${i}`, words: [{ word: `a${i}`, start, end: start + 0.4, probability: 0.9 }] });
    }
    // Then one 30-word segment right after.
    const tailStart = 79 * 0.5;
    segments.push({
      start: tailStart, end: tailStart + 15,
      text: Array.from({ length: 30 }, (_, j) => `b${j}`).join(' '),
      words: Array.from({ length: 30 }, (_, j) => ({ word: `b${j}`, start: tailStart + j * 0.5, end: tailStart + j * 0.5 + 0.4, probability: 0.9 }))
    });
    const raw = JSON.stringify({ text: '...', language: 'en', duration: 100, segments });
    const doc = parseTimedWhisperResponse(raw, 100, 'req_soft_cap');
    expect(doc).not.toBeNull();
    // All 109 words land in one merged paragraph (prev=79 < cap=80 at decision time → merge).
    expect(doc!.segments).toHaveLength(1);
    expect(doc!.words).toHaveLength(109);
  });

  it('keeps single-segment whisper responses with empty-only-punctuation segments alive', () => {
    // A two-segment response where one segment contains only punctuation tokens (e.g. a
    // laugh transcribed as just "."). The empty segment should be skipped (continue, not
    // return null) so the rest of the transcript survives.
    const raw = JSON.stringify({
      text: 'hello. ...', language: 'en', duration: 4,
      segments: [
        { start: 0, end: 1.0, text: 'hello.', words: [
          { word: 'hello', start: 0.0, end: 0.8, probability: 0.9 },
          { word: '.', start: 0.8, end: 0.9, probability: 0.9 }
        ] },
        { start: 2.0, end: 3.0, text: '...', words: [
          { word: '.', start: 2.0, end: 2.2, probability: 0.5 },
          { word: '.', start: 2.2, end: 2.4, probability: 0.5 }
        ] }
      ]
    });
    const doc = parseTimedWhisperResponse(raw, 4, 'req_empty_seg');
    expect(doc).not.toBeNull();
    // The second pure-punct segment is skipped; the first (hello.) remains.
    expect(doc!.words.map((word) => word.text)).toEqual(['hello.']);
    expect(doc!.segments).toHaveLength(1);
  });
});
