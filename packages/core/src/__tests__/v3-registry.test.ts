import { describe, expect, it } from 'vitest';
import { OPERATION_PRECEDENCE, OperationSchemaV3, registeredOperationKinds } from '../index';

const target = { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 1, end: 2 };

describe('v3 operation registry', () => {
  it('builds the union from registered kinds', () => {
    const types = registeredOperationKinds.map((kind) => kind.type);
    expect(types).toEqual(['cut', 'mute', 'voice_patch', 'speed', 'overlay', 'transition', 'caption_style', 'transcript_amend']);
    for (const type of types) {
      const payload = { id: `op_${type}_0001`, type, status: 'approved', target, proposedBy: 'agent', createdBy: 'user', createdAt: '2026-05-17T00:00:00.000Z',
        ...(type === 'voice_patch' ? { text: 'patched' } : {}),
        ...(type === 'speed' ? { rate: 4 } : {}),
        ...(type === 'overlay' ? { source: { kind: 'text', text: 'hello' }, rect: { x: 0, y: 0, width: 100, height: 30 } } : {}),
        ...(type === 'transition' ? { target: { kind: 'clip-boundary', trackId: 'track_video_001', clipId: 'clip_001' }, durationMs: 250 } : {}),
        ...(type === 'caption_style' ? { target: { kind: 'track', trackId: 'track_caption_001' }, styleId: 'default' } : {}),
        ...(type === 'transcript_amend' ? { amendedText: 'Hi there' } : {}) };
      expect(OperationSchemaV3.safeParse(payload).success).toBe(true);
    }
  });

  it('pins all registered v3 ops to their target kinds', () => {
    expect(registeredOperationKinds.map((kind) => [kind.type, kind.targetKind])).toEqual([
      ['cut', 'clip-span'],
      ['mute', 'clip-span'],
      ['voice_patch', 'clip-span'],
      ['speed', 'clip-span'],
      ['overlay', 'clip-span'],
      ['transition', 'clip-boundary'],
      ['caption_style', 'track'],
      ['transcript_amend', 'clip-span']
    ]);
  });

  it('exposes the locked precedence order for registered chunk-1 ops', () => {
    expect(OPERATION_PRECEDENCE.cut).toBeGreaterThan(OPERATION_PRECEDENCE.mute);
    expect(OPERATION_PRECEDENCE.mute).toBeGreaterThan(OPERATION_PRECEDENCE.speed);
    expect(OPERATION_PRECEDENCE.speed).toBeGreaterThan(OPERATION_PRECEDENCE.voice_patch);
    expect(OPERATION_PRECEDENCE.mute).toBeGreaterThan(OPERATION_PRECEDENCE.voice_patch);
  });
});
