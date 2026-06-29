import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createApp } from './server';
import { wavTone } from '@etvideoscript/core';

function config(root: string) {
  return { host: '127.0.0.1', port: 0, workspaceRoot: root, enableTerminal: false, enableAgent: false, allowedOrigins: ['http://127.0.0.1:4318'], lanOrigins: [], terminalToken: null };
}

let fixtureMp4: Buffer;
let silentMp4: Buffer;

function makeFixture(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'etvideo-recording-fixture-'));
  const output = join(root, 'fixture.mp4');
  const result = spawnSync('ffmpeg', ['-y', ...args, output], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const buffer = readFileSync(output);
  rmSync(root, { recursive: true, force: true });
  return buffer;
}

beforeAll(() => {
  fixtureMp4 = makeFixture(['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  silentMp4 = makeFixture(['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an']);
});

function multipart(file: Buffer, opts: { type?: string; source?: string; durationSec?: number; filename?: string } = {}) {
  const boundary = `----etvs-${Math.random().toString(36).slice(2)}`;
  const chunks = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="source"\r\n\r\n${opts.source || 'screen'}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="durationSec"\r\n\r\n${opts.durationSec ?? 1}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${opts.filename || 'recording.mp4'}"\r\nContent-Type: ${opts.type || 'video/mp4'}\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ];
  const payload = Buffer.concat(chunks);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) } };
}

async function createProject(app: ReturnType<typeof createApp>) {
  const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
  expect(created.statusCode).toBe(200);
}

