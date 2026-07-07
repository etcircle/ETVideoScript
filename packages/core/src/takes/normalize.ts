import type { TranscriptWord } from '../schemas';

export interface NormalizedWord { text: string; index: number }

const EDGE_STRIP = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

export function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(EDGE_STRIP, '');
}

export function normalizeWords(words: TranscriptWord[]): NormalizedWord[] {
  const out: NormalizedWord[] = [];
  words.forEach((word, index) => {
    const text = normalizeToken(word.normalized || word.text);
    if (text) out.push({ text, index });
  });
  return out;
}
