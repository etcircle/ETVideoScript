import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './server';
import { defaultManifest, latestProviderRequest, loadManifestV3, loadProject, readProviderRequests, saveManifestV3, saveProject, writeTranscript, wordsFromPlainText } from '@etvideoscript/core';

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
    tracks: [
      { trackId: 'track_video_001', kind: 'video', name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [
        { clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 10, timelineStart: 0 },
        { clipId: 'clip_002', assetId: 'asset_video_001', sourceStart: 10, sourceEnd: 20, timelineStart: 10 }
      ] },
      { trackId: 'track_caption_001', kind: 'caption', name: 'Captions', order: 1, locked: false, muted: false, solo: false, hidden: false, clips: [] }
    ]
  }, { revision: false });
  writeTranscript(workspace, wordsFromPlainText('hello world this is a clip', 6));
  return { app, workspace };
}

const clipSpan = { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 1, end: 3 };

describe('generic manifest operation route', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('creates speed, overlay, transition, and caption style operations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-manifest-ops-'));
    const { app, workspace } = await createProject(root);
    try {
      const speed = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/operations', payload: { type: 'speed', target: clipSpan, rate: 4, bed: 'pitched', reason: 'skim dead air' } });
      expect(speed.statusCode).toBe(200);
      expect(JSON.parse(speed.body).operation.type).toBe('speed');

      const overlay = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/operations', payload: { type: 'overlay', target: { ...clipSpan, start: 4, end: 6 }, source: { kind: 'text', text: 'Hello' }, rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.16 }, zIndex: 1, opacity: 0.9 } });
      expect(overlay.statusCode).toBe(200);
      expect(JSON.parse(overlay.body).operation.source.text).toBe('Hello');

      const transition = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/operations', payload: { type: 'transition', target: { kind: 'clip-boundary', trackId: 'track_video_001', clipId: 'clip_001' }, transitionType: 'fade', durationMs: 300 } });
      expect(transition.statusCode).toBe(200);
      expect(JSON.parse(transition.body).operation.target.kind).toBe('clip-boundary');

      const caption = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/operations', payload: { type: 'caption_style', target: { kind: 'track', trackId: 'track_caption_001' }, styleId: 'shorts-bold', fontSize: 42 } });
      expect(caption.statusCode).toBe(200);
      expect(JSON.parse(caption.body).operation.target.kind).toBe('track');

      expect(loadManifestV3(workspace).operations.map((op: any) => op.type)).toEqual(['speed', 'overlay', 'transition', 'caption_style']);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects invalid operations and voice_patch on the generic route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-manifest-ops-'));
    const { app } = await createProject(root);
    try {
      const invalid = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/operations', payload: { type: 'speed', target: { ...clipSpan, end: 1 }, rate: 3 } });
      expect(invalid.statusCode).toBe(400);
      expect(JSON.parse(invalid.body).error).toMatch(/operation|invalid|rate|end/i);

      const voicePatch = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/operations', payload: { type: 'voice_patch', target: clipSpan, text: 'Nope' } });
      expect(voicePatch.statusCode).toBe(400);
      expect(JSON.parse(voicePatch.body).error).toMatch(/voice_patch.*voice-patches/i);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rejecting a synthesized voice_patch does not append a provider rejection event', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-manifest-ops-'));
    const { app, workspace } = await createProject(root);
    try {
      const create = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload: { provider: 'mock', requestId: 'vp_reject_001', start: 1, end: 3, text: 'replacement line' } });
      expect(create.statusCode).toBe(200);
      const created = JSON.parse(create.body);
      expect(created.operation.status).toBe('approved');
      expect(latestProviderRequest(workspace, 'vp_reject_001')?.status).toBe('succeeded');

      const reject = await app.inject({ method: 'PATCH', url: `/api/projects/episode-001/manifest/operations/${created.operation.id}`, payload: { status: 'rejected' } });
      expect(reject.statusCode).toBe(200);
      expect(JSON.parse(reject.body).operation.status).toBe('rejected');
      expect(latestProviderRequest(workspace, 'vp_reject_001')?.status).toBe('succeeded');
      expect(readProviderRequests(workspace).filter((event: any) => event.requestId === 'vp_reject_001' && event.status === 'rejected')).toHaveLength(0);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('deduplicates concurrent voice_patch creates with the same requestId', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-manifest-ops-'));
    const { app, workspace } = await createProject(root);
    try {
      const payload = { provider: 'mock', requestId: 'vp_concurrent_001', start: 1, end: 3, text: 'replacement line' };
      const [first, second] = await Promise.all([
        app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload }),
        app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload })
      ]);

      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 200]);
      const firstBody = JSON.parse(first.body);
      const secondBody = JSON.parse(second.body);
      expect(firstBody.providerRequestId).toBe('vp_concurrent_001');
      expect(secondBody.providerRequestId).toBe('vp_concurrent_001');
      expect(firstBody.operation.id).toBe(secondBody.operation.id);

      const manifest = loadManifestV3(workspace);
      const operations = manifest.operations.filter((op: any) => op.type === 'voice_patch' && op.providerRequestId === 'vp_concurrent_001');
      expect(operations).toHaveLength(1);
      expect(operations[0].status).toBe('approved');

      const requests = readProviderRequests(workspace).filter((event: any) => event.requestId === 'vp_concurrent_001');
      expect(requests.map((event: any) => event.status)).toEqual(['approved', 'started', 'succeeded']);
      expect(new Set(requests.map((event: any) => event.operationId))).toEqual(new Set([operations[0].id]));
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
