import { describe, expect, it } from 'vitest';
import { isStudioCleanupFresh } from '../channelFixScope';
import type { ManifestV3 } from '../manifest/schema';

// isStudioCleanupFresh is the SHARED freshness rule the render pipeline and the multi-window
// clone selector both use (mirrors render/plan.ts staleness semantics EXACTLY). Tests here pin
// the pure predicate; render/plan behavior is covered by the render tests.

function baseManifest(): ManifestV3 {
  return {
    manifestVersion: 3, projectId: 'p', createdAt: '2026-07-10T00:00:00.000Z', updatedAt: '2026-07-10T00:00:00.000Z',
    assets: [{ assetId: 'a', kind: 'video', path: 'input/source.mp4', durationSec: 10, provenance: 'imported', video: { width: 16, height: 9, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } }],
    tracks: [{ trackId: 't', kind: 'video', name: 'B', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [{ clipId: 'c', assetId: 'a', sourceStart: 0, sourceEnd: 10, timelineStart: 0 }] }],
    operations: [],
    outputs: [{ outputId: 'o', kind: 'full', aspects: ['16:9'], status: 'manual' }],
    renderPresets: { draft: { resolution: '16x9', videoBitrate: '250k', audioBitrate: '64k' }, youtube: { resolution: '32x18', videoBitrate: '500k', audioBitrate: '128k' } }
  } as ManifestV3;
}

const cleanup = (over: Partial<NonNullable<ManifestV3['studioCleanup']>> = {}): NonNullable<ManifestV3['studioCleanup']> => ({
  status: 'approved', assetPath: 'assets/studio-clean/k.wav', cacheKey: 'k', provider: 'studio-sound.elevenlabs-isolation',
  createdAt: '2026-07-10T00:00:00.000Z', ...over
});

describe('isStudioCleanupFresh', () => {
  it('false when there is no cleanup', () => {
    expect(isStudioCleanupFresh(baseManifest())).toBe(false);
  });

  it('false when cleanup is not approved', () => {
    const m = baseManifest();
    m.studioCleanup = cleanup({ status: 'disabled' });
    expect(isStudioCleanupFresh(m)).toBe(false);
  });

  it('true for an approved cleanup with no channel-fix history (never stale on that axis)', () => {
    const m = baseManifest();
    m.studioCleanup = cleanup();
    expect(isStudioCleanupFresh(m)).toBe(true);
  });

  it('true when the cleanup fingerprint matches the current channel-fix state', () => {
    const m = baseManifest();
    m.audioChannelFix = { status: 'approved', sourceChannel: 'left', detection: { leftRmsDb: -12, rightRmsDb: -60, auto: true }, appliedAt: '2026-07-10T00:00:00.000Z' };
    // current fingerprint for an approved left fix on input/source.mp4 is 'left'
    m.studioCleanup = cleanup({ audioChannelFixFingerprint: 'left' });
    expect(isStudioCleanupFresh(m)).toBe(true);
  });

  it('false (stale) when a channel-fix exists and the fingerprint no longer matches', () => {
    const m = baseManifest();
    m.audioChannelFix = { status: 'approved', sourceChannel: 'right', detection: { leftRmsDb: -60, rightRmsDb: -12, auto: true }, appliedAt: '2026-07-10T00:00:00.000Z' };
    // cleanup recorded 'left' but the current state is 'right' → stale
    m.studioCleanup = cleanup({ audioChannelFixFingerprint: 'left' });
    expect(isStudioCleanupFresh(m)).toBe(false);
  });

  it('false (stale) when a channel-fix exists but the cleanup has NO recorded fingerprint', () => {
    const m = baseManifest();
    m.audioChannelFix = { status: 'approved', sourceChannel: 'left', detection: { leftRmsDb: -12, rightRmsDb: -60, auto: true }, appliedAt: '2026-07-10T00:00:00.000Z' };
    m.studioCleanup = cleanup(); // no audioChannelFixFingerprint
    expect(isStudioCleanupFresh(m)).toBe(false);
  });
});
