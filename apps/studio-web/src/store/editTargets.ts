import type { ManifestV3, ClipSpanTargetV3, ClipBoundaryTargetV3, TrackV3 } from '@etvideoscript/core/browser';

export const CLIP_BOUNDARY_TOLERANCE_SEC = 0.5;

type TrackKind = TrackV3['kind'];

export type ClipTimedWord = { start: number; end: number; clipId?: string };

export function clipSpanTargetsForRange(manifest: ManifestV3 | null | undefined, start: number, end: number, trackKind?: TrackKind): ClipSpanTargetV3[] {
  const rangeStart = Math.min(start, end);
  const rangeEnd = Math.max(start, end);
  if (rangeEnd <= rangeStart) return [];
  return (manifest?.tracks || [])
    .filter((track) => !trackKind || track.kind === trackKind)
    .flatMap((track) => track.clips.map((clip) => ({ track, clip })))
    .sort((a, b) => a.clip.timelineStart - b.clip.timelineStart)
    .flatMap(({ track, clip }) => {
      const duration = Math.max(0, clip.sourceEnd - clip.sourceStart);
      const clipStart = clip.timelineStart;
      const clipEnd = clipStart + duration;
      const overlapStart = Math.max(rangeStart, clipStart);
      const overlapEnd = Math.min(rangeEnd, clipEnd);
      if (overlapEnd <= overlapStart) return [];
      return [{ kind: 'clip-span' as const, trackId: track.trackId, clipId: clip.clipId, start: overlapStart - clipStart, end: overlapEnd - clipStart }];
    });
}

export function clipSpanTargetForRange(manifest: ManifestV3 | null | undefined, start: number, end: number, trackKind?: TrackKind): ClipSpanTargetV3 | null {
  return clipSpanTargetsForRange(manifest, start, end, trackKind)[0] || null;
}

export function clipAtTime(manifest: ManifestV3 | null | undefined, time: number, trackKind?: TrackKind) {
  return (manifest?.tracks || [])
    .filter((track) => !trackKind || track.kind === trackKind)
    .flatMap((track) => track.clips.map((clip) => ({ track, clip })))
    .find(({ clip }) => time >= clip.timelineStart && time <= clip.timelineStart + Math.max(0, clip.sourceEnd - clip.sourceStart)) || null;
}

export function videoClipAtTime(manifest: ManifestV3 | null | undefined, time: number) {
  return clipAtTime(manifest, time, 'video');
}

export function clipBoundaryAtTime(manifest: ManifestV3 | null | undefined, time: number, trackKind?: TrackKind): ClipBoundaryTargetV3 | null {
  const seams = (manifest?.tracks || [])
    .filter((track) => !trackKind || track.kind === trackKind)
    .flatMap((track) => {
    const clips = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart);
    return clips.slice(0, -1).flatMap((clip, index) => {
      const nextClip = clips[index + 1];
      if (!nextClip) return [];
      const boundary = clip.timelineStart + Math.max(0, clip.sourceEnd - clip.sourceStart);
      if (Math.abs(nextClip.timelineStart - boundary) > CLIP_BOUNDARY_TOLERANCE_SEC) return [];
      return [{ track, clip, boundary }];
    });
  });
  const seam = seams
    .filter((candidate) => Math.abs(candidate.boundary - time) <= CLIP_BOUNDARY_TOLERANCE_SEC)
    .sort((a, b) => Math.abs(a.boundary - time) - Math.abs(b.boundary - time))[0];
  return seam ? { kind: 'clip-boundary', trackId: seam.track.trackId, clipId: seam.clip.clipId } : null;
}

export function videoClipBoundaryAtTime(manifest: ManifestV3 | null | undefined, time: number): ClipBoundaryTargetV3 | null {
  return clipBoundaryAtTime(manifest, time, 'video');
}

export function clipSpanTargetsForWords(manifest: ManifestV3 | null | undefined, words: ClipTimedWord[]): ClipSpanTargetV3[] {
  if (!words.length) return [];
  if (!words.some((word) => word.clipId)) {
    return clipSpanTargetsForRange(manifest, words[0]!.start, words.at(-1)!.end);
  }

  const clipOwners = new Map<string, string>();
  for (const track of manifest?.tracks || []) {
    for (const clip of track.clips) clipOwners.set(clip.clipId, track.trackId);
  }

  const groups = new Map<string, { start: number; end: number }>();
  for (const word of words) {
    if (!word.clipId) continue;
    const group = groups.get(word.clipId);
    if (!group) groups.set(word.clipId, { start: word.start, end: word.end });
    else {
      group.start = Math.min(group.start, word.start);
      group.end = Math.max(group.end, word.end);
    }
  }

  return Array.from(groups.entries()).flatMap(([clipId, range]) => {
    const trackId = clipOwners.get(clipId);
    if (!trackId || range.end <= range.start) return [];
    return [{ kind: 'clip-span' as const, trackId, clipId, start: range.start, end: range.end }];
  });
}
