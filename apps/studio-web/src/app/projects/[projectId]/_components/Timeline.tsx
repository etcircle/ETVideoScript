"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import { getOperationKind, type OperationV3, type TrackV3 } from '@etvideoscript/core/browser';
import { API } from '../../../../lib/api';
import { useEditorStore } from '../../../../store/editorStore';
import { clipSpanTargetsForRange } from '../../../../store/editTargets';
import { operationTimelineRange, projectDuration, wordTimelineRange } from '../../../../store/selectors';
import { buildClipTimeline, loadWaveformPeaks, type WaveformPeaks } from './timeline/waveform';
import { type TimelineOperationView } from './timeline/operationTones';
import { WaveformCanvas } from './timeline/WaveformCanvas';
import { TimelineWordLabels, type WordLike } from './timeline/TimelineWordLabels';

// ─── helpers ─────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }

function trackChipLabel(kind: string, index: number) {
  return `${kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'C'}${index + 1}`;
}

function formatTime(seconds: number) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function numberFrom(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function stringFrom(value: unknown) { return typeof value === 'string' ? value : null; }

type HighlightMarker = { id: string; t: number; label: string; score?: number; reason?: string };
type SilenceRegion = { id: string; start: number; end: number; conf?: number; label?: string };

function collectArrays(root: unknown, names: string[], maxDepth = 4): unknown[][] {
  const found: unknown[][] = [];
  const seen = new Set<unknown>();
  function visit(value: unknown, depth: number) {
    if (!isObject(value) || seen.has(value) || depth > maxDepth) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (names.includes(key) && Array.isArray(child)) found.push(child);
      else if (isObject(child)) visit(child, depth + 1);
    }
  }
  visit(root, 0);
  return found;
}

function extractHighlights(...roots: unknown[]): HighlightMarker[] {
  const candidates = roots.flatMap((root) => collectArrays(root, ['highlights', 'hooks', 'highlightMarkers', 'hookMarkers'])).flat();
  const markers = candidates.flatMap((candidate, index): HighlightMarker[] => {
    if (!isObject(candidate)) return [];
    const t = numberFrom(candidate.t) ?? numberFrom(candidate.start) ?? numberFrom(candidate.startSec) ?? numberFrom(candidate.time) ?? numberFrom(candidate.timeSec);
    if (t == null) return [];
    const label = stringFrom(candidate.label) ?? stringFrom(candidate.title) ?? stringFrom(candidate.reason) ?? 'hook';
    const score = numberFrom(candidate.score) ?? numberFrom(candidate.confidence);
    const reason = stringFrom(candidate.reason) ?? undefined;
    return [{ id: stringFrom(candidate.id) ?? stringFrom(candidate.highlightId) ?? `hl-${index}-${t}`, t, label, score: score ?? undefined, reason }];
  });
  return markers.sort((a, b) => a.t - b.t);
}

function extractSilences(...roots: unknown[]): SilenceRegion[] {
  const candidates = roots.flatMap((root) => collectArrays(root, ['silences', 'silenceRegions', 'detectedSilences'])).flat();
  const regions = candidates.flatMap((candidate, index): SilenceRegion[] => {
    if (!isObject(candidate)) return [];
    const start = numberFrom(candidate.start) ?? numberFrom(candidate.startSec) ?? numberFrom(candidate.from);
    const end = numberFrom(candidate.end) ?? numberFrom(candidate.endSec) ?? numberFrom(candidate.to);
    if (start == null || end == null || end <= start) return [];
    const conf = numberFrom(candidate.conf) ?? numberFrom(candidate.confidence) ?? undefined;
    return [{ id: stringFrom(candidate.id) ?? `sil-${index}-${start}`, start, end, conf, label: stringFrom(candidate.label) ?? undefined }];
  });
  return regions.sort((a, b) => a.start - b.start);
}

function captionGroups(words: NonNullable<ReturnType<typeof useEditorStore.getState>['transcript']>['words'], manifest: ReturnType<typeof useEditorStore.getState>['manifest']) {
  const groups: Array<{ id: string; text: string; start: number; end: number }> = [];
  for (let index = 0; index < Math.min(words.length, 180); index += 3) {
    const chunk = words.slice(index, index + 3);
    if (!chunk.length) continue;
    const first = wordTimelineRange(manifest, chunk[0]!);
    const last = wordTimelineRange(manifest, chunk[chunk.length - 1]!);
    if (last.end <= first.start) continue;
    groups.push({ id: chunk.map((w) => w.id).join('-'), text: chunk.map((w) => w.text).join(' '), start: first.start, end: last.end });
  }
  return groups;
}

// ─── Lane descriptor types ────────────────────────────────────────────────────
//
// Lanes presented to the user are DECOUPLED from raw manifest tracks.
// A single video track always spawns two visual lanes: a filmstrip lane and a
// dialog/audio lane.  The audio-dialog lane is "virtual" — it has no own
// manifest track; it shares the video track's clips/peaks/fx for wiring.
//
// laneId is stable per lane so React keys stay stable.

type VideoFilmstripLane = {
  kind: 'video-filmstrip';
  laneId: string;
  chipLabel: string;          // 'V1'
  track: TrackV3;             // the real video track
  height: 60;
};

type AudioDialogLane = {
  kind: 'audio-dialog';
  laneId: string;
  chipLabel: string;          // 'A1'
  // backed by the parent video track (or a real audio track)
  track: TrackV3;
  isVirtual: boolean;         // true when derived from video track, not a manifest audio track
  height: 96;
};

type AudioExtraLane = {
  kind: 'audio-extra';
  laneId: string;
  chipLabel: string;
  track: TrackV3;             // real manifest audio track
  height: 96;
};

type CaptionLane = {
  kind: 'caption';
  laneId: string;
  chipLabel: string;          // 'CC'
  track: TrackV3 | null;      // null when virtual
  height: 48;
};

type LaneDescriptor = VideoFilmstripLane | AudioDialogLane | AudioExtraLane | CaptionLane;

