import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspace, loadManifestV3, saveManifestV3, writeChannelFixSidecar } from '@etvideoscript/core';
import { createApp } from './server';

function config(root: string) {
  return { host: '127.0.0.1', port: 0, workspaceRoot: root, enableTerminal: false, allowedOrigins: ['http://127.0.0.1:4318'], lanOrigins: [], terminalToken: null };
}

function wavSilence(bytes = 44): Buffer {
  const dataBytes = Math.max(bytes - 44, 0);
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(dataBytes, 40);
  return b;
}

// Backdates a file's mtime so a later-written "source" reads as newer, matching the
// mtime axis channelFixSidecarFresh checks (see channelFixSidecar.ts).
function backdate(path: string, secondsAgo: number) {
  const past = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, past, past);
}

describe('studio-cleanup route', () => {
  it('does not 500 when the largest media/<clipId> dir belongs to a clip removed from the manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-studiocleanup-orphan-'));
    const app = createApp(config(root));
    try {
      const workspace = join(root, 'episode-001');
      await createWorkspace({ workspacePath: workspace, projectId: 'episode-001', title: 'Episode 001' });

      // Live clip_001 with a real (if placeholder) source asset and a small extracted audio.
      const manifest = loadManifestV3(workspace);
      manifest.assets = [{ assetId: 'asset_video_001', kind: 'video', path: 'input/source.mp4', durationSec: 1, provenance: 'imported', video: { width: 320, height: 240, fps: 30 } }];
      manifest.tracks[0].clips = [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 1, timelineStart: 0 }];
      saveManifestV3(workspace, manifest, { revision: false });

      mkdirSync(join(workspace, 'input'), { recursive: true });
      writeFileSync(join(workspace, 'input/source.mp4'), Buffer.from('placeholder'));
      backdate(join(workspace, 'input/source.mp4'), 5);

      mkdirSync(join(workspace, 'media/clip_001'), { recursive: true });
      const liveAudio = join(workspace, 'media/clip_001/extracted-audio.wav');
      writeFileSync(liveAudio, wavSilence(200));
      writeChannelFixSidecar(liveAudio, undefined); // marks it fresh for "no channel fix"

      // An orphaned dir: media/<clipId> for a clip no longer in the manifest, with a
      // LARGER extracted-audio.wav than the live clip — this used to win primaryAudioRel's
      // largest-file heuristic and 500 the route (extractClipAudio: "Unknown clipId").
      mkdirSync(join(workspace, 'media/clip_removed'), { recursive: true });
      writeFileSync(join(workspace, 'media/clip_removed/extracted-audio.wav'), wavSilence(2000));

      const res = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/studio-cleanup', payload: {} });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.studioCleanup.status).toBe('approved');
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not 500 when input/source.mp4 is missing but legacy extracted audio already exists on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-studiocleanup-nosource-'));
    const app = createApp(config(root));
    try {
      const workspace = join(root, 'episode-001');
      await createWorkspace({ workspacePath: workspace, projectId: 'episode-001', title: 'Episode 001' });

      // Legacy top-level layout, but input/source.mp4 was removed after extraction —
      // the best-effort refresh must fall back to the bytes already on disk instead
      // of letting extractAudio's "source not found" throw bubble into a 500.
      mkdirSync(join(workspace, 'media'), { recursive: true });
      const legacyAudio = join(workspace, 'media/extracted-audio.wav');
      writeFileSync(legacyAudio, wavSilence(200));

      const res = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/studio-cleanup', payload: {} });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.studioCleanup.status).toBe('approved');
      // Confirms the cache-hash was computed from the pre-existing bytes, not a refreshed file.
      expect(statSync(legacyAudio).size).toBe(200);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
