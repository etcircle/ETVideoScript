import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createApp } from './server';

function config(root: string) {
  return { host: '127.0.0.1', port: 0, workspaceRoot: root, enableTerminal: false, enableAgent: false, allowedOrigins: ['http://127.0.0.1:4318'], lanOrigins: [], terminalToken: null };
}
function validMp4(root: string) {
  const path = join(root, 'tiny.mp4');
  const result = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=16000', '-t', '0.4', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return readFileSync(path);
}
function multipart(file: Buffer) {
  const boundary = `----etvs-${Math.random().toString(36).slice(2)}`;
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tiny.mp4"\r\nContent-Type: video/mp4\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) } };
}
async function waitForJob(app: ReturnType<typeof createApp>, jobId: string) {
  for (let i = 0; i < 80; i += 1) {
    const detail = await app.inject({ method: 'GET', url: `/api/projects/episode-001/jobs/${jobId}` });
    const job = JSON.parse(detail.body).job;
    if (!['queued', 'running', 'waiting_for_approval'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${jobId}`);
}

describe('per-project manifest mutex', () => {
  it('keeps concurrent upload manifest writes serialized and valid', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-mutex-'));
    const app = createApp(config(root));
    try {
      const fixtureMp4 = validMp4(root);
      await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
      const uploads = await Promise.all([0, 1].map(async () => {
        const body = multipart(fixtureMp4);
        const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/video', payload: body.payload, headers: body.headers });
        expect(response.statusCode).toBe(202);
        return JSON.parse(response.body).jobId;
      }));
      const done = await Promise.all(uploads.map((jobId) => waitForJob(app, jobId)));
      expect(done.map((job) => job.status), JSON.stringify(done.map((job) => job.error))).toEqual(['succeeded', 'succeeded']);
      const project = await app.inject({ method: 'GET', url: '/api/projects/episode-001' });
      const body = JSON.parse(project.body);
      expect(body.validation.valid).toBe(true);
      expect(body.manifest.tracks[0].clips.map((clip: any) => clip.clipId).sort()).toEqual(['clip_001', 'clip_002']);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
