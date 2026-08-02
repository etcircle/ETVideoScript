import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePaidTransportStubbingGlobalFetch } from './paidTransportTestSetup';
usePaidTransportStubbingGlobalFetch();
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProvider, runProvider, type SttElevenlabsScribeOutput } from '../providers';
import { setProviderSecret, upsertProvider, type ProviderRecord } from '../providerSettings';

const originalFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
  vi.restoreAllMocks();
});

function tempRoot() { return mkdtempSync(join(tmpdir(), 'etvs-elevenlabs-scribe-')); }
function audioPath(root: string, sizeBytes = 16) {
  const path = join(root, 'audio.wav');
  writeFileSync(path, Buffer.alloc(sizeBytes, 0));
  return path;
}
function record(costPerUnit?: ProviderRecord['costPerUnit']): ProviderRecord {
  const now = new Date().toISOString();
  return { schemaVersion: 1, id: 'stt.elevenlabs', kind: 'stt', name: 'elevenlabs', tier: 'paid', enabled: true, default: false, createdAt: now, updatedAt: now, ...(costPerUnit ? { costPerUnit } : {}) };
}
function configure(root: string, costPerUnit?: ProviderRecord['costPerUnit']) {
  upsertProvider({ homeDir: root, provider: { ...record(costPerUnit), secretRef: 'elevenlabs-test' } });
  setProviderSecret({ homeDir: root, secretRef: 'elevenlabs-test', value: 'test-eleven-key' });
}

const scribeResponseJson = JSON.stringify({
  text: 'hello world [laughter] test',
  language_code: 'eng',
  language_probability: 0.95,
  words: [
    { text: 'hello', start: 0.0, end: 0.5, type: 'word', logprob: -0.1, speaker_id: 'speaker_0' },
    { text: 'world', start: 0.6, end: 1.1, type: 'word', logprob: -0.15, speaker_id: 'speaker_0' },
    { text: '[laughter]', start: 1.2, end: 1.5, type: 'audio_event' },
    { text: 'test', start: 1.6, end: 2.0, type: 'word', logprob: -0.08, speaker_id: 'speaker_0' }
  ]
});

async function runScribe(root: string, input: Record<string, unknown> = {}) {
  return runProvider({
    homeDir: root,
    workspacePath: root,
    kind: 'stt',
    providerId: 'elevenlabs',
    requestType: 'transcription',
    input: { audioPath: audioPath(root), audioRel: 'media/extracted-audio.wav', durationSec: 60, ...input },
    env: {}
  });
}

function formEntries(init: RequestInit): Array<[string, FormDataEntryValue]> {
  // FormData.entries() exists at runtime (Node 18+) but isn't always in TS lib defaults.
  return Array.from((init.body as any).entries());
}

