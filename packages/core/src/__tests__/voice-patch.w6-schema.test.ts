/**
 * W6 schema back-compat + new fields tests for VoicePatchOperationSchema.
 * Tests §6.2 of the BUILD SPEC.
 */

import { describe, expect, it } from 'vitest';
import { VoicePatchOperationSchemaV3 } from '../index';

const now = '2026-05-30T00:00:00.000Z';

function baseOp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op_voice_patch_w6',
    type: 'voice_patch' as const,
    status: 'proposed' as const,
    target: { kind: 'clip-span' as const, trackId: 'track_001', clipId: 'clip_001', start: 1.0, end: 2.0 },
    text: 'replacement speech',
    proposedBy: 'user' as const,
    createdBy: 'user' as const,
    createdAt: now,
    ...overrides
  };
}

describe('VoicePatchOperationSchema W6 — back-compat + new fields', () => {
  // §6.2 test 14: back-compat parse — no new fields
  it('parses a legacy op without granularity/cloneScope/referenceRange (all undefined)', () => {
    const result = VoicePatchOperationSchemaV3.parse(baseOp());
    expect(result.granularity).toBeUndefined();
    expect(result.cloneScope).toBeUndefined();
    expect(result.referenceRange).toBeUndefined();
    // Existing fields still work.
    expect(result.text).toBe('replacement speech');
    expect(result.status).toBe('proposed');
  });

  // §6.2 test 15: parse WITH new fields round-trips intact
  it('round-trips an op with all three new W6 fields', () => {
    const result = VoicePatchOperationSchemaV3.parse(baseOp({
      granularity: 'phrase',
      cloneScope: 'local',
      referenceRange: { clipId: 'clip_ref', start: 1.0, end: 3.0 }
    }));
    expect(result.granularity).toBe('phrase');
    expect(result.cloneScope).toBe('local');
    expect(result.referenceRange).toEqual({ clipId: 'clip_ref', start: 1.0, end: 3.0 });
  });

  it('round-trips granularity:word', () => {
    const result = VoicePatchOperationSchemaV3.parse(baseOp({ granularity: 'word' }));
    expect(result.granularity).toBe('word');
  });

  it('round-trips granularity:sentence', () => {
    const result = VoicePatchOperationSchemaV3.parse(baseOp({ granularity: 'sentence' }));
    expect(result.granularity).toBe('sentence');
  });

  it('round-trips cloneScope:project', () => {
    const result = VoicePatchOperationSchemaV3.parse(baseOp({ cloneScope: 'project' }));
    expect(result.cloneScope).toBe('project');
  });

  // §6.2 test 16: referenceRange refine — end must be > start
  it('rejects referenceRange with end <= start (end < start)', () => {
    expect(() =>
      VoicePatchOperationSchemaV3.parse(baseOp({
        referenceRange: { clipId: 'clip_ref', start: 2.0, end: 1.0 }
      }))
    ).toThrow(/referenceRange\.end must be greater than start/i);
  });

  it('rejects referenceRange with end === start', () => {
    expect(() =>
      VoicePatchOperationSchemaV3.parse(baseOp({
        referenceRange: { clipId: 'clip_ref', start: 1.0, end: 1.0 }
      }))
    ).toThrow(/referenceRange\.end must be greater than start/i);
  });

  // §6.2 test 17: enum guards
  it('rejects granularity:"paragraph" (not in enum)', () => {
    expect(() =>
      VoicePatchOperationSchemaV3.parse(baseOp({ granularity: 'paragraph' }))
    ).toThrow();
  });

  it('rejects cloneScope:"global" (not in enum)', () => {
    expect(() =>
      VoicePatchOperationSchemaV3.parse(baseOp({ cloneScope: 'global' }))
    ).toThrow();
  });

  it('rejects unknown granularity string', () => {
    expect(() =>
      VoicePatchOperationSchemaV3.parse(baseOp({ granularity: 'utterance' }))
    ).toThrow();
  });

  // §6.2 test 18: unknown-key strip + granularity persists across approve-like update
  it('granularity persists when op is re-parsed as if approved (simulating updateOperation path)', () => {
    const proposed = VoicePatchOperationSchemaV3.parse(baseOp({ granularity: 'sentence', cloneScope: 'project' }));
    // Simulate what apply.ts:22 does: { ...current, ...patch }
    const patch = { status: 'approved' as const, assetId: 'asset_voice_001', durationGeneratedSec: 0.8, durationRequestedSec: 1.0 };
    const merged = VoicePatchOperationSchemaV3.parse({ ...proposed, ...patch });
    expect(merged.granularity).toBe('sentence');
    expect(merged.cloneScope).toBe('project');
    expect(merged.status).toBe('approved');
    expect(merged.assetId).toBe('asset_voice_001');
  });

  // §6.4: unknown keys are stripped (zod default strip behavior)
  it('strips unknown keys that do not belong to the schema', () => {
    const result = VoicePatchOperationSchemaV3.parse(baseOp({ unknownField: 'should-be-stripped' }));
    expect((result as Record<string, unknown>).unknownField).toBeUndefined();
  });

  // referenceRange: clipId min/max length guards
  it('rejects referenceRange.clipId exceeding 128 characters', () => {
    expect(() =>
      VoicePatchOperationSchemaV3.parse(baseOp({
        referenceRange: { clipId: 'c'.repeat(129), start: 0, end: 1 }
      }))
    ).toThrow();
  });

  it('rejects referenceRange.clipId of empty string', () => {
    expect(() =>
      VoicePatchOperationSchemaV3.parse(baseOp({
        referenceRange: { clipId: '', start: 0, end: 1 }
      }))
    ).toThrow();
  });

  it('accepts referenceRange.start === 0 (nonnegative)', () => {
    const result = VoicePatchOperationSchemaV3.parse(baseOp({
      referenceRange: { clipId: 'clip_ref', start: 0, end: 5 }
    }));
    expect(result.referenceRange?.start).toBe(0);
    expect(result.referenceRange?.end).toBe(5);
  });

  it('rejects referenceRange.start < 0', () => {
    expect(() =>
      VoicePatchOperationSchemaV3.parse(baseOp({
        referenceRange: { clipId: 'clip_ref', start: -0.1, end: 1 }
      }))
    ).toThrow();
  });
});
