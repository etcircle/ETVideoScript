import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './server';
import { defaultManifest, loadManifestV3, loadProject, saveManifestV3, saveProject, writeTranscript, wordsFromPlainText } from '@etvideoscript/core';

function config(root: string) {
  return { host: '127.0.0.1', port: 0, workspaceRoot: root, enableTerminal: false, allowedOrigins: ['http://127.0.0.1:4318'], lanOrigins: [], terminalToken: null };
}

async function createProject(root: string) {
  const app = createApp(config(root));
  await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
  const workspace = join(root, 'episode-001');
  mkdirSync(join(workspace, 'input'), { recursive: true });
  writeFileSync(join(workspace, 'input/source.mp4'), Buffer.from('fake'));
  const project = loadProject(workspace);
  saveProject({ ...project, clipSources: [{ clipId: 'clip_001', path: 'input/source.mp4', originalFilename: 'source.mp4', sha256: 'test', durationSec: 30, width: 1920, height: 1080, fps: 30, audioSampleRate: 48000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' }], status: { ...project.status, imported: true } });
  saveManifestV3(workspace, {
    ...defaultManifest('episode-001'),
    assets: [{ assetId: 'asset_video_001', kind: 'video', path: 'input/source.mp4', durationSec: 30, provenance: 'imported', video: { width: 1920, height: 1080, fps: 30, codec: 'h264', pixelFormat: 'yuv420p' }, audio: { sampleRate: 48000, codec: 'aac' } }],
    tracks: [{ trackId: 'track_video_001', kind: 'video', name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 30, timelineStart: 0 }] }]
  }, { revision: false });
  writeTranscript(workspace, wordsFromPlainText('hello world this is a clip', 6));
  return { app, workspace };
}

describe('structure routes', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('adds and removes an empty track', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-structure-'));
    const { app } = await createProject(root);
    try {
      const add = await app.inject({ method: 'POST', url: '/api/projects/episode-001/tracks', payload: { trackId: 'track_audio_1', kind: 'audio', subtype: 'dialog', name: 'Dialog', order: 1, locked: false, muted: false, solo: false, hidden: false } });
      expect(add.statusCode).toBe(200);
      expect(JSON.parse(add.body).track.trackId).toBe('track_audio_1');
      const remove = await app.inject({ method: 'DELETE', url: '/api/projects/episode-001/tracks/track_audio_1' });
      expect(remove.statusCode).toBe(200);
      expect(JSON.parse(remove.body).manifest.tracks.some((track: any) => track.trackId === 'track_audio_1')).toBe(false);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('moves and trims a clip', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-structure-'));
    const { app } = await createProject(root);
    try {
      const move = await app.inject({ method: 'PATCH', url: '/api/projects/episode-001/clips/clip_001', payload: { timelineStart: 2 } });
      expect(move.statusCode).toBe(200);
      expect(JSON.parse(move.body).clip.timelineStart).toBe(2);
      const trim = await app.inject({ method: 'PATCH', url: '/api/projects/episode-001/clips/clip_001', payload: { sourceStart: 1, sourceEnd: 12 } });
      expect(trim.statusCode).toBe(200);
      expect(JSON.parse(trim.body).clip.sourceStart).toBe(1);
      expect(JSON.parse(trim.body).clip.sourceEnd).toBe(12);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('detaches audio through the workspace-aware route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-structure-'));
    const fakeFfmpeg = join(root, 'ffmpeg');
    writeFileSync(fakeFfmpeg, '#!/bin/sh\nfor last do :; done\nmkdir -p "$(dirname "$last")"\nprintf wav > "$last"\nexit 0\n');
    chmodSync(fakeFfmpeg, 0o755);
    vi.stubEnv('FFMPEG_PATH', fakeFfmpeg);
    const { app } = await createProject(root);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/clips/clip_001/detach-audio', payload: { detachedClipId: 'clip_audio_001' } });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.audioClip.clipId).toBe('clip_audio_001');
      expect(body.videoClip.audioDetached).toBe(true);
      expect(body.asset.kind).toBe('audio');
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('returns 400 for invalid structural edits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-structure-'));
    const { app } = await createProject(root);
    try {
      const response = await app.inject({ method: 'DELETE', url: '/api/projects/episode-001/tracks/track_video_001' });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toMatch(/non-empty track/i);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('sets, clears, and rejects brand packs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-structure-'));
    const { app, workspace } = await createProject(root);
    try {
      const set = await app.inject({ method: 'PUT', url: '/api/projects/episode-001/brand-pack', payload: { brandPackId: 'etcircle' } });
      expect(set.statusCode).toBe(200);
      expect(JSON.parse(set.body).brandPackId).toBe('etcircle');
      expect(JSON.parse(set.body).manifest.brandPackId).toBe('etcircle');
      expect(loadManifestV3(workspace).brandPackId).toBe('etcircle');

      const clear = await app.inject({ method: 'PUT', url: '/api/projects/episode-001/brand-pack', payload: { brandPackId: null } });
      expect(clear.statusCode).toBe(200);
      expect(JSON.parse(clear.body).brandPackId).toBeNull();
      expect(loadManifestV3(workspace).brandPackId).toBeUndefined();

      const invalid = await app.inject({ method: 'PUT', url: '/api/projects/episode-001/brand-pack', payload: { brandPackId: 'bogus' } });
      expect(invalid.statusCode).toBe(400);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('manages output definitions without touching operations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-structure-'));
    const { app, workspace } = await createProject(root);
    try {
      const create = await app.inject({ method: 'POST', url: '/api/projects/episode-001/outputs', payload: { outputId: 'out_1', kind: 'full', aspects: ['16:9'], status: 'manual' } });
      expect(create.statusCode).toBe(200);
      const patch = await app.inject({ method: 'PATCH', url: '/api/projects/episode-001/outputs/out_1', payload: { aspects: ['9:16', '1:1'] } });
      expect(patch.statusCode).toBe(200);
      const manifest = loadManifestV3(workspace);
      expect(manifest.outputs.some((output: any) => output.outputId === 'out_1' && output.aspects.includes('9:16'))).toBe(true);
      expect(manifest.operations).toHaveLength(0);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
