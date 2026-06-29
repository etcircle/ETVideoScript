import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMedia } from '../generateMedia';

function tempRoot() { return mkdtempSync(join(tmpdir(), 'etvs-generate-media-')); }

describe('generateMedia', () => {
  it('writes mock generated image, video, and music assets under assets/generated', async () => {
    const root = tempRoot();
    try {
      const image = await generateMedia(root, { kind: 'image-gen', prompt: 'gray square', provider: 'mock' });
      const video = await generateMedia(root, { kind: 'video-gen', prompt: 'black clip', provider: 'mock' });
      const music = await generateMedia(root, { kind: 'music-gen', prompt: 'tone', provider: 'mock' });
      expect(image.assetKind).toBe('image');
      expect(video.assetKind).toBe('video');
      expect(music.assetKind).toBe('audio');
      for (const result of [image, video, music]) {
        expect(result.asset).toMatch(/^assets\/generated\//);
        expect(existsSync(join(root, result.asset))).toBe(true);
      }
      expect(image.durationSec).toBe(0);
      expect(video.durationSec).toBeGreaterThan(0);
      expect(music.durationSec).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
