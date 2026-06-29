import { describe, expect, it } from 'vitest';
import { summarizeRenderFailure } from './CenterPreview';

describe('summarizeRenderFailure', () => {
  it('keeps the full render log out of the short reason', () => {
    const stderr = [
      'ffmpeg version 7.1 Copyright blah blah',
      'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from source.mp4:',
      'Stream mapping:',
      '[concat @ 0x123] Impossible to open assets/missing.wav',
      'Error opening input file assets/missing.wav.',
      'Error opening input files: No such file or directory'
    ].join('\n');

    const summary = summarizeRenderFailure(stderr, [{ name: 'concat', status: 'failed', error: 'concat failed' }]);

    expect(summary.stage).toBe('concat');
    expect(summary.reason).toBe('Error opening input files: No such file or directory');
    expect(summary.reason).not.toContain('ffmpeg version');
    expect(summary.fullLog).toBe(stderr);
  });
});
