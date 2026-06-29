import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { summarizeProviderRequests, summarizeProviderRequestsForWorkspace } from '../providerRequests';

function legacy(status: 'pending' | 'approved' | 'called' | 'succeeded' | 'failed' | 'rejected' = 'succeeded') {
  return {
    requestId: 'legacy_001',
    projectId: 'episode-001',
    provider: 'xai',
    voice: 'eve',
    language: 'en',
    textHash: 'text-hash',
    bodyHash: 'body-hash',
    operationId: 'voice_patch_001',
    status,
    createdAt: '2026-05-14T12:00:00.000Z',
    completedAt: '2026-05-14T12:00:05.000Z',
    durationGeneratedSec: 4.8,
    durationRequestedSec: 5
  } as const;
}

function generic(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'generic_001',
    type: 'audio_enhance',
    projectId: 'episode-001',
    provider: 'elevenlabs-isolation',
    voice: '',
    language: '',
    bodyHash: 'generic-body-hash',
    status: 'succeeded',
    operationId: 'audio_enhance_001',
    createdAt: '2026-05-14T13:00:00.000Z',
    completedAt: '2026-05-14T13:00:09.000Z',
    cost: { currency: 'USD', estimated: 0.05, actual: 0.08 },
    providerStatus: 200,
    durationRequestedSec: 30,
    ...overrides
  } as const;
}

