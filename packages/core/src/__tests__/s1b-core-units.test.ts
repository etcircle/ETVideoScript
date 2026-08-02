import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePaidTransportStubbingGlobalFetch } from './paidTransportTestSetup';
// This file drives paid adapters with its own stubs; the gate suite below opts back OUT
// explicitly (setPaidTransportForTests(null)) to assert the default blocked state.
usePaidTransportStubbingGlobalFetch();
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JobRecordSchema, parseProviderRequestRow, VoicePatchStepRecordSchema, isVoicePatchStepRecord } from '../schemas';
import { readRegularFileNoFollow } from '../filesystem';
import { appendProviderRequestEvent, appendVoicePatchStepRecord, ProviderLedgerCorruptError, readProviderRequests, summarizeProviderRequests, voicePatchAccountingRequestId, voicePatchStepRecordId, voicePatchStepRecords, voicePatchStepState, providerEstimatedSpend } from '../providerRequests';
import { ProviderRequestIdSchema } from '../schemas';
import { isTerminalJobStatus, type JobView } from '../jobView';
import { speechToSpeechElevenlabs, cloneElevenLabsVoice, ELEVENLABS_STS_DEFAULT_SOURCE_MIME } from '../providers/tts/elevenlabs';
import { PaidCallBlockedError, paidTransportFromGlobalFetch, setPaidTransportForTests } from '../network/paidCallGate';

const originalFetch = globalThis.fetch;
afterEach(() => { (globalThis as any).fetch = originalFetch; vi.restoreAllMocks(); });

function tmpWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'etvs-s1b-core-'));
  mkdirSync(join(ws, 'logs'), { recursive: true });
  return ws;
}

// ── W1.4 job schema (⟨R5⟩/⟨F9⟩) ─────────────────────────────────────────────────

