import { describe, expect, it } from 'vitest';
import type { ManifestV3 } from '@etvideoscript/core/browser';
import { isApprovable } from './OperationApproval';

type Operation = ManifestV3['operations'][number];

function operation(status: Operation['status']): Operation {
  return {
    id: `op_${status}`,
    type: 'cut',
    status,
    target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 1, end: 2 },
    proposedBy: 'agent',
    createdBy: 'agent',
    createdAt: '2026-05-18T00:00:00.000Z'
  } as Operation;
}

describe('OperationApproval helpers', () => {
  it('only approves proposed operations', () => {
    expect(isApprovable(operation('proposed'))).toBe(true);
    for (const status of ['awaiting_approval', 'approved', 'rejected', 'disabled'] as const) {
      expect(isApprovable(operation(status))).toBe(false);
    }
  });
});
