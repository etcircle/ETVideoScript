import { describe, expect, it } from 'vitest';
import type { ManifestV3 } from '@etvideoscript/core/browser';
import { isRejectedUnsynthesizedVoicePatch } from './ManifestPanel';

type Operation = ManifestV3['operations'][number];

function voicePatch(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'op_voice_patch_0001',
    type: 'voice_patch',
    status: 'rejected',
    target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 1, end: 2 },
    text: 'replacement',
    providerRequestId: 'provider_req_0001',
    proposedBy: 'agent',
    createdBy: 'agent',
    createdAt: '2026-05-18T00:00:00.000Z',
    ...overrides
  } as Operation;
}

describe('ManifestPanel restore affordance helpers', () => {
  it('blocks restore only for rejected voice patches with no synthesized asset', () => {
    expect(isRejectedUnsynthesizedVoicePatch(voicePatch())).toBe(true);
    expect(isRejectedUnsynthesizedVoicePatch(voicePatch({ assetId: 'asset_voice_001' }))).toBe(false);
    expect(isRejectedUnsynthesizedVoicePatch(voicePatch({ status: 'disabled' }))).toBe(false);
  });
});
