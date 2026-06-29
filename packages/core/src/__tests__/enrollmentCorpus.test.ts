import { describe, expect, it } from 'vitest';
import { enrollmentCorpus, selectEnrollmentSentences } from '../enrollmentCorpus';

describe('enrollmentCorpus', () => {
  it('has exactly 200 sentences', () => {
    expect(enrollmentCorpus).toHaveLength(200);
  });

  it('all sentences are tagged as domain or phoneme', () => {
    for (const s of enrollmentCorpus) {
      expect(['domain', 'phoneme']).toContain(s.category);
      expect(s.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('has 100 domain and 100 phoneme sentences', () => {
    const domain = enrollmentCorpus.filter((s) => s.category === 'domain').length;
    const phoneme = enrollmentCorpus.filter((s) => s.category === 'phoneme').length;
    expect(domain).toBe(100);
    expect(phoneme).toBe(100);
  });

  it('has no duplicate sentence ids', () => {
    const ids = enrollmentCorpus.map((s) => s.id);
    expect(new Set(ids).size).toBe(200);
  });

  it('has no duplicate sentence texts', () => {
    const texts = enrollmentCorpus.map((s) => s.text);
    expect(new Set(texts).size).toBe(200);
  });

  it('each sentence has at least 5 words', () => {
    for (const s of enrollmentCorpus) {
      expect(s.text.trim().split(/\s+/).length).toBeGreaterThanOrEqual(5);
    }
  });

  it('covers all 26 letters of the alphabet', () => {
    const allText = enrollmentCorpus.map((s) => s.text.toLowerCase()).join(' ');
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
      expect(allText, `letter "${letter}" missing from corpus`).toContain(letter);
    }
  });
});

describe('selectEnrollmentSentences', () => {
  it('returns 50 sentences by default', () => {
    expect(selectEnrollmentSentences('seed-a')).toHaveLength(50);
  });

  it('is deterministic for the same seed', () => {
    const a = selectEnrollmentSentences('seed-a');
    const b = selectEnrollmentSentences('seed-a');
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
  });

  it('returns different orderings for different seeds', () => {
    const a = selectEnrollmentSentences('seed-a');
    const b = selectEnrollmentSentences('seed-b');
    expect(a.map((s) => s.id)).not.toEqual(b.map((s) => s.id));
  });

  it('includes both domain and phoneme sentences', () => {
    const selected = selectEnrollmentSentences('seed-a');
    expect(selected.some((s) => s.category === 'domain')).toBe(true);
    expect(selected.some((s) => s.category === 'phoneme')).toBe(true);
  });

  it('accepts a custom count', () => {
    expect(selectEnrollmentSentences('seed-a', 30)).toHaveLength(30);
  });

  it('all returned sentences have the required fields', () => {
    const selected = selectEnrollmentSentences('seed-z', 10);
    for (const s of selected) {
      expect(s.id).toMatch(/^[a-z0-9-]+$/);
      expect(s.text.length).toBeGreaterThan(10);
      expect(['domain', 'phoneme']).toContain(s.category);
    }
  });
});