function laneHeight(lane: LaneDescriptor): number { return lane.height; }

/**
 * Build the 3-lane design stack from manifest tracks.
 *
 * For a project with a single video track (the common real case) this produces:
 *   [video-filmstrip, audio-dialog (virtual), caption (virtual)]
 *
 * Real manifest audio tracks are appended after the dialog lane.
 * Real manifest caption tracks replace the virtual caption lane.
 */
function deriveLaneStack(tracks: TrackV3[]): LaneDescriptor[] {
  const lanes: LaneDescriptor[] = [];

  let videoCount = 0;
  let audioCount = 0;
  let captionCount = 0;
  let hasCaptionLane = false;

  // First pass: real video tracks → filmstrip + dialog lane each
  for (const track of tracks) {
    if (track.kind === 'video') {
      const vIdx = videoCount++;
      lanes.push({
        kind: 'video-filmstrip',
        laneId: `${track.trackId}__filmstrip`,
        chipLabel: `V${vIdx + 1}`,
        track,
        height: 60,
      });
      // The virtual dialog/audio lane beneath this video track
      lanes.push({
        kind: 'audio-dialog',
        laneId: `${track.trackId}__audio`,
        chipLabel: `A${audioCount + 1}`,
        track,
        isVirtual: true,
        height: 96,
      });
      audioCount++;
    }
  }

  // Second pass: real audio tracks
  for (const track of tracks) {
    if (track.kind === 'audio') {
      const isDialog = !track.subtype || track.subtype === 'dialog';
      if (isDialog) {
        lanes.push({
          kind: 'audio-dialog',
          laneId: `${track.trackId}__audio`,
          chipLabel: `A${audioCount + 1}`,
          track,
          isVirtual: false,
          height: 96,
        });
      } else {
        lanes.push({
          kind: 'audio-extra',
          laneId: track.trackId,
          chipLabel: `A${audioCount + 1}`,
          track,
          height: 96,
        });
      }
      audioCount++;
    }
  }

  // Third pass: real caption tracks
  for (const track of tracks) {
    if (track.kind === 'caption') {
      lanes.push({
        kind: 'caption',
        laneId: track.trackId,
        chipLabel: `C${captionCount + 1}`,
        track,
        height: 48,
      });
      captionCount++;
      hasCaptionLane = true;
    }
  }

  // Always ensure at least one caption lane
  if (!hasCaptionLane) {
    lanes.push({
      kind: 'caption',
      laneId: '__virtual_caption__',
      chipLabel: 'CC',
      track: null,
      height: 48,
    });
  }

  return lanes;
}

// ─── SVG icons ───────────────────────────────────────────────────────────────

function IconEye() {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M1 8s2.8-5 7-5 7 5 7 5-2.8 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
  </svg>;
}

function IconEyeOff() {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2 2l12 12M6.5 6.6A2 2 0 0 0 9.4 9.5M4.4 4.5C2.8 5.7 1 8 1 8s2.8 5 7 5c1.3 0 2.4-.3 3.4-.8M7 3.1C7.3 3 7.7 3 8 3c4.2 0 7 5 7 5s-.7 1.2-1.8 2.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>;
}

function IconLock() {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
    <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>;
}

function IconUnlock() {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
    <path d="M5 7V5a3 3 0 1 1 6 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>;
}

function IconSpeaker() {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3 6H1v4h2l4 3V3L3 6z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M11 5a4 4 0 0 1 0 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>;
}

function IconSpeakerMute() {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3 6H1v4h2l4 3V3L3 6z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M13 6l-3 3m0-3l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>;
}

// ─── sub-components ───────────────────────────────────────────────────────────

function FxChip({ on, letter, tip, onClick }: { on: boolean; letter: string; tip: string; onClick: () => void }) {
  return <button
    type="button"
    className={`tl-fx-chip${on ? ' on' : ''}`}
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    title={tip}
    aria-pressed={on}
  >{letter}</button>;
}

function AddTrackMenu({ onAdd }: { onAdd: (subtype: 'dialog' | 'music' | 'sfx') => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function clickOff(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', clickOff);
    return () => document.removeEventListener('mousedown', clickOff);
  }, []);

  return <div className="tl-add-track" ref={ref}>
    <button type="button" className="tl-add-track-btn" onClick={() => setOpen((v) => !v)}>
      <span>＋</span> add audio
    </button>
    {open && <div className="tl-add-track-menu">
      <button type="button" onClick={() => { onAdd('dialog'); setOpen(false); }}>
        <span className="kind-pill kind-dialog">A</span> Dialog
        <span className="hint">VO · interview</span>
      </button>
      <button type="button" onClick={() => { onAdd('music'); setOpen(false); }}>
        <span className="kind-pill kind-music">A</span> Music
        <span className="hint">background score</span>
      </button>
      <button type="button" onClick={() => { onAdd('sfx'); setOpen(false); }}>
        <span className="kind-pill kind-sfx">A</span> SFX
        <span className="hint">stings · ambient</span>
      </button>
    </div>}
  </div>;
}

function TrackNameInput({ track }: { track: TrackV3 }) {
  const patchTrack = useEditorStore((state) => state.patchTrack);
  const [draft, setDraft] = useState(track.name);
  const skipNextCommitRef = useRef(false);

  useEffect(() => { setDraft(track.name); }, [track.name]);

  function commit() {
    if (skipNextCommitRef.current) { skipNextCommitRef.current = false; return; }
    const name = draft.trim();
    if (!name) { setDraft(track.name); return; }
    if (name !== track.name) void patchTrack(track.trackId, { name });
  }

  return <input
    className="tl-head-name"
    value={draft}
    aria-label={`Rename ${track.name}`}
    onChange={(e) => setDraft(e.target.value)}
    onBlur={commit}
    onKeyDown={(e) => {
      if (e.key === 'Enter') e.currentTarget.blur();
      if (e.key === 'Escape') { skipNextCommitRef.current = true; setDraft(track.name); e.currentTarget.blur(); }
    }}
  />;
}

