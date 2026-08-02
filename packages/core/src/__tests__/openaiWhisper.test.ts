import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePaidTransportStubbingGlobalFetch } from './paidTransportTestSetup';
usePaidTransportStubbingGlobalFetch();
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace, loadProject, readProviderRequests, saveProject, transcribeAudio } from '../index';
import { getProvider, runProvider, type SttHomelabWhisperOutput } from '../providers';
import { setProviderSecret, upsertProvider, type ProviderRecord } from '../providerSettings';

const originalFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
  vi.restoreAllMocks();
});

function tempRoot() { return mkdtempSync(join(tmpdir(), 'etvs-openai-whisper-')); }
function audioPath(root: string) {
  const path = join(root, 'audio.wav');
  writeFileSync(path, Buffer.from('RIFF....WAVE'));
  return path;
}
function record(costPerUnit?: ProviderRecord['costPerUnit']): ProviderRecord {
  const now = new Date().toISOString();
  return { schemaVersion: 1, id: 'stt.openai-whisper', kind: 'stt', name: 'openai-whisper', tier: 'paid', enabled: true, default: false, createdAt: now, updatedAt: now, ...(costPerUnit ? { costPerUnit } : {}) };
}
function configure(root: string, costPerUnit?: ProviderRecord['costPerUnit']) {
  upsertProvider({ homeDir: root, provider: { ...record(costPerUnit), secretRef: 'openai-test' } });
  setProviderSecret({ homeDir: root, secretRef: 'openai-test', value: 'test-openai-key' });
}
function whisperJson(words = true) {
  // OpenAI verbose_json with timestamp_granularities=word puts words at the TOP level, not on
  // each segment (per the OpenAI API reference). The earlier shape mirrored homelab Whisper and
  // hid a real parsing bug — codex review flagged this; parser now handles both shapes.
  return JSON.stringify({
    text: 'hello world',
    language: 'en',
    duration: 1.2,
    segments: [{ start: 0, end: 1.2, text: 'hello world' }],
    ...(words ? { words: [{ word: 'hello', start: 0, end: 0.5 }, { word: 'world', start: 0.6, end: 1.1 }] } : {})
  });
}
async function runWhisper(root: string, input: Record<string, unknown> = {}) {
  return runProvider({
    homeDir: root,
    workspacePath: root,
    kind: 'stt',
    providerId: 'openai-whisper',
    requestType: 'transcription',
    input: { audioPath: audioPath(root), audioRel: 'media/extracted-audio.wav', durationSec: 60, ...input },
    env: {}
  });
}
function bodyText(init: RequestInit) {
  return Buffer.from(init.body as Buffer).toString('utf8');
}
function expectField(body: string, name: string, value: string) {
  expect(body).toContain(`name="${name}"`);
  expect(body).toContain(`\r\n\r\n${value}`);
}

