export type TranscriptCaret = { wordIndex: number; side: 'left' | 'right' };
export type TranscriptSelection = { anchor: number; focus: number };

export function boundaryFromCaret(caret: TranscriptCaret): number {
  return caret.wordIndex + (caret.side === 'right' ? 1 : 0);
}

export function caretFromBoundary(boundary: number, wordCount: number): TranscriptCaret | null {
  if (wordCount <= 0) return null;
  const clamped = Math.max(0, Math.min(wordCount, boundary));
  if (clamped <= 0) return { wordIndex: 0, side: 'left' };
  return { wordIndex: clamped - 1, side: 'right' };
}

export function selectionFromBoundaries(anchorBoundary: number, focusBoundary: number): TranscriptSelection | null {
  if (anchorBoundary === focusBoundary) return null;
  const start = Math.min(anchorBoundary, focusBoundary);
  const endExclusive = Math.max(anchorBoundary, focusBoundary);
  return { anchor: start, focus: endExclusive - 1 };
}

export function deletedWordIndexForCaret(caret: TranscriptCaret | null, key: 'Backspace' | 'Delete', wordCount: number): number | null {
  if (!caret || wordCount <= 0) return null;
  const boundary = boundaryFromCaret(caret);
  const index = key === 'Backspace' ? boundary - 1 : boundary;
  return index >= 0 && index < wordCount ? index : null;
}

export function moveCaretBoundary(caret: TranscriptCaret | null, direction: -1 | 1, wordCount: number): number | null {
  if (wordCount <= 0) return null;
  const boundary = caret ? boundaryFromCaret(caret) : 0;
  return Math.max(0, Math.min(wordCount, boundary + direction));
}
