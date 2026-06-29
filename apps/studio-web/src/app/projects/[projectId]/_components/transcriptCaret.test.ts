import { describe, expect, it } from 'vitest';
import { boundaryFromCaret, caretFromBoundary, deletedWordIndexForCaret, moveCaretBoundary, selectionFromBoundaries } from './transcriptCaret';

describe('transcript caret helpers', () => {
  it('maps caret sides to word boundaries', () => {
    expect(boundaryFromCaret({ wordIndex: 2, side: 'left' })).toBe(2);
    expect(boundaryFromCaret({ wordIndex: 2, side: 'right' })).toBe(3);
    expect(caretFromBoundary(0, 4)).toEqual({ wordIndex: 0, side: 'left' });
    expect(caretFromBoundary(3, 4)).toEqual({ wordIndex: 2, side: 'right' });
    expect(caretFromBoundary(99, 4)).toEqual({ wordIndex: 3, side: 'right' });
  });

  it('turns dragged caret boundaries into word-aligned selections', () => {
    expect(selectionFromBoundaries(1, 4)).toEqual({ anchor: 1, focus: 3 });
    expect(selectionFromBoundaries(4, 1)).toEqual({ anchor: 1, focus: 3 });
    expect(selectionFromBoundaries(2, 2)).toBeNull();
  });

  it('uses normal editor delete semantics around the caret', () => {
    expect(deletedWordIndexForCaret({ wordIndex: 2, side: 'left' }, 'Backspace', 5)).toBe(1);
    expect(deletedWordIndexForCaret({ wordIndex: 2, side: 'left' }, 'Delete', 5)).toBe(2);
    expect(deletedWordIndexForCaret({ wordIndex: 0, side: 'left' }, 'Backspace', 5)).toBeNull();
    expect(deletedWordIndexForCaret({ wordIndex: 4, side: 'right' }, 'Delete', 5)).toBeNull();
  });

  it('moves caret boundaries one word at a time', () => {
    expect(moveCaretBoundary({ wordIndex: 1, side: 'right' }, 1, 4)).toBe(3);
    expect(moveCaretBoundary({ wordIndex: 1, side: 'right' }, -1, 4)).toBe(1);
    expect(moveCaretBoundary({ wordIndex: 0, side: 'left' }, -1, 4)).toBe(0);
    expect(moveCaretBoundary({ wordIndex: 3, side: 'right' }, 1, 4)).toBe(4);
  });
});