// ─── Per-lane track headers ───────────────────────────────────────────────────

type LaneHeaderProps = {
  lane: LaneDescriptor;
  removable: boolean;
  onReorder: (delta: number) => void;
};

function LaneHeader({ lane, removable, onReorder }: LaneHeaderProps) {
  const state = useEditorStore();

  if (lane.kind === 'video-filmstrip') {
    const track = lane.track;
    return <div
      className={`tl-head tl-head-video${track.hidden ? ' is-hidden' : ''}`}
      style={{ height: lane.height }}
    >
      <div className="tl-head-row">
        <span className={`tl-head-id kind-video`}>{lane.chipLabel}</span>
        <TrackNameInput track={track} />
        {removable && <button type="button" className="tl-head-x" onClick={() => void state.removeTrack(track.trackId)} title="Remove track">×</button>}
      </div>
      <div className="tl-head-controls">
        <button type="button" className={`tl-icon-btn${!track.hidden ? ' on' : ''}`} onClick={() => void state.patchTrack(track.trackId, { hidden: !track.hidden })} title={track.hidden ? 'Show video' : 'Hide video'}>
          {track.hidden ? <IconEyeOff /> : <IconEye />}
        </button>
        <button type="button" className={`tl-icon-btn${track.locked ? ' on' : ''}`} onClick={() => void state.patchTrack(track.trackId, { locked: !track.locked })} title={track.locked ? 'Unlock track' : 'Lock track'}>
          {track.locked ? <IconLock /> : <IconUnlock />}
        </button>
        <button type="button" className="tl-icon-btn" onClick={() => onReorder(-1)} aria-label="Move track up">↑</button>
        <button type="button" className="tl-icon-btn" onClick={() => onReorder(1)} aria-label="Move track down">↓</button>
      </div>
    </div>;
  }

  if (lane.kind === 'audio-dialog') {
    const track = lane.track;
    const fx = track.fx;
    const isVirtual = lane.isVirtual;
    return <div
      className={`tl-head tl-head-audio${track.muted ? ' is-muted' : ''}${track.locked ? ' is-locked' : ''}`}
      style={{ height: lane.height }}
    >
      <div className="tl-head-row">
        <span className={`tl-head-id kind-audio`}>{lane.chipLabel}</span>
        {isVirtual
          // Virtual dialog lane: read-only label — track name lives in the video lane header above
          ? <span className="tl-head-name" title="dialog audio from video track">dialog</span>
          : <TrackNameInput track={track} />
        }
        {removable && !isVirtual && <button type="button" className="tl-head-x" onClick={() => void state.removeTrack(track.trackId)} title="Remove track">×</button>}
      </div>
      <div className="tl-head-controls">
        <button type="button" className={`tl-icon-btn${track.muted ? ' on warn' : ''}`} onClick={() => void state.patchTrack(track.trackId, { muted: !track.muted })} title={track.muted ? 'Unmute' : 'Mute'}>
          {track.muted ? <IconSpeakerMute /> : <IconSpeaker />}
        </button>
        <button type="button" className={`tl-icon-btn${track.solo ? ' on accent' : ''}`} onClick={() => void state.patchTrack(track.trackId, { solo: !track.solo })} title={track.solo ? 'Unsolo' : 'Solo'}>
          <span className="tl-letter">S</span>
        </button>
        <button type="button" className={`tl-icon-btn${track.locked ? ' on' : ''}`} onClick={() => void state.patchTrack(track.trackId, { locked: !track.locked })} title={track.locked ? 'Unlock track' : 'Lock track'}>
          {track.locked ? <IconLock /> : <IconUnlock />}
        </button>
        {!isVirtual && <>
          <button type="button" className="tl-icon-btn" onClick={() => onReorder(-1)} aria-label="Move track up">↑</button>
          <button type="button" className="tl-icon-btn" onClick={() => onReorder(1)} aria-label="Move track down">↓</button>
        </>}
      </div>
      {/* FX rack — EN / DN / DR */}
      <div className="tl-fx-rack" role="toolbar" aria-label="Audio FX">
        <FxChip on={Boolean(fx?.enhance)} letter="EN" tip="Enhance · loudnorm + tone" onClick={() => void state.patchTrack(track.trackId, { fx: { enhance: !fx?.enhance, denoise: Boolean(fx?.denoise), dereverb: Boolean(fx?.dereverb) } })} />
        <FxChip on={Boolean(fx?.denoise)} letter="DN" tip="Denoise · afftdn / arnndn" onClick={() => void state.patchTrack(track.trackId, { fx: { enhance: Boolean(fx?.enhance), denoise: !fx?.denoise, dereverb: Boolean(fx?.dereverb) } })} />
        <FxChip on={Boolean(fx?.dereverb)} letter="DR" tip="Dereverb · room tone cleanup" onClick={() => void state.patchTrack(track.trackId, { fx: { enhance: Boolean(fx?.enhance), denoise: Boolean(fx?.denoise), dereverb: !fx?.dereverb } })} />
      </div>
      {/* Studio Sound stamp lives once, in the lane body (AudioWaveformLane) — prototype stamps once. */}
    </div>;
  }

  if (lane.kind === 'audio-extra') {
    const track = lane.track;
    const fx = track.fx;
    return <div
      className={`tl-head tl-head-audio${track.muted ? ' is-muted' : ''}${track.locked ? ' is-locked' : ''}`}
      style={{ height: lane.height }}
    >
      <div className="tl-head-row">
        <span className={`tl-head-id kind-audio`}>{lane.chipLabel}</span>
        <TrackNameInput track={track} />
        {removable && <button type="button" className="tl-head-x" onClick={() => void state.removeTrack(track.trackId)} title="Remove track">×</button>}
      </div>
      <div className="tl-head-controls">
        <button type="button" className={`tl-icon-btn${track.muted ? ' on warn' : ''}`} onClick={() => void state.patchTrack(track.trackId, { muted: !track.muted })} title={track.muted ? 'Unmute' : 'Mute'}>
          {track.muted ? <IconSpeakerMute /> : <IconSpeaker />}
        </button>
        <button type="button" className={`tl-icon-btn${track.solo ? ' on accent' : ''}`} onClick={() => void state.patchTrack(track.trackId, { solo: !track.solo })} title={track.solo ? 'Unsolo' : 'Solo'}>
          <span className="tl-letter">S</span>
        </button>
        <button type="button" className={`tl-icon-btn${track.locked ? ' on' : ''}`} onClick={() => void state.patchTrack(track.trackId, { locked: !track.locked })} title={track.locked ? 'Unlock track' : 'Lock track'}>
          {track.locked ? <IconLock /> : <IconUnlock />}
        </button>
        <button type="button" className="tl-icon-btn" onClick={() => onReorder(-1)} aria-label="Move track up">↑</button>
        <button type="button" className="tl-icon-btn" onClick={() => onReorder(1)} aria-label="Move track down">↓</button>
      </div>
      {/* FX rack — EN / DN / DR */}
      <div className="tl-fx-rack" role="toolbar" aria-label="Audio FX">
        <FxChip on={Boolean(fx?.enhance)} letter="EN" tip="Enhance · loudnorm + tone" onClick={() => void state.patchTrack(track.trackId, { fx: { enhance: !fx?.enhance, denoise: Boolean(fx?.denoise), dereverb: Boolean(fx?.dereverb) } })} />
        <FxChip on={Boolean(fx?.denoise)} letter="DN" tip="Denoise · afftdn / arnndn" onClick={() => void state.patchTrack(track.trackId, { fx: { enhance: Boolean(fx?.enhance), denoise: !fx?.denoise, dereverb: Boolean(fx?.dereverb) } })} />
        <FxChip on={Boolean(fx?.dereverb)} letter="DR" tip="Dereverb · room tone cleanup" onClick={() => void state.patchTrack(track.trackId, { fx: { enhance: Boolean(fx?.enhance), denoise: Boolean(fx?.denoise), dereverb: !fx?.dereverb } })} />
      </div>
      {/* Studio Sound stamp lives once, in the lane body (AudioWaveformLane) — prototype stamps once. */}
    </div>;
  }

  if (lane.kind === 'caption') {
    return <div className="tl-head tl-head-caption" style={{ height: lane.height }}>
      <div className="tl-head-row">
        <span className={`tl-head-id kind-caption`}>{lane.chipLabel}</span>
        <span className="tl-head-name" title="captions · burn-in">captions · burn-in</span>
      </div>
      <div className="tl-head-controls">
        <span className="tl-cap-style" title="Active caption style">shorts-bold</span>
        <button type="button" className="tl-icon-btn on" disabled title="Caption track is locked to the manifest">
          <IconLock />
        </button>
      </div>
    </div>;
  }

  return null;
}

