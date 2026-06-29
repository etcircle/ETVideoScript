import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProvider } from '../providers';
import { parseTimedWhisperResponse } from '../transcript';

function providerRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    id: 'stt.cartesia',
    kind: 'stt' as const,
    name: 'cartesia',
    tier: 'paid' as const,
    enabled: true,
    default: false,
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
    ...overrides
  };
}

function withAudio<T>(fn: (audioPath: string) => Promise<T> | T): Promise<T> | T {
  const root = mkdtempSync(join(tmpdir(), 'etvs-cartesia-stt-'));
  const audioPath = join(root, 'audio.wav');
  writeFileSync(audioPath, Buffer.from('RIFFfake-wav-bytes-for-upload'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    const result = fn(audioPath);
    return result instanceof Promise ? result.finally(cleanup) : (cleanup(), result);
  } catch (err) {
    cleanup();
    throw err;
  }
}

describe('stt.cartesia adapter (Ink-Whisper)', () => {
  it('posts /stt multipart with model ink-whisper + word granularity, and emits a parseable word-timed transcript', async () => {
    await withAudio(async (audioPath) => {
      const adapter = getProvider('stt.cartesia')! as any;
      const cartesiaResponse = {
        text: 'hello world',
        duration: 1.2,
        language: 'en',
        words: [
          { word: 'hello', start: 0.0, end: 0.5 },
          { word: 'world', start: 0.6, end: 1.1 }
        ]
      };
      let captured: any;
      const guardedFetch = vi.fn(async (url: string, opts: any) => { captured = { url, opts }; return new Response(JSON.stringify(cartesiaResponse), { status: 200 }); });
      const out = await adapter.run(
        { audioPath, audioRel: 'media/extracted-audio.wav', durationSec: 1.2 },
        { provider: providerRecord(), requestId: 'r', signal: new AbortController().signal, secret: 'sk_car_test', guardedFetch }
      );
      expect(captured.url).toBe('https://api.cartesia.ai/stt');
      expect(captured.opts.headers.Authorization).toBe('Bearer sk_car_test');
      expect(captured.opts.headers['Cartesia-Version']).toBe('2026-03-01');
      const form = captured.opts.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get('model')).toBe('ink-whisper');
      expect(form.get('timestamp_granularities[]')).toBe('word');
      expect(form.get('language')).toBe('en');
      expect(form.get('file')).toBeInstanceOf(Blob);

      // The native Cartesia word shape feeds parseTimedWhisperResponse directly; the model is surfaced.
      const doc = parseTimedWhisperResponse(out.rawJson, out.durationSec, 'req', 'clip1', 'cartesia');
      expect(doc).not.toBeNull();
      expect(doc!.words.map((w) => w.text)).toEqual(['hello', 'world']);
      expect(doc!.provider.model).toBe('ink-whisper');
      expect(out.providerStatus).toBe(200);
    });
  });

  it('summarizes the ledger output to word counts, never the raw word arrays', () => {
    const adapter = getProvider('stt.cartesia')! as any;
    const summary = adapter.ledgerOutput({
      rawJson: JSON.stringify({ words: [{ word: 'alpha', start: 0, end: 0.1 }, { word: 'beta', start: 0.2, end: 0.3 }], model: 'ink-whisper' }),
      originalJson: '{}',
      responseBytes: 80,
      durationSec: 0.3,
      providerStatus: 200,
      timing: 'provider-json'
    });
    expect(summary).toMatchObject({ wordCount: 2, timing: 'exact', providerStatus: 200 });
    expect(JSON.stringify(summary)).not.toContain('alpha');
  });

  it('throws provider_auth_failed without a secret and makes no network call', async () => {
    await withAudio(async (audioPath) => {
      const adapter = getProvider('stt.cartesia')! as any;
      const guardedFetch = vi.fn();
      await expect(adapter.run(
        { audioPath, audioRel: 'media/extracted-audio.wav', durationSec: 1 },
        { provider: providerRecord(), requestId: 'r', signal: new AbortController().signal, secret: '', guardedFetch }
      )).rejects.toMatchObject({ code: 'provider_auth_failed' });
      expect(guardedFetch).not.toHaveBeenCalled();
    });
  });

  it('surfaces a non-2xx with a bounded error body', async () => {
    await withAudio(async (audioPath) => {
      const adapter = getProvider('stt.cartesia')! as any;
      const guardedFetch = vi.fn(async () => new Response('nope '.repeat(2000), { status: 500 }));
      await expect(adapter.run(
        { audioPath, audioRel: 'media/extracted-audio.wav', durationSec: 1 },
        { provider: providerRecord(), requestId: 'r', signal: new AbortController().signal, secret: 's', guardedFetch }
      )).rejects.toThrow(/Cartesia Ink-Whisper failed with HTTP 500/);
    });
  });

  it('rejects a degraded HTTP 200 carrying an error envelope, even with a junk words[] alongside', async () => {
    await withAudio(async (audioPath) => {
      const adapter = getProvider('stt.cartesia')! as any;
      // Plain error envelope.
      await expect(adapter.run(
        { audioPath, audioRel: 'media/extracted-audio.wav', durationSec: 1 },
        { provider: providerRecord(), requestId: 'r', signal: new AbortController().signal, secret: 's', guardedFetch: vi.fn(async () => new Response(JSON.stringify({ error: 'audio too short' }), { status: 200 })) }
      )).rejects.toThrow(/error payload: audio too short/);
      // Bypass attempt: error + a non-empty-but-junk words[]. Must still be rejected as bad_request.
      await expect(adapter.run(
        { audioPath, audioRel: 'media/extracted-audio.wav', durationSec: 1 },
        { provider: providerRecord(), requestId: 'r', signal: new AbortController().signal, secret: 's', guardedFetch: vi.fn(async () => new Response(JSON.stringify({ error: 'quota exceeded', words: [{ word: '', start: 0, end: 0 }] }), { status: 200 })) }
      )).rejects.toMatchObject({ code: 'provider_bad_request' });
    });
  });

  // Edge cases for the adapter→parser boundary (Hermes P3): the adapter does no pre-validation,
  // so prove parseTimedWhisperResponse handles each shape safely.
  async function adaptAndParse(cartesiaResponse: unknown, durationSec = 2) {
    return withAudio(async (audioPath) => {
      const adapter = getProvider('stt.cartesia')! as any;
      const guardedFetch = vi.fn(async () => new Response(JSON.stringify(cartesiaResponse), { status: 200 }));
      const out = await adapter.run(
        { audioPath, audioRel: 'media/extracted-audio.wav', durationSec },
        { provider: providerRecord(), requestId: 'r', signal: new AbortController().signal, secret: 's', guardedFetch }
      );
      return parseTimedWhisperResponse(out.rawJson, out.durationSec, 'req', 'clip1', 'cartesia');
    });
  }

  it('preserves a non-en language returned by Cartesia (fallback only fills a missing one)', async () => {
    const doc = await adaptAndParse({ text: 'bonjour le monde', duration: 1.2, language: 'fr', words: [{ word: 'bonjour', start: 0, end: 0.6 }, { word: 'monde', start: 0.7, end: 1.1 }] });
    expect(doc).not.toBeNull();
    expect(doc!.language).toBe('fr');
  });

  it('returns null (→ caller throws) for an empty words[] rather than a bogus transcript', async () => {
    const doc = await adaptAndParse({ text: '', duration: 1, language: 'en', words: [] });
    expect(doc).toBeNull();
  });

  it('drops words with invalid timing (start >= end), keeping valid ones', async () => {
    const doc = await adaptAndParse({ text: 'ok bad', duration: 1, language: 'en', words: [{ word: 'ok', start: 0, end: 0.4 }, { word: 'bad', start: 0.9, end: 0.9 }] });
    expect(doc).not.toBeNull();
    expect(doc!.words.map((w) => w.text)).toEqual(['ok']);
  });
});