describe('JobRecord errorCode / errorDetails (S1b W1.4)', () => {
  it('round-trips an interrupted job WITHOUT widening the status enum', () => {
    const parsed = JobRecordSchema.parse({
      jobId: 'job_prepare-voice_1', projectId: 'p', type: 'prepare-voice',
      status: 'failed', createdAt: new Date().toISOString(),
      errorCode: 'interrupted', errorDetails: { usableSec: 12.5, requiredSec: 30 }
    });
    expect(parsed.status).toBe('failed');
    expect(parsed.errorCode).toBe('interrupted');
    expect(parsed.errorDetails).toEqual({ usableSec: 12.5, requiredSec: 30 });
    // The record must survive a JSON round-trip (jobs.jsonl is written and re-parsed).
    expect(JobRecordSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    // 'interrupted' is deliberately NOT a status.
    expect(JobRecordSchema.safeParse({ ...parsed, status: 'interrupted' }).success).toBe(false);
  });

  it('rejects a non-slug errorCode and an oversized errorDetails', () => {
    const base = { jobId: 'j', type: 'prepare-voice', status: 'failed' as const, createdAt: new Date().toISOString() };
    expect(JobRecordSchema.safeParse({ ...base, errorCode: 'Not A Slug' }).success).toBe(false);
    expect(JobRecordSchema.safeParse({ ...base, errorDetails: { blob: 'x'.repeat(4000) } }).success).toBe(false);
    expect(JobRecordSchema.safeParse({ ...base, errorCode: 'voice-slot-limit' }).success).toBe(true);
  });

  it('is assignable to the browser-safe JobView (the studio types against it)', () => {
    const parsed = JobRecordSchema.parse({ jobId: 'j', type: 'prepare-voice', status: 'succeeded', createdAt: new Date().toISOString() });
    const view: JobView = parsed;
    expect(view.jobId).toBe('j');
    expect(isTerminalJobStatus(view.status)).toBe(true);
    expect(isTerminalJobStatus('running')).toBe(false);
  });
});

// ── W1 ⟨Q4⟩/⟨R1⟩ step records ───────────────────────────────────────────────────

describe('voice-patch step records (⟨Q4⟩/⟨R1⟩/⟨R8⟩)', () => {
  const artifact = { relPath: 'assets/voice/steps/a.wav', bytes: 100, sha256: 'a'.repeat(64), durationSec: 1.2 };

  it('derives ids that are schema-valid, bounded and distinct from the accounting ids', () => {
    const parent = 'req-0123456789abcdef';
    const stepId = voicePatchStepRecordId(parent, 'tts');
    const acctId = voicePatchAccountingRequestId(parent, 'tts');
    for (const id of [stepId, acctId, voicePatchStepRecordId(parent, 'sts')]) {
      expect(ProviderRequestIdSchema.safeParse(id).success).toBe(true);
      expect(id.length).toBeLessThanOrEqual(128);
      expect(id).not.toContain(':');
    }
    expect(stepId).not.toBe(acctId);
    expect(voicePatchStepRecordId(parent, 'tts')).not.toBe(voicePatchStepRecordId(parent, 'sts'));
    expect(voicePatchStepRecordId(parent, 'tts')).toBe(stepId); // deterministic
  });

  it('enforces {response XOR error} terminals', () => {
    const base = { recordKind: 'voice-patch-step' as const, requestId: voicePatchStepRecordId('p-request-id', 'tts'), parentRequestId: 'p-request-id', step: 'tts' as const, provider: 'tts.elevenlabs', createdAt: new Date().toISOString() };
    expect(VoicePatchStepRecordSchema.safeParse({ ...base, status: 'succeeded', artifact }).success).toBe(true);
    expect(VoicePatchStepRecordSchema.safeParse({ ...base, status: 'succeeded' }).success).toBe(false);
    expect(VoicePatchStepRecordSchema.safeParse({ ...base, status: 'succeeded', artifact, error: 'boom' }).success).toBe(false);
    expect(VoicePatchStepRecordSchema.safeParse({ ...base, status: 'failed', error: 'boom' }).success).toBe(true);
    expect(VoicePatchStepRecordSchema.safeParse({ ...base, status: 'failed', artifact }).success).toBe(false);
    expect(VoicePatchStepRecordSchema.safeParse({ ...base, status: 'started' }).success).toBe(true);
    expect(VoicePatchStepRecordSchema.safeParse({ ...base, status: 'started', artifact }).success).toBe(false);
  });

  it('reads back started-without-terminal as the unknown-outcome state, and never appears as a cost row', () => {
    const ws = tmpWorkspace();
    try {
      const parent = 'parent-request-id';
      const base = { recordKind: 'voice-patch-step' as const, parentRequestId: parent, provider: 'tts.elevenlabs', projectId: 'p', operationId: 'op_1', createdAt: new Date().toISOString() };
      appendVoicePatchStepRecord(ws, { ...base, requestId: voicePatchStepRecordId(parent, 'tts'), step: 'tts', status: 'started' });
      expect(voicePatchStepState(ws, parent, 'tts')).toEqual({ terminal: null, started: true });

      appendVoicePatchStepRecord(ws, { ...base, requestId: voicePatchStepRecordId(parent, 'tts'), step: 'tts', status: 'succeeded', artifact, completedAt: new Date().toISOString() });
      const state = voicePatchStepState(ws, parent, 'tts');
      expect(state.terminal?.status).toBe('succeeded');
      expect(state.terminal?.artifact).toEqual(artifact);
      expect(voicePatchStepState(ws, parent, 'sts')).toEqual({ terminal: null, started: false });

      // Not a cost row and not counted against the spend cap — the engine's own accounting
      // rows are the single source of billing truth.
      expect(summarizeProviderRequests(readProviderRequests(ws)).rows).toEqual([]);
      expect(providerEstimatedSpend(ws, 'tts.elevenlabs')).toBe(0);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('reads the paid ledger STRICTLY for idempotency, while legacy readers stay lenient', () => {
    const ws = tmpWorkspace();
    try {
      const parent = 'parent-request-id';
      appendVoicePatchStepRecord(ws, {
        recordKind: 'voice-patch-step', requestId: voicePatchStepRecordId(parent, 'tts'), parentRequestId: parent,
        step: 'tts', projectId: 'p', operationId: 'op_1', provider: 'tts.elevenlabs', status: 'started', createdAt: new Date().toISOString()
      });
      // A torn final line is exactly what an un-fsynced crash leaves behind.
      appendFileSync(join(ws, 'logs/provider-requests.jsonl'), '{"requestId":"vps-trunc","recordKi');

      // LEGACY semantics are preserved: the lenient reader tolerates the torn tail, so the cost
      // summary and older agent-WS sticky records keep working on real-world workspaces.
      expect(readProviderRequests(ws)).toHaveLength(1);
      // The paid-idempotency reader does NOT: a record it cannot see is a record that no longer
      // says "this was already billed".
      expect(() => readProviderRequests(ws, { strict: true })).toThrow(/provider-ledger-corrupt/);
      expect(() => voicePatchStepState(ws, parent, 'tts')).toThrow(ProviderLedgerCorruptError);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('refuses to MIGRATE a malformed modern row, so a step marker can never be laundered away', () => {
    const ws = tmpWorkspace();
    try {
      const parent = 'parent-request-id';
      // A 'started' step marker that is malformed (its artifact-bearing sibling fields are wrong,
      // here an invalid step value). zod strips unknown keys, so a permissive migration member
      // would normalize this into a generic row with recordKind/parentRequestId/step ERASED —
      // and voicePatchStepRecords, which filters on exactly those fields, would then report the
      // marker as ABSENT and let the paid step run again.
      writeFileSync(join(ws, 'logs/provider-requests.jsonl'), `${JSON.stringify({
        recordKind: 'voice-patch-step',
        requestId: voicePatchStepRecordId(parent, 'tts'),
        parentRequestId: parent,
        step: 'not-a-real-step',
        provider: 'tts.elevenlabs',
        status: 'started',
        createdAt: new Date().toISOString()
      })}\n`);

      // It is CORRUPTION, not history: strict reads throw rather than silently reshaping it.
      expect(() => readProviderRequests(ws, { strict: true })).toThrow(ProviderLedgerCorruptError);
      expect(() => voicePatchStepState(ws, parent, 'tts')).toThrow(ProviderLedgerCorruptError);
      // Specifically: it must NOT come back as a migrated generic row with the discriminators gone.
      expect(() => voicePatchStepRecords(ws, parent)).toThrow(ProviderLedgerCorruptError);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('routes every row by its OWN discriminators, so no schema can rescue a mis-declared row', () => {
    const legacyRow = { requestId: 'legacy-1', status: 'succeeded', createdAt: new Date().toISOString(), provider: 'tts.mock', operationId: 'op_1' };
    // A genuine pre-schema row (no discriminators at all) migrates when migration is allowed...
    expect(parseProviderRequestRow(legacyRow, { migrateLegacy: true }).ok).toBe(true);
    // ...and is NOT invented when it is not.
    expect(parseProviderRequestRow(legacyRow).ok).toBe(false);

    // A VALID generic body — the payload that previously "rescued" mis-declared rows, because a
    // union tries members in order and zod strips whatever the winning member does not declare.
    const validGenericBody = {
      requestId: 'hybrid-1', type: 'voice_patch', projectId: 'p', provider: 'tts.elevenlabs',
      voice: '', language: '', bodyHash: '', operationId: 'op_1', status: 'started',
      cost: { currency: 'USD', estimated: 1, actual: null }, createdAt: new Date().toISOString()
    };
    expect(parseProviderRequestRow(validGenericBody, { migrateLegacy: true }).ok).toBe(true);

    // Every STEP discriminator, crossed with that valid generic body. Family membership is
    // EXCLUSIVE, so this is a conflict: the step schema would strip type/cost/output (removing a
    // charge from spend accounting) and the generic schema would strip the step identity
    // (hiding a paid-step marker). Neither may claim it.
    for (const stepField of [
      { recordKind: 'voice-patch-step' },
      { parentRequestId: 'parent-request-id' },
      { step: 'not-a-real-step' },
      { artifact: { relPath: 'x' } },
      { accountingRequestId: 'vpa-1' },
      { stepProviderStatus: 429 }
    ]) {
      const parsed = parseProviderRequestRow({ ...validGenericBody, ...stepField }, { migrateLegacy: true });
      expect(parsed.ok).toBe(false);
      expect((parsed as { reason: string }).reason).toMatch(/more than one record family/);
    }

    // Combinations too — several step discriminators plus a valid generic body is the exact shape
    // that parsed as Generic before, with its step fields erased.
    expect(parseProviderRequestRow({ ...validGenericBody, recordKind: 'voice-patch-step', parentRequestId: 'parent-request-id', step: 'not-a-real-step' }, { migrateLegacy: true }).ok).toBe(false);

    // Legacy × generic-accounting is the same class: a row valid as BOTH would parse as Legacy
    // and silently lose type/cost/output.
    expect(parseProviderRequestRow({ ...validGenericBody, textHash: 'abc' }, { migrateLegacy: true }).ok).toBe(false);

    // A step row carrying ONLY its own family's fields, but malformed, fails as a STEP record —
    // it is never rescued by another schema and never migrated.
    const malformedStep = parseProviderRequestRow({
      recordKind: 'voice-patch-step', requestId: voicePatchStepRecordId('parent-request-id', 'tts'),
      parentRequestId: 'parent-request-id', step: 'not-a-real-step', provider: 'tts.elevenlabs',
      status: 'started', createdAt: new Date().toISOString()
    }, { migrateLegacy: true });
    expect(malformedStep.ok).toBe(false);
    expect((malformedStep as { reason: string }).reason).toMatch(/"step" record/);

    // Modern (non-step) discriminators on an otherwise legacy row: it claims to be a current
    // record and must satisfy one, rather than falling through to migration.
    for (const modernField of [
      { type: 'voice_patch' },
      { cost: { currency: 'USD' } },
      { textHash: 'abc' },
      { output: {} },
      { providerStatus: 200 },
      { input: { executionSnapshot: { voiceId: 'v' } } },
      { input: { resolvedRange: { clipId: 'clip_001' } } }
    ]) {
      expect(parseProviderRequestRow({ ...legacyRow, ...modernField }, { migrateLegacy: true }).ok).toBe(false);
    }

    // A VALID step record still parses as itself, with its discriminators intact.
    const validStep = {
      recordKind: 'voice-patch-step', requestId: voicePatchStepRecordId('parent-request-id', 'tts'),
      parentRequestId: 'parent-request-id', step: 'tts', provider: 'tts.elevenlabs',
      status: 'started', createdAt: new Date().toISOString()
    };
    const parsedStep = parseProviderRequestRow(validStep, { migrateLegacy: true });
    expect(parsedStep.ok).toBe(true);
    expect(isVoicePatchStepRecord((parsedStep as { value: any }).value)).toBe(true);
  });

  it('never leaves a paid-step marker invisible when its row is a step/generic hybrid', () => {
    const ws = tmpWorkspace();
    try {
      const parent = 'parent-request-id';
      // The round-5 probe: step discriminators + an invalid step + a valid generic body.
      writeFileSync(join(ws, 'logs/provider-requests.jsonl'), `${JSON.stringify({
        recordKind: 'voice-patch-step', parentRequestId: parent, step: 'not-a-real-step',
        requestId: voicePatchStepRecordId(parent, 'tts'), type: 'voice_patch', projectId: 'p',
        provider: 'tts.elevenlabs', voice: '', language: '', bodyHash: '', operationId: 'op_1',
        status: 'started', cost: { currency: 'USD', estimated: 1, actual: null }, createdAt: new Date().toISOString()
      })}\n`);
      // It must be corruption — not a generic row whose step identity was stripped, which would
      // make voicePatchStepState report the 'started' marker as absent and re-run a paid step.
      expect(() => voicePatchStepState(ws, parent, 'tts')).toThrow(ProviderLedgerCorruptError);
      expect(() => readProviderRequests(ws, { strict: true })).toThrow(ProviderLedgerCorruptError);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('refuses cap admission when a historical row records a paid call it cannot price or attribute', () => {
    const ws = tmpWorkspace();
    try {
      const rows = [
        // Same provider as the cap group, but no cost: counting it as zero deflates the total.
        { requestId: 'hist-1', status: 'succeeded', createdAt: new Date().toISOString(), provider: 'tts.elevenlabs', operationId: 'op_1' },
        // Absent provider: dropped by the group filter entirely, yet it may well be ours.
        { requestId: 'hist-2', status: 'succeeded', createdAt: new Date().toISOString(), operationId: 'op_2' },
        // EMPTY provider — belongs to no group, so it was silently counted as zero by all of them.
        { requestId: 'hist-3', status: 'succeeded', createdAt: new Date().toISOString(), provider: '', operationId: 'op_3' },
        // WHITESPACE provider — same hole, one trim away.
        { requestId: 'hist-4', status: 'called', createdAt: new Date().toISOString(), provider: '   ', operationId: 'op_4' }
      ];
      for (const row of rows) {
        writeFileSync(join(ws, 'logs/provider-requests.jsonl'), `${JSON.stringify(row)}\n`);
        expect(() => providerEstimatedSpend(ws, ['tts.elevenlabs', 'tts.elevenlabs-sts'])).toThrow(ProviderLedgerCorruptError);
      }
      // A migrated row that never fired a call is not spending, so it does not block anything.
      writeFileSync(join(ws, 'logs/provider-requests.jsonl'), `${JSON.stringify({ requestId: 'hist-9', status: 'rejected', createdAt: new Date().toISOString(), provider: 'tts.elevenlabs' })}\n`);
      expect(providerEstimatedSpend(ws, ['tts.elevenlabs'])).toBe(0);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('REFUSES TO WRITE a row that spans record families, so the log can never contain one', () => {
    const ws = tmpWorkspace();
    try {
      // The write path validates by the same exhaustive classification as the read path. Without
      // that, an ordered union would accept this, strip whichever family lost, and leave a
      // permanently mis-classified line in an append-only log.
      expect(() => appendProviderRequestEvent(ws, {
        recordKind: 'voice-patch-step',
        requestId: voicePatchStepRecordId('parent-request-id', 'tts'),
        parentRequestId: 'parent-request-id',
        step: 'tts',
        provider: 'tts.elevenlabs',
        status: 'started',
        createdAt: new Date().toISOString(),
        type: 'voice_patch',
        cost: { currency: 'USD', estimated: 1, actual: null }
      } as never)).toThrow(/more than one record family/);
      expect(readProviderRequests(ws)).toEqual([]);

      // Both families still write cleanly on their own — the guard is exclusivity, not strictness
      // about legitimate records.
      appendProviderRequestEvent(ws, {
        recordKind: 'voice-patch-step', requestId: voicePatchStepRecordId('parent-request-id', 'tts'),
        parentRequestId: 'parent-request-id', step: 'tts', projectId: 'p', operationId: 'op_1',
        provider: 'tts.elevenlabs', status: 'succeeded', createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(), stepProviderStatus: 200,
        artifact: { relPath: 'assets/voice/steps/a.wav', bytes: 10, sha256: 'a'.repeat(64), durationSec: 1 }
      } as never);
      appendProviderRequestEvent(ws, {
        requestId: 'generic-row-1', type: 'voice_patch', projectId: 'p', provider: 'tts.elevenlabs',
        voice: '', language: '', bodyHash: '', operationId: 'op_1', status: 'started',
        cost: { currency: 'USD', estimated: 1, actual: null }, createdAt: new Date().toISOString()
      } as never);
      const rows = readProviderRequests(ws, { strict: true });
      expect(rows).toHaveLength(2);
      // The step terminal kept its HTTP status under the step-owned name, so no information was
      // traded away for family exclusivity.
      expect((rows[0] as any).stepProviderStatus).toBe(200);
      expect(isVoicePatchStepRecord(rows[0]!)).toBe(true);
      expect(isVoicePatchStepRecord(rows[1]!)).toBe(false);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('normalizes provider attribution at parse time in EVERY record family', () => {
    const createdAt = new Date().toISOString();
    // Generic: `.min(1)` accepted a single space, so whitespace reached the cap matcher and
    // belonged to no group.
    const generic = parseProviderRequestRow({ requestId: 'generic-1', type: 'voice_patch', projectId: 'p', provider: '   ', voice: '', language: '', bodyHash: '', operationId: '', status: 'started', cost: { currency: 'USD', estimated: 1, actual: null }, createdAt }, {});
    expect((generic as { value: any }).value.provider).toBe('unknown');
    // Legacy accepted a blank provider outright.
    const legacy = parseProviderRequestRow({ requestId: 'legacy-1', projectId: 'p', provider: '', voice: '', language: '', textHash: 't', bodyHash: 'b', operationId: '', status: 'succeeded', createdAt }, {});
    expect((legacy as { value: any }).value.provider).toBe('unknown');
    // Migrated history, and a normal value that must survive untouched.
    const migrated = parseProviderRequestRow({ requestId: 'hist-1', status: 'succeeded', createdAt, provider: '  ' }, { migrateLegacy: true });
    expect((migrated as { value: any }).value.provider).toBe('unknown');
    const normal = parseProviderRequestRow({ requestId: 'generic-2', type: 'voice_patch', projectId: 'p', provider: ' tts.elevenlabs ', voice: '', language: '', bodyHash: '', operationId: '', status: 'started', cost: { currency: 'USD', estimated: 1, actual: null }, createdAt }, {});
    expect((normal as { value: any }).value.provider).toBe('tts.elevenlabs');
  });

  it('fails cap admission closed for ANY call-fired family, not only migrated rows', () => {
    const ws = tmpWorkspace();
    const createdAt = new Date().toISOString();
    try {
      const rows: Array<Record<string, unknown>> = [
        // A fully schema-valid LEGACY row for the capped provider, fired, with no cost anywhere.
        { requestId: 'legacy-fired', projectId: 'p', provider: 'tts.elevenlabs', voice: '', language: '', textHash: 't', bodyHash: 'b', operationId: 'op_1', status: 'succeeded', createdAt },
        // A schema-valid GENERIC row for the capped provider, fired, with a null estimate.
        { requestId: 'generic-fired', type: 'voice_patch', projectId: 'p', provider: 'tts.elevenlabs', voice: '', language: '', bodyHash: '', operationId: 'op_1', status: 'succeeded', cost: { currency: 'USD', estimated: null, actual: null }, createdAt },
        // A fired row whose provider normalizes to 'unknown' — it belongs to no group, so it was
        // counted as zero by every one of them.
        { requestId: 'blank-fired', type: 'voice_patch', projectId: 'p', provider: '  ', voice: '', language: '', bodyHash: '', operationId: 'op_1', status: 'succeeded', cost: { currency: 'USD', estimated: 1, actual: 1 }, createdAt }
      ];
      for (const row of rows) {
        writeFileSync(join(ws, 'logs/provider-requests.jsonl'), `${JSON.stringify(row)}\n`);
        expect(() => providerEstimatedSpend(ws, ['tts.elevenlabs', 'tts.elevenlabs-sts'])).toThrow(ProviderLedgerCorruptError);
      }
      // NEVER-FIRED rows still contribute 0 and never block, in every family.
      writeFileSync(join(ws, 'logs/provider-requests.jsonl'), [
        JSON.stringify({ requestId: 'legacy-rejected', projectId: 'p', provider: 'tts.elevenlabs', voice: '', language: '', textHash: 't', bodyHash: 'b', operationId: '', status: 'rejected', createdAt }),
        JSON.stringify({ requestId: 'generic-approved', type: 'voice_patch', projectId: 'p', provider: 'tts.elevenlabs', voice: '', language: '', bodyHash: '', operationId: '', status: 'approved', cost: { currency: 'USD', estimated: null, actual: null }, createdAt })
      ].join('\n') + '\n');
      expect(providerEstimatedSpend(ws, ['tts.elevenlabs'])).toBe(0);
      // And a fired, priced row for the group still totals normally.
      writeFileSync(join(ws, 'logs/provider-requests.jsonl'), `${JSON.stringify({ requestId: 'generic-priced', type: 'voice_patch', projectId: 'p', provider: 'tts.elevenlabs', voice: '', language: '', bodyHash: '', operationId: '', status: 'succeeded', cost: { currency: 'USD', estimated: 0.25, actual: 0.25 }, createdAt })}\n`);
      expect(providerEstimatedSpend(ws, ['tts.elevenlabs'])).toBe(0.25);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('counts spend from the FIRED accounting row, not the first lifecycle row', () => {
    const ws = tmpWorkspace();
    const createdAt = new Date().toISOString();
    try {
      // The real shape of a legacy voice-patch lifecycle: a phase-one row written before
      // execution, then the engine's rows. If the group's provider is taken from the FIRST row
      // and that row carries a shorthand id, the whole (cost-bearing) group falls outside the cap.
      writeFileSync(join(ws, 'logs/provider-requests.jsonl'), [
        JSON.stringify({ requestId: 'lifecycle-1', type: 'voice_patch', projectId: 'p', provider: 'tts.xai', voice: 'eve', language: 'en', bodyHash: 'b', operationId: 'op_1', status: 'approved', cost: { currency: 'USD', estimated: 0, actual: 0 }, createdAt }),
        JSON.stringify({ requestId: 'lifecycle-1', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: 'eve', language: 'en', bodyHash: '', operationId: 'op_1', status: 'started', cost: { currency: 'USD', estimated: 0.5, actual: null }, createdAt }),
        JSON.stringify({ requestId: 'lifecycle-1', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: 'eve', language: 'en', bodyHash: '', operationId: 'op_1', status: 'succeeded', cost: { currency: 'USD', estimated: 0.5, actual: 0.5 }, createdAt })
      ].join('\n') + '\n');
      expect(providerEstimatedSpend(ws, 'tts.xai')).toBe(0.5);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('refuses a requestId whose fired rows disagree on provider or family', () => {
    const ws = tmpWorkspace();
    const createdAt = new Date().toISOString();
    try {
      // Two different providers under one requestId: whichever row we believed, the other's
      // charge would silently disappear.
      writeFileSync(join(ws, 'logs/provider-requests.jsonl'), [
        JSON.stringify({ requestId: 'split-req-1', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'succeeded', cost: { currency: 'USD', estimated: 0.5, actual: 0.5 }, createdAt }),
        JSON.stringify({ requestId: 'split-req-1', type: 'tts', projectId: 'p', provider: 'tts.elevenlabs', voice: '', language: '', bodyHash: '', operationId: '', status: 'succeeded', cost: { currency: 'USD', estimated: 0.7, actual: 0.7 }, createdAt })
      ].join('\n') + '\n');
      expect(() => providerEstimatedSpend(ws, 'tts.xai')).toThrow(/more than one provider/);

      // Family transitions within one requestId are equally irreconcilable.
      writeFileSync(join(ws, 'logs/provider-requests.jsonl'), [
        JSON.stringify({ requestId: 'split-req-2', projectId: 'p', provider: 'tts.xai', voice: '', language: '', textHash: 't', bodyHash: 'b', operationId: '', status: 'succeeded', createdAt }),
        JSON.stringify({ requestId: 'split-req-2', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'succeeded', cost: { currency: 'USD', estimated: 0.5, actual: 0.5 }, createdAt })
      ].join('\n') + '\n');
      expect(() => providerEstimatedSpend(ws, 'tts.xai')).toThrow(/mixes/);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('never lets a later row launder an earlier fired charge', () => {
    const ws = tmpWorkspace();
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const later = new Date().toISOString();
    try {
      // (a) A fired row with NO cost followed by a priced one: collapsing to "the latest non-null
      // cost" made the unpriced charge vanish. Every fired row must be priced.
      writeFileSync(join(ws, 'logs/provider-requests.jsonl'), [
        JSON.stringify({ requestId: 'launder-1', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'succeeded', cost: { currency: 'USD', estimated: null, actual: null }, createdAt }),
        JSON.stringify({ requestId: 'launder-1', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'op_update_failed', cost: { currency: 'USD', estimated: 0, actual: 0 }, createdAt: later })
      ].join('\n') + '\n');
      expect(() => providerEstimatedSpend(ws, 'tts.xai')).toThrow(/no cost estimate/);

      // (b) SUCCEEDED → FAILED. The later failure is a later attempt, not a refund: the completed
      // call's cost must remain counted.
      writeFileSync(join(ws, 'logs/provider-requests.jsonl'), [
        JSON.stringify({ requestId: 'launder-2', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'succeeded', cost: { currency: 'USD', estimated: 0.5, actual: 0.5 }, createdAt }),
        JSON.stringify({ requestId: 'launder-2', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'failed', cost: { currency: 'USD', estimated: 0.5, actual: null }, createdAt: later })
      ].join('\n') + '\n');
      expect(providerEstimatedSpend(ws, 'tts.xai')).toBe(0.5);

      // (c) SUCCEEDED then a cheaper later row: the floor holds.
      writeFileSync(join(ws, 'logs/provider-requests.jsonl'), [
        JSON.stringify({ requestId: 'launder-3', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'succeeded', cost: { currency: 'USD', estimated: 0.5, actual: 0.5 }, createdAt }),
        JSON.stringify({ requestId: 'launder-3', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'op_update_failed', cost: { currency: 'USD', estimated: 0.01, actual: 0.01 }, createdAt: later })
      ].join('\n') + '\n');
      expect(providerEstimatedSpend(ws, 'tts.xai')).toBe(0.5);

      // (d) RETRY IN FLIGHT: started → failed → started. The failure is history, not the group's
      // outcome — the newer 'started' is an outstanding call whose estimate must still be
      // reserved, or two concurrent retries could each slip past the cap.
      const middle = new Date(Date.now() - 30_000).toISOString();
      writeFileSync(join(ws, 'logs/provider-requests.jsonl'), [
        JSON.stringify({ requestId: 'retry-req-1', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'started', cost: { currency: 'USD', estimated: 0.5, actual: null }, createdAt }),
        JSON.stringify({ requestId: 'retry-req-1', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'failed', cost: { currency: 'USD', estimated: 0.5, actual: null }, createdAt: middle }),
        JSON.stringify({ requestId: 'retry-req-1', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'started', cost: { currency: 'USD', estimated: 0.5, actual: null }, createdAt: later })
      ].join('\n') + '\n');
      expect(providerEstimatedSpend(ws, 'tts.xai')).toBe(0.5);

      // Ties on timestamp fall back to LEDGER ORDER — same-millisecond rows are common.
      const tied = new Date().toISOString();
      writeFileSync(join(ws, 'logs/provider-requests.jsonl'), [
        JSON.stringify({ requestId: 'retry-req-2', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'started', cost: { currency: 'USD', estimated: 0.5, actual: null }, createdAt: tied }),
        JSON.stringify({ requestId: 'retry-req-2', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'failed', cost: { currency: 'USD', estimated: 0.5, actual: null }, createdAt: tied }),
        JSON.stringify({ requestId: 'retry-req-2', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'started', cost: { currency: 'USD', estimated: 0.5, actual: null }, createdAt: tied })
      ].join('\n') + '\n');
      expect(providerEstimatedSpend(ws, 'tts.xai')).toBe(0.5);
      // ...and the reverse tie — the failure last — still spends nothing.
      writeFileSync(join(ws, 'logs/provider-requests.jsonl'), [
        JSON.stringify({ requestId: 'retry-req-3', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'started', cost: { currency: 'USD', estimated: 0.5, actual: null }, createdAt: tied }),
        JSON.stringify({ requestId: 'retry-req-3', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'failed', cost: { currency: 'USD', estimated: 0.5, actual: null }, createdAt: tied })
      ].join('\n') + '\n');
      expect(providerEstimatedSpend(ws, 'tts.xai')).toBe(0);

      // (e) A call that only ever FAILED still spends nothing.
      writeFileSync(join(ws, 'logs/provider-requests.jsonl'), [
        JSON.stringify({ requestId: 'launder-4', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'started', cost: { currency: 'USD', estimated: 0.5, actual: null }, createdAt }),
        JSON.stringify({ requestId: 'launder-4', type: 'tts', projectId: 'p', provider: 'tts.xai', voice: '', language: '', bodyHash: '', operationId: '', status: 'failed', cost: { currency: 'USD', estimated: 0.5, actual: null }, createdAt: later })
      ].join('\n') + '\n');
      expect(providerEstimatedSpend(ws, 'tts.xai')).toBe(0);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('discriminates step records from generic ledger records', () => {
    const step = VoicePatchStepRecordSchema.parse({ recordKind: 'voice-patch-step', requestId: voicePatchStepRecordId('parent-id-value', 'sts'), parentRequestId: 'parent-id-value', step: 'sts', provider: 'tts.elevenlabs-sts', status: 'started', createdAt: new Date().toISOString() });
    expect(isVoicePatchStepRecord(step)).toBe(true);
    expect(isVoicePatchStepRecord({ requestId: 'r-1234567', type: 'voice_patch', provider: 'x', voice: '', language: '', bodyHash: '', operationId: '', status: 'approved', cost: { currency: 'USD' }, createdAt: new Date().toISOString(), projectId: '' } as never)).toBe(false);
  });
});

// ── ⟨Q7⟩ symlink-safe read ──────────────────────────────────────────────────────

describe('readRegularFileNoFollow (⟨Q7⟩)', () => {
  it('reads a regular file and hashes exactly the bytes behind the verified descriptor', () => {
    const ws = tmpWorkspace();
    try {
      mkdirSync(join(ws, 'assets/voice/steps'), { recursive: true });
      writeFileSync(join(ws, 'assets/voice/steps/a.wav'), Buffer.from('hello'));
      const read = readRegularFileNoFollow(ws, 'assets/voice/steps/a.wav');
      expect(read.bytes.toString()).toBe('hello');
      expect(read.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('refuses a symlinked LEAF even when it points back inside the workspace (assertInside alone would pass)', () => {
    const ws = tmpWorkspace();
    try {
      mkdirSync(join(ws, 'assets/voice/steps'), { recursive: true });
      writeFileSync(join(ws, 'assets/voice/steps/real.wav'), Buffer.from('real'));
      symlinkSync(join(ws, 'assets/voice/steps/real.wav'), join(ws, 'assets/voice/steps/link.wav'));
      expect(() => readRegularFileNoFollow(ws, 'assets/voice/steps/link.wav')).toThrow();
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('refuses a symlinked ANCESTOR directory', () => {
    const ws = tmpWorkspace();
    try {
      mkdirSync(join(ws, 'assets/voice/real-steps'), { recursive: true });
      mkdirSync(join(ws, 'assets/voice'), { recursive: true });
      writeFileSync(join(ws, 'assets/voice/real-steps/a.wav'), Buffer.from('real'));
      symlinkSync(join(ws, 'assets/voice/real-steps'), join(ws, 'assets/voice/steps'));
      expect(() => readRegularFileNoFollow(ws, 'assets/voice/steps/a.wav')).toThrow(/symlink/);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('still refuses paths that escape the workspace lexically', () => {
    const ws = tmpWorkspace();
    try {
      expect(() => readRegularFileNoFollow(ws, '../../etc/passwd')).toThrow(/escapes outside workspace/);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
});

// ── D8 central paid-call gate ───────────────────────────────────────────────────

describe('D8 central paid-call gate', () => {
  it('never invokes the network for TTS, speech-to-speech or clone when no transport is installed', async () => {
    // A real-looking key is installed on every call; the gate is what stops the wire, not the
    // absence of credentials. No transport is installed for this test — the DEFAULT state — and
    // there is no env bypass that could re-open the path.
    const secret = 'sk_elevenlabs_0123456789abcdef0123456789abcdef';
    setPaidTransportForTests(null);
    // The global fetch is also replaced with a spy: even a "helpfully" stubbed global must not
    // be treated as consent, so this proves the gate blocks on the ABSENCE of an installation
    // rather than on the pristineness of globalThis.fetch.
    const globalSpy = vi.fn(async () => new Response(new Uint8Array(44), { status: 200 }));
    (globalThis as any).fetch = globalSpy;
    await expect(cloneElevenLabsVoice({
      name: 'v', samples: [{ audio: Buffer.alloc(10), fileName: 'a.wav', mimeType: 'audio/wav' }],
      secret, signal: new AbortController().signal
    })).rejects.toBeInstanceOf(PaidCallBlockedError);

    await expect(speechToSpeechElevenlabs({
      audio: Buffer.alloc(10), voiceId: 'v1', secret, signal: new AbortController().signal
    })).rejects.toBeInstanceOf(PaidCallBlockedError);

    const { ttsElevenlabsProvider } = await import('../providers/tts/elevenlabs');
    const { guardedFetch } = await import('../network/guardedFetch');
    await expect(ttsElevenlabsProvider.run(
      { text: 'hi', voice: 'v1', language: 'en' },
      { provider: { id: 'tts.elevenlabs', kind: 'tts', tier: 'paid' } as any, requestId: 'r', signal: new AbortController().signal, guardedFetch, secret }
    )).rejects.toBeInstanceOf(PaidCallBlockedError);

    // Studio Sound's Voice Isolator is the fourth paid call type and now goes through the same
    // boundary, so it is blocked by the same absence.
    const { guardedFetch: gf } = await import('../network/guardedFetch');
    await expect(gf('https://api.elevenlabs.io/v1/audio-isolation', { tier: 'paid', method: 'POST' })).rejects.toBeInstanceOf(PaidCallBlockedError);

    expect(globalSpy).not.toHaveBeenCalled();
  });

  it('allows the call through once a test transport is installed', async () => {
    const calls: string[] = [];
    (globalThis as any).fetch = vi.fn(async (url: unknown) => { calls.push(String(url)); return new Response(new Uint8Array(44), { status: 200 }); });
    setPaidTransportForTests(paidTransportFromGlobalFetch());
    await speechToSpeechElevenlabs({ audio: Buffer.alloc(4), voiceId: 'v1', secret: 'k', signal: new AbortController().signal });
    expect(calls[0]).toContain('/v1/speech-to-speech/v1');
    setPaidTransportForTests(null);
  });

  it('still blocks inside an opted-in suite when the individual test forgets its stub', async () => {
    // The file-level opt-in installs paidTransportFromGlobalFetch, which refuses a PRISTINE
    // global — so "this suite touches paid code" never degrades into "any call is fine".
    setPaidTransportForTests(paidTransportFromGlobalFetch());
    (globalThis as any).fetch = originalFetch;
    await expect(speechToSpeechElevenlabs({ audio: Buffer.alloc(4), voiceId: 'v1', secret: 'k', signal: new AbortController().signal }))
      .rejects.toBeInstanceOf(PaidCallBlockedError);
    setPaidTransportForTests(null);
  });
});

// ── D4 STS parameterization ─────────────────────────────────────────────────────

describe('speech-to-speech parameterization (D4)', () => {
  async function captureForm(input: Parameters<typeof speechToSpeechElevenlabs>[0]) {
    const captured: Request[] = [];
    (globalThis as any).fetch = vi.fn(async (url: unknown, init: any) => {
      captured.push(new Request(url as string, init));
      return new Response(new Uint8Array(44), { status: 200 });
    });
    await speechToSpeechElevenlabs(input);
    return captured[0]!.formData();
  }

  it('keeps the PUBLIC DEFAULTS unchanged (record-a-take still uploads a webm part, no voice_settings)', async () => {
    const form = await captureForm({ audio: Buffer.from('take'), voiceId: 'v1', secret: 'k', signal: new AbortController().signal });
    expect((form.get('audio') as File).type).toBe(ELEVENLABS_STS_DEFAULT_SOURCE_MIME);
    expect((form.get('audio') as File).type).toBe('audio/webm');
    expect((form.get('audio') as File).name).toBe('recording.webm');
    expect(form.get('voice_settings')).toBeNull();
    expect(form.get('remove_background_noise')).toBe('false');
  });

  it('sends the ear-locked recipe values when the callsite passes them', async () => {
    const form = await captureForm({
      audio: Buffer.from('tts-output'), voiceId: 'v1', secret: 'k', signal: new AbortController().signal,
      model: 'eleven_multilingual_sts_v2',
      sourceMimeType: 'audio/wav', sourceFileName: 'tts.wav',
      voiceSettings: { stability: 0.5, similarity_boost: 0.9, use_speaker_boost: true }
    });
    expect((form.get('audio') as File).type).toBe('audio/wav');
    expect((form.get('audio') as File).name).toBe('tts.wav');
    expect(form.get('model_id')).toBe('eleven_multilingual_sts_v2');
    expect(JSON.parse(String(form.get('voice_settings')))).toEqual({ stability: 0.5, similarity_boost: 0.9, use_speaker_boost: true });
  });
});