function FilmFrame({ index, current }: { index: number; current: boolean }) {
  const kind = index % 4;
  return <svg className={`film-frame${current ? ' current' : ''}`} viewBox="0 0 34 22" aria-hidden="true">
    <rect className="frame-bg" x="0.5" y="0.5" width="33" height="21" rx="3" />
    {kind === 0 ? <><circle cx="17" cy="8" r="3.2" /><path d="M9 19c1.7-5 14.3-5 16 0" /></> : null}
    {kind === 1 ? <><path d="M4 16l7-7 5 5 4-4 10 8" /><circle cx="26" cy="6" r="2" /></> : null}
    {kind === 2 ? <><path d="M8 8h18M6 13h22M12 17h10" /></> : null}
    {kind === 3 ? <><rect x="7" y="6" width="20" height="10" rx="1.5" /><path d="M10 18h14" /></> : null}
  </svg>;
}

type AudioWaveformLaneProps = {
  clipPeaks: Record<string, WaveformPeaks>;
  clipTimeline: ReturnType<typeof buildClipTimeline>;
  pxWidth: number;
  duration: number;
  height: number;
  operations: TimelineOperationView[];
  showSilences: boolean;
  silences: SilenceRegion[];
  studioSound: boolean;
  ariaLabel: string;
  words: WordLike[] | undefined;
  manifest: ReturnType<typeof useEditorStore.getState>['manifest'];
  trackId: string;
  currentTime: number;
  onSeek: (time: number) => void;
  timeToPx: (t: number) => number;
  // Per-word labels collide with the caption-pill lane at normal zoom (the
  // "captions twice" bug). Only show them once zoomed in enough that the
  // waveform is wide and word labels read as a scrubbable strip, not a
  // duplicate caption row.
  showWordLabels: boolean;
};

function AudioWaveformLane({ clipPeaks, clipTimeline, pxWidth, duration, height, operations, showSilences, silences, studioSound, ariaLabel, words, manifest, trackId, currentTime, onSeek, timeToPx, showWordLabels }: AudioWaveformLaneProps) {
  return <>
    {studioSound ? <span className="audio-fx-stamp" title="Studio Sound applied">✦ studio sound</span> : null}
    <WaveformCanvas clipPeaks={clipPeaks} clipTimeline={clipTimeline} pxWidth={pxWidth} height={height} duration={duration} operations={operations} ariaLabel={ariaLabel} />
    {showWordLabels ? <TimelineWordLabels words={words} manifest={manifest} trackId={trackId} duration={duration} pxWidth={pxWidth} currentTime={currentTime} onSeek={onSeek} /> : null}
    {showSilences ? silences.map((silence) => (
      <button
        type="button"
        key={silence.id}
        className="silence-box"
        style={{ left: timeToPx(silence.start), width: Math.max(10, timeToPx(silence.end - silence.start)) }}
        onClick={(e) => { e.stopPropagation(); }}
        title={`Silence ${(silence.end - silence.start).toFixed(2)}s${silence.conf != null ? ` · conf ${Math.round(silence.conf * 100)}%` : ''}`}
        aria-label={`Silence ${formatTime(silence.start)} to ${formatTime(silence.end)}`}
      >
        <span className="silence-label">{silence.label ?? 'silence'}</span>
      </button>
    )) : null}
  </>;
}

