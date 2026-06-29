import type { PeakPair } from './waveformPixels';

export type WaveformPeaks = { resolutionHz: number; durationSec: number; channels: 1; peaks: PeakPair[] };
export type TimelineClip = { clipId: string; sourceStart: number; sourceEnd: number; timelineStart?: number; assetId?: string };
export type ClipSource = { clipId: string; sha256?: string; durationSec?: number; width?: number; height?: number; fps?: number; videoCodec?: string; audioCodec?: string };
export type ClipTimelineEntry = { clipId: string; durationSec: number; outputStartOffset: number; outputEndOffset: number; metadata?: ClipSource };
export type TimelineWord = { id: string; text: string; start: number; end: number; clipId?: string };

export function buildClipTimeline(clips: TimelineClip[] = [], clipSources: ClipSource[] = []): ClipTimelineEntry[] {
  let cursor = 0;
  return clips.map((clip) => {
    const metadata = clipSources.find((source) => source.clipId === clip.clipId);
    const durationSec = Math.max(0, (clip.sourceEnd ?? metadata?.durationSec ?? 0) - (clip.sourceStart ?? 0));
    const outputStartOffset = typeof clip.timelineStart === 'number' ? clip.timelineStart : cursor;
    const entry = { clipId: clip.clipId, durationSec, outputStartOffset, outputEndOffset: outputStartOffset + durationSec, metadata };
    cursor = outputStartOffset + durationSec;
    return entry;
  });
}

export function projectWordToOutput(word: TimelineWord, timeline: ClipTimelineEntry[]): TimelineWord {
  if (!word.clipId) return word;
  const clip = timeline.find((entry) => entry.clipId === word.clipId);
  return clip ? { ...word, start: clip.outputStartOffset + word.start, end: clip.outputStartOffset + word.end } : word;
}

export type LoadWaveformPeaksResult =
  | { kind: 'per-clip'; clipPeaks: Record<string, WaveformPeaks> }
  | { kind: 'empty' };

export async function loadWaveformPeaks(fetchFn: typeof fetch, apiBase: string, projectId: string, clipIds: string[]): Promise<LoadWaveformPeaksResult> {
  if (!projectId.trim()) return { kind: 'empty' };
  const encodedProjectId = encodeURIComponent(projectId);
  if (clipIds.length) {
    const entries = await Promise.all(clipIds.map(async (clipId) => {
      const res = await fetchFn(`${apiBase}/api/projects/${encodedProjectId}/peaks/${encodeURIComponent(clipId)}`);
      if (!res.ok) return null;
      return [clipId, (await res.json()) as WaveformPeaks] as const;
    }));
    const clipPeaks = Object.fromEntries(entries.filter(Boolean) as Array<readonly [string, WaveformPeaks]>);
    if (Object.keys(clipPeaks).length) return { kind: 'per-clip', clipPeaks };
  }
  return { kind: 'empty' };
}

export function clipTooltip(clip: ClipTimelineEntry) {
  const meta = clip.metadata;
  if (!meta) return clip.clipId;
  return [
    `${clip.clipId} · ${clip.durationSec.toFixed(1)}s`,
    meta.sha256 ? `sha256 ${meta.sha256.slice(0, 8)}` : null,
    meta.fps ? `${meta.fps.toFixed(2)} fps` : null,
    meta.width && meta.height ? `${meta.width}×${meta.height}` : null,
    [meta.videoCodec, meta.audioCodec].filter(Boolean).join(' / ')
  ].filter(Boolean).join('\n');
}


