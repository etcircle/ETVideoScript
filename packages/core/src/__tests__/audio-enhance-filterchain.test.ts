import { describe, expect, it } from 'vitest';
import { buildLocalEnhanceArgv } from '../audioEnhance';

const profiles = ['clean_voice', 'podcast', 'meeting', 'tutorial'] as const;

describe('audio enhance local filter chain', () => {
  it.each(profiles)('builds deterministic ffmpeg argv for %s', (profile) => {
    expect(buildLocalEnhanceArgv({
      inputPath: '/tmp/input.wav',
      outputPath: '/tmp/output.wav',
      profile,
      filterChainVersion: 0
    })).toMatchSnapshot();
  });
});
