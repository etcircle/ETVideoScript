import { describe, expect, it } from 'vitest';
import { VoicePatchOperationSchemaV3, voicePatchOperationKind } from '../index';

function baseOp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op_voice_patch_0001',
    type: 'voice_patch' as const,
    status: 'proposed' as const,
    target: { kind: 'clip-span' as const, trackId: 'track_001', clipId: 'clip_001', start: 1, end: 2 },
    text: 'replacement speech',
    proposedBy: 'user' as const,
    createdBy: 'user' as const,
    createdAt: '2026-05-20T00:00:00.000Z',
    ...overrides
  };
}

describe('voice_patch op schema — voiceRef field', () => {
  it('parses without voiceRef (back-compat with manifests written before the field existed)', () => {
    const parsed = VoicePatchOperationSchemaV3.parse(baseOp());
    expect(parsed.voiceRef).toBeUndefined();
    expect(parsed.text).toBe('replacement speech');
  });

  it('round-trips a present voiceRef (cloned-voice from ElevenLabs)', () => {
    const parsed = VoicePatchOperationSchemaV3.parse(baseOp({ voiceRef: { providerId: 'tts.elevenlabs', voiceId: 'el_cloned_abc123def456' } }));
    expect(parsed.voiceRef).toEqual({ providerId: 'tts.elevenlabs', voiceId: 'el_cloned_abc123def456' });
  });

  it('round-trips a stock xAI voiceRef', () => {
    const parsed = VoicePatchOperationSchemaV3.parse(baseOp({ voiceRef: { providerId: 'tts.xai', voiceId: 'eve' } }));
    expect(parsed.voiceRef).toEqual({ providerId: 'tts.xai', voiceId: 'eve' });
  });

  it('strips a transport-layer bare `voice: string` field instead of failing — agent/manifest routes still send it today', () => {
    // The agent route spreads `voice: 'eve'` into the op-creation params; the op schema's
    // strip-unknown default discards it cleanly so the transport layer and persisted op don't
    // collide. Lane F will translate the transport string into a voiceRef object.
    const parsed = VoicePatchOperationSchemaV3.parse({ ...baseOp(), voice: 'eve', provider: 'xai' });
    expect((parsed as Record<string, unknown>).voice).toBeUndefined();
    expect(parsed.voiceRef).toBeUndefined();
  });

  it('rejects a voiceRef with a non-tts providerId', () => {
    expect(() => VoicePatchOperationSchemaV3.parse(baseOp({ voiceRef: { providerId: 'image-gen.xai', voiceId: 'eve' } }))).toThrow(/providerId must be a tts/i);
  });

  it('rejects empty-string voiceId (use omission of the whole voiceRef field instead)', () => {
    expect(() => VoicePatchOperationSchemaV3.parse(baseOp({ voiceRef: { providerId: 'tts.xai', voiceId: '' } }))).toThrow();
  });

  it('rejects voiceId over 128 chars (defensive bound — matches ElevenLabs voice id length)', () => {
    expect(() => VoicePatchOperationSchemaV3.parse(baseOp({ voiceRef: { providerId: 'tts.elevenlabs', voiceId: 'x'.repeat(129) } }))).toThrow();
  });

  it('exposes voiceRef in transcriptView details when present, omits the key when absent', () => {
    const opWith = VoicePatchOperationSchemaV3.parse(baseOp({ voiceRef: { providerId: 'tts.elevenlabs', voiceId: 'el_voice_xyz' } }));
    const pillWith = voicePatchOperationKind.transcriptView(opWith);
    expect(pillWith?.details?.voiceRef).toEqual({ providerId: 'tts.elevenlabs', voiceId: 'el_voice_xyz' });
    expect(pillWith?.details?.text).toBe('replacement speech');

    const opWithout = VoicePatchOperationSchemaV3.parse(baseOp());
    const pillWithout = voicePatchOperationKind.transcriptView(opWithout);
    expect(pillWithout?.details && 'voiceRef' in pillWithout.details).toBe(false);
  });

  it('exposes voiceRef in timelineView details when present', () => {
    const op = VoicePatchOperationSchemaV3.parse(baseOp({ voiceRef: { providerId: 'tts.elevenlabs', voiceId: 'el_voice_xyz' }, assetId: 'asset_voice_op_voice_patch_0001' }));
    const overlay = voicePatchOperationKind.timelineView(op);
    expect(overlay.details?.voiceRef).toEqual({ providerId: 'tts.elevenlabs', voiceId: 'el_voice_xyz' });
    expect(overlay.details?.assetId).toBe('asset_voice_op_voice_patch_0001');
  });
});
