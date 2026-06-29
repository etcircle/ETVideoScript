import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendProviderRequestEvent, readProviderRequests } from '../providerRequests';

function validEvent(requestId: string) {
  return {
    requestId,
    projectId: 'episode-001',
    provider: 'mock',
    voice: 'eve',
    language: 'en',
    textHash: `${requestId}-text-hash`,
    bodyHash: `${requestId}-body-hash`,
    operationId: `op-${requestId}`,
    status: 'pending' as const,
    createdAt: '2026-05-14T12:00:00.000Z'
  };
}

describe('provider request audit log reads', () => {
  it('returns valid provider request events and warns once for invalid legacy lines', () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-provider-requests-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mkdirSync(join(root, 'logs'), { recursive: true });
      const first = validEvent('request_001');
      const second = validEvent('request_002');
      writeFileSync(join(root, 'logs/provider-requests.jsonl'), [
        JSON.stringify(first),
        JSON.stringify({ requestId: 'transcribe_1778706771185', type: 'transcription', provider: 'homelab-whisper', model: 'homelab-whisper', status: 'succeeded', input: { audio: 'media/extracted-audio.wav', timingRequired: 'word' }, output: { transcript: 'transcript/words.json', timing: 'approximate' }, cost: { currency: 'USD', estimated: 0, actual: 0 } }),
        '{not-json',
        JSON.stringify(second)
      ].join('\n'));

      expect(readProviderRequests(root)).toEqual([first, second]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/Skipped 2 invalid provider request/);
      expect(warn.mock.calls[0]?.[0]).toContain(root);
    } finally {
      warn.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps appendProviderRequestEvent strict for malformed events', () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-provider-requests-'));
    try {
      expect(() => appendProviderRequestEvent(root, { ...validEvent('request_003'), bodyHash: undefined } as any)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
