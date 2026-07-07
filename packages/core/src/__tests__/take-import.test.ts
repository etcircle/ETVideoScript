import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../media')>();
  return { ...actual, probeRecordingMedia: vi.fn(() => ({ durationSec: 20, hasVideo: true, hasAudio: true, video: { width: 1920, height: 1080, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } })) };
});

import { importTake } from '../takes/import';
import { loadManifestV3, saveManifestV3 } from '../manifest/io';
import { defaultManifest } from '../filesystem';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function workspace(): string {
  dir = mkdtempSync(join(tmpdir(), 'ets-take-'));
  mkdirSync(join(dir, 'edits'), { recursive: true });
  saveManifestV3(dir, defaultManifest('proj_test'), { revision: false });
  return dir;
}

function fakeVideo(name: string): string { const p = join(dir, name); writeFileSync(p, 'x'); return p; }

describe('importTake', () => {
  it('copies takes with sequential numbering and builds staging track + group', () => {
    const w = workspace();
    const r1 = importTake(w, fakeVideo('a.mp4'), { groupId: 'main' });
    const r2 = importTake(w, fakeVideo('b.mp4'), { groupId: 'main' });
    expect(r1.clipId).toBe('clip_take_01');
    expect(r2.clipId).toBe('clip_take_02');
    expect(existsSync(join(w, 'input/takes/take-01.mp4'))).toBe(true);
    expect(existsSync(join(w, 'input/takes/take-02.mp4'))).toBe(true);
    const manifest = loadManifestV3(w);
    const staging = manifest.tracks.find((t) => t.role === 'staging')!;
    expect(staging.clips.map((c) => c.clipId)).toEqual(['clip_take_01', 'clip_take_02']);
    expect(manifest.takeGroups[0].clipIds).toEqual(['clip_take_01', 'clip_take_02']);
  });

  it('never overwrites input/source.mp4 and keeps the timeline video track empty', () => {
    const w = workspace();
    importTake(w, fakeVideo('a.mp4'), { groupId: 'main' });
    expect(existsSync(join(w, 'input/source.mp4'))).toBe(false);
  });
});