describe('OpenAI Whisper provider', () => {
  it('posts verbose_json transcription requests with bearer auth and word timestamps', async () => {
    const root = tempRoot();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    (globalThis as any).fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(whisperJson(), { status: 200 });
    });
    try {
      configure(root);
      const envelope = await runWhisper(root);
      expect(envelope.ok).toBe(true);
      expect(calls[0]!.url).toMatch(/\/v1\/audio\/transcriptions$/);
      expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer test-openai-key');
      expect(new Headers(calls[0]!.init.headers).get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
      const body = bodyText(calls[0]!.init);
      expect(body).toContain('filename="audio.wav"');
      expectField(body, 'model', 'whisper-1');
      expectField(body, 'response_format', 'verbose_json');
      expectField(body, 'timestamp_granularities[]', 'word');
      if (envelope.ok) {
        const output = envelope.output as SttHomelabWhisperOutput;
        expect(output).toMatchObject({ rawJson: whisperJson(), responseBytes: Buffer.byteLength(whisperJson()), durationSec: 60, providerStatus: 200, timing: 'provider-json' });
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('passes a requested OpenAI Whisper model override', async () => {
    const root = tempRoot();
    let body = '';
    (globalThis as any).fetch = vi.fn(async (_url, init) => {
      body = bodyText(init!);
      return new Response(whisperJson(), { status: 200 });
    });
    try {
      configure(root);
      expect((await runWhisper(root, { model: 'whisper-1' })).ok).toBe(true);
      expectField(body, 'model', 'whisper-1');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails before fetch when no OpenAI secret is configured', async () => {
    const root = tempRoot();
    const fetchImpl = vi.fn();
    (globalThis as any).fetch = fetchImpl;
    try {
      const envelope = await runWhisper(root);
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) expect(envelope.error.code).toBe('provider_auth_failed');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('surfaces OpenAI HTTP 401 failures with status and bounded body', async () => {
    const root = tempRoot();
    (globalThis as any).fetch = vi.fn(async () => new Response('invalid api key', { status: 401 }));
    try {
      configure(root);
      const envelope = await runWhisper(root);
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) {
        expect(envelope.error.statusCode).toBe(401);
        expect(envelope.error.message).toContain('invalid api key');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('surfaces OpenAI 5xx failures as provider unavailable', async () => {
    const root = tempRoot();
    (globalThis as any).fetch = vi.fn(async () => new Response('overloaded', { status: 503 }));
    try {
      configure(root);
      const envelope = await runWhisper(root);
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) expect(envelope.error).toMatchObject({ code: 'provider_unavailable', statusCode: 503, message: expect.stringContaining('overloaded') });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('estimates OpenAI Whisper cost by audio minutes', () => {
    const adapter = getProvider('stt.openai-whisper')!;
    expect(adapter.estimateCost({ audioPath: '/tmp/audio.wav', audioRel: 'media/extracted-audio.wav', durationSec: 120 } as any, record()))
      .toMatchObject({ currency: 'USD', estimated: 0.012, actual: null });
  });

  it('uses provider cost overrides for estimate and actual cost', () => {
    const adapter = getProvider('stt.openai-whisper')!;
    const provider = record({ currency: 'USD', unit: 'request', amount: 0.05 });
    const input = { audioPath: '/tmp/audio.wav', audioRel: 'media/extracted-audio.wav', durationSec: 120 } as any;
    expect(adapter.estimateCost(input, provider)).toMatchObject({ estimated: 0.05, actual: null });
    expect(adapter.actualCost!({ rawJson: '{}', responseBytes: 2, durationSec: 120, providerStatus: 200, timing: 'provider-json' } as any, input, provider))
      .toMatchObject({ estimated: 0.05, actual: 0.05 });
  });

  it('surfaces empty successful responses as provider errors', async () => {
    const root = tempRoot();
    (globalThis as any).fetch = vi.fn(async () => new Response('', { status: 200 }));
    try {
      configure(root);
      const envelope = await runWhisper(root);
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) expect(envelope.error.message).toContain('empty transcript');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps OpenAI no-word-timestamp responses as succeeded provider calls then domain-errors', async () => {
    const root = tempRoot();
    const workspace = join(root, 'p');
    (globalThis as any).fetch = vi.fn(async () => new Response(whisperJson(false), { status: 200 }));
    try {
      await createWorkspace({ workspacePath: workspace, projectId: 'p', title: 'Project' });
      writeFileSync(join(workspace, 'media/extracted-audio.wav'), Buffer.from('RIFF....WAVE'));
      const project = loadProject(workspace);
      saveProject({ ...project, clipSources: [{ clipId: 'clip_001', path: 'input/source.mp4', sha256: 'abc123', durationSec: 12, width: 1, height: 1, fps: 30, audioSampleRate: 16000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' }] });
      configure(root);
      await expect(transcribeAudio(workspace, { provider: 'openai-whisper', homeDir: root, env: {} })).rejects.toThrow(/word-level timestamps/);
      expect(readProviderRequests(workspace).map((event) => event.status)).toEqual(['started', 'succeeded']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
