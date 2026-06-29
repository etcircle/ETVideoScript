import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './server';

function config(root: string) {
  return { host: '127.0.0.1', port: 0, workspaceRoot: root, enableTerminal: false, enableAgent: false, allowedOrigins: ['http://127.0.0.1:4318'], lanOrigins: [], terminalToken: null };
}

const fixtureMp4 = readFileSync(join(process.cwd(), 'packages/core/src/__tests__/fixtures/v2-workspaces/two-clip-homogeneous/assets/video/clip_001/source.mp4'));

function multipart(file: Buffer, type = 'video/mp4') {
  const boundary = `----etvs-${Math.random().toString(36).slice(2)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tiny.mp4"\r\nContent-Type: ${type}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([head, file, tail]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) } };
}

async function createProject(app: ReturnType<typeof createApp>) {
  const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
  expect(created.statusCode).toBe(200);
}

describe('video upload endpoint', () => {
  afterEach(() => { delete process.env.ETVS_MAX_UPLOAD_BYTES; });

  it('accepts a tiny MP4 and returns 202 with clipId/jobId', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-upload-'));
    const app = createApp(config(root));
    try {
      await createProject(app);
      const body = multipart(fixtureMp4);
      const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/video', payload: body.payload, headers: body.headers });
      expect(response.statusCode).toBe(202);
      expect(JSON.parse(response.body)).toMatchObject({ clipId: 'clip_001' });
      expect(JSON.parse(response.body).jobId).toMatch(/^job_upload-video_/);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects bad MIME with 415', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-upload-'));
    const app = createApp(config(root));
    try {
      await createProject(app);
      const body = multipart(Buffer.from('nope'), 'text/plain');
      const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/video', payload: body.payload, headers: body.headers });
      expect(response.statusCode).toBe(415);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects oversize uploads with 413', async () => {
    process.env.ETVS_MAX_UPLOAD_BYTES = '8';
    const root = mkdtempSync(join(tmpdir(), 'etvideo-upload-'));
    const app = createApp(config(root));
    try {
      await createProject(app);
      const body = multipart(fixtureMp4);
      const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/video', payload: body.payload, headers: body.headers });
      expect(response.statusCode).toBe(413);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('assigns sequential clip IDs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-upload-'));
    const app = createApp(config(root));
    try {
      await createProject(app);
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const body = multipart(fixtureMp4);
        const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/assets/video', payload: body.payload, headers: body.headers });
        expect(response.statusCode).toBe(202);
        ids.push(JSON.parse(response.body).clipId);
      }
      expect(ids).toEqual(['clip_001', 'clip_002', 'clip_003']);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
