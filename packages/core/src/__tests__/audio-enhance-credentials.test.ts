import { describe, expect, it, vi } from 'vitest';
import { usePaidTransportStubbingGlobalFetch } from './paidTransportTestSetup';
usePaidTransportStubbingGlobalFetch();
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeAudioEnhance } from '../audioEnhance';
import { setProviderSecret, upsertProvider } from '../providerSettings';

const paidOp = {
  id: 'op_audio_enhance_0001',
  type: 'audio_enhance' as const,
  status: 'approved',
  clipId: 'clip_001',
  start: 0,
  end: 30,
  provider: 'elevenlabs-isolation' as const,
  profile: 'podcast' as const,
  filterChainVersion: 0,
  intensity: 0.6,
  createdBy: 'user',
  createdAt: '2026-05-15T00:00:00.000Z'
};

function headerValue(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null;
  return (headers as Record<string, string> | undefined)?.[name] ?? null;
}

// Minimal response body that passes the byte-count floor in paidStudioSoundProvider.
// Must be >= 1000 bytes. We use a real minimal WAV header + silence data.
function minimalWavResponse(): Uint8Array {
  // 1000+ byte WAV: RIFF header (44 bytes) + 960 bytes of silence (100ms @ 48kHz mono 16-bit)
  const pcmBytes = 960;
  const buf = Buffer.alloc(44 + pcmBytes, 0);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcmBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(48000, 24); buf.writeUInt32LE(96000, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
  buf.writeUInt32LE(pcmBytes, 40);
  return new Uint8Array(buf);
}

describe('audio enhance paid credentials', () => {
  it('uses the configured secrets store credential before legacy env vars', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvs-enhance-secret-store-'));
    const originalWrite = process.stderr.write;
    try {
      const inputPath = join(root, 'input.wav');
      const outputPath = join(root, 'enhanced.wav');
      writeFileSync(inputPath, Buffer.from('RIFF....WAVE'));
      upsertProvider({
        homeDir: root,
        provider: {
          id: 'studio-sound.elevenlabs-isolation',
          kind: 'studio-sound',
          name: 'elevenlabs-isolation',
          tier: 'paid',
          secretRef: 'elevenlabs-primary'
        }
      });
      setProviderSecret({ homeDir: root, secretRef: 'elevenlabs-primary', value: 'stored-key' });
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      // Use a response large enough to pass the byte-count floor (>= 1000 bytes).
      const fetchImpl = vi.fn(async () => new Response(minimalWavResponse().buffer as ArrayBuffer, { status: 200 }));

      await materializeAudioEnhance({
        inputPath,
        outputPath,
        op: paidOp,
        clipSourceSha256: 'abc123',
        durationSec: 30,
        fetchImpl,
        env: { ELEVENLABS_API_KEY: 'env-key' },
        homeDir: root
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const firstCall = fetchImpl.mock.calls[0] as unknown as [string | URL | Request, RequestInit | undefined];
      // ElevenLabs Isolator uses xi-api-key header (not Bearer Authorization).
      expect(headerValue(firstCall[1], 'xi-api-key')).toBe('stored-key');
    } finally {
      process.stderr.write = originalWrite;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the legacy env var when no stored secret exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvs-enhance-env-fallback-'));
    const originalWrite = process.stderr.write;
    try {
      const inputPath = join(root, 'input.wav');
      const outputPath = join(root, 'enhanced.wav');
      writeFileSync(inputPath, Buffer.from('RIFF....WAVE'));
      upsertProvider({
        homeDir: root,
        provider: {
          id: 'studio-sound.elevenlabs-isolation',
          kind: 'studio-sound',
          name: 'elevenlabs-isolation',
          tier: 'paid',
          secretRef: 'missing-secret'
        }
      });
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      // Use a response large enough to pass the byte-count floor (>= 1000 bytes).
      const fetchImpl = vi.fn(async () => new Response(minimalWavResponse().buffer as ArrayBuffer, { status: 200 }));

      await materializeAudioEnhance({
        inputPath,
        outputPath,
        op: paidOp,
        clipSourceSha256: 'abc123',
        durationSec: 30,
        fetchImpl,
        env: { ELEVENLABS_API_KEY: 'env-key' },
        homeDir: root
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const firstCall = fetchImpl.mock.calls[0] as unknown as [string | URL | Request, RequestInit | undefined];
      // ElevenLabs Isolator uses xi-api-key header (not Bearer Authorization).
      expect(headerValue(firstCall[1], 'xi-api-key')).toBe('env-key');
    } finally {
      process.stderr.write = originalWrite;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
