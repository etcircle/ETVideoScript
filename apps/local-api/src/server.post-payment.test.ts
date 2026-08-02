import { describe, expect, it, vi } from 'vitest';
import { usePaidTransportStubbingGlobalFetch } from './paidTransportTestSetup';
usePaidTransportStubbingGlobalFetch();
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createApp } from './server';

// Post-payment failure harness: the provider call SUCCEEDS (ledger row 'succeeded'),
// then the next step throws a raw Error carrying a string .code. Node fs errors
// (ENOENT) satisfy a loose `'code' in err` guard; an Error whose .code happens to be
// a protocol-VALID enum value ('internal_error') even satisfies a non-strict schema
// parse. Either misread skips op rollback, skips the sticky record (paid retry
// re-executes!), and emits a malformed envelope — the sticky JSON round-trip would
// also drop Error's non-enumerable .message. This file pins the strict-guard contract
// for BOTH imposters. The mock targets ffprobeDurationSecOrZero (the first
// post-synthesis step in the agent path); everything else passes through to the real
// core module; each test installs its own error factory.
let makePostSynthesisError: (filePath: string) => Error;
vi.mock('@etvideoscript/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@etvideoscript/core')>();
  return {
    ...mod,
    ffprobeDurationSecOrZero: vi.fn((filePath: string) => { throw makePostSynthesisError(filePath); })
  };
});

import { defaultManifest, loadManifestV3, loadProject, saveManifestV3, saveProject, setProviderSecret, upsertProvider, writeTranscript, wordsFromPlainText } from '@etvideoscript/core';

function config(root: string, overrides = {}) {
  return { host: '127.0.0.1', port: 0, workspaceRoot: root, enableTerminal: false, allowedOrigins: ['http://127.0.0.1:4318'], lanOrigins: [], terminalToken: null, ...overrides };
}

// Audible tone so the payload survives silence-trim — the failure under test is the
// fs error AFTER a fully successful synthesis, not a degraded payload.
function toneWav(durationSec: number): Buffer {
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
  for (let i = 0; i < samples; i += 1) {
    const fade = Math.min(i / 800, (samples - i) / 800, 1);
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 2400 * Math.max(fade, 0)), 44 + i * 2);
  }
  return buffer;
}

