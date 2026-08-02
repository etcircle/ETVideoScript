import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The paid-idempotency ledger must be DURABLE: a 'started' row written before a paid call is the
// only thing that stops a retry from re-billing it, and appendFileSync alone leaves that row in
// the page cache. Spying on fsync needs a module mock — an ESM namespace object is frozen, so it
// cannot be patched in place — which is why this lives in its own file.
const fsyncCalls: number[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    fsyncSync: (fd: number) => { fsyncCalls.push(fd); return actual.fsyncSync(fd); }
  };
});

const { appendVoicePatchStepRecord, voicePatchStepRecordId, voicePatchStepState } = await import('../providerRequests');

describe('paid ledger durability', () => {
  it('fsyncs every append, so a crash cannot lose the record that prevents a second charge', () => {
    const ws = mkdtempSync(join(tmpdir(), 'etvs-ledger-durability-'));
    mkdirSync(join(ws, 'logs'), { recursive: true });
    try {
      fsyncCalls.length = 0;
      appendVoicePatchStepRecord(ws, {
        recordKind: 'voice-patch-step',
        requestId: voicePatchStepRecordId('parent-request-id', 'tts'),
        parentRequestId: 'parent-request-id',
        step: 'tts', projectId: 'p', operationId: 'op_1',
        provider: 'tts.elevenlabs', status: 'started',
        createdAt: new Date().toISOString()
      });
      expect(fsyncCalls.length).toBeGreaterThan(0);
      // ...and the record is genuinely readable afterwards (the fsync did not replace the write).
      expect(voicePatchStepState(ws, 'parent-request-id', 'tts').started).toBe(true);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
});
