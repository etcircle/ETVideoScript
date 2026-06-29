"use client";
import { memo, useMemo } from 'react';
import type { ManifestV3 } from '@etvideoscript/core/browser';
import { wordTimelineRange } from '../../../../../store/selectors';

export type WordLike = { id: string; text: string; start: number; end: number; clipId?: string };

// Static layout = pure position + text. Current-word state is computed at render
// time so playback-tick re-renders don't re-walk every transcript word. Codex
// P2-1 (2026-05-25).
export type TimelineWordLabelLayout = {
  id: string;
  left: number;
  width: number;
  text: string;
  start: number;
  end: number;
};

export type TimelineWordLabelItem = TimelineWordLabelLayout & { current: boolean };

// 30 CSS px ≈ ~3 monospace chars at 0.55rem. Below this, labels overlap or
// become unreadable. Threshold is empirical — tune if word density on long
// projects becomes a problem.
export const WORD_LABEL_MIN_WIDTH_PX = 30;

type LayoutInput = {
  words: WordLike[] | undefined | null;
  manifest: ManifestV3 | null | undefined;
  trackId: string;
  duration: number;
  pxWidth: number;
  minWidthPx?: number;
};

export function buildWordLabelLayout(input: LayoutInput): TimelineWordLabelLayout[] {
  const { words, manifest, trackId, duration, pxWidth } = input;
  const minWidthPx = input.minWidthPx ?? WORD_LABEL_MIN_WIDTH_PX;
  if (!words || !manifest || duration <= 0 || pxWidth <= 0) return [];

  // Map every clip in the manifest to the track that owns it so we can drop
  // words from other tracks. Unknown clipIds resolve to `undefined` and are
  // skipped (codex P1 2026-05-25 — previously they fell through and rendered
  // on every lane).
  const clipToTrack = new Map<string, string>();
  for (const track of manifest.tracks) {
    for (const clip of track.clips) clipToTrack.set(clip.clipId, track.trackId);
  }
  // Schema default: TranscriptWord.clipId is `''` for legacy single-clip
  // transcripts. Fall back to the manifest's first clip — same convention as
  // derivePreviewScriptFromTimeMap (`packages/core/src/transcript/preview-script.ts:86`).
  const defaultClipId = manifest.tracks.flatMap((track) => track.clips)[0]?.clipId ?? '';

  const out: TimelineWordLabelLayout[] = [];
  for (const word of words) {
    const effectiveClipId = word.clipId || defaultClipId;
    if (!effectiveClipId) continue;
    const owner = clipToTrack.get(effectiveClipId);
    if (owner !== trackId) continue;
    // Project through the *effective* clipId so legacy empty-clipId words land
    // on their default clip's timelineStart, not raw transcript origin
    // (codex pass 2 P2-a 2026-05-25). Same fallback we use for ownership.
    const range = wordTimelineRange(manifest, { ...word, clipId: effectiveClipId });
    if (range.end <= range.start) continue;
    const left = (range.start / duration) * pxWidth;
    const width = ((range.end - range.start) / duration) * pxWidth;
    if (width < minWidthPx) continue;
    // Per-clip transcripts can reuse word.id (e.g. `w000001`) across clips
    // after `mergeTranscripts`. Prefix with effectiveClipId to keep React keys
    // stable on multi-clip same-track timelines (codex pass 2 P2-b 2026-05-25).
    out.push({ id: `${effectiveClipId}|${word.id}`, left, width, text: word.text, start: range.start, end: range.end });
  }
  return out;
}

// Retained for tests: composes layout + current flag in one call.
export function buildWordLabelItems(input: LayoutInput & { currentTime: number }): TimelineWordLabelItem[] {
  return buildWordLabelLayout(input).map((item) => ({
    ...item,
    current: input.currentTime >= item.start && input.currentTime < item.end
  }));
}

function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}

type Props = {
  words: WordLike[] | undefined | null;
  manifest: ManifestV3 | null | undefined;
  trackId: string;
  duration: number;
  pxWidth: number;
  currentTime: number;
  onSeek: (time: number) => void;
};

export const TimelineWordLabels = memo(function TimelineWordLabels({ words, manifest, trackId, duration, pxWidth, currentTime, onSeek }: Props) {
  // Heavy work (filter, ownership lookup, layout) memoizes on inputs that
  // change rarely. Playback-tick re-renders only diff the small `current`
  // class on individual buttons.
  const layout = useMemo(() => buildWordLabelLayout({ words, manifest, trackId, duration, pxWidth }), [words, manifest, trackId, duration, pxWidth]);
  if (layout.length === 0) return null;
  return <div className="tl-word-labels" aria-label="Transcript words on timeline">
    {layout.map((item) => {
      const current = currentTime >= item.start && currentTime < item.end;
      const label = `Seek to "${item.text}" at ${formatTimestamp(item.start)}`;
      return <button
        key={item.id}
        type="button"
        // tabIndex={-1} keeps these out of the global tab order — the timeline
        // already has its own keyboard navigation (ArrowLeft/Right, Home/End)
        // and 50+ word stops would be an unnavigable wall. Mouse/touch click
        // still works. Codex P2-2 (2026-05-25).
        tabIndex={-1}
        className={`tl-word-label${current ? ' current' : ''}`}
        style={{ left: item.left, width: item.width }}
        onClick={(event) => { event.stopPropagation(); onSeek(item.start); }}
        onPointerDown={(event) => { event.stopPropagation(); }}
        aria-label={label}
        title={label}
      >{item.text}</button>;
    })}
  </div>;
});