async function waitJob(app: ReturnType<typeof createApp>, jobId: string) {
  for (let i = 0; i < 80; i += 1) {
    const res = await app.inject({ method: 'GET', url: `/api/projects/episode-001/jobs/${jobId}` });
    expect(res.statusCode).toBe(200);
    const job = JSON.parse(res.body).job;
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${jobId}`);
}

async function detail(app: ReturnType<typeof createApp>) {
  const res = await app.inject({ method: 'GET', url: '/api/projects/episode-001' });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}

describe('recording endpoint', () => {
  afterEach(() => { delete process.env.ETVS_MAX_UPLOAD_BYTES; });

  it('records a video as a recorded asset, clip, and merged transcript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-recording-'));
    const app = createApp(config(root));
    try {
      await createProject(app);
      const body = multipart(fixtureMp4, { source: 'screen', type: 'video/mp4' });
      const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/recordings', payload: body.payload, headers: body.headers });
      expect(response.statusCode).toBe(202);
      const { clipId, jobId } = JSON.parse(response.body);
      expect(clipId).toBe('clip_001');
      const job = await waitJob(app, jobId);
      expect(job.status).toBe('succeeded');
      const project = await detail(app);
      const asset = project.manifest.assets.find((candidate: any) => candidate.assetId === `asset_rec_${clipId}`);
      expect(asset).toMatchObject({ kind: 'video', provenance: 'recorded', path: `assets/recordings/${clipId}/source.mp4` });
      expect(project.manifest.tracks.some((track: any) => track.kind === 'video' && track.clips.some((clip: any) => clip.clipId === clipId))).toBe(true);
      expect(project.transcript.words.some((word: any) => word.clipId === clipId)).toBe(true);
      expect(asset.path.startsWith('assets/recordings/')).toBe(true);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('records voice onto a voiceover track and transcribes it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-recording-'));
    const app = createApp(config(root));
    try {
      await createProject(app);
      const body = multipart(wavTone('voice recording'), { source: 'voice', type: 'audio/wav', filename: 'voice.wav' });
      const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/recordings', payload: body.payload, headers: body.headers });
      expect(response.statusCode).toBe(202);
      const { clipId, jobId } = JSON.parse(response.body);
      const job = await waitJob(app, jobId);
      expect(job.status).toBe('succeeded');
      const project = await detail(app);
      expect(project.manifest.assets.find((asset: any) => asset.assetId === `asset_rec_${clipId}`)).toMatchObject({ kind: 'audio', provenance: 'recorded' });
      expect(project.manifest.tracks.some((track: any) => track.kind === 'audio' && track.subtype === 'voiceover' && track.clips.some((clip: any) => clip.clipId === clipId))).toBe(true);
      expect(project.transcript.words.some((word: any) => word.clipId === clipId)).toBe(true);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('skips extract/transcribe for a silent screen recording', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-recording-'));
    const app = createApp(config(root));
    try {
      await createProject(app);
      const body = multipart(silentMp4, { source: 'screen', type: 'video/mp4' });
      const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/recordings', payload: body.payload, headers: body.headers });
      expect(response.statusCode).toBe(202);
      const { jobId } = JSON.parse(response.body);
      const job = await waitJob(app, jobId);
      expect(job.status).toBe('succeeded');
      expect(job.stages.find((stage: any) => stage.name === 'extract-audio').status).toBe('cancelled');
      expect(job.stages.find((stage: any) => stage.name === 'transcribe').status).toBe('cancelled');
      expect((await detail(app)).transcript).toBeNull();
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects bad source, bad MIME, and oversize recordings', async () => {
    let root = mkdtempSync(join(tmpdir(), 'etvideo-recording-'));
    let app = createApp(config(root));
    try {
      await createProject(app);
      let body = multipart(Buffer.from('nope'), { source: 'bogus', type: 'video/mp4' });
      expect((await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/recordings', payload: body.payload, headers: body.headers })).statusCode).toBe(400);
      body = multipart(Buffer.from('nope'), { source: 'screen', type: 'text/plain' });
      expect((await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/recordings', payload: body.payload, headers: body.headers })).statusCode).toBe(415);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }

    process.env.ETVS_MAX_UPLOAD_BYTES = '8';
    root = mkdtempSync(join(tmpdir(), 'etvideo-recording-'));
    app = createApp(config(root));
    try {
      await createProject(app);
      const body = multipart(fixtureMp4, { source: 'screen', type: 'video/mp4' });
      expect((await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/recordings', payload: body.payload, headers: body.headers })).statusCode).toBe(413);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('allocates clip IDs across uploaded-video and recording directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-recording-'));
    const app = createApp(config(root));
    try {
      await createProject(app);
      mkdirSync(join(root, 'episode-001/assets/video/clip_001'), { recursive: true });
      const body = multipart(fixtureMp4, { source: 'cam', type: 'video/mp4' });
      const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/recordings', payload: body.payload, headers: body.headers });
      expect(response.statusCode).toBe(202);
      expect(JSON.parse(response.body).clipId).toBe('clip_002');
      expect(existsSync(join(root, 'episode-001/assets/recordings/clip_002/source.mp4'))).toBe(true);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('merges uploaded video and recorded voiceover transcripts without regressing uploaded video assets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-recording-'));
    const app = createApp(config(root));
    try {
      await createProject(app);
      const videoBody = multipart(fixtureMp4, { source: 'screen', type: 'video/mp4', filename: 'fixture.mp4' });
      const videoResponse = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/video', payload: videoBody.payload, headers: videoBody.headers });
      expect(videoResponse.statusCode).toBe(202);
      const videoUpload = JSON.parse(videoResponse.body);
      expect(videoUpload.clipId).toBe('clip_001');
      expect((await waitJob(app, videoUpload.jobId)).status).toBe('succeeded');

      const voiceBody = multipart(wavTone('voice recording'), { source: 'voice', type: 'audio/wav', filename: 'voice.wav' });
      const voiceResponse = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/recordings', payload: voiceBody.payload, headers: voiceBody.headers });
      expect(voiceResponse.statusCode).toBe(202);
      const voiceUpload = JSON.parse(voiceResponse.body);
      expect(voiceUpload.clipId).toBe('clip_002');
      expect((await waitJob(app, voiceUpload.jobId)).status).toBe('succeeded');

      const project = await detail(app);
      const words = project.transcript.words;
      expect(words.some((word: any) => word.clipId === 'clip_001')).toBe(true);
      expect(words.some((word: any) => word.clipId === 'clip_002')).toBe(true);
      expect(project.manifest.assets.find((asset: any) => asset.assetId === 'asset_video_clip_001')).toMatchObject({ kind: 'video', provenance: 'imported', path: 'assets/video/clip_001/source.mp4' });
      expect(project.manifest.tracks.some((track: any) => track.kind === 'video' && track.clips.some((clip: any) => clip.clipId === 'clip_001'))).toBe(true);
      expect(existsSync(join(root, 'episode-001/assets/video/clip_001/source.mp4'))).toBe(true);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
