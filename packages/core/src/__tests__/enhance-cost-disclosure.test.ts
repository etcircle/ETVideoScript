import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeAudioEnhance } from '../audioEnhance';

describe('audio enhance paid cost disclosure', () => {
  it('logs cost disclosure before the paid HTTP request fires', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvs-enhance-paid-'));
    const originalWrite = process.stderr.write;
    try {
      const inputPath = join(root, 'input.wav');
      const outputPath = join(root, 'enhanced.wav');
      writeFileSync(inputPath, Buffer.from('RIFF....WAVE'));
      const events: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        events.push(`stderr:${String(chunk)}`);
        return true;
      }) as typeof process.stderr.write);
      const onCostDisclosure = (message: string) => events.push(`log:${message}`);
      // Response must be >= 1000 bytes to pass the byte-count floor.
      const pcmBytes = 960;
      const wavBuf = Buffer.alloc(44 + pcmBytes, 0);
      wavBuf.write('RIFF', 0); wavBuf.writeUInt32LE(36 + pcmBytes, 4); wavBuf.write('WAVE', 8);
      wavBuf.write('fmt ', 12); wavBuf.writeUInt32LE(16, 16); wavBuf.writeUInt16LE(1, 20);
      wavBuf.writeUInt16LE(1, 22); wavBuf.writeUInt32LE(48000, 24); wavBuf.writeUInt32LE(96000, 28);
      wavBuf.writeUInt16LE(2, 32); wavBuf.writeUInt16LE(16, 34); wavBuf.write('data', 36);
      wavBuf.writeUInt32LE(pcmBytes, 40);
      const fetchImpl = vi.fn(async () => {
        events.push('fetch');
        return new Response(wavBuf.buffer as ArrayBuffer, { status: 200 });
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
        onCostDisclosure,
        fetchImpl,
        env: { ELEVENLABS_API_KEY: 'test-key' }
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(events[0]).toMatch(/^stderr:\[paid\] ElevenLabs Isolation — ~\$/);
      expect(events[1]).toMatch(/^log:ElevenLabs Isolation — ~\$/);
      expect(events[2]).toBe('fetch');
    } finally {
      process.stderr.write = originalWrite;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
