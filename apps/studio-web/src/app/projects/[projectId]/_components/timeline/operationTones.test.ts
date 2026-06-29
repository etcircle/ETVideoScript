import { describe, expect, it } from 'vitest';
import type { OperationV3, OverlayView } from '@etvideoscript/core/browser';
import { operationToneAt, type TimelineOperationView } from './operationTones';

function viewFor(op: OperationV3, start: number, end: number): TimelineOperationView {
  const view: OverlayView = { kind: op.type, operationId: op.id, trackId: 'v1', tone: 'neutral', label: 'op' };
  return { op, view, range: { start, end } };
}

function cut(id: string, status: OperationV3['status'] = 'approved'): OperationV3 {
  return { id, type: 'cut', status, target: { kind: 'clip-span', trackId: 'v1', clipId: 'c1', start: 0, end: 1 }, createdAt: '2026-01-01T00:00:00Z', createdBy: 'user', proposedBy: 'user' };
}
function mute(id: string, status: OperationV3['status'] = 'approved'): OperationV3 {
  return { id, type: 'mute', status, target: { kind: 'clip-span', trackId: 'v1', clipId: 'c1', start: 0, end: 1 }, createdAt: '2026-01-01T00:00:00Z', createdBy: 'user', proposedBy: 'user' };
}
function patch(id: string, status: OperationV3['status'] = 'approved'): OperationV3 {
  return { id, type: 'voice_patch', status, target: { kind: 'clip-span', trackId: 'v1', clipId: 'c1', start: 0, end: 1 }, text: 'hi', voiceRef: { providerId: 'tts.mock', voiceId: 'mock' }, createdAt: '2026-01-01T00:00:00Z', createdBy: 'user', proposedBy: 'user' };
}

describe('operationToneAt', () => {
  it('returns null when no operation overlaps the bar window', () => {
    expect(operationToneAt([viewFor(cut('a'), 5, 6)], 0, 1)).toBeNull();
  });

  it('returns cut when only a cut overlaps', () => {
    expect(operationToneAt([viewFor(cut('a'), 0.4, 0.6)], 0.3, 0.7)).toBe('cut');
  });

  it('returns mute when only a mute overlaps', () => {
    expect(operationToneAt([viewFor(mute('a'), 0.4, 0.6)], 0.3, 0.7)).toBe('mute');
  });

  it('returns voice_patch when only a voice_patch overlaps', () => {
    expect(operationToneAt([viewFor(patch('a'), 0.4, 0.6)], 0.3, 0.7)).toBe('voice_patch');
  });

  it('voice_patch wins over an overlapping cut on the same range (replacement > destruction)', () => {
    expect(operationToneAt([viewFor(cut('a'), 0.4, 0.6), viewFor(patch('b'), 0.4, 0.6)], 0.3, 0.7)).toBe('voice_patch');
  });

  it('voice_patch wins over an overlapping mute on the same range', () => {
    expect(operationToneAt([viewFor(mute('a'), 0.4, 0.6), viewFor(patch('b'), 0.4, 0.6)], 0.3, 0.7)).toBe('voice_patch');
  });

  it('ignores rejected ops', () => {
    expect(operationToneAt([viewFor(cut('a', 'rejected'), 0.4, 0.6)], 0.3, 0.7)).toBeNull();
    expect(operationToneAt([viewFor(patch('p', 'rejected'), 0.4, 0.6)], 0.3, 0.7)).toBeNull();
  });

  it('ignores disabled ops (revertable history pattern)', () => {
    expect(operationToneAt([viewFor(cut('a', 'disabled'), 0.4, 0.6)], 0.3, 0.7)).toBeNull();
    expect(operationToneAt([viewFor(patch('p', 'disabled'), 0.4, 0.6)], 0.3, 0.7)).toBeNull();
  });
});
