import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspace, latestJobs, loadManifestV3, loadProject, saveManifestV3, saveProject } from '@etvideoscript/core';
import { createApp } from './server';

function config(root: string) {
  return { host: '127.0.0.1', port: 0, workspaceRoot: root, enableTerminal: false, allowedOrigins: ['http://127.0.0.1:4318'], lanOrigins: [], terminalToken: null };
}

function wavSilence(): Buffer {
  const samples = 160;
  const dataBytes = samples * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(dataBytes, 40);
  return b;
}

async function withTwoClipWorkspace(workspace: string) {
  await createWorkspace({ workspacePath: workspace, projectId: 'episode-001', title: 'Episode 001' });
  const manifest = loadManifestV3(workspace);
  manifest.assets = [
    { assetId: 'asset_video_001', kind: 'video', path: 'input/source-1.mp4', durationSec: 1, provenance: 'imported', video: { width: 1920, height: 1080, fps: 30 } },
    { assetId: 'asset_video_002', kind: 'video', path: 'input/source-2.mp4', durationSec: 1, provenance: 'imported', video: { width: 1920, height: 1080, fps: 30 } }
  ];
  manifest.tracks[0].clips = [
    { clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 1, timelineStart: 0 },
    { clipId: 'clip_002', assetId: 'asset_video_002', sourceStart: 0, sourceEnd: 1, timelineStart: 1 }
  ];
  saveManifestV3(workspace, manifest, { revision: false });
  const project = loadProject(workspace);
  saveProject({
    ...project,
    clipSources: [
      { clipId: 'clip_001', path: 'input/source-1.mp4', originalFilename: 'source-1.mp4', sha256: 'x1', durationSec: 1, width: 1920, height: 1080, fps: 30, audioSampleRate: 16000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' },
      { clipId: 'clip_002', path: 'input/source-2.mp4', originalFilename: 'source-2.mp4', sha256: 'x2', durationSec: 1, width: 1920, height: 1080, fps: 30, audioSampleRate: 16000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' }
    ],
    status: { ...project.status, imported: true }
  });
}

async function waitForSettledJob(workspace: string) {
  for (let i = 0; i < 20; i += 1) {
    const [job] = latestJobs(workspace);
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('job did not settle');
}

describe('peaks API', () => {
  it('reports peaks diagnostics state without exposing global peaks over HTTP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-peaks-'));
    const app = createApp(config(root));
    try {
      const workspace = join(root, 'episode-001');
      await createWorkspace({ workspacePath: workspace, projectId: 'episode-001', title: 'Episode 001' });
      mkdirSync(join(workspace, 'media'), { recursive: true });
      writeFileSync(join(workspace, 'media/extracted-audio.wav'), Buffer.from('audio'));
      writeFileSync(join(workspace, 'media/peaks.json'), JSON.stringify({ resolutionHz: 100, durationSec: 1, channels: 1, peaks: [[-0.5, 0.5]] }));

      const peaks = await app.inject({ method: 'GET', url: '/api/projects/episode-001/peaks' });
      expect(peaks.statusCode).toBe(404);

      const diagnostics = await app.inject({ method: 'GET', url: '/api/projects/episode-001/diagnostics' });
      const body = JSON.parse(diagnostics.body);
      expect(body.diagnostics.files.peaks.exists).toBe(true);
      expect(body.diagnostics.peaksFreshness.state).toBe('fresh');
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('peaks jobs write per-clip peaks for every manifest clip', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-peaks-job-'));
    const app = createApp(config(root));
    try {
      const workspace = join(root, 'episode-001');
      await withTwoClipWorkspace(workspace);
      mkdirSync(join(workspace, 'media/clip_001'), { recursive: true });
      mkdirSync(join(workspace, 'media/clip_002'), { recursive: true });
      writeFileSync(join(workspace, 'media/clip_001/extracted-audio.wav'), wavSilence());
      writeFileSync(join(workspace, 'media/clip_002/extracted-audio.wav'), wavSilence());

      const queued = await app.inject({ method: 'POST', url: '/api/projects/episode-001/jobs', payload: { type: 'peaks', resolutionHz: 50 } });
      expect(queued.statusCode).toBe(202);
      const job = await waitForSettledJob(workspace);

      expect(job.status).toBe('succeeded');
      expect(job.outputs).toEqual(['media/clip_001/peaks.json', 'media/clip_002/peaks.json']);
      expect(existsSync(join(workspace, 'media/clip_001/peaks.json'))).toBe(true);
      expect(existsSync(join(workspace, 'media/clip_002/peaks.json'))).toBe(true);
      expect(existsSync(join(workspace, 'media/peaks.json'))).toBe(false);

      const clipPeaks = await app.inject({ method: 'GET', url: '/api/projects/episode-001/peaks/clip_001' });
      expect(clipPeaks.statusCode).toBe(200);
      expect(JSON.parse(clipPeaks.body).peaks).toEqual([[0, 0]]);

      const invalidProject = await app.inject({ method: 'GET', url: '/api/projects/%20/peaks/clip_001' });
      expect(invalidProject.statusCode).toBe(400);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('transcribe jobs consume per-clip audio after API extract-audio jobs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-transcribe-job-'));
    const app = createApp(config(root));
    try {
      const workspace = join(root, 'episode-001');
      await withTwoClipWorkspace(workspace);
      mkdirSync(join(workspace, 'input'), { recursive: true });
      mkdirSync(join(workspace, 'media/clip_001'), { recursive: true });
      mkdirSync(join(workspace, 'media/clip_002'), { recursive: true });
      writeFileSync(join(workspace, 'input/source-1.mp4'), Buffer.from('placeholder'));
      writeFileSync(join(workspace, 'input/source-2.mp4'), Buffer.from('placeholder'));
      writeFileSync(join(workspace, 'media/clip_001/extracted-audio.wav'), wavSilence());
      writeFileSync(join(workspace, 'media/clip_002/extracted-audio.wav'), wavSilence());
      expect(existsSync(join(workspace, 'media/extracted-audio.wav'))).toBe(false);

      const extractQueued = await app.inject({ method: 'POST', url: '/api/projects/episode-001/jobs', payload: { type: 'extract-audio' } });
      expect(extractQueued.statusCode).toBe(202);
      const extractJob = await waitForSettledJob(workspace);
      expect(extractJob.status).toBe('succeeded');
      expect(extractJob.outputs).toEqual([
        'media/clip_001/extracted-audio.wav',
        'media/clip_001/peaks.json',
        'media/clip_002/extracted-audio.wav',
        'media/clip_002/peaks.json'
      ]);
      expect(existsSync(join(workspace, 'media/extracted-audio.wav'))).toBe(false);

      const transcribeQueued = await app.inject({ method: 'POST', url: '/api/projects/episode-001/jobs', payload: { type: 'transcribe', provider: 'mock' } });
      expect(transcribeQueued.statusCode).toBe(202);
      const transcribeJob = await waitForSettledJob(workspace);

      expect(transcribeJob.error).toBeUndefined();
      expect(transcribeJob.status).toBe('succeeded');
      expect(transcribeJob.outputs).toEqual([
        'transcript/clip_001/words.json',
        'transcript/clip_001/transcript.md',
        'transcript/clip_002/words.json',
        'transcript/clip_002/transcript.md',
        'transcript/words.json',
        'transcript/transcript.md'
      ]);
      expect(existsSync(join(workspace, 'transcript/clip_001/words.json'))).toBe(true);
      expect(existsSync(join(workspace, 'transcript/clip_002/words.json'))).toBe(true);
      expect(existsSync(join(workspace, 'transcript/words.json'))).toBe(true);

      const merged = JSON.parse(readFileSync(join(workspace, 'transcript/words.json'), 'utf8'));
      expect(new Set(merged.words.map((word: { clipId: string }) => word.clipId))).toEqual(new Set(['clip_001', 'clip_002']));
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves per-clip peaks for uuid-style audio clip ids and rejects unsafe ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-peaks-audioclip-'));
    const app = createApp(config(root));
    try {
      const workspace = join(root, 'episode-001');
      await createWorkspace({ workspacePath: workspace, projectId: 'episode-001', title: 'Episode 001' });
      // Detached-audio tracks carry clip ids like clip_audio_<uuid>; MediaPanel makes clip_<assetId>_<ts>.
      const audioClipId = 'clip_audio_d0502ff8-7393-4b50-bd61-efb6de3d9ad9';
      mkdirSync(join(workspace, `media/${audioClipId}`), { recursive: true });
      writeFileSync(join(workspace, `media/${audioClipId}/peaks.json`), JSON.stringify({ resolutionHz: 50, durationSec: 1, channels: 1, peaks: [[-0.4, 0.4]] }));

      const ok = await app.inject({ method: 'GET', url: `/api/projects/episode-001/peaks/${audioClipId}` });
      expect(ok.statusCode).toBe(200);
      expect(JSON.parse(ok.body).peaks).toEqual([[-0.4, 0.4]]);

      // A clip id containing a path-traversal character must still be rejected.
      const unsafe = await app.inject({ method: 'GET', url: '/api/projects/episode-001/peaks/clip_a.b' });
      expect(unsafe.statusCode).toBe(400);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
