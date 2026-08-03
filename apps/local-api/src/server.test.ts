import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePaidTransportStubbingGlobalFetch } from './paidTransportTestSetup';
usePaidTransportStubbingGlobalFetch();
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createApp } from './server';
import { loadConfig } from './config';
import { defaultManifest, loadManifestV3, loadProject, providerEstimatedSpend, saveManifestV3, saveProject, setProviderSecret, upsertProvider, writeTranscript, wordsFromPlainText } from '@etvideoscript/core';

function config(root: string, overrides = {}) {
  return { host: '127.0.0.1', port: 0, workspaceRoot: root, enableTerminal: false, allowedOrigins: ['http://127.0.0.1:4318'], lanOrigins: [], terminalToken: null, ...overrides };
}

// Audible 440 Hz tone (like the mock provider's wavTone, but with an exact duration).
// Must NOT be silence: the TTS pipeline silence-trims every synthesized asset at -40 dB
// (tts.ts trimSilenceInPlace), so an all-zero payload trims to a zero-sample WAV and the
// route correctly rejects it as a degraded payload. Success-path stubs need real signal.
function wavBuffer(durationSec: number, opts: { silent?: boolean } = {}): Buffer {
  const sampleRate = 24000;
  const samples = Math.ceil(sampleRate * durationSec);
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  if (!opts.silent) {
    for (let i = 0; i < samples; i += 1) {
      const fade = Math.min(i / 800, (samples - i) / 800, 1);
      const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 2400 * Math.max(fade, 0));
      buffer.writeInt16LE(sample, 44 + i * 2);
    }
  }
  return buffer;
}

function stubXai(root: string, durationSec = 1, opts: { silent?: boolean } = {}) {
  const audio = wavBuffer(durationSec, opts);
  const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('HOME', root);
  upsertProvider({ homeDir: root, provider: { id: 'tts.xai', kind: 'tts', name: 'xai', tier: 'paid', enabled: true, default: false, secretRef: 'xai-test' } });
  setProviderSecret({ homeDir: root, secretRef: 'xai-test', value: 'test-xai-key' });
  return fetchMock;
}

