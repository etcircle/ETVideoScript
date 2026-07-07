import { describe, expect, it } from 'vitest';
import { normalizeWords } from '../takes/normalize';
import { makeWords } from './takes-fixtures';

describe('normalizeWords', () => {
  it('lowercases and strips edge punctuation, keeping internal apostrophes/hyphens', () => {
    const words = makeWords(`Hello, World! don't built-in "quoted"`);
    expect(normalizeWords(words).map((w) => w.text)).toEqual(['hello', 'world', "don't", 'built-in', 'quoted']);
  });

  it('drops words that normalize to empty and preserves original indices', () => {
    const words = makeWords('one ... two');
    const norm = normalizeWords(words);
    expect(norm.map((w) => w.text)).toEqual(['one', 'two']);
    expect(norm.map((w) => w.index)).toEqual([0, 2]);
  });

  it('prefers the transcript-provided normalized field', () => {
    const words = makeWords('Umm');
    words[0] = { ...words[0], normalized: 'um' };
    expect(normalizeWords(words)[0].text).toBe('um');
  });

  it('handles unicode letters', () => {
    expect(normalizeWords(makeWords('¡Héllo! ¿qué?')).map((w) => w.text)).toEqual(['héllo', 'qué']);
  });
});
