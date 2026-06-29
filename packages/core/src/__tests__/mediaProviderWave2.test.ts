import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkspace,
  defaultManifest,
  enhanceAudio,
  materializeAudioEnhance,
  readProviderRequests,
  redactSecrets,
  resolveWhisperBaseUrl,
  runProvider,
  saveManifestV3,
  loadProject,
  saveProject,
  transcribeAudio,
  wordsFromPlainText,
  type AudioEnhanceOperationLike
} from '../index';
import { getProvider, listProviders } from '../providers';

function tempRoot(prefix = 'etvs-wave2-') { return mkdtempSync(join(tmpdir(), prefix)); }
function isolatedEtvsDir(root: string) { return join(root, '.etvs'); }

async function workspaceWithAudio() {
  const root = tempRoot();
  const workspace = join(root, 'p');
  await createWorkspace({ workspacePath: workspace, projectId: 'p', title: 'Project' });
  writeFileSync(join(workspace, 'media/extracted-audio.wav'), Buffer.from('RIFF....WAVE'));
  const project = loadProject(workspace);
  saveProject({ ...project, clipSources: [{ clipId: 'clip_001', path: 'input/source.mp4', sha256: 'abc123', durationSec: 12, width: 1, height: 1, fps: 30, audioSampleRate: 16000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' }] });
  return { root, workspace };
}

const enhanceOp: AudioEnhanceOperationLike = {
  id: 'op_audio_enhance_0001',
  type: 'audio_enhance',
  status: 'approved',
  clipId: 'clip_001',
  provider: 'elevenlabs-isolation',
  profile: 'podcast',
  filterChainVersion: 0,
  intensity: 0.6,
  createdBy: 'user',
  createdAt: '2026-05-15T00:00:00.000Z'
};

describe('media provider wave 2', () => {
  it('registers stt and studio-sound adapters with full ids and modes', () => {
    expect(listProviders().map((provider) => provider.id)).toEqual(expect.arrayContaining([
      'stt.mock',
      'stt.homelab-whisper',
      'studio-sound.ffmpeg-local',
      'studio-sound.adobe-enhance',
      'studio-sound.elevenlabs-isolation'
    ]));
    expect(getProvider('stt.mock')?.mode).toBe('local');
    expect(getProvider('stt.homelab-whisper')?.mode).toBe('http');
    expect(getProvider('studio-sound.ffmpeg-local')?.mode).toBe('local');
  });

  it('summarizes large provider outputs in the generic ledger fallback', async () => {
    const root = tempRoot();
    try {
      const envelope = await runProvider({ workspacePath: root, etvsDir: isolatedEtvsDir(root), kind: 'stt', providerId: 'mock', requestType: 'transcription', input: { text: 'word '.repeat(5000), durationSec: 120 } });
      expect(envelope.ok).toBe(true);
      const ledger = join(root, 'logs/provider-requests.jsonl');
      expect(statSync(ledger).size).toBeLessThan(12_000);
      const output = readProviderRequests(root).at(-1) as any;
      expect(output.output.wordCount).toBeGreaterThan(1000);
      expect(output.output).not.toHaveProperty('words');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('resolves all legacy Whisper env var names and redacts Basic auth', () => {
    for (const key of ['ETVS_WHISPER_BASE_URL', 'WHISPER_BASE_URL', 'ETVS_WHISPER_URL', 'ETVS_WHISPER_LAN_URL', 'ETVIDEO_WHISPER_BASE_URL', 'ETVIDEO_WHISPER_URL', 'ETVIDEO_WHISPER_LAN_URL', 'WHISPER_URL', 'WHISPER_LAN_URL']) {
      expect(resolveWhisperBaseUrl({ [key]: `http://127.0.0.1/${key}` })).toBe(`http://127.0.0.1/${key}`);
    }
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: Basic [REDACTED]');
  });

  it('transcribeAudio writes transcript after a successful provider call and leaves no failed row for no-word domain errors', async () => {
    const { root, workspace } = await workspaceWithAudio();
    const originalFetch = globalThis.fetch;
    const injected = (async () => new Response(JSON.stringify({ text: 'no words here' }), { status: 200 })) as typeof fetch & { mock?: boolean };
    injected.mock = true;
    (globalThis as any).fetch = injected;
    try {
      await expect(transcribeAudio(workspace, { provider: 'homelab-whisper', etvsDir: isolatedEtvsDir(root), env: { ETVS_WHISPER_BASE_URL: 'http://127.0.0.1:8788/inference' } })).rejects.toThrow(/word-level timestamps/);
      expect(readProviderRequests(workspace).map((event) => event.status)).toEqual(['started', 'succeeded']);
    } finally { (globalThis as any).fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
  });

  it('redacts Whisper basic auth from every provider ledger row', async () => {
    const { root, workspace } = await workspaceWithAudio();
    const rawBasic = Buffer.from('user:super-secret-password').toString('base64');
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCalls += 1;
      expect([`Basic ${rawBasic}`, rawBasic]).toContain((init?.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify({
        language: 'en',
        duration: 1,
        segments: [{ start: 0, end: 1, text: 'hello', words: [{ word: 'hello', start: 0, end: 1, probability: 0.9 }] }]
      }), { status: 200 });
    }) as typeof fetch & { mock?: boolean };
    fetchImpl.mock = true;
    (globalThis as any).fetch = fetchImpl;
    try {
      await transcribeAudio(workspace, { provider: 'homelab-whisper', etvsDir: isolatedEtvsDir(root), env: { ETVS_WHISPER_BASE_URL: 'http://127.0.0.1:8788/inference', ETVS_WHISPER_BASIC_AUTH: rawBasic } });
      const direct = await runProvider({
        workspacePath: workspace,
        etvsDir: isolatedEtvsDir(root),
        kind: 'stt',
        providerId: 'homelab-whisper',
        requestType: 'transcription',
        input: { audioPath: join(workspace, 'media/extracted-audio.wav'), audioRel: 'media/extracted-audio.wav', durationSec: 1, baseUrl: 'http://127.0.0.1:8788/inference', basicAuth: rawBasic }
      });
      expect(direct.ok).toBe(true);
      expect(fetchCalls).toBe(2);
      const ledger = readFileSync(join(workspace, 'logs/provider-requests.jsonl'), 'utf8');
      expect(ledger).not.toContain(rawBasic);
      expect(ledger).not.toContain('user:super-secret-password');
      for (const line of ledger.trim().split('\n')) {
        const row = JSON.parse(line);
        expect(row.input).not.toHaveProperty('basicAuth');
        expect(row.input).not.toHaveProperty('audioPath');
      }
    } finally { (globalThis as any).fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
  });

  it('caps provider HTTP error bodies before writing failed ledger rows', async () => {
    const { root, workspace } = await workspaceWithAudio();
    const hugeBody = 'x'.repeat(10_000);
    const originalFetch = globalThis.fetch;
    const fetchImpl = (async () => new Response(hugeBody, { status: 500 })) as typeof fetch & { mock?: boolean };
    fetchImpl.mock = true;
    (globalThis as any).fetch = fetchImpl;
    try {
      await expect(transcribeAudio(workspace, { provider: 'homelab-whisper', etvsDir: isolatedEtvsDir(root), env: { ETVS_WHISPER_BASE_URL: 'http://127.0.0.1:8788/inference' } })).rejects.toThrow(/HTTP 500/);
      const failed = readProviderRequests(workspace).at(-1) as any;
      expect(failed.status).toBe('failed');
      expect(failed.error.length).toBeLessThan(2_500);
    } finally { (globalThis as any).fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
  });

  it('caps paid studio-sound HTTP error bodies before writing failed ledger rows', async () => {
    const { root, workspace } = await workspaceWithAudio();
    const hugeBody = 'y'.repeat(10_000);
    try {
      const inputPath = join(workspace, 'media/extracted-audio.wav');
      const response = new Response(hugeBody, { status: 500 });
      response.arrayBuffer = vi.fn(async () => { throw new Error('arrayBuffer must not be called for provider errors'); }) as any;
      await expect(enhanceAudio(workspace, {
        inputPath,
        op: { ...enhanceOp, provider: 'elevenlabs-isolation' },
        clipSourceSha256: 'abc123',
        durationSec: 30,
        etvsDir: isolatedEtvsDir(root),
        fetchImpl: async () => response,
        env: { ELEVENLABS_API_KEY: 'env-key' }
      })).rejects.toThrow(/HTTP 500/);
      expect(response.arrayBuffer).not.toHaveBeenCalled();
      const failed = readProviderRequests(workspace).at(-1) as any;
      expect(failed.status).toBe('failed');
      expect(failed.error.length).toBeLessThan(2_500);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('enhanceAudio keeps cache hits before provider execution and writes bare-provider cached assets', async () => {
    const { root, workspace } = await workspaceWithAudio();
    try {
      const inputPath = join(workspace, 'media/extracted-audio.wav');
      const first = await enhanceAudio(workspace, { inputPath, op: { ...enhanceOp, provider: 'elevenlabs-isolation' }, clipSourceSha256: 'abc123', durationSec: 30, etvsDir: isolatedEtvsDir(root), env: { ETVS_PAID_PROVIDER_TEST_MODE: '1' } });
      expect(first.outputPath).toContain('/assets/enhanced/');
      expect(existsSync(first.outputPath)).toBe(true);
      const before = readProviderRequests(workspace).length;
      const second = await enhanceAudio(workspace, { inputPath, op: { ...enhanceOp, provider: 'elevenlabs-isolation' }, clipSourceSha256: 'abc123', durationSec: 30, etvsDir: isolatedEtvsDir(root), env: { ETVS_PAID_PROVIDER_TEST_MODE: '1' } });
      expect(second.cacheKey).toBe(first.cacheKey);
      expect(readProviderRequests(workspace)).toHaveLength(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('materializeAudioEnhance preserves legacy env credentials through the engine path', async () => {
    const root = tempRoot();
    const originalFetch = globalThis.fetch;
    try {
      const inputPath = join(root, 'input.wav');
      const outputPath = join(root, 'assets/enhanced/out.wav');
      writeFileSync(inputPath, Buffer.from('RIFF....WAVE'));
      // Response must be >= 1000 bytes to pass the byte-count floor.
      const pcmBytes = 960;
      const wavBuf = Buffer.alloc(44 + pcmBytes, 0);
      wavBuf.write('RIFF', 0); wavBuf.writeUInt32LE(36 + pcmBytes, 4); wavBuf.write('WAVE', 8);
      wavBuf.write('fmt ', 12); wavBuf.writeUInt32LE(16, 16); wavBuf.writeUInt16LE(1, 20);
      wavBuf.writeUInt16LE(1, 22); wavBuf.writeUInt32LE(48000, 24); wavBuf.writeUInt32LE(96000, 28);
      wavBuf.writeUInt16LE(2, 32); wavBuf.writeUInt16LE(16, 34); wavBuf.write('data', 36);
      wavBuf.writeUInt32LE(pcmBytes, 40);
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        // ElevenLabs Isolator uses xi-api-key (not Bearer Authorization).
        expect((init?.headers as Record<string, string>)['xi-api-key']).toBe('env-key');
        return new Response(wavBuf.buffer as ArrayBuffer, { status: 200 });
      });
      await materializeAudioEnhance({ inputPath, outputPath, op: enhanceOp, clipSourceSha256: 'abc123', durationSec: 30, fetchImpl, env: { ELEVENLABS_API_KEY: 'env-key' }, workspacePath: root, etvsDir: isolatedEtvsDir(root) });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally { (globalThis as any).fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
  });

  it('uses the primary video track consistently for v2 clip transcription', async () => {
    const root = tempRoot();
    const workspace = join(root, 'p');
    try {
      await createWorkspace({ workspacePath: workspace, projectId: 'p', title: 'P' });
      const project = loadProject(workspace);
      const clipSources = [
        { clipId: 'primary', path: 'primary.mp4', sha256: 'p', durationSec: 4, width: 1, height: 1, fps: 30, audioSampleRate: 16000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' }
      ];
      saveProject({ ...project, clipSources, status: { ...project.status, imported: true } });
      saveManifestV3(workspace, {
        ...defaultManifest('p'),
        assets: [{ assetId: 'asset_primary', kind: 'video', path: 'primary.mp4', durationSec: 4, provenance: 'imported', video: { width: 1, height: 1, fps: 30 }, audio: { sampleRate: 16000 } }],
        tracks: [
          { trackId: 'empty', kind: 'video', name: 'Empty', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [] },
          { trackId: 'primary-track', kind: 'video', name: 'Primary', order: 1, locked: false, muted: false, solo: false, hidden: false, clips: [{ clipId: 'primary', assetId: 'asset_primary', sourceStart: 0, sourceEnd: 4, timelineStart: 0 }] }
        ]
      }, { revision: false });
      await transcribeAudio(workspace, { provider: 'mock', clipId: 'primary', mockText: 'hello primary', etvsDir: isolatedEtvsDir(root) });
      const merged = await (await import('../transcript')).mergeTranscripts(workspace);
      expect(merged.words.map((word) => word.clipId)).toEqual(['primary', 'primary']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