async function openAgentSocket(app: ReturnType<typeof createApp>, projectId = 'episode-001') {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/projects/${projectId}/agent/test-session?token=test-token`,
    { headers: { origin: 'http://127.0.0.1:4318' } }
  );
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

function wsJsonReceiver(ws: WebSocket): () => Promise<any> {
  const buffered: any[] = [];
  const waiters: Array<(value: any) => void> = [];
  ws.on('message', (data) => {
    const value = JSON.parse(String(data));
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else buffered.push(value);
  });
  return () => new Promise((resolve) => {
    const value = buffered.shift();
    if (value) resolve(value);
    else waiters.push(resolve);
  });
}

function sendWs(ws: WebSocket, value: any) { ws.send(JSON.stringify(value)); }

async function createTranscriptProject(app: ReturnType<typeof createApp>, root: string, text = 'hello um world like hello') {
  await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
  const workspace = join(root, 'episode-001');
  const project = loadProject(workspace);
  saveProject({ ...project, clipSources: [{ clipId: 'clip_001', path: 'input/source.mp4', originalFilename: 'source.mp4', sha256: 'test', durationSec: 30, width: 1920, height: 1080, fps: 30, audioSampleRate: 48000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' }], status: { ...project.status, imported: true } });
  saveManifestV3(workspace, {
    ...defaultManifest('episode-001'),
    assets: [{ assetId: 'asset_video_001', kind: 'video', path: 'input/source.mp4', durationSec: 30, provenance: 'imported', video: { width: 1920, height: 1080, fps: 30, codec: 'h264', pixelFormat: 'yuv420p' }, audio: { sampleRate: 48000, codec: 'aac' } }],
    tracks: [{ trackId: 'track_video_001', kind: 'video', name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 30, timelineStart: 0 }] }]
  }, { revision: false });
  writeTranscript(workspace, wordsFromPlainText(text, text.split(/\s+/).length));
}

describe('local API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
  });
  it('serves health and project creation routes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
      expect(created.statusCode).toBe(200);
      const list = await app.inject({ method: 'GET', url: '/api/projects' });
      expect(JSON.parse(list.body).projects).toHaveLength(1);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('serves project diagnostics with files, validation, doctor, job state, and draft render freshness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
      const response = await app.inject({ method: 'GET', url: '/api/projects/episode-001/diagnostics' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.diagnostics.projectId).toBe('episode-001');
      expect(body.diagnostics.files.source.exists).toBe(false);
      expect(body.diagnostics.validation.valid).toBe(true);
      expect(body.diagnostics.doctor).toHaveProperty('ffmpeg');
      expect(Array.isArray(body.diagnostics.jobs.recent)).toBe(true);
      expect(body.diagnostics.renderFreshness.draft.state).toBe('missing');
      expect(body.diagnostics.errors).toEqual({});
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('returns partial diagnostics when legacy provider requests cannot populate the section', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
      const projectRoot = join(root, 'episode-001');
      mkdirSync(join(projectRoot, 'logs'), { recursive: true });
      writeFileSync(join(projectRoot, 'logs/provider-requests.jsonl'), [
        JSON.stringify({ requestId: 'transcribe_1778706771185', type: 'transcription', provider: 'homelab-whisper', model: 'homelab-whisper', status: 'succeeded', input: { audio: 'media/extracted-audio.wav', timingRequired: 'word' }, output: { transcript: 'transcript/words.json', timing: 'approximate' }, cost: { currency: 'USD', estimated: 0, actual: 0 } }),
        JSON.stringify({ requestId: 'transcribe_1778706955161', type: 'transcription', provider: 'homelab-whisper', model: 'homelab-whisper', status: 'succeeded', input: { audio: 'media/extracted-audio.wav', timingRequired: 'word' }, output: { transcript: 'transcript/words.json', timing: 'approximate' }, cost: { currency: 'USD', estimated: 0, actual: 0 } })
      ].join('\n'));

      const response = await app.inject({ method: 'GET', url: '/api/projects/episode-001/diagnostics' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.diagnostics.providerRequests).toBeNull();
      expect(body.diagnostics.errors.providerRequests).toMatch(/invalid provider request/i);
      expect(body.diagnostics.files.manifest.exists).toBe(true);
      expect(body.diagnostics.files.draft.exists).toBe(false);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('marks draft render stale when manifest changed after the draft input snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await createTranscriptProject(app, root);
      const projectRoot = join(root, 'episode-001');
      mkdirSync(join(projectRoot, 'renders/render-logs'), { recursive: true });
      const manifestPath = join(projectRoot, 'edits/manifest.json');
      const oldManifestRaw = readFileSync(manifestPath);
      const oldManifest = JSON.parse(oldManifestRaw.toString('utf8'));
      const oldSha = createHash('sha256').update(oldManifestRaw).digest('hex');
      const draftPath = join(projectRoot, 'renders/draft.mp4');
      writeFileSync(draftPath, Buffer.from('draft'));
      writeFileSync(join(projectRoot, 'renders/render-logs/draft.mp4.metadata.json'), JSON.stringify({ schemaVersion: 1, output: 'renders/draft.mp4', renderedAt: new Date().toISOString(), manifest: { updatedAt: oldManifest.updatedAt, sha256: oldSha } }));
      await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/operations', payload: { type: 'cut', start: 1, end: 2, reason: 'newer edit' } });
      const future = new Date(Date.now() + 5000);
      utimesSync(draftPath, future, future);

      const response = await app.inject({ method: 'GET', url: '/api/projects/episode-001/diagnostics' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.diagnostics.renderFreshness.draft.state).toBe('stale');
      expect(body.diagnostics.renderFreshness.draft.reason).toMatch(/differs/i);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('streams media with HTTP range support for browser video preview', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
      const projectRoot = join(root, 'episode-001');
      mkdirSync(join(projectRoot, 'input'), { recursive: true });
      writeFileSync(join(projectRoot, 'input/source.mp4'), Buffer.from('0123456789'));
      const response = await app.inject({ method: 'GET', url: '/api/projects/episode-001/media/source', headers: { range: 'bytes=2-5' } });
      expect(response.statusCode).toBe(206);
      expect(response.headers['content-range']).toBe('bytes 2-5/10');
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.body).toBe('2345');
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('queues supported jobs and exposes file-backed job status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
      const queued = await app.inject({ method: 'POST', url: '/api/projects/episode-001/jobs', payload: { type: 'validate-manifest' } });
      expect(queued.statusCode).toBe(202);
      const jobId = JSON.parse(queued.body).job.jobId;
      await new Promise((resolve) => setTimeout(resolve, 40));
      const jobs = await app.inject({ method: 'GET', url: '/api/projects/episode-001/jobs' });
      expect(JSON.parse(jobs.body).jobs.some((job: any) => job.jobId === jobId)).toBe(true);
      const detail = await app.inject({ method: 'GET', url: `/api/projects/episode-001/jobs/${jobId}` });
      expect(detail.statusCode).toBe(200);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('exports captions through the API job path from the edited script', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await createTranscriptProject(app, root, 'Keep delete this then replace me quiet end');
      const projectRoot = join(root, 'episode-001');
      await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/operations', payload: { type: 'cut', start: 1, end: 3, reason: 'remove words' } });
      await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/operations', payload: { type: 'mute', start: 6, end: 7, reason: 'silence audio only' } });
      const patch = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload: { start: 4, end: 6, text: 'fixed phrase', provider: 'mock', voice: 'eve' } });
      expect(patch.statusCode).toBe(200);

      const queued = await app.inject({ method: 'POST', url: '/api/projects/episode-001/jobs', payload: { type: 'export-captions', format: 'srt' } });
      expect(queued.statusCode).toBe(202);
      const jobId = JSON.parse(queued.body).job.jobId;
      await new Promise((resolve) => setTimeout(resolve, 80));

      const detail = await app.inject({ method: 'GET', url: `/api/projects/episode-001/jobs/${jobId}` });
      expect(JSON.parse(detail.body).job.outputs).toEqual(['captions/edited.srt']);
      expect(existsSync(join(projectRoot, 'captions/draft.srt'))).toBe(false);
      const body = readFileSync(join(projectRoot, 'captions/edited.srt'), 'utf8');
      expect(body).toContain('fixed phrase');
      // Phase-1 voice_patch semantics (822f94d, AGENTS.md): shorter generated audio must NOT
      // shrink the timeline — the slot duration is preserved and slack renders as silence.
      // Captions are a projection of the timeline, so the cue spans the full 2s slot, not the
      // 0.66s mock-audio duration the pre-phase-1 ripple/shrink era asserted here.
      expect(body).toContain('00:00:02,000 --> 00:00:04,000\nfixed phrase');
      expect(body).toContain('quiet');
      expect(body).not.toContain('delete');
      expect(body).not.toContain('this');
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('allows browser CORS preflight for manifest PATCH and DELETE actions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await createTranscriptProject(app, root);
      const created = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/operations', payload: { type: 'cut', start: 1, end: 2, reason: 'bad word' } });
      const opId = JSON.parse(created.body).operation.id;

      for (const method of ['PATCH', 'DELETE']) {
        const preflight = await app.inject({
          method: 'OPTIONS',
          url: `/api/projects/episode-001/manifest/operations/${opId}`,
          headers: {
            origin: 'http://127.0.0.1:4318',
            'access-control-request-method': method,
            'access-control-request-headers': 'content-type'
          }
        });
        expect(preflight.statusCode).toBe(204);
        expect(preflight.headers['access-control-allow-methods']).toContain(method);
      }
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('updates and disables manifest operations through browser-facing routes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await createTranscriptProject(app, root);
      const created = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/operations', payload: { type: 'cut', start: 1, end: 2, reason: 'bad word', status: 'proposed' } });
      const createdOperation = JSON.parse(created.body).operation;
      expect(createdOperation.status).toBe('approved');
      const opId = createdOperation.id;

      const patched = await app.inject({ method: 'PATCH', url: `/api/projects/episode-001/manifest/operations/${opId}`, payload: { reason: 'delete selected words', start: 1.1, end: 2.1 } });
      expect(patched.statusCode).toBe(200);
      expect(JSON.parse(patched.body).operation.reason).toBe('delete selected words');

      // draftText is a MUTE-only field (703e61d type-over draft flow: typing over a selection
      // creates a mute op carrying the draft). The v3 op registry parses each patch through
      // the op kind's schema, so draftText on a cut is stripped — round-trip it on a mute.
      const mute = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/operations', payload: { type: 'mute', start: 3, end: 4, reason: 'type-over draft' } });
      const muteId = JSON.parse(mute.body).operation.id;
      const muted = await app.inject({ method: 'PATCH', url: `/api/projects/episode-001/manifest/operations/${muteId}`, payload: { draftText: 'draft words' } });
      expect(muted.statusCode).toBe(200);
      expect(JSON.parse(muted.body).operation.draftText).toBe('draft words');

      const removed = await app.inject({ method: 'DELETE', url: `/api/projects/episode-001/manifest/operations/${opId}` });
      expect(removed.statusCode).toBe(200);
      expect(JSON.parse(removed.body).operation.status).toBe('disabled');
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('creates mock replacement speech assets without exposing provider keys to the browser', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await createTranscriptProject(app, root);
      const response = await app.inject({
        method: 'POST',
        url: '/api/projects/episode-001/manifest/voice-patches',
        payload: { start: 3, end: 4, text: 'corrected words', provider: 'mock', voice: 'eve' }
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.operation.type).toBe('voice_patch');
      expect(body.operation.asset).toMatch(/^assets\/voice\/patch-/);
      expect(body.operation.providerRequestId).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/);
      expect(body.operation).not.toHaveProperty('apiKey');
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('persists explicit voiceRef on browser voice patches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await createTranscriptProject(app, root);
      const response = await app.inject({
        method: 'POST',
        url: '/api/projects/episode-001/manifest/voice-patches',
        payload: { start: 3, end: 4, text: 'corrected words', provider: 'mock', voice: 'eve', voiceRef: { providerId: 'tts.mock', voiceId: 'eve' } }
      });
      expect(response.statusCode).toBe(200);
      const operationId = JSON.parse(response.body).operation.id;
      const operation = loadManifestV3(join(root, 'episode-001')).operations.find((op: any) => op.id === operationId);
      expect(operation).toMatchObject({ voiceRef: { providerId: 'tts.mock', voiceId: 'eve' } });
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('computes a fallback voiceRef from provider and voice for legacy voice patches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await createTranscriptProject(app, root);
      const response = await app.inject({
        method: 'POST',
        url: '/api/projects/episode-001/manifest/voice-patches',
        payload: { start: 3, end: 4, text: 'corrected words', provider: 'mock', voice: 'eve' }
      });
      expect(response.statusCode).toBe(200);
      const operationId = JSON.parse(response.body).operation.id;
      const operation = loadManifestV3(join(root, 'episode-001')).operations.find((op: any) => op.id === operationId);
      expect(operation).toMatchObject({ voiceRef: { providerId: 'tts.mock', voiceId: 'eve' } });
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects invalid voiceRef on browser voice patches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await createTranscriptProject(app, root);
      const response = await app.inject({
        method: 'POST',
        url: '/api/projects/episode-001/manifest/voice-patches',
        payload: { start: 3, end: 4, text: 'corrected words', provider: 'mock', voice: 'eve', voiceRef: { providerId: 'image-gen.xai', voiceId: 'eve' } }
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toMatch(/voiceRef/i);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('treats different model values as distinct dedup bodies for the same requestId', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await createTranscriptProject(app, root);
      const first = await app.inject({
        method: 'POST',
        url: '/api/projects/episode-001/manifest/voice-patches',
        payload: { start: 3, end: 4, text: 'corrected words', provider: 'mock', voice: 'eve', model: 'eleven_multilingual_v2', requestId: 'req_model_dedup' }
      });
      expect(first.statusCode).toBe(200);
      const conflict = await app.inject({
        method: 'POST',
        url: '/api/projects/episode-001/manifest/voice-patches',
        payload: { start: 3, end: 4, text: 'corrected words', provider: 'mock', voice: 'eve', model: 'eleven_turbo_v2_5', requestId: 'req_model_dedup' }
      });
      expect(conflict.statusCode).toBe(409);
      expect(JSON.parse(conflict.body).error).toMatch(/different voice patch body/);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('reports clip-scoped extracted audio and peaks in diagnostics (v2 media layout)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await createTranscriptProject(app, root);
      const projectRoot = join(root, 'episode-001');
      mkdirSync(join(projectRoot, 'media/clip_001'), { recursive: true });
      writeFileSync(join(projectRoot, 'media/clip_001/extracted-audio.wav'), 'RIFF0000WAVE');
      writeFileSync(join(projectRoot, 'media/clip_001/peaks.json'), '{"peaks":[]}');
      const body = JSON.parse((await app.inject({ method: 'GET', url: '/api/projects/episode-001/diagnostics' })).body);
      expect(body.diagnostics.files.audio.path).toBe('media/clip_001/extracted-audio.wav');
      expect(body.diagnostics.files.audio.exists).toBe(true);
      expect(body.diagnostics.files.peaks.path).toBe('media/clip_001/peaks.json');
      expect(body.diagnostics.files.peaks.exists).toBe(true);
      expect(body.diagnostics.peaksFreshness.state).not.toBe('missing_audio');
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('writes voice_patch provider-request rows in the generic cost-bearing schema', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await createTranscriptProject(app, root);
      const patch = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload: { start: 3, end: 4, text: 'corrected words', provider: 'mock', voice: 'eve' } });
      expect(patch.statusCode).toBe(200);
      const request = JSON.parse(patch.body).request;
      expect(request.type).toBe('voice_patch');
      expect(request.cost).toEqual({ currency: 'USD', estimated: 0, actual: 0 });
      expect(request).not.toHaveProperty('textHash');
      const summary = JSON.parse((await app.inject({ method: 'GET', url: '/api/projects/episode-001/provider-requests' })).body).costSummary;
      const row = summary.rows.find((candidate: { requestType: string }) => candidate.requestType === 'voice_patch');
      expect(row).toBeTruthy();
      expect(row.whyCostUnknown).toBeNull();
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps browser asset reads and generated speech writes under assets/voice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
      const projectRoot = join(root, 'episode-001');
      mkdirSync(join(projectRoot, 'logs'), { recursive: true });
      writeFileSync(join(projectRoot, 'logs/secret.txt'), 'SECRET');

      const leaked = await app.inject({ method: 'GET', url: '/api/projects/episode-001/assets/assets%2F..%2Flogs%2Fsecret.txt' });
      expect(leaked.statusCode).toBe(404);

      const badProvider = await app.inject({
        method: 'POST',
        url: '/api/projects/episode-001/manifest/voice-patches',
        payload: { start: 1, end: 2, text: 'nope', provider: '../../logs/pwn', voice: 'eve' }
      });
      expect(badProvider.statusCode).toBe(400);
      expect(JSON.parse(badProvider.body).error).toMatch(/provider/i);

      const badText = await app.inject({
        method: 'POST',
        url: '/api/projects/episode-001/manifest/voice-patches',
        payload: { start: 1, end: 2, text: {}, provider: 'mock', voice: 'eve' }
      });
      expect(badText.statusCode).toBe(400);
      expect(JSON.parse(badText.body).error).toMatch(/text/i);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects malformed replacement text before creating voice patch work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
      for (const payload of [{ start: 1, end: 2, provider: 'mock' }, { start: 1, end: 2, text: '', provider: 'mock' }, { start: 1, end: 2, text: '   ', provider: 'mock' }]) {
        const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload });
        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).error).toMatch(/text/i);
      }
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('synthesizes xAI voice patches directly and calls fetch immediately', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    const fetchMock = stubXai(root, 1);
    try {
      await createTranscriptProject(app, root);
      const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload: { requestId: 'req-xai-direct-1', start: 1, end: 2, text: 'paid words', provider: 'xai', voice: 'eve' } });
      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(response.body);
      expect(body.providerRequestId).toBe('req-xai-direct-1');
      expect(body.operation.status).toBe('approved');
      expect(body.operation.asset).toMatch(/^assets\/voice\/patch-/);
      const lines = readFileSync(join(root, 'episode-001/logs/provider-requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.filter((line) => line.requestId === 'req-xai-direct-1').map((line) => line.status)).toEqual(['approved', 'started', 'succeeded']);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects a pure-silence TTS payload as degraded instead of 500ing on the unreadable trimmed asset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    stubXai(root, 1, { silent: true });
    try {
      await createTranscriptProject(app, root);
      // A 1s all-silence payload passes the provider's HTTP layer but silence-trims to a
      // zero-sample WAV (duration unreadable). That must land in the same degraded-payload
      // rejection as the ~50 ms ElevenLabs near-silence case — op rejected, 502, no 500.
      const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload: { requestId: 'req-xai-silent-1', start: 1, end: 2, text: 'paid words', provider: 'xai', voice: 'eve' } });
      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('implausibly short audio');
      const workspace = join(root, 'episode-001');
      const op = loadManifestV3(workspace).operations.find((candidate: any) => candidate.providerRequestId === 'req-xai-silent-1') as any;
      expect(op?.status).toBe('rejected');
      const lines = readFileSync(join(root, 'episode-001/logs/provider-requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.filter((line) => line.requestId === 'req-xai-silent-1').map((line) => line.status)).toEqual(['approved', 'started', 'succeeded', 'op_update_failed']);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });


  it('serializes concurrent xAI voice patch POSTs and runs only one paid synthesis', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    const audio = wavBuffer(1);
    let releaseFetch!: () => void;
    let fetchMock!: ReturnType<typeof vi.fn>;
    const fetchStarted = new Promise<void>((resolveStarted) => {
      fetchMock = vi.fn(async () => {
        resolveStarted();
        await new Promise<void>((resolve) => { releaseFetch = resolve; });
        return { ok: true, arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) };
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('HOME', root);
    upsertProvider({ homeDir: root, provider: { id: 'tts.xai', kind: 'tts', name: 'xai', tier: 'paid', enabled: true, default: false, secretRef: 'xai-test' } });
    setProviderSecret({ homeDir: root, secretRef: 'xai-test', value: 'test-xai-key' });
    try {
      await createTranscriptProject(app, root);
      const payload = { requestId: 'req-xai-concurrent-1', start: 1, end: 2, text: 'paid words', provider: 'xai', voice: 'eve' };
      const first = app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload });
      await fetchStarted;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const second = app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      releaseFetch();

      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const bodies = responses.map((response) => JSON.parse(response.body));
      expect(bodies.map((body) => body.operation.status)).toEqual(['approved', 'approved']);
      expect(new Set(bodies.map((body) => body.operation.id)).size).toBe(1);
      const lines = readFileSync(join(root, 'episode-001/logs/provider-requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.filter((line) => line.requestId === 'req-xai-concurrent-1').map((line) => line.status)).toEqual(['approved', 'started', 'succeeded']);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('does not resurrect a voice patch the user rejected during paid synthesis (P4-1c phase-3 reload guard)', async () => {
    // P4-1c regression: with the manifest mutex released during the paid synthesis call, the
    // user can PATCH the proposed voice_patch operation to rejected/disabled while synthesis is
    // mid-flight. Phase 3 must reload the operation and refuse to overwrite the user's intent
    // back to 'approved'. The synthesized audio is left on disk (orphaned) and a 409 is
    // surfaced with a ledger event tagging the conflict.
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    const audio = wavBuffer(1);
    let releaseFetch!: () => void;
    let fetchMock!: ReturnType<typeof vi.fn>;
    const fetchStarted = new Promise<void>((resolveStarted) => {
      fetchMock = vi.fn(async () => {
        resolveStarted();
        await new Promise<void>((resolve) => { releaseFetch = resolve; });
        return { ok: true, arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) };
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('HOME', root);
    upsertProvider({ homeDir: root, provider: { id: 'tts.xai', kind: 'tts', name: 'xai', tier: 'paid', enabled: true, default: false, secretRef: 'xai-test' } });
    setProviderSecret({ homeDir: root, secretRef: 'xai-test', value: 'test-xai-key' });
    try {
      await createTranscriptProject(app, root);
      const payload = { requestId: 'req-xai-mid-flight-reject', start: 1, end: 2, text: 'paid words', provider: 'xai', voice: 'eve' };
      const inflight = app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload });
      await fetchStarted;
      // While synthesis is blocked, the user PATCHes the proposed operation to rejected.
      const manifestResp = await app.inject({ method: 'GET', url: '/api/projects/episode-001/manifest' });
      const proposedOp = JSON.parse(manifestResp.body).manifest.operations.find((op: any) => op.providerRequestId === 'req-xai-mid-flight-reject');
      expect(proposedOp.status).toBe('proposed');
      const patchResp = await app.inject({ method: 'PATCH', url: `/api/projects/episode-001/manifest/operations/${proposedOp.id}`, payload: { status: 'rejected', reason: 'user changed their mind' } });
      expect(patchResp.statusCode).toBe(200);
      // Release synthesis.
      releaseFetch();
      const response = await inflight;
      // The synthesis call succeeded, but Phase 3 must refuse to resurrect the user-rejected op.
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error).toMatch(/no longer accepts the synthesis/);
      // The operation must still be in the user's rejected state.
      const finalManifest = await app.inject({ method: 'GET', url: '/api/projects/episode-001/manifest' });
      const finalOp = JSON.parse(finalManifest.body).manifest.operations.find((op: any) => op.providerRequestId === 'req-xai-mid-flight-reject');
      expect(finalOp.status).toBe('rejected');
      expect(finalOp.reason).toBe('user changed their mind');
      expect(finalOp.asset).toBeUndefined();
      // Ledger records the conflict.
      const lines = readFileSync(join(root, 'episode-001/logs/provider-requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const conflict = lines.filter((line) => line.requestId === 'req-xai-mid-flight-reject').find((line) => line.status === 'op_update_failed');
      expect(conflict).toBeTruthy();
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('does not approve a voice patch whose text was edited during paid synthesis (P4-1c phase-3 body-match guard)', async () => {
    // P4-1c regression: status + providerRequestId alone are not enough — a PATCH to the
    // text leaves both unchanged but invalidates the synthesized audio. Phase 3's body-match
    // guard must compare text + target start/end against the op we synthesized for.
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    const audio = wavBuffer(1);
    let releaseFetch!: () => void;
    let fetchMock!: ReturnType<typeof vi.fn>;
    const fetchStarted = new Promise<void>((resolveStarted) => {
      fetchMock = vi.fn(async () => {
        resolveStarted();
        await new Promise<void>((resolve) => { releaseFetch = resolve; });
        return { ok: true, arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) };
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('HOME', root);
    upsertProvider({ homeDir: root, provider: { id: 'tts.xai', kind: 'tts', name: 'xai', tier: 'paid', enabled: true, default: false, secretRef: 'xai-test' } });
    setProviderSecret({ homeDir: root, secretRef: 'xai-test', value: 'test-xai-key' });
    try {
      await createTranscriptProject(app, root);
      const payload = { requestId: 'req-xai-mid-flight-edit', start: 1, end: 2, text: 'original words', provider: 'xai', voice: 'eve' };
      const inflight = app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload });
      await fetchStarted;
      // User PATCHes the text while synthesis is mid-flight. Status stays 'proposed'.
      const manifestResp = await app.inject({ method: 'GET', url: '/api/projects/episode-001/manifest' });
      const proposedOp = JSON.parse(manifestResp.body).manifest.operations.find((op: any) => op.providerRequestId === 'req-xai-mid-flight-edit');
      const editResp = await app.inject({ method: 'PATCH', url: `/api/projects/episode-001/manifest/operations/${proposedOp.id}`, payload: { text: 'edited words' } });
      expect(editResp.statusCode).toBe(200);
      releaseFetch();
      const response = await inflight;
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error).toMatch(/no longer accepts the synthesis/);
      // The op keeps the user's edited text and is NOT promoted to approved.
      const finalManifest = await app.inject({ method: 'GET', url: '/api/projects/episode-001/manifest' });
      const finalOp = JSON.parse(finalManifest.body).manifest.operations.find((op: any) => op.providerRequestId === 'req-xai-mid-flight-edit');
      expect(finalOp.text).toBe('edited words');
      expect(finalOp.status).toBe('proposed');
      expect(finalOp.asset).toBeUndefined();
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('makes voice patch requestId idempotent for repeated xAI posts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    const fetchMock = stubXai(root, 1);
    try {
      await createTranscriptProject(app, root);
      const payload = { requestId: 'req-idempotent-1', start: 1, end: 2, text: 'paid words', provider: 'xai', voice: 'eve' };
      const first = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload });
      const second = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(first.body).operation.id).toBe(JSON.parse(second.body).operation.id);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const project = await app.inject({ method: 'GET', url: '/api/projects/episode-001' });
      expect(JSON.parse(project.body).manifest.operations).toHaveLength(1);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects same requestId with a different voice patch body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    const fetchMock = stubXai(root, 1);
    try {
      await createTranscriptProject(app, root);
      const first = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload: { requestId: 'req-idem-conflict-1', start: 1, end: 2, text: 'paid words', provider: 'xai', voice: 'eve', language: 'en' } });
      const second = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload: { requestId: 'req-idem-conflict-1', start: 1, end: 2, text: 'different words', provider: 'xai', voice: 'eve', language: 'en' } });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(409);
      expect(JSON.parse(second.body).error).toMatch(/requestId.*different/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const project = await app.inject({ method: 'GET', url: '/api/projects/episode-001' });
      expect(JSON.parse(project.body).manifest.operations).toHaveLength(1);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps failed xAI POST sticky and does not retry the provider on repeat POST', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'provider down' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('HOME', root);
    upsertProvider({ homeDir: root, provider: { id: 'tts.xai', kind: 'tts', name: 'xai', tier: 'paid', enabled: true, default: false, secretRef: 'xai-test' } });
    setProviderSecret({ homeDir: root, secretRef: 'xai-test', value: 'test-xai-key' });
    try {
      await createTranscriptProject(app, root);
      const payload = { requestId: 'req-fail-sticky-1', start: 1, end: 2, text: 'paid words', provider: 'xai', voice: 'eve' };
      const failed = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload });
      expect(failed.statusCode).toBe(500);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const retry = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload });
      expect(retry.statusCode).toBe(200);
      expect(JSON.parse(retry.body).request.status).toBe('failed');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });



  it('persists duration metadata and exposes it in the cost summary for generated replacement audio', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await createTranscriptProject(app, root);
      const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload: { requestId: 'req-duration-1', start: 1, end: 1.5, text: 'this mock audio is deliberately too long', provider: 'mock', voice: 'eve' } });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.operation.durationGeneratedSec).toBeGreaterThan(1);
      expect(body.operation.durationRequestedSec).toBe(0.5);
      expect(body.operation.durationWarning).toMatchObject({ requested: 0.5 });
      expect(body.operation.durationWarning.generated).toBeGreaterThan(1);

      const listed = await app.inject({ method: 'GET', url: '/api/projects/episode-001/provider-requests' });
      const row = JSON.parse(listed.body).costSummary.rows.find((candidate: any) => candidate.requestId === 'req-duration-1');
      expect(row.duration).toEqual({ generatedSec: body.operation.durationGeneratedSec, requestedSec: 0.5, unit: 'seconds' });
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps op_update_failed rows generic-shaped and cost-coherent after provider success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    const audio = wavBuffer(1);
    const fetchMock = vi.fn(async () => {
      const manifestPath = join(root, 'episode-001/edits/manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.operations.push({ id: 'op_mute_late_0001', type: 'mute', status: 'approved', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_missing_999', start: 1.5, end: 2.5 }, reason: 'late overlapping edit', proposedBy: 'user', createdBy: 'user', createdAt: new Date().toISOString() });
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: true, arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('HOME', root);
    upsertProvider({ homeDir: root, provider: { id: 'tts.xai', kind: 'tts', name: 'xai', tier: 'paid', enabled: true, default: false, secretRef: 'xai-test' } });
    setProviderSecret({ homeDir: root, secretRef: 'xai-test', value: 'test-xai-key' });
    try {
      await createTranscriptProject(app, root);
      const pending = await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload: { requestId: 'req-op-update-fail-1', start: 1, end: 2, text: 'paid words', provider: 'xai', voice: 'eve' } });
      const failed = pending;
      expect(failed.statusCode).toBe(500);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const lines = readFileSync(join(root, 'episode-001/logs/provider-requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.map((line) => line.status)).toEqual(['approved', 'started', 'succeeded', 'op_update_failed']);
      expect(lines.filter((line) => ['succeeded', 'failed', 'rejected'].includes(line.status))).toHaveLength(1);
      const succeeded = lines.find((line) => line.status === 'succeeded');
      const opUpdateFailed = lines.find((line) => line.status === 'op_update_failed');
      expect(opUpdateFailed).toMatchObject({ type: 'voice_patch', cost: succeeded.cost });
      expect(opUpdateFailed).not.toHaveProperty('textHash');

      const listed = await app.inject({ method: 'GET', url: '/api/projects/episode-001/provider-requests' });
      const row = JSON.parse(listed.body).costSummary.rows.find((candidate: any) => candidate.requestId === 'req-op-update-fail-1');
      expect(row.status).toBe('failed');
      expect(row.estimatedCost).toBe(succeeded.cost.estimated);
      expect(row.actualCost).toBe(succeeded.cost.actual);
      expect(row.whyCostUnknown).not.toBe('legacy/no-cost-record');
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('exposes provider request audit trail with one line per state transition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    stubXai(root, 1);
    try {
      await createTranscriptProject(app, root);
      await app.inject({ method: 'POST', url: '/api/projects/episode-001/manifest/voice-patches', payload: { requestId: 'req-audit-1', start: 1, end: 2, text: 'paid words', provider: 'xai', voice: 'eve' } });
      const lines = readFileSync(join(root, 'episode-001/logs/provider-requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.map((line) => line.status)).toEqual(['approved', 'started', 'succeeded']);
      const listed = await app.inject({ method: 'GET', url: '/api/projects/episode-001/provider-requests' });
      expect(JSON.parse(listed.body).providerRequests.map((line: any) => line.status)).toEqual(['approved', 'started', 'succeeded']);
      const diagnostics = await app.inject({ method: 'GET', url: '/api/projects/episode-001/diagnostics' });
      expect(JSON.parse(diagnostics.body).diagnostics.providerRequests).toHaveLength(3);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('agent websocket round-trips proposals, state_push, and approvals', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-agent-'));
    const app = createApp(config(root, { enableAgent: true, terminalToken: 'test-token' }));
    let ws: WebSocket | null = null;
    try {
      await createTranscriptProject(app, root, 'hello hello world');
      ws = await openAgentSocket(app);
      const recv = wsJsonReceiver(ws);
      sendWs(ws, { kind: 'hello', id: 'hello-1', protocolVersion: 3, agent: { name: 'vitest', skill: 'round-trip' } });
      const ready = await recv();
      expect(ready.kind).toBe('ready');
      expect(ready.protocolVersion).toBe(3);
      expect(ready.manifestVersion).toMatch(/^[a-f0-9]{16}$/);

      sendWs(ws, { kind: 'tool_call', id: 'cut-1', protocolVersion: 3, tool: 'propose_operation', params: { requestId: 'req-cut-0001', type: 'cut', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 0, end: 1 }, reason: 'remove repeated hello' } });
      const proposed = await recv();
      const push = await recv();
      expect(proposed.kind).toBe('tool_result');
      expect(proposed.protocolVersion).toBe(3);
      expect(proposed.result.result.operation.status).toBe('proposed');
      expect(proposed.result.manifestVersion).not.toBe(ready.manifestVersion);
      expect(push.kind).toBe('state_push');
      expect(push.protocolVersion).toBe(3);
      expect(push.event.operationIds).toEqual([proposed.result.result.operation.id]);

      sendWs(ws, { kind: 'tool_call', id: 'approve-1', protocolVersion: 3, tool: 'approve_operation', params: { requestId: 'req-approve-1', operationId: proposed.result.result.operation.id } });
      const approved = await recv();
      await recv();
      expect(approved.kind).toBe('tool_result');
      expect(approved.result.result.operation.status).toBe('approved');
      expect(approved.result.manifestVersion).not.toBe(proposed.result.manifestVersion);
      sendWs(ws, { kind: 'tool_call', id: 'track-1', protocolVersion: 3, tool: 'add_track', params: { requestId: 'req-add-track-1', trackId: 'track_music_001', kind: 'audio', subtype: 'music', name: 'Music', order: 10 } });
      const trackAdded = await recv();
      const structuralPush = await recv();
      expect(trackAdded.kind).toBe('tool_result');
      expect(trackAdded.result.result.track.trackId).toBe('track_music_001');
      expect(structuralPush.kind).toBe('state_push');
      expect(structuralPush.event.type).toBe('manifest_changed');
      expect(structuralPush.event.operationIds).toEqual([]);
      expect(structuralPush.event.manifestVersion).toBe(trackAdded.result.manifestVersion);
      expect(JSON.parse(readFileSync(join(root, 'episode-001/edits/manifest.json'), 'utf8')).operations[0].status).toBe('approved');
    } finally { ws?.close(); await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('agent requestId is idempotent and rejects body conflicts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-agent-'));
    const app = createApp(config(root, { enableAgent: true, terminalToken: 'test-token' }));
    let ws: WebSocket | null = null;
    try {
      await createTranscriptProject(app, root);
      ws = await openAgentSocket(app);
      const recv = wsJsonReceiver(ws);
      sendWs(ws, { kind: 'hello', id: 'hello-1', protocolVersion: 3, agent: { name: 'vitest' } });
      await recv();
      const call = { kind: 'tool_call', id: 'mute-1', protocolVersion: 3, tool: 'propose_operation', params: { requestId: 'req-mute-0001', type: 'mute', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 1, end: 2 }, reason: 'filler' } };
      sendWs(ws, call);
      const first = await recv(); await recv();
      sendWs(ws, { ...call, id: 'mute-2' });
      const replay = await recv();
      expect(replay.result.result.operation.id).toBe(first.result.result.operation.id);
      sendWs(ws, { ...call, id: 'mute-3', params: { ...call.params, target: { ...call.params.target, end: 3 } } });
      const conflict = await recv();
      expect(conflict.kind).toBe('tool_error');
      expect(conflict.error.code).toBe('request_id_conflict');
      expect(JSON.parse(readFileSync(join(root, 'episode-001/edits/manifest.json'), 'utf8')).operations).toHaveLength(1);
    } finally { ws?.close(); await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('agent voice_patch propose_operation with xai synthesizes directly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-agent-'));
    const app = createApp(config(root, { enableAgent: true, terminalToken: 'test-token' }));
    const fetchMock = stubXai(root, 1);
    let ws: WebSocket | null = null;
    try {
      await createTranscriptProject(app, root, 'replace these words now');
      ws = await openAgentSocket(app);
      const recv = wsJsonReceiver(ws);
      sendWs(ws, { kind: 'hello', id: 'hello-1', protocolVersion: 3, agent: { name: 'vitest' } });
      await recv();
      sendWs(ws, { kind: 'tool_call', id: 'voice-1', protocolVersion: 3, tool: 'propose_operation', params: { requestId: 'req-xai-agent-1', providerRequestId: 'req-xai-agent-divergent', type: 'voice_patch', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 0, end: 1 }, text: 'paid words', provider: 'xai', voice: 'eve' } });
      const proposed = await recv();
      expect(proposed.kind).toBe('tool_result');
      expect(proposed.result.result.operation.status).toBe('approved');
      expect(proposed.result.result.operation.asset).toMatch(/^assets\/voice\/patch-/);
      expect(proposed.result.result.operation.providerRequestId).toBe('req-xai-agent-1');
      expect(proposed.result.result.providerRequestId).toBe('req-xai-agent-1');
      expect(proposed.result.result.asset).toMatch(/^assets\/voice\/patch-/);
      // Agent-created voice patches now persist the canonical voiceRef pair, matching the
      // browser path (Lane F closure on the agent transport gap codex flagged in review).
      expect(proposed.result.result.operation.voiceRef).toEqual({ providerId: 'tts.xai', voiceId: 'eve' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { ws?.close(); await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('agent voice_patch degraded payload rejects with HTTP-route parity and stays sticky on retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-agent-'));
    const app = createApp(config(root, { enableAgent: true, terminalToken: 'test-token' }));
    const fetchMock = stubXai(root, 1, { silent: true });
    let ws: WebSocket | null = null;
    try {
      await createTranscriptProject(app, root, 'replace these words now');
      ws = await openAgentSocket(app);
      const recv = wsJsonReceiver(ws);
      sendWs(ws, { kind: 'hello', id: 'hello-1', protocolVersion: 3, agent: { name: 'vitest' } });
      await recv();
      const callParams = { requestId: 'req-xai-agent-silent-1', type: 'voice_patch', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 0, end: 1 }, text: 'paid words', provider: 'xai', voice: 'eve' };
      sendWs(ws, { kind: 'tool_call', id: 'voice-silent-1', protocolVersion: 3, tool: 'propose_operation', params: callParams });
      const failed = await recv();
      // Transport parity with the HTTP tooShort branch: 502 (not 500), op rejected, and
      // the same audit trail — an op_update_failed row AFTER the provider's succeeded row.
      expect(failed.kind).toBe('tool_error');
      expect(failed.error.code).toBe('paid_provider_failed');
      expect(failed.error.status).toBe(502);
      expect(failed.error.message).toContain('implausibly short audio');
      const workspace = join(root, 'episode-001');
      const op = loadManifestV3(workspace).operations.find((candidate: any) => candidate.providerRequestId === 'req-xai-agent-silent-1') as any;
      expect(op?.status).toBe('rejected');
      const rowsFor = (lines: any[]) => lines.filter((line) => line.requestId === 'req-xai-agent-silent-1');
      const lines = readFileSync(join(workspace, 'logs/provider-requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(rowsFor(lines).map((line) => line.status)).toEqual(['approved', 'started', 'succeeded', 'op_update_failed']);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Sticky failure (parity with 'keeps failed xAI POST sticky'): the same requestId
      // replays the stored terminal error and must NOT re-execute the paid provider.
      sendWs(ws, { kind: 'tool_call', id: 'voice-silent-2', protocolVersion: 3, tool: 'propose_operation', params: callParams });
      const replayed = await recv();
      expect(replayed.kind).toBe('tool_error');
      expect(replayed.error.code).toBe('paid_provider_failed');
      expect(replayed.error.status).toBe(502);
      expect(replayed.error.message).toContain('implausibly short audio');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // No new ledger rows either — the replay is a read, not a new attempt.
      const linesAfter = readFileSync(join(workspace, 'logs/provider-requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(rowsFor(linesAfter).length).toBe(rowsFor(lines).length);
    } finally { ws?.close(); await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('attributes EVERY agent-path ledger row to the canonical provider id, so the spend group stays readable', async () => {
    // Pre-existing bug (S1b follow-up): the agent WS tool wrote its own lifecycle rows under the
    // transport's SHORTHAND ('xai') while the execution engine wrote the cost-bearing rows under
    // the canonical id ('tts.xai'). Two consequences, both about money:
    //   • a cap configured on 'tts.xai' never saw the route's rows, and
    //   • 'op_update_failed' is a FIRED status, so one requestId ended up carrying paid rows
    //     under two provider names — which providerEstimatedSpend rejects as an unattributable
    //     ledger, poisoning every later cap check in the workspace.
    // The degraded-payload path is used because it exercises all four row statuses in one call.
    const root = mkdtempSync(join(tmpdir(), 'etvideo-agent-'));
    const app = createApp(config(root, { enableAgent: true, terminalToken: 'test-token' }));
    stubXai(root, 1, { silent: true });
    let ws: WebSocket | null = null;
    try {
      await createTranscriptProject(app, root, 'replace these words now');
      ws = await openAgentSocket(app);
      const recv = wsJsonReceiver(ws);
      sendWs(ws, { kind: 'hello', id: 'hello-1', protocolVersion: 3, agent: { name: 'vitest' } });
      await recv();
      sendWs(ws, { kind: 'tool_call', id: 'voice-canon-1', protocolVersion: 3, tool: 'propose_operation', params: { requestId: 'req-xai-agent-canon-1', type: 'voice_patch', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 0, end: 1 }, text: 'paid words', provider: 'xai', voice: 'eve' } });
      const failed = await recv();
      expect(failed.kind).toBe('tool_error');

      const workspace = join(root, 'episode-001');
      const rows = readFileSync(join(workspace, 'logs/provider-requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((line) => line.requestId === 'req-xai-agent-canon-1');
      expect(rows.map((row) => row.status)).toEqual(['approved', 'started', 'succeeded', 'op_update_failed']);
      // Not one shorthand anywhere in the group.
      expect([...new Set(rows.map((row) => row.provider))]).toEqual(['tts.xai']);
      // And the ledger the cap reads is intact: one attributable, priced group.
      expect(() => providerEstimatedSpend(workspace, ['tts.xai'])).not.toThrow();
      expect(providerEstimatedSpend(workspace, ['tts.xai'])).toBeGreaterThan(0);
      // The shorthand attributes nothing — spend belongs to the canonical id alone.
      expect(providerEstimatedSpend(workspace, ['xai'])).toBe(0);
    } finally { ws?.close(); await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('records the ATTACH-failure audit row canonically too, after money was already spent', async () => {
    // The second edited ledger site (the catch-all after a SUCCESSFUL paid call — a probe or
    // manifest write that fails once the audio is bought). Same canonical-attribution rule as
    // the degraded-payload branch, and it matters more here: the provider row says 'succeeded',
    // so this row is the record of money spent on audio that could not be attached.
    const root = mkdtempSync(join(tmpdir(), 'etvideo-agent-'));
    const app = createApp(config(root, { enableAgent: true, terminalToken: 'test-token' }));
    const workspace = join(root, 'episode-001');
    const editsDir = join(workspace, 'edits');
    const upstream = stubXai(root, 1);
    // Make the manifest unwritable DURING the paid call, so the failure lands after synthesis
    // succeeded — exactly the window this branch exists for.
    vi.stubGlobal('fetch', vi.fn(async (...args: unknown[]) => { chmodSync(editsDir, 0o555); return (upstream as any)(...args); }));
    let ws: WebSocket | null = null;
    try {
      await createTranscriptProject(app, root, 'replace these words now');
      ws = await openAgentSocket(app);
      const recv = wsJsonReceiver(ws);
      sendWs(ws, { kind: 'hello', id: 'hello-1', protocolVersion: 3, agent: { name: 'vitest' } });
      await recv();
      sendWs(ws, { kind: 'tool_call', id: 'voice-attach-1', protocolVersion: 3, tool: 'propose_operation', params: { requestId: 'req-xai-agent-attach-1', type: 'voice_patch', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 0, end: 1 }, text: 'paid words', provider: 'xai', voice: 'eve' } });
      const failed = await recv();
      expect(failed.kind).toBe('tool_error');
      expect(failed.error.code).toBe('paid_provider_failed');
      // Pin the BRANCH: 500 + not the degraded-floor message ⇒ this is the attach-failure catch,
      // not the sub-100ms rejection the other test covers.
      expect(failed.error.status).toBe(500);
      expect(failed.error.message).not.toContain('implausibly short');

      chmodSync(editsDir, 0o755);
      const rows = readFileSync(join(workspace, 'logs/provider-requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((line) => line.requestId === 'req-xai-agent-attach-1');
      expect(rows.map((row) => row.status)).toEqual(['approved', 'started', 'succeeded', 'op_update_failed']);
      expect([...new Set(rows.map((row) => row.provider))]).toEqual(['tts.xai']);
      expect(() => providerEstimatedSpend(workspace, ['tts.xai'])).not.toThrow();
      expect(providerEstimatedSpend(workspace, ['tts.xai'])).toBeGreaterThan(0);
    } finally {
      try { chmodSync(editsDir, 0o755); } catch { /* already restored */ }
      ws?.close(); await app.close(); rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unsupported job types', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-api-'));
    const app = createApp(config(root));
    try {
      await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
      const response = await app.inject({ method: 'POST', url: '/api/projects/episode-001/jobs', payload: { type: 'shell' } });
      expect(response.statusCode).toBe(400);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses to enable terminal without localhost binding', () => {
    const oldEnv = { ...process.env };
    try {
      process.env.ETVIDEO_ENABLE_TERMINAL = '1';
      process.env.ETVIDEO_TERMINAL_TOKEN = 'local-only-test-placeholder';
      process.env.ETVIDEO_API_HOST = '0.0.0.0';
      expect(() => loadConfig({ envFile: null })).toThrow(/localhost/);
    } finally {
      process.env = oldEnv;
    }
  });
});