// Shared scenario: synthesize successfully, fail the first post-synthesis step with
// `makeError`, then assert the strict-guard contract end to end (wrapped envelope,
// rollback, audit row, sticky no-recharge retry).
async function runPostPaymentScenario(requestId: string, makeError: (filePath: string) => Error, expectFragment: string) {
  makePostSynthesisError = makeError;
  {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-agent-postpay-'));
    const app = createApp(config(root, { enableAgent: true, terminalToken: 'test-token' }));
    const audio = toneWav(1);
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('HOME', root);
    upsertProvider({ homeDir: root, provider: { id: 'tts.xai', kind: 'tts', name: 'xai', tier: 'paid', enabled: true, default: false, secretRef: 'xai-test' } });
    setProviderSecret({ homeDir: root, secretRef: 'xai-test', value: 'test-xai-key' });
    let ws: WebSocket | null = null;
    try {
      await app.inject({ method: 'POST', url: '/api/projects', payload: { projectId: 'episode-001', title: 'Episode 001' } });
      const workspace = join(root, 'episode-001');
      const project = loadProject(workspace);
      saveProject({ ...project, clipSources: [{ clipId: 'clip_001', path: 'input/source.mp4', originalFilename: 'source.mp4', sha256: 'test', durationSec: 30, width: 1920, height: 1080, fps: 30, audioSampleRate: 48000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' }], status: { ...project.status, imported: true } });
      saveManifestV3(workspace, {
        ...defaultManifest('episode-001'),
        assets: [{ assetId: 'asset_video_001', kind: 'video', path: 'input/source.mp4', durationSec: 30, provenance: 'imported', video: { width: 1920, height: 1080, fps: 30, codec: 'h264', pixelFormat: 'yuv420p' }, audio: { sampleRate: 48000, codec: 'aac' } }],
        tracks: [{ trackId: 'track_video_001', kind: 'video', name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 30, timelineStart: 0 }] }]
      }, { revision: false });
      writeTranscript(workspace, wordsFromPlainText('replace these words now', 4));

      await app.listen({ host: '127.0.0.1', port: 0 });
      const port = (app.server.address() as AddressInfo).port;
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws/projects/episode-001/agent/test-session?token=test-token`, { headers: { origin: 'http://127.0.0.1:4318' } });
      await new Promise<void>((resolve, reject) => { ws!.once('open', () => resolve()); ws!.once('error', reject); });
      const buffered: any[] = [];
      const waiters: Array<(value: any) => void> = [];
      ws.on('message', (data) => {
        const value = JSON.parse(String(data));
        const waiter = waiters.shift();
        if (waiter) waiter(value);
        else buffered.push(value);
      });
      const recv = () => new Promise<any>((resolve) => {
        const value = buffered.shift();
        if (value) resolve(value);
        else waiters.push(resolve);
      });

      ws.send(JSON.stringify({ kind: 'hello', id: 'hello-1', protocolVersion: 3, agent: { name: 'vitest' } }));
      await recv();
      const callParams = { requestId, type: 'voice_patch', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 0, end: 1 }, text: 'paid words', provider: 'xai', voice: 'eve' };
      ws.send(JSON.stringify({ kind: 'tool_call', id: `${requestId}-call-1`, protocolVersion: 3, tool: 'propose_operation', params: callParams }));
      const failed = await recv();
      // Well-formed protocol envelope, not a raw thrown Error: the failure must be wrapped.
      expect(failed.kind).toBe('tool_error');
      expect(failed.error.code).toBe('paid_provider_failed');
      expect(failed.error.status).toBe(500);
      expect(failed.error.message).toContain(expectFragment);
      // Op rolled back — not stranded in 'proposed'.
      const op = loadManifestV3(workspace).operations.find((candidate: any) => candidate.providerRequestId === requestId) as any;
      expect(op?.status).toBe('rejected');
      // Money was spent (provider row 'succeeded') and the attach failed — audit row present.
      const lines = readFileSync(join(workspace, 'logs/provider-requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.filter((line) => line.requestId === requestId).map((line) => line.status)).toEqual(['approved', 'started', 'succeeded', 'op_update_failed']);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Sticky: retrying the same requestId replays the stored terminal error and must
      // NOT re-execute the paid provider.
      ws.send(JSON.stringify({ kind: 'tool_call', id: `${requestId}-call-2`, protocolVersion: 3, tool: 'propose_operation', params: callParams }));
      const replayed = await recv();
      expect(replayed.kind).toBe('tool_error');
      expect(replayed.error.code).toBe('paid_provider_failed');
      expect(replayed.error.message).toContain(expectFragment);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      ws?.close();
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
}

describe('agent voice_patch post-payment failure (strict ToolError guard)', () => {
  it('wraps a Node ENOENT after paid success into a proper tool_error, rolls the op back, and stays sticky', async () => {
    await runPostPaymentScenario('req-xai-postpay-1', (filePath) => {
      const err = new Error(`ENOENT: no such file or directory, stat '${filePath}'`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      err.errno = -2;
      return err;
    }, 'ENOENT');
  });

  it('rejects an Error imposter whose .code is a protocol-valid enum value ("internal_error")', async () => {
    // ToolErrorSchema is a non-strict z.object; without the instanceof exclusion this
    // Error would parse as a protocol envelope — passing through raw (skipping the
    // rollback + sticky record) and losing its non-enumerable .message on the sticky
    // JSON round-trip.
    await runPostPaymentScenario('req-xai-postpay-2', () =>
      Object.assign(new Error('boom after payment'), { code: 'internal_error', status: 500, errno: -2, path: '/x' }), 'boom after payment');
  });
});
