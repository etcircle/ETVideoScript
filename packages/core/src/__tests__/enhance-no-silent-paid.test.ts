import { describe, expect, it, vi } from 'vitest';
import { usePaidTransportStubbingGlobalFetch } from './paidTransportTestSetup';
usePaidTransportStubbingGlobalFetch();
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeAudioEnhance } from '../audioEnhance';

// Minimal WAV response (>= 1000 bytes) that passes the byte-count floor.
function minimalWavResponse(): Uint8Array {
  const pcmBytes = 960;
  const buf = Buffer.alloc(44 + pcmBytes, 0);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcmBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(48000, 24); buf.writeUInt32LE(96000, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
  buf.writeUInt32LE(pcmBytes, 40);
  return new Uint8Array(buf);
}

describe('audio enhance paid disclosure fallback', () => {
  it('writes cost disclosure to stderr before paid HTTP when no sink is supplied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvs-enhance-no-silent-paid-'));
    const originalWrite = process.stderr.write;
    try {
      const inputPath = join(root, 'input.wav');
      const outputPath = join(root, 'enhanced.wav');
      writeFileSync(inputPath, Buffer.from('RIFF....WAVE'));
      const events: string[] = [];
      const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        events.push(`stderr:${String(chunk)}`);
        return true;
      }) as typeof process.stderr.write);
      const fetchImpl = vi.fn(async () => {
        events.push('fetch');
        return new Response(minimalWavResponse().buffer as ArrayBuffer, { status: 200 });
      });

      await materializeAudioEnhance({
        inputPath,
        outputPath,
        op: {
          id: 'op_audio_enhance_0001',
          type: 'audio_enhance',
          status: 'approved',
          clipId: 'clip_001',
          start: 0,
          end: 30,
          provider: 'elevenlabs-isolation',
          profile: 'podcast',
          filterChainVersion: 0,
          intensity: 0.6,
          createdBy: 'user',
          createdAt: '2026-05-15T00:00:00.000Z'
        },
        clipSourceSha256: 'abc123',
        durationSec: 30,
        fetchImpl,
        env: { ELEVENLABS_API_KEY: 'test-key' }
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(stderrWrite).toHaveBeenCalledTimes(1);
      expect(events[0]).toMatch(/^stderr:\[paid\] ElevenLabs Isolation — ~\$/);
      expect(events[1]).toBe('fetch');
    } finally {
      process.stderr.write = originalWrite;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still writes paid stderr disclosure before fetch when an explicit no-op sink and ETVS_HIDE_COST are supplied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvs-enhance-additive-paid-'));
    const originalWrite = process.stderr.write;
    try {
      const inputPath = join(root, 'input.wav');
      const outputPath = join(root, 'enhanced.wav');
      writeFileSync(inputPath, Buffer.from('RIFF....WAVE'));
      const events: string[] = [];
      const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        events.push(`stderr:${String(chunk)}`);
        return true;
      }) as typeof process.stderr.write);
      const fetchImpl = vi.fn(async () => {
        events.push('fetch');
        return new Response(minimalWavResponse().buffer as ArrayBuffer, { status: 200 });
      });

      await materializeAudioEnhance({
        inputPath,
        outputPath,
        op: {
          id: 'op_audio_enhance_0002',
          type: 'audio_enhance',
          status: 'approved',
          clipId: 'clip_001',
          start: 0,
          end: 30,
          provider: 'elevenlabs-isolation',
          profile: 'podcast',
          filterChainVersion: 0,
          intensity: 0.6,
          createdBy: 'user',
          createdAt: '2026-05-15T00:00:00.000Z'
        },
        clipSourceSha256: 'abc123',
        durationSec: 30,
        onCostDisclosure: () => {},
        fetchImpl,
        env: { ELEVENLABS_API_KEY: 'test-key', ETVS_HIDE_COST: '1' }
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(stderrWrite).toHaveBeenCalledTimes(1);
      expect(events[0]).toMatch(/^stderr:\[paid\] ElevenLabs Isolation — ~\$/);
      expect(events[1]).toBe('fetch');
    } finally {
      process.stderr.write = originalWrite;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
