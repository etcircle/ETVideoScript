import { describe, expect, it } from 'vitest';
import { isActiveBrandPack } from './ElementsPanel';

describe('ElementsPanel brand pack helpers', () => {
  it('marks only the manifest brand pack as active', () => {
    expect(isActiveBrandPack('etcircle', 'etcircle')).toBe(true);
    expect(isActiveBrandPack('etcircle', 'shorts')).toBe(false);
    expect(isActiveBrandPack(undefined, 'etcircle')).toBe(false);
    expect(isActiveBrandPack(null, 'etcircle')).toBe(false);
  });
});
