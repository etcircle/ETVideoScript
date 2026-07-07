import type { ManifestV3 } from '../manifest/schema';
import type { Clip, Track } from '../tracks/schema';

export function makeClip(clipId: string, assetId: string, durationSec: number, timelineStart = 0): Clip {
  return { clipId, assetId, sourceStart: 0, sourceEnd: durationSec, timelineStart, audioDetached: undefined, detachedFrom: undefined, transitionAfter: undefined };
}

export function makeTrack(partial: Partial<Track> & Pick<Track, 'trackId' | 'kind'>): Track {
  return { name: partial.trackId, order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [], subtype: undefined, fx: undefined, ...partial };
}

export function makeManifest(partial: Partial<ManifestV3> = {}): ManifestV3 {
  return {
    manifestVersion: 3, projectId: 'proj_test',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    assets: [], tracks: [], operations: [], outputs: [],
    renderPresets: {
      draft: { resolution: '1280x720', videoBitrate: '2M', audioBitrate: '128k' },
      youtube: { resolution: '1920x1080', videoBitrate: '8M', audioBitrate: '192k' }
    },
    ...partial
  } as ManifestV3;
}

export function makeVideoAsset(assetId: string, durationSec: number, path = `input/takes/${assetId}.mp4`) {
  return { assetId, kind: 'video' as const, path, durationSec, provenance: 'imported' as const, video: { width: 1920, height: 1080, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } };
}

import type { TranscriptWord } from '../schemas';

export interface MakeWordsOptions {
  clipId?: string;
  startAt?: number;
  wordSec?: number;              // duration of each word, default 0.3
  gapSec?: number;               // gap after each word, default 0.05
  gapsAfter?: Record<number, number>; // extra gap AFTER word index i (overrides gapSec for that slot)
}

export function makeWords(text: string, opts: MakeWordsOptions = {}): TranscriptWord[] {
  const { clipId = 'clip_take_01', startAt = 0, wordSec = 0.3, gapSec = 0.05, gapsAfter = {} } = opts;
  let t = startAt;
  return text.split(/\s+/).filter(Boolean).map((token, i) => {
    const start = t;
    const end = start + wordSec;
    t = end + (gapsAfter[i] ?? gapSec);
    return {
      id: `${clipId}_w${i}`, text: token, normalized: '', start, end,
      speaker: 'speaker_1', confidence: 1, segmentId: `${clipId}_s1`, clipId
    };
  });
}