describe('ElevenLabs Scribe provider', () => {
  it('posts speech-to-text requests with xi-api-key, scribe_v2 default, and event tags off', async () => {
    const root = tempRoot();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    (globalThis as any).fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(scribeResponseJson, { status: 200 });
    });
    try {
      configure(root);
      const envelope = await runScribe(root);
      expect(envelope.ok).toBe(true);
      expect(calls[0]!.url).toMatch(/\/v1\/speech-to-text$/);
      expect(new Headers(calls[0]!.init.headers).get('xi-api-key')).toBe('test-eleven-key');
      const entries = formEntries(calls[0]!.init);
      const fieldValue = (name: string) => entries.find(([k]) => k === name)?.[1];
      expect(fieldValue('model_id')).toBe('scribe_v2');
      expect(fieldValue('timestamps_granularity')).toBe('word');
      expect(fieldValue('tag_audio_events')).toBe('false');
      expect(fieldValue('diarize')).toBe('false');
      // File field is a Blob, not a plain string.
      const file = fieldValue('file');
      expect(file).toBeInstanceOf(Blob);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('filters audio_event tokens, preserves word onsets, and maps logprob to probability', async () => {
    const root = tempRoot();
    (globalThis as any).fetch = vi.fn(async () => new Response(scribeResponseJson, { status: 200 }));
    try {
      configure(root);
      const envelope = await runScribe(root);
      expect(envelope.ok).toBe(true);
      if (!envelope.ok) return;
      const output = envelope.output as SttElevenlabsScribeOutput;
      const adapted = JSON.parse(output.rawJson);
      expect(adapted.words).toHaveLength(3);
      expect(adapted.words.map((w: any) => w.text)).toEqual(['hello', 'world', 'test']);
      // Onsets must not shift after the audio_event is removed.
      expect(adapted.words[0].start).toBe(0.0);
      expect(adapted.words[1].start).toBe(0.6);
      expect(adapted.words[2].start).toBe(1.6);
      // logprob -0.1 → Math.exp(-0.1) ≈ 0.9048.
      expect(adapted.words[0].probability).toBeCloseTo(Math.exp(-0.1), 5);
      expect(adapted.words[1].probability).toBeCloseTo(Math.exp(-0.15), 5);
      expect(adapted.words[2].probability).toBeCloseTo(Math.exp(-0.08), 5);
      // [laughter] must be stripped from the synthesized segment text.
      expect(adapted.text).toBe('hello world test');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves the original Scribe response alongside the adapted JSON', async () => {
    const root = tempRoot();
    (globalThis as any).fetch = vi.fn(async () => new Response(scribeResponseJson, { status: 200 }));
    try {
      configure(root);
      const envelope = await runScribe(root);
      expect(envelope.ok).toBe(true);
      if (!envelope.ok) return;
      const output = envelope.output as SttElevenlabsScribeOutput;
      const original = JSON.parse(output.originalJson);
      // Original keeps the audio_event entry and speaker_id metadata.
      expect(original.words).toHaveLength(4);
      expect(original.words[2]).toMatchObject({ type: 'audio_event', text: '[laughter]' });
      expect(original.words[0].speaker_id).toBe('speaker_0');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('passes a requested model override', async () => {
    const root = tempRoot();
    let captured: RequestInit | null = null;
    (globalThis as any).fetch = vi.fn(async (_url, init) => {
      captured = init!;
      return new Response(scribeResponseJson, { status: 200 });
    });
    try {
      configure(root);
      const envelope = await runScribe(root, { model: 'scribe_v1' });
      expect(envelope.ok).toBe(true);
      const fieldValue = (name: string) => formEntries(captured!).find(([k]) => k === name)?.[1];
      expect(fieldValue('model_id')).toBe('scribe_v1');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails before fetch when no ElevenLabs secret is configured', async () => {
    const root = tempRoot();
    const fetchImpl = vi.fn();
    (globalThis as any).fetch = fetchImpl;
    try {
      const envelope = await runScribe(root);
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) expect(envelope.error.code).toBe('provider_auth_failed');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails before fetch when audio exceeds the upload cap', async () => {
    const root = tempRoot();
    const fetchImpl = vi.fn();
    (globalThis as any).fetch = fetchImpl;
    try {
      configure(root);
      // 501 MB is just over the cap (500 MB). Writing the whole file would be wasteful; use the
      // sparse file trick — writeFileSync with a buffer is fine since the size check uses statSync.
      const path = join(root, 'huge.wav');
      writeFileSync(path, Buffer.alloc(1));
      // Truncate-via-write to grow the file cheaply on macOS/Linux.
      const fs = await import('node:fs');
      const fd = fs.openSync(path, 'r+');
      fs.ftruncateSync(fd, 501 * 1024 * 1024);
      fs.closeSync(fd);
      const envelope = await runProvider({
        homeDir: root, workspacePath: root, kind: 'stt', providerId: 'elevenlabs',
        requestType: 'transcription',
        input: { audioPath: path, audioRel: 'media/extracted-audio.wav', durationSec: 1800 },
        env: {}
      });
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) {
        expect(envelope.error.code).toBe('provider_bad_request');
        expect(envelope.error.message).toMatch(/Scribe upload cap/);
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('surfaces ElevenLabs HTTP 401 failures with status and bounded body', async () => {
    const root = tempRoot();
    (globalThis as any).fetch = vi.fn(async () => new Response('invalid api key', { status: 401 }));
    try {
      configure(root);
      const envelope = await runScribe(root);
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) {
        expect(envelope.error.statusCode).toBe(401);
        expect(envelope.error.message).toContain('invalid api key');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('surfaces empty successful responses as provider errors', async () => {
    const root = tempRoot();
    (globalThis as any).fetch = vi.fn(async () => new Response('', { status: 200 }));
    try {
      configure(root);
      const envelope = await runScribe(root);
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) expect(envelope.error.message).toContain('empty response');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('surfaces malformed JSON 200 responses as provider errors', async () => {
    const root = tempRoot();
    (globalThis as any).fetch = vi.fn(async () => new Response('<!DOCTYPE html><html>maintenance</html>', { status: 200 }));
    try {
      configure(root);
      const envelope = await runScribe(root);
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) expect(envelope.error.message).toContain('malformed JSON');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('estimates ElevenLabs Scribe cost by audio minutes at $0.003667/min', () => {
    const adapter = getProvider('stt.elevenlabs')!;
    const cost = adapter.estimateCost({ audioPath: '/tmp/audio.wav', audioRel: 'media/extracted-audio.wav', durationSec: 60 } as any, record());
    expect(cost.currency).toBe('USD');
    expect(cost.actual).toBeNull();
    expect(cost.estimated).toBeCloseTo(0.003667, 6);
  });

  it('uses provider costPerUnit as a per-minute override', () => {
    const adapter = getProvider('stt.elevenlabs')!;
    const provider = record({ currency: 'USD', unit: 'minute', amount: 0.01 });
    const input = { audioPath: '/tmp/audio.wav', audioRel: 'media/extracted-audio.wav', durationSec: 120 } as any;
    expect(adapter.estimateCost(input, provider)).toMatchObject({ estimated: 0.02, actual: null });
    expect(adapter.actualCost!({ rawJson: '{}', originalJson: '{}', responseBytes: 2, durationSec: 120, providerStatus: 200, timing: 'provider-json' } as any, input, provider))
      .toMatchObject({ estimated: 0.02, actual: 0.02 });
  });
});
