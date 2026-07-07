import { describe, expect, it } from 'vitest';
import { transcribableClips, type ManifestV3 } from '../index';

const now = '2026-05-17T00:00:00.000Z';
const renderPresets = { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: 'source', videoBitrate: 'source-or-auto', audioBitrate: '192k' } };

function clip(clipId: string, timelineStart: number) {
  return { clipId, assetId: `asset_${clipId}`, sourceStart: 0, sourceEnd: 1, timelineStart };
}

function manifest(tracks: ManifestV3['tracks']): ManifestV3 {
  return { manifestVersion: 3, projectId: 'transcribable-clips', createdAt: now, updatedAt: now, assets: [], tracks, operations: [], outputs: [], takeGroups: [], renderPresets };
}

describe('transcribableClips', () => {
  it('returns primary video and voiceover clips in timeline-major order, excluding other tracks and duplicate clip IDs', () => {
    const result = transcribableClips(manifest([
      { trackId: 'video_primary', kind: 'video', name: 'Primary video', order: 1, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [clip('video_late', 10), clip('same_id', 20)] },
      { trackId: 'video_secondary', kind: 'video', name: 'Secondary video', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [clip('secondary_video', 1)] },
      { trackId: 'audio_voiceover', kind: 'audio', subtype: 'voiceover', name: 'Voiceover', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [clip('voice_early', 5), clip('same_id', 30)] },
      { trackId: 'audio_music', kind: 'audio', subtype: 'music', name: 'Music', order: 2, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [clip('music_clip', 2)] },
      { trackId: 'audio_sfx', kind: 'audio', subtype: 'sfx', name: 'SFX', order: 3, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [clip('sfx_clip', 3)] },
      { trackId: 'audio_dialog', kind: 'audio', subtype: 'dialog', name: 'Dialog', order: 4, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [clip('dialog_clip', 4)] }
    ]));

    expect(result).toEqual([{ clipId: 'voice_early' }, { clipId: 'video_late' }, { clipId: 'same_id' }]);
  });

  it('returns exactly the single video track clips for a video-only project', () => {
    const result = transcribableClips(manifest([
      { trackId: 'video_only', kind: 'video', name: 'Video', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [clip('video_a', 0), clip('video_b', 4)] }
    ]));

    expect(result).toEqual([{ clipId: 'video_a' }, { clipId: 'video_b' }]);
  });

  it('returns only voiceover clips for a voice-only project', () => {
    const result = transcribableClips(manifest([
      { trackId: 'voice_only', kind: 'audio', subtype: 'voiceover', name: 'Voiceover', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [clip('voice_a', 1), clip('voice_b', 2)] },
      { trackId: 'music', kind: 'audio', subtype: 'music', name: 'Music', order: 1, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [clip('music_a', 0)] }
    ]));

    expect(result).toEqual([{ clipId: 'voice_a' }, { clipId: 'voice_b' }]);
  });
});
