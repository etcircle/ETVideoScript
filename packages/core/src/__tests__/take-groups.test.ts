import { describe, expect, it } from 'vitest';
import { ManifestV3Schema } from '../manifest/schema';
import { validateManifestV3Document } from '../manifest/validate';
import { TakesError, TAKES_CONSTANTS } from '../takes/schema';
import { makeClip, makeManifest, makeTrack, makeVideoAsset } from './takes-fixtures';

const staging = makeTrack({ trackId: 'track_takes', kind: 'video', role: 'staging', hidden: true, order: 1000,
  clips: [makeClip('clip_take_01', 'a1', 20), makeClip('clip_take_02', 'a2', 21)] });
const base = { assets: [makeVideoAsset('a1', 20), makeVideoAsset('a2', 21)], tracks: [staging] };

describe('takeGroups', () => {
  it('defaults to [] for existing manifests', () => {
    const raw = { ...makeManifest(), takeGroups: undefined } as Record<string, unknown>;
    delete raw.takeGroups;
    expect(ManifestV3Schema.parse(raw).takeGroups).toEqual([]);
  });

  it('accepts a valid group referencing staging clips', () => {
    const m = makeManifest({ ...base, takeGroups: [{ groupId: 'main', label: 'main', clipIds: ['clip_take_01', 'clip_take_02'] }] });
    expect(validateManifestV3Document(m).valid).toBe(true);
  });

  it('rejects a group clipId that is not on the staging track', () => {
    const m = makeManifest({ ...base, takeGroups: [{ groupId: 'main', label: 'main', clipIds: ['clip_nope'] }] });
    expect(validateManifestV3Document(m).errors.join('\n')).toMatch(/clip_nope.*not on the staging track/i);
  });

  it('rejects duplicate groupIds and shared clipIds', () => {
    const m = makeManifest({ ...base, takeGroups: [
      { groupId: 'main', label: 'a', clipIds: ['clip_take_01'] },
      { groupId: 'main', label: 'b', clipIds: ['clip_take_01'] }
    ] });
    const errors = validateManifestV3Document(m).errors.join('\n');
    expect(errors).toMatch(/duplicated: main/i);
    expect(errors).toMatch(/clip_take_01.*more than one take group/i);
  });

  it('accepts composeState and exposes constants', () => {
    const m = makeManifest({ composeState: { appliedAt: '2026-01-02T00:00:00.000Z', compositionHash: 'abc' } });
    expect(ManifestV3Schema.parse(m).composeState?.compositionHash).toBe('abc');
    expect(TAKES_CONSTANTS.MIN_CANDIDATE_COVERAGE).toBe(0.5);
    expect(new TakesError('TAKES_UNKNOWN_GROUP', 'nope').code).toBe('TAKES_UNKNOWN_GROUP');
  });
});