describe('provider request cost summary', () => {
  it('aggregates mixed legacy and generic ledger rows with divergence, totals, and unknown-cost reasons', () => {
    const summary = summarizeProviderRequests([
      legacy(),
      generic(),
      generic({ requestId: 'generic_002', status: 'failed', createdAt: '2026-05-14T13:05:00.000Z', completedAt: '2026-05-14T13:05:09.000Z', cost: { currency: 'USD', estimated: 0.02, actual: null }, providerStatus: 502 })
    ]);

    expect(summary.rows).toHaveLength(3);
    expect(summary.rows.map((row) => row.requestId)).toEqual(['generic_002', 'generic_001', 'legacy_001']);
    expect(summary.rows[0]).toMatchObject({
      requestId: 'generic_002',
      actualCost: null,
      whyCostUnknown: 'actual-cost-missing'
    });
    expect(summary.rows[1]).toMatchObject({
      requestId: 'generic_001',
      provider: 'elevenlabs-isolation',
      requestType: 'audio_enhance',
      status: 'succeeded',
      estimatedCost: 0.05,
      actualCost: 0.08,
      costDiverged: true,
      providerStatus: 200,
      whyCostUnknown: null
    });
    expect(summary.rows[2]).toMatchObject({
      requestId: 'legacy_001',
      provider: 'xai',
      requestType: 'voice_patch',
      status: 'succeeded',
      estimatedCost: null,
      actualCost: null,
      costDiverged: false,
      duration: { generatedSec: 4.8, requestedSec: 5, unit: 'seconds' },
      timestamp: '2026-05-14T12:00:05.000Z',
      sourceAction: 'voice_patch_001',
      whyCostUnknown: 'legacy/no-cost-record'
    });
    expect(summary.totalsByProvider).toEqual([
      { provider: 'elevenlabs-isolation', currency: 'USD', estimatedTotal: 0.07, actualTotal: 0.08, count: 2 },
      { provider: 'xai', currency: 'USD', estimatedTotal: 0, actualTotal: 0, count: 1 }
    ]);
  });

  it('collapses lifecycle transition events into one non-doubled request summary', () => {
    const summary = summarizeProviderRequests([
      generic({
        requestId: 'audio_lifecycle_001',
        status: 'started',
        createdAt: '2026-05-14T14:00:00.000Z',
        completedAt: undefined,
        cost: { currency: 'USD', estimated: 0.05, actual: null },
        providerStatus: undefined
      }),
      generic({
        requestId: 'audio_lifecycle_001',
        status: 'succeeded',
        createdAt: '2026-05-14T14:00:10.000Z',
        completedAt: '2026-05-14T14:00:11.000Z',
        cost: { currency: 'USD', estimated: null, actual: 0.04 },
        providerStatus: 200,
        durationGeneratedSec: 29.5
      })
    ]);

    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]).toMatchObject({
      requestId: 'audio_lifecycle_001',
      status: 'succeeded',
      estimatedCost: 0.05,
      actualCost: 0.04,
      timestamp: '2026-05-14T14:00:11.000Z',
      providerStatus: 200,
      whyCostUnknown: null
    });
    expect(summary.rows[0]?.duration).toEqual({ generatedSec: 29.5, requestedSec: 30, unit: 'seconds' });
    expect(summary.totalsByProvider).toEqual([{ provider: 'elevenlabs-isolation', currency: 'USD', estimatedTotal: 0.05, actualTotal: 0.04, count: 1 }]);
  });

  it('keeps provider totals separate per currency', () => {
    const summary = summarizeProviderRequests([
      generic({ requestId: 'usd_request_001', cost: { currency: 'USD', estimated: 0.25, actual: 0.2 } }),
      generic({ requestId: 'eur_request_001', cost: { currency: 'EUR', estimated: 0.5, actual: 0.4 } })
    ]);

    expect(summary.totalsByProvider).toEqual([
      { provider: 'elevenlabs-isolation', currency: 'EUR', estimatedTotal: 0.5, actualTotal: 0.4, count: 1 },
      { provider: 'elevenlabs-isolation', currency: 'USD', estimatedTotal: 0.25, actualTotal: 0.2, count: 1 }
    ]);
  });

  it('uses manifest voice-patch duration metadata when the generic terminal row is intentionally duration-free', () => {
    const summary = summarizeProviderRequests([
      generic({
        requestId: 'voice_patch_duration_001',
        type: 'voice_patch',
        provider: 'tts.mock',
        operationId: 'op_voice_patch_0001',
        durationRequestedSec: undefined,
        durationGeneratedSec: undefined,
        cost: { currency: 'USD', estimated: 0, actual: 0 }
      })
    ], {
      operations: [{
        id: 'op_voice_patch_0001',
        type: 'voice_patch',
        status: 'approved',
        clipId: 'clip_001',
        start: 1,
        end: 2,
        text: 'patched',
        asset: 'assets/voice/patch.wav',
        providerRequestId: 'voice_patch_duration_001',
        durationGeneratedSec: 1.25,
        durationRequestedSec: 1,
        createdBy: 'user',
        createdAt: '2026-05-14T13:00:00.000Z'
      }]
    });

    expect(summary.rows[0]?.duration).toEqual({ generatedSec: 1.25, requestedSec: 1, unit: 'seconds' });
  });

  it('does not mark known zero-cost requests as unknown cost', () => {
    const summary = summarizeProviderRequests([
      generic({ requestId: 'free_request_001', cost: { currency: 'USD', estimated: 0, actual: 0 } })
    ]);

    expect(summary.rows[0]?.whyCostUnknown).toBeNull();
    expect(summary.totalsByProvider).toEqual([{ provider: 'elevenlabs-isolation', currency: 'USD', estimatedTotal: 0, actualTotal: 0, count: 1 }]);
  });

  it('returns an empty summary for absent ledgers', () => {
    const root = mkdtempSync(join(tmpdir(), 'ets-provider-summary-'));
    try {
      expect(summarizeProviderRequestsForWorkspace(root)).toEqual({ rows: [], totalsByProvider: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reads a workspace ledger with tolerant parsing before summarizing', () => {
    const root = mkdtempSync(join(tmpdir(), 'ets-provider-summary-'));
    try {
      mkdirSync(join(root, 'logs'), { recursive: true });
      writeFileSync(join(root, 'logs/provider-requests.jsonl'), `${JSON.stringify(generic())}\n{partial`);
      const summary = summarizeProviderRequestsForWorkspace(root);
      expect(summary.rows).toHaveLength(1);
      expect(summary.totalsByProvider[0]?.estimatedTotal).toBe(0.05);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