// ─── main export ─────────────────────────────────────────────────────────────

const TL_HEAD_W = 186;
const RULER_H = 22;

export function Timeline() {
  const state = useEditorStore();
  const manifest = state.manifest;
  // Raw manifest tracks sorted by order — used for data/mutations only
  const manifestTracks = [...(manifest?.tracks || [])].sort((a, b) => a.order - b.order);
  const videoTrack = manifestTracks.find((t) => t.kind === 'video');
  const duration = projectDuration(manifest, state.transcript) || 1;

  const [clipPeaks, setClipPeaks] = useState<Record<string, WaveformPeaks>>({});
  // Default ON — matches prototype default (app-v4.jsx useState(true)).
  const [showSilences, setShowSilences] = useState(true);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const keyboardAnchorRef = useRef<number | null>(null);
  const [width, setWidth] = useState(900);

  const pxWidth = Math.max(900, duration * 60 * state.timelineZoom);
  // Zoom-gate per-word labels so they don't visually duplicate the caption-pill
  // lane at normal zoom ("captions twice" bug). At >= 2x the waveform is wide
  // enough that the word strip reads as a scrubbable label row, not captions.
  const showWordLabels = state.timelineZoom >= 2;
  const clipTimeline = useMemo(() => buildClipTimeline(videoTrack?.clips || []), [videoTrack]);
  const timeToPx = useMemo(() => (t: number) => (t / duration) * pxWidth, [duration, pxWidth]);

  // ── Lane stack — decoupled from raw manifest tracks ──
  const laneStack = useMemo(() => deriveLaneStack(manifestTracks), [manifestTracks]);

  // Adaptive ruler tick density
  const tickEvery = duration > 90 ? 15 : duration > 30 ? 5 : 2;

  const operationViews = useMemo<TimelineOperationView[]>(() => (manifest?.operations || []).flatMap((op) => {
    const range = operationTimelineRange(manifest, op);
    if (!range) return [];
    return [{ op, view: getOperationKind(op.type).timelineView(op), range }];
  }), [manifest]);

  const highlights = useMemo(() => extractHighlights(manifest, state.project, state.diagnostics, state.transcript), [manifest, state.project, state.diagnostics, state.transcript]);
  const silences = useMemo(() => extractSilences(manifest, state.project, state.diagnostics, state.transcript), [manifest, state.project, state.diagnostics, state.transcript]);

  // ── Lane positions for op spanning (computed from lane stack) ──
  const lanePositions = useMemo(() => {
    const map: Record<string, { top: number; height: number }> = {};
    let y = 0;
    for (const lane of laneStack) {
      map[lane.laneId] = { top: y, height: lane.height };
      y += laneHeight(lane);
    }
    return { map, total: y };
  }, [laneStack]);

  // Op spanning helpers: cuts/mutes span everything; voice_patch → first dialog lane; overlay/transition → first video filmstrip lane
  const firstDialogLaneId = laneStack.find((l) => l.kind === 'audio-dialog')?.laneId;
  const firstVideoLaneId = laneStack.find((l) => l.kind === 'video-filmstrip')?.laneId;

  function rangeForOp(op: OperationV3) {
    if (op.type === 'cut' || op.type === 'mute') {
      return { top: 0, height: lanePositions.total };
    }
    if (op.type === 'voice_patch') {
      const p = firstDialogLaneId ? lanePositions.map[firstDialogLaneId] : null;
      return p ?? { top: 0, height: lanePositions.total };
    }
    if (op.type === 'overlay' || op.type === 'transition') {
      const p = firstVideoLaneId ? lanePositions.map[firstVideoLaneId] : null;
      return p ?? { top: 0, height: 60 };
    }
    return { top: 0, height: lanePositions.total };
  }

  useEffect(() => {
    const update = () => setWidth(Math.floor(bodyRef.current?.clientWidth || 900));
    update(); window.addEventListener('resize', update); return () => window.removeEventListener('resize', update);
  }, []);

  // Re-centre on playhead after zoom change
  useEffect(() => {
    const el = bodyRef.current; const c = contentRef.current;
    if (!el || !c) return;
    const playheadX = (state.currentTime / duration) * c.offsetWidth;
    el.scrollLeft = Math.max(0, playheadX - el.clientWidth / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.timelineZoom]);

  useEffect(() => {
    let cancelled = false;
    // Load peaks for all manifest tracks' clips
    const clipIds = manifestTracks.flatMap((t) => t.clips.map((c) => c.clipId));
    loadWaveformPeaks(fetch, API, state.projectId, clipIds).then((result) => {
      if (cancelled) return;
      if (result.kind === 'per-clip') setClipPeaks(result.clipPeaks);
      else setClipPeaks({});
    }).catch(() => { setClipPeaks({}); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.projectId, manifestTracks.flatMap((t) => t.clips.map((c) => c.clipId)).join('|')]);

  // ── clip / trim drag ──
  function clipPointerDown(e: React.PointerEvent<HTMLDivElement>, clipId: string, timelineStart: number) {
    e.stopPropagation();
    const originX = e.clientX;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    function up(ev: PointerEvent) {
      target.releasePointerCapture(e.pointerId);
      window.removeEventListener('pointerup', up);
      const delta = ((ev.clientX - originX) / pxWidth) * duration;
      void state.moveClip(clipId, clamp(timelineStart + delta, 0, duration));
    }
    window.addEventListener('pointerup', up, { once: true });
  }

  function trimPointerDown(e: React.PointerEvent<HTMLButtonElement>, clip: TrackV3['clips'][number], edge: 'start' | 'end') {
    e.stopPropagation();
    const originX = e.clientX;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    function up(ev: PointerEvent) {
      target.releasePointerCapture(e.pointerId);
      window.removeEventListener('pointerup', up);
      const delta = ((ev.clientX - originX) / pxWidth) * duration;
      const sourceStart = edge === 'start' ? clamp(clip.sourceStart + delta, 0, clip.sourceEnd - 0.1) : clip.sourceStart;
      const sourceEnd = edge === 'end' ? Math.max(sourceStart + 0.1, clip.sourceEnd + delta) : clip.sourceEnd;
      void state.trimClip(clip.clipId, sourceStart, sourceEnd);
    }
    window.addEventListener('pointerup', up, { once: true });
  }

  // ── timeline seek / selection ──
  function timeFromClientX(clientX: number) {
    const el = bodyRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft;
    return clamp((x / pxWidth) * duration, 0, duration);
  }

  function timelinePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    if (e.target instanceof HTMLElement && e.target.closest('button,input,select')) return;
    const target = e.currentTarget;
    const originX = e.clientX;
    const originTime = timeFromClientX(e.clientX);
    let dragged = false;
    target.setPointerCapture(e.pointerId);
    state.setSelection(null);
    function move(ev: PointerEvent) {
      const nextTime = timeFromClientX(ev.clientX);
      if (!dragged && Math.abs(ev.clientX - originX) < 4) return;
      dragged = true;
      state.setSelection({ start: Math.min(originTime, nextTime), end: Math.max(originTime, nextTime) });
    }
    function up(ev: PointerEvent) {
      target.releasePointerCapture(e.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const nextTime = timeFromClientX(ev.clientX);
      if (dragged) {
        const start = Math.min(originTime, nextTime);
        const end = Math.max(originTime, nextTime);
        state.setSelection(end > start ? { start, end } : null);
        state.seek(start);
      } else {
        keyboardAnchorRef.current = null;
        state.seek(nextTime);
        state.setSelection(null);
      }
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  function seekOperation(start: number, end: number, opId: string) {
    keyboardAnchorRef.current = null;
    state.seek(start);
    state.setSelection({ start, end, opId });
  }

  async function createRangeOperation(type: 'cut' | 'mute') {
    if (!state.selection || state.selection.end <= state.selection.start) return;
    const targets = clipSpanTargetsForRange(manifest, state.selection.start, state.selection.end);
    for (const target of targets) await state.createOperation({ type, target, reason: `Manual ${type} from timeline` });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'PageUp' ? -5 : e.key === 'PageDown' ? 5 : null;
    if (delta != null) {
      e.preventDefault();
      const next = clamp(state.currentTime + delta, 0, duration);
      if (e.shiftKey) {
        const anchor = keyboardAnchorRef.current ?? state.currentTime;
        keyboardAnchorRef.current = anchor;
        state.seek(next);
        state.setSelection({ start: Math.min(anchor, next), end: Math.max(anchor, next) });
      } else {
        keyboardAnchorRef.current = null;
        state.seek(next);
        state.setSelection(null);
      }
    }
    if (e.key === 'Home') { e.preventDefault(); keyboardAnchorRef.current = null; state.seek(0); state.setSelection(null); }
    if (e.key === 'End') { e.preventDefault(); keyboardAnchorRef.current = null; state.seek(duration); state.setSelection(null); }
  }

  // ── track management (operate on real manifest tracks) ──
  function reorder(track: TrackV3, delta: number) {
    const sorted = [...manifestTracks];
    const index = sorted.findIndex((t) => t.trackId === track.trackId);
    const nextIndex = clamp(index + delta, 0, sorted.length - 1);
    const [item] = sorted.splice(index, 1);
    sorted.splice(nextIndex, 0, item!);
    void state.reorderTracks(sorted.map((t, order) => ({ trackId: t.trackId, order })));
  }

  function addAudioTrack(subtype: 'dialog' | 'music' | 'sfx') {
    const order = Math.max(-1, ...manifestTracks.map((t) => t.order)) + 1;
    const names = { dialog: 'Dialog', music: 'Music', sfx: 'SFX' };
    void state.addTrack({
      trackId: `track_audio_${Date.now()}`,
      kind: 'audio',
      subtype,
      name: names[subtype],
      order,
      locked: false,
      muted: false,
      solo: false,
      hidden: false,
      role: 'timeline',
      fx: { enhance: false, denoise: false, dereverb: false }
    });
  }

  // ── collapsed state ──
  if (state.timelineCollapsed) {
    return <div className="timeline collapsed">
      <button type="button" className="pane-rail-h" onClick={() => state.setTimelineCollapsed(false)} title="Expand timeline">
        <span className="pane-rail-chev" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 12 12"><path d="M3 8 L6 4 L9 8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <span className="pane-rail-label-h">Timeline · {manifest?.operations.length || 0} edits · {manifestTracks.length} tracks · {formatTime(duration)}</span>
        <span className="pane-rail-meta">drag up to expand</span>
      </button>
    </div>;
  }

  return <div className="timeline" aria-label="Timeline">
    {/* ── Transport bar ── */}
    <div className="tl-transport">
      <div className="left">
        <button type="button" disabled={!state.canUndo()} onClick={() => state.undo()} title={state.undoLabel() ? `Undo ${state.undoLabel()}` : 'Undo'}>↺ undo</button>
        <button type="button" disabled={!state.canRedo()} onClick={() => state.redo()} title={state.redoLabel() ? `Redo ${state.redoLabel()}` : 'Redo'}>↻ redo</button>
        <span style={{ color: 'var(--line-strong)' }}>·</span>
        <button type="button" disabled={!state.selection || state.selection.end <= state.selection.start} onClick={() => { void createRangeOperation('cut'); }}>cut</button>
        <button type="button" disabled={!state.selection || state.selection.end <= state.selection.start} onClick={() => { void createRangeOperation('mute'); }}>mute</button>
        <button type="button" className="soon" disabled title="Coming soon">split</button>
        <button type="button" disabled title="Speed-ramp the current selection">» speed</button>
        <span style={{ color: 'var(--line-strong)' }}>·</span>
        <button
          type="button"
          className={showSilences ? 'tl-toggle on' : 'tl-toggle'}
          aria-pressed={showSilences}
          onClick={() => setShowSilences((v) => !v)}
          title="Toggle silence detection overlay on dialog lane"
        >silences</button>
      </div>
      <div className="right">
        <span className="clock">
          {formatTime(state.currentTime)}{' '}
          <span style={{ color: 'var(--ink-3)' }}>/ {formatTime(duration)}</span>
        </span>
        <span style={{ color: 'var(--line-strong)' }}>·</span>
        <span className="zoom">
          <button type="button" onClick={() => state.setTimelineZoom(state.timelineZoom / 1.25)} title="Zoom out">−</button>
          <span>{Math.round(state.timelineZoom * 100)}%</span>
          <button type="button" onClick={() => state.setTimelineZoom(state.timelineZoom * 1.25)} title="Zoom in">+</button>
        </span>
        <button type="button" onClick={() => state.setTimelineZoom(1)} title="Reset zoom">fit</button>
        <button type="button" className="soon" disabled title="Coming soon">captions</button>
        <button
          type="button"
          className="pane-collapse pane-collapse-h"
          onClick={() => state.setTimelineCollapsed(true)}
          title="Collapse timeline"
          aria-label="Collapse timeline"
        >
          <svg width="10" height="10" viewBox="0 0 12 12"><path d="M3 5 L6 9 L9 5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
    </div>

    {/* ── Body ── */}
    <div className="tl-body" style={{ '--tl-head-w': `${TL_HEAD_W}px` } as React.CSSProperties}>
      {/* Sticky track headers — one per lane in the stack */}
      <div className="tl-heads">
        <div className="tl-heads-spacer" style={{ height: RULER_H }}>
          <span className="tl-heads-meta">tracks</span>
        </div>
        {laneStack.map((lane) => {
          // Removable: only non-virtual real audio tracks, and only when there are > 1 real audio tracks
          const realAudioCount = manifestTracks.filter((t) => t.kind === 'audio').length;
          const removable = (lane.kind === 'audio-extra' || (lane.kind === 'audio-dialog' && !lane.isVirtual)) && realAudioCount > 1;
          const backingTrack = lane.kind !== 'caption' ? lane.track : null;
          return <LaneHeader
            key={lane.laneId}
            lane={lane}
            removable={removable}
            onReorder={(delta) => backingTrack ? reorder(backingTrack, delta) : undefined}
          />;
        })}
        <AddTrackMenu onAdd={addAudioTrack} />
      </div>

      {/* Scrollable lanes */}
      <div className="tl-scroll" ref={bodyRef} onPointerDown={timelinePointerDown} onKeyDown={onKeyDown} tabIndex={0}>
        <div className="tl-content" ref={contentRef} style={{ width: pxWidth, minWidth: width }}>
          {/* Ruler */}
          <div className="ruler" style={{ height: RULER_H }}>
            {Array.from({ length: Math.floor(duration / tickEvery) + 1 }, (_, i) => (
              <div className="tick" key={i} style={{ left: `${((i * tickEvery) / duration) * 100}%` }}>
                {formatTime(i * tickEvery)}
              </div>
            ))}
            {highlights.map((h) => (
              <div
                key={h.id}
                className="hl-flag"
                style={{ left: `${(h.t / duration) * 100}%` }}
                title={`${h.label}${h.score != null ? ` · ${Math.round(h.score * 100)}%` : ''}${h.reason ? ` · ${h.reason}` : ''}`}
                onClick={(e) => { e.stopPropagation(); state.seek(h.t); }}
              >
                <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
                  <path d="M1 1v10" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M1 1h7l-1.6 2.6L8 6H1z" fill="currentColor" />
                </svg>
              </div>
            ))}
          </div>

          {/* Selection overlay */}
          {state.selection && state.selection.end > state.selection.start
            ? <div className="tl-selection" style={{ left: timeToPx(state.selection.start), width: Math.max(2, timeToPx(state.selection.end - state.selection.start)) }} />
            : null}

          {/* Stacked lane renderers */}
          <div className="tl-lanes">
            {laneStack.map((lane) => {
              if (lane.kind === 'video-filmstrip') {
                const track = lane.track;
                const dimmed = track.muted || track.hidden;
                const locked = track.locked;
                return <div
                  key={lane.laneId}
                  className={`tl-lane lane-video${dimmed ? ' is-dim' : ''}${locked ? ' is-locked' : ''}`}
                  style={{ height: lane.height }}
                >
                  <div className="filmstrip">
                    {track.clips.map((clip) => {
                      const clipWidth = Math.max(24, timeToPx(clip.sourceEnd - clip.sourceStart));
                      const frameCount = Math.max(6, Math.min(24, Math.floor(clipWidth / 38)));
                      const currentFrame = Math.floor(((state.currentTime - clip.timelineStart) / Math.max(0.001, clip.sourceEnd - clip.sourceStart)) * frameCount);
                      return <div
                        className="film-clip"
                        key={clip.clipId}
                        role="button"
                        tabIndex={0}
                        onPointerDown={(e) => clipPointerDown(e, clip.clipId, clip.timelineStart)}
                        style={{ left: timeToPx(clip.timelineStart), width: clipWidth }}
                      >
                        <button type="button" className="trim start" onPointerDown={(e) => trimPointerDown(e, clip, 'start')} aria-label="Trim clip start" />
                        <button type="button" className="trim end" onPointerDown={(e) => trimPointerDown(e, clip, 'end')} aria-label="Trim clip end" />
                        {Array.from({ length: frameCount }, (_, i) => <FilmFrame key={i} index={i} current={i === currentFrame} />)}
                        <span className="clip-actions">
                          <button type="button" onClick={(e) => { e.stopPropagation(); void state.detachAudio(clip.clipId); }}>detach</button>
                          <button type="button" onClick={(e) => { e.stopPropagation(); void state.removeClip(clip.clipId); }}>×</button>
                        </span>
                      </div>;
                    })}
                  </div>
                  <div className="lane-tag">{lane.chipLabel} · {track.name}</div>
                </div>;
              }

              if (lane.kind === 'audio-dialog') {
                const track = lane.track;
                const dimmed = track.muted || track.hidden;
                const locked = track.locked;
                const enhanced = Boolean(track.fx?.enhance || track.fx?.denoise || track.fx?.dereverb);
                return <div
                  key={lane.laneId}
                  className={`tl-lane lane-audio lane-audio-dialog${dimmed ? ' is-dim' : ''}${locked ? ' is-locked' : ''}${enhanced ? ' is-enhanced' : ''}`}
                  style={{ height: lane.height }}
                >
                  <AudioWaveformLane
                    clipPeaks={clipPeaks}
                    clipTimeline={buildClipTimeline(track.clips)}
                    pxWidth={pxWidth}
                    duration={duration}
                    timeToPx={timeToPx}
                    height={70}
                    operations={operationViews.filter((item) => item.view.trackId === track.trackId)}
                    showSilences={showSilences}
                    silences={silences}
                    studioSound={enhanced}
                    showWordLabels={showWordLabels}
                    ariaLabel={`${lane.chipLabel} dialog waveform`}
                    words={state.transcript?.words}
                    manifest={manifest}
                    trackId={track.trackId}
                    currentTime={state.currentTime}
                    onSeek={(t) => { keyboardAnchorRef.current = null; state.seek(t); state.setSelection(null); }}
                  />
                  <div className="lane-tag">
                    {lane.chipLabel} · dialog
                    {track.muted ? ' · muted' : ''}{track.locked ? ' · locked' : ''}
                  </div>
                </div>;
              }

              if (lane.kind === 'audio-extra') {
                const track = lane.track;
                const dimmed = track.muted || track.hidden;
                const locked = track.locked;
                const enhanced = Boolean(track.fx?.enhance || track.fx?.denoise || track.fx?.dereverb);
                const subtypeClass = track.subtype ? ` lane-audio-${track.subtype}` : '';
                return <div
                  key={lane.laneId}
                  className={`tl-lane lane-audio${subtypeClass}${dimmed ? ' is-dim' : ''}${locked ? ' is-locked' : ''}${enhanced ? ' is-enhanced' : ''}`}
                  style={{ height: lane.height }}
                >
                  <AudioWaveformLane
                    clipPeaks={clipPeaks}
                    clipTimeline={buildClipTimeline(track.clips)}
                    pxWidth={pxWidth}
                    duration={duration}
                    timeToPx={timeToPx}
                    height={70}
                    operations={operationViews.filter((item) => item.view.trackId === track.trackId)}
                    showSilences={false}
                    silences={[]}
                    studioSound={enhanced}
                    showWordLabels={showWordLabels}
                    ariaLabel={`${lane.chipLabel} ${track.name} waveform`}
                    words={undefined}
                    manifest={manifest}
                    trackId={track.trackId}
                    currentTime={state.currentTime}
                    onSeek={(t) => { keyboardAnchorRef.current = null; state.seek(t); state.setSelection(null); }}
                  />
                  <div className="lane-tag">
                    {lane.chipLabel} · {track.name}
                    {track.muted ? ' · muted' : ''}{track.locked ? ' · locked' : ''}
                  </div>
                </div>;
              }

              if (lane.kind === 'caption') {
                const groups = captionGroups(state.transcript?.words || [], manifest);
                const dimmed = lane.track ? (lane.track.muted || lane.track.hidden) : false;
                return <div
                  key={lane.laneId}
                  className={`tl-lane lane-caption${dimmed ? ' is-dim' : ''}`}
                  style={{ height: lane.height }}
                >
                  <div className="caption-pills">
                    {groups.map((group) => (
                      <div
                        key={group.id}
                        className="caption-pill"
                        style={{
                          left: `${(group.start / duration) * 100}%`,
                          width: `${((group.end - group.start) / duration) * 100}%`,
                        }}
                        title={group.text}
                      >
                        <span>{group.text}</span>
                      </div>
                    ))}
                  </div>
                  <div className="lane-tag">{lane.chipLabel} · burn-in</div>
                </div>;
              }

              return null;
            })}
          </div>

          {/* Single .tl-ops layer — spans lanes based on op type */}
          <div className="tl-ops" style={{ top: RULER_H, height: lanePositions.total }}>
            {operationViews.map((item) => {
              const left = (item.range.start / duration) * 100;
              const width = ((item.range.end - item.range.start) / duration) * 100;
              const { top, height } = rangeForOp(item.op);
              const label = width > 4 ? (item.op.type === 'voice_patch' ? '↺ voice' : item.op.type === 'speed' ? '» speed' : item.op.type) : '';
              return <div
                key={item.op.id}
                className={`op-overlay ${item.op.type}${item.op.status === 'proposed' ? ' proposed' : ''}`}
                style={{ left: `${left}%`, width: `${width}%`, top, height }}
                title={`${item.op.type} · ${item.range.start.toFixed(2)}–${item.range.end.toFixed(2)}s${item.op.reason ? ` · ${item.op.reason}` : ''}`}
                onClick={(e) => { e.stopPropagation(); seekOperation(item.range.start, item.range.end, item.op.id); }}
                role="button"
                tabIndex={-1}
                aria-label={`${item.op.type} operation ${item.range.start.toFixed(2)} to ${item.range.end.toFixed(2)}s`}
              >{label}</div>;
            })}
          </div>

          {/* Playhead */}
          <div className="playhead" style={{ left: `${(state.currentTime / duration) * 100}%`, top: 0, bottom: 0 }} />
        </div>
      </div>
    </div>
  </div>;
}
