/**
 * designData.ts — presentation-layer constants and heuristic derivations for the
 * re-skinned ETVideoScript editor.
 *
 * PURPOSE: Provide the `window.ETV_DATA`-compatible static arrays and lightweight
 * client-side derivations the design prototype used as fixtures, so every
 * re-skinned component can be populated 1:1 with the design without reinventing
 * coordinate math or re-importing data.js.
 *
 * IMPORTANT: The derivations below (silences, highlights, proposedClips) are
 * PRESENTATION-LAYER HEURISTICS that stand in for unbuilt backend analysis
 * endpoints. They are NOT real ML output. They use simple gap detection and
 * scoring rules that approximate what a real silence-detector / moment-scoring
 * model would produce, purely so the UI can be populated with believable data.
 * When real backends exist (remove-silences skill endpoint, find-clips analysis,
 * find-highlights scoring), these client-side derivations should be replaced by
 * the server-returned values.
 */

import type { ManifestV3, OperationV3 } from '@etvideoscript/core/browser';
import type { TranscriptDoc, TranscriptWord } from '../lib/api';
import { operationTimelineRange, wordTimelineRange } from './selectors';

// ─── Static design constants ─────────────────────────────────────────────────

export type SkillTier = 'cleanup' | 'edit' | 'distribute';

export type Skill = {
  name: string;
  desc: string;
  icon: string;
  tier: SkillTier;
};

/** Nine skills surfaced in the skills strip. */
export const SKILLS: readonly Skill[] = [
  { name: 'find-fillers',        desc: 'Mark um/uh/like for cutting',         icon: 'wave',    tier: 'cleanup' },
  { name: 'remove-silences',     desc: 'Trim dead air > 0.6s',                icon: 'silence', tier: 'cleanup' },
  { name: 'speed-up-waits',      desc: 'Speed-ramp tool waits + dead air',    icon: 'fast',    tier: 'cleanup' },
  { name: 'enhance-dialog',      desc: 'Studio Sound · denoise · dereverb',   icon: 'eq',      tier: 'cleanup' },
  { name: 'tighten-section',     desc: 'Collapse rambling sections',          icon: 'square',  tier: 'edit' },
  { name: 'polish-narration',    desc: 'Re-record off-tone lines',            icon: 'wave',    tier: 'edit' },
  { name: 'find-clips',          desc: 'Propose social clips',                icon: 'shorts',  tier: 'distribute' },
  { name: 'find-highlights',     desc: 'Mark hooks · key moments',            icon: 'star',    tier: 'distribute' },
  { name: 'assemble-from-clips', desc: 'Order clips into a draft',            icon: 'stack',   tier: 'edit' },
] as const;

export type CaptionStyleSwatch = { bg: string; fg: string; accent: string };

export type CaptionStyle = {
  id: string;
  label: string;
  hint: string;
  swatch: CaptionStyleSwatch;
};

/** Five caption preset swatches. */
export const CAPTION_STYLES: readonly CaptionStyle[] = [
  { id: 'shorts-bold', label: 'Shorts · bold',  hint: 'TikTok/Reels — bold yellow, karaoke',  swatch: { bg: '#171411', fg: '#fefefe', accent: '#f5c542' } },
  { id: 'talk-show',   label: 'Talk show',       hint: 'White text · drop shadow · centered', swatch: { bg: 'transparent', fg: '#ffffff', accent: 'rgba(0,0,0,.65)' } },
  { id: 'clean',       label: 'Clean',           hint: 'Hairline cap · sentence at a time',   swatch: { bg: '#fbf8f1', fg: '#171411', accent: '#d65a36' } },
  { id: 'ted',         label: 'TED · serif',     hint: 'Serif · single line · refined',       swatch: { bg: 'transparent', fg: '#f4efe6', accent: '#d65a36' } },
  { id: 'podcast',     label: 'Podcast · bars',  hint: 'Bar above · monospace · two lines',   swatch: { bg: '#0d0b09', fg: '#f4efe6', accent: '#e98b62' } },
] as const;

export type BrandPackPreview = { bg: string; accent: string; ink: string; kind: string };

export type BrandPack = {
  id: string;
  label: string;
  desc: string;
  installed: boolean;
  preview: BrandPackPreview;
};

/** Four brand pack presets. */
export const BRAND_PACKS: readonly BrandPack[] = [
  {
    id: 'etcircle',  label: 'ETCircle · warm editorial',
    desc: 'Paper · clay · Instrument Serif. Hairline lower-thirds.',
    installed: true,
    preview: { bg: '#f4efe6', accent: '#d65a36', ink: '#171411', kind: 'paper' },
  },
  {
    id: 'shorts',    label: 'Shorts · bold',
    desc: 'High-contrast captions, animated word-by-word, vertical.',
    installed: false,
    preview: { bg: '#171411', accent: '#f5c542', ink: '#fefefe', kind: 'bold' },
  },
  {
    id: 'podcast',   label: 'Podcast · waveform',
    desc: 'Static frame with waveform · chapter cards · two-line caption.',
    installed: false,
    preview: { bg: '#0d0b09', accent: '#e98b62', ink: '#f4efe6', kind: 'wave' },
  },
  {
    id: 'tutorial',  label: 'Tutorial · screen',
    desc: 'Picture-in-picture facecam · subtitle bar · timestamp chips.',
    installed: false,
    preview: { bg: '#072752', accent: '#e15924', ink: '#f4efe6', kind: 'screen' },
  },
] as const;

export type AspectRatio = {
  id: string;
  label: string;
  name: string;
  w: number;
  h: number;
  use: string;
};

/** Four aspect ratio presets matching the render-dialog + preview picker. */
export const ASPECT_RATIOS: readonly AspectRatio[] = [
  { id: '16:9', label: '16:9', name: 'Landscape', w: 16, h: 9,  use: 'YouTube · podcast' },
  { id: '9:16', label: '9:16', name: 'Vertical',  w: 9,  h: 16, use: 'Shorts · Reels · TikTok' },
  { id: '1:1',  label: '1:1',  name: 'Square',    w: 1,  h: 1,  use: 'LinkedIn · feed' },
  { id: '4:5',  label: '4:5',  name: 'Portrait',  w: 4,  h: 5,  use: 'Instagram feed' },
] as const;

// ─── Heuristic derivations from real transcript data ─────────────────────────
//
// All three functions below are CLIENT-SIDE HEURISTICS that approximate the
// output of backend analysis passes (silence detection, moment scoring, social
// clip proposal). They use only the loaded transcript words/segments so the UI
// can display populated data without waiting for a backend skill run. They are
// intentionally simple — replace each with a server-backed selector when the
// corresponding skill endpoint ships.

/** Minimum inter-word gap (seconds) treated as a silence. */
export const SILENCE_GAP_THRESHOLD_SEC = 0.6;

/** Alias matching the v4 spec naming (`SILENCE_GAP_THRESHOLD`). */
export const SILENCE_GAP_THRESHOLD = SILENCE_GAP_THRESHOLD_SEC;

export type DerivedSilence = {
  id: string;
  /** Timeline-axis start of the gap (= end of the preceding word). */
  start: number;
  /** Timeline-axis end of the gap (= start of the following word). */
  end: number;
  /** Heuristic confidence: longer gaps score higher (capped at 0.99). */
  conf: number;
};

/**
 * Derive silence spans from inter-word gaps in the transcript.
 *
 * Heuristic: any gap between consecutive words longer than 0.6 s is a silence.
 * Confidence is a simple inverse-exponential of gap length: short gaps near the
 * threshold score ~0.6; long pauses approach 0.99. Words must be sorted by start
 * time (the core transcript writer guarantees this).
 *
 * HEURISTIC STANDING IN FOR: the remove-silences skill / ffmpeg silencedetect
 * analysis that would run on the extracted audio track.
 */
export function deriveSilences(words: TranscriptWord[]): DerivedSilence[] {
  const result: DerivedSilence[] = [];
  let idx = 0;
  for (let i = 0; i < words.length - 1; i += 1) {
    const current = words[i]!;
    const next = words[i + 1]!;
    const gap = next.start - current.end;
    if (gap >= SILENCE_GAP_THRESHOLD_SEC) {
      const conf = Math.min(0.99, 0.6 + (1 - Math.exp(-gap + SILENCE_GAP_THRESHOLD_SEC)) * 0.4);
      result.push({
        id: `sil-${String(idx + 1).padStart(3, '0')}`,
        start: current.end,
        end: next.start,
        conf: Math.round(conf * 100) / 100,
      });
      idx += 1;
    }
  }
  return result;
}

export type DerivedHighlight = {
  id: string;
  /** Timeline-axis time of the highlight anchor word. */
  t: number;
  segmentId: string;
  label: string;
  score: number;
  reason: string;
};

/** Internal segment shape used by deriveHighlights. */
type SegmentInput = {
  id?: string;
  segmentId?: string;
  speaker?: string;
  start?: number;
  end?: number;
  text?: string;
};

/**
 * Derive candidate highlight moments from transcript segments.
 *
 * Heuristic: score each segment by a combination of position-in-video bonus
 * (openings/closings score higher), word-count penalty for very short segments,
 * and a modest density bonus for longer utterances. The top 4 segments become
 * highlights. Label assignment is positional: first → 'Hook', middle → 'Insight'
 * or 'Quotable', last → 'Brand promise' or 'Close'.
 *
 * HEURISTIC STANDING IN FOR: the find-highlights skill that would use a real
 * moment-scoring model over the transcript and audio features.
 */
export function deriveHighlights(segments: SegmentInput[]): DerivedHighlight[] {
  if (!segments.length) return [];

  const scored = segments.map((seg, idx) => {
    const start = seg.start ?? 0;
    const end = seg.end ?? 0;
    const text = seg.text ?? '';
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const duration = Math.max(0, end - start);
    const total = segments.length;

    // Position bonus: openings (first 20%) and closings (last 20%) score higher
    const posRatio = total > 1 ? idx / (total - 1) : 0;
    const posBonus = posRatio < 0.2 ? 0.15 : posRatio > 0.8 ? 0.08 : 0;

    // Word-count bonus: segments with 10-20 words score highest
    const lengthScore = wordCount < 5 ? 0.2 : wordCount < 10 ? 0.4 : wordCount < 25 ? 0.6 : 0.5;

    // Density bonus: speaking pace (words/sec) — fast speech scores a touch higher
    const density = duration > 0 ? Math.min(1, wordCount / (duration * 2.5)) : 0;

    const score = Math.min(0.99, 0.6 * lengthScore + 0.25 * density + posBonus);
    const segId = seg.id ?? seg.segmentId ?? `seg-${idx}`;
    return { idx, seg, score, segId, start };
  });

  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, Math.min(4, sorted.length)).sort((a, b) => a.start - b.start);

  const LABELS = ['Hook · the pitch', 'Brand promise', 'Insight', 'Quotable', 'Close'];
  const REASONS = [
    'Strong opener — names the product + thesis in one line.',
    'The boundary disclaimer — recurring brand line.',
    'Agent-orchestrates / deterministic-source-of-truth principle.',
    'Quotable single-line principle.',
    'Clean sign-off — memorable closer.',
  ];

  return top.map((item, i) => ({
    id: `hl-${String(i + 1).padStart(3, '0')}`,
    t: item.start,
    segmentId: item.segId,
    label: LABELS[i] ?? 'Key moment',
    score: Math.round(item.score * 100) / 100,
    reason: REASONS[i] ?? 'Key moment in the recording.',
  }));
}

export type DerivedProposedClip = {
  id: string;
  title: string;
  start: number;
  end: number;
  score: number;
  aspect: '16:9' | '9:16' | '1:1';
  segments: string[];
  hookText: string;
  tags: string[];
};

/**
 * Derive social-clip proposals from transcript segments.
 *
 * Heuristic: group consecutive segments into 15-30 s windows, score each window
 * using the same position/density metric as deriveHighlights, then assign the
 * top 4 windows a plausible aspect ratio (first = 16:9, alternating 9:16/1:1
 * thereafter) and a hook text taken from the first segment's text.
 *
 * HEURISTIC STANDING IN FOR: the find-clips skill that would use real engagement
 * prediction over audio+video features to propose social clips.
 */
export function deriveProposedClips(segments: SegmentInput[]): DerivedProposedClip[] {
  if (!segments.length) return [];

  // Build windows of segments whose combined duration falls between MIN and MAX
  const MIN_SEC = 12;
  const MAX_SEC = 32;
  const windows: Array<{ start: number; end: number; segs: SegmentInput[]; score: number }> = [];

  let i = 0;
  while (i < segments.length) {
    let j = i;
    let windowStart = segments[i]?.start ?? 0;
    let windowEnd = segments[i]?.end ?? 0;
    const windowSegs: SegmentInput[] = [];

    while (j < segments.length && (windowEnd - windowStart) < MAX_SEC) {
      const seg = segments[j]!;
      windowEnd = seg.end ?? windowEnd;
      windowSegs.push(seg);
      j += 1;
    }

    const duration = windowEnd - windowStart;
    if (duration >= MIN_SEC) {
      const posRatio = segments.length > 1 ? i / (segments.length - 1) : 0;
      const posScore = posRatio < 0.2 ? 0.91 : posRatio < 0.5 ? 0.86 : posRatio < 0.8 ? 0.82 : 0.74;
      windows.push({ start: windowStart, end: windowEnd, segs: windowSegs, score: posScore });
    }
    // advance by half the window to allow overlap
    i += Math.max(1, Math.floor(windowSegs.length / 2));
  }

  const ASPECTS: Array<'16:9' | '9:16' | '1:1'> = ['16:9', '9:16', '1:1', '9:16'];
  const TAG_SETS = [
    ['hook', 'intro', 'shorts'],
    ['promise', 'principles'],
    ['quotable', 'thesis'],
    ['principles'],
  ];

  return windows.slice(0, 4).map((win, idx) => {
    const firstSeg = win.segs[0];
    const hookText = firstSeg?.text?.trim()
      ? firstSeg.text.trim().split(/[.!?]/)[0]?.trim() + '.'
      : `Clip ${idx + 1}`;
    const segIds = win.segs.map((s) => s.id ?? s.segmentId ?? '').filter(Boolean);

    return {
      id: `clip-prop-${idx + 1}`,
      title: `Clip ${idx + 1} · ${Math.round(win.end - win.start)}s`,
      start: win.start,
      end: win.end,
      score: Math.round(win.score * 100) / 100,
      aspect: ASPECTS[idx] ?? '16:9',
      segments: segIds,
      hookText,
      tags: TAG_SETS[idx] ?? ['clip'],
    };
  });
}

// ─── Convenience bundle ───────────────────────────────────────────────────────
// Components can call `deriveDesignData(transcript)` to get all three derived
// arrays in one shot.

export type DerivedDesignData = {
  silences: DerivedSilence[];
  highlights: DerivedHighlight[];
  proposedClips: DerivedProposedClip[];
};

/**
 * Derive all presentation-layer data from the real transcript in one call.
 * Returns empty arrays when transcript is null/undefined.
 */
export function deriveDesignData(transcript: TranscriptDoc | null | undefined): DerivedDesignData {
  const words = transcript?.words ?? [];
  const segments = transcript?.segments ?? [];
  return {
    silences: deriveSilences(words),
    highlights: deriveHighlights(segments),
    proposedClips: deriveProposedClips(segments),
  };
}

// ─── Clean-up sweep candidates ───────────────────────────────────────────────
//
// `deriveSweepCandidates` is the data half of the v4 "clean-up sweep" surface
// (CleanupStrip). It mirrors the prototype's `sweepCandidates` memo
// (app-v4.jsx L383-405) but operates on the REAL coordinate model:
//
//   - filler words + the "you know" bigram come from transcript.words, mapped to
//     the TIMELINE axis via `wordTimelineRange` (so words on clips not at
//     timelineStart=0 land in the right place);
//   - dead-air candidates come from the caller-supplied derived silences
//     (`deriveSilences(transcript.words)`), mapped to the same timeline axis;
//   - any candidate range already overlapped by an existing ENABLED, non-amend
//     operation is excluded (so re-running the sweep never re-proposes a cut the
//     user already accepted). Existing op ranges are taken on the timeline axis
//     via `operationTimelineRange`.
//
// This is a PURE selector — no store access, no side effects — so it can be
// memoised in the component and unit-tested directly.

/** Filler-word regex — single um/uh/erm/like/so/yeah/well token + trailing punctuation. */
const SWEEP_FILLER_RE = /^(um+|uh+|erm+|like|so|yeah|well)[,.!?—–-]*$/i;

/** Small epsilon so touching (but not truly overlapping) ranges don't collide. */
const SWEEP_OVERLAP_EPSILON = 0.01;

// Op kinds that actually remove or replace the candidate's audio in the render —
// the only ones that should hide a filler / dead-air candidate from the sweep.
// caption_style / overlay / transition target whole tracks or only change
// presentation, and `operationTimelineRange` expands a track target to the full
// project, so counting them would let a single approved caption style hide every
// cleanup candidate. speed re-times but doesn't remove the filler audio.
const SWEEP_AUDIO_REMOVING_KINDS: ReadonlySet<string> = new Set(['cut', 'mute', 'voice_patch']);

export type SweepCandidate = {
  /** Stable id derived from the source word/silence id (`sw-<id>`). */
  id: string;
  kind: 'filler' | 'silence';
  /** Timeline-axis start (seconds). */
  start: number;
  /** Timeline-axis end (seconds). */
  end: number;
  /** The filler text (e.g. "um", "you know"); empty string for silence. */
  text: string;
  /**
   * The clip that owns this candidate's words (or the clip bracketing a
   * silence). The cut op is anchored to THIS clip so a sweep never cuts
   * unrelated overlapping tracks (music/SFX/captions). Undefined → fall back
   * to the primary media track.
   */
  clipId?: string;
};

/**
 * Derive clean-up sweep candidates (fillers + dead air) from the real transcript,
 * excluding ranges already covered by an enabled, non-amend operation.
 *
 * @param transcript      The loaded transcript (null → no candidates).
 * @param manifest        The live manifest (used to map clip-local → timeline axis).
 * @param derivedSilences Output of `deriveSilences(transcript.words)` — source-axis gaps.
 * @param existingOps     The manifest operations to exclude overlaps against.
 * @returns Candidates sorted by timeline start.
 */
export function deriveSweepCandidates(
  transcript: TranscriptDoc | null | undefined,
  manifest: ManifestV3 | null | undefined,
  derivedSilences: DerivedSilence[],
  existingOps: OperationV3[] | null | undefined
): SweepCandidate[] {
  const words = transcript?.words ?? [];
  if (!words.length && !derivedSilences.length) return [];

  // Op ranges already removed/replaced in the render, on the timeline axis. A
  // candidate is only "already handled" when an APPROVED audio-removing op (cut /
  // mute / voice_patch) covers it — those are the statuses+kinds the render
  // projection actually applies (render/plan.ts, timeMap/compose.ts project
  // status === 'approved'). A merely proposed suggestion, or a display-only op
  // (transcript_amend, caption_style, overlay, transition, speed), must NOT hide a
  // filler or dead-air candidate that is still audible in the current cut.
  const blockedRanges = (existingOps ?? [])
    .filter((op) => op.status === 'approved' && SWEEP_AUDIO_REMOVING_KINDS.has(op.type))
    .map((op) => operationTimelineRange(manifest, op))
    .filter((range): range is { start: number; end: number } => Boolean(range));

  const overlapped = (start: number, end: number): boolean =>
    blockedRanges.some((r) => !(r.end <= start + SWEEP_OVERLAP_EPSILON || r.start >= end - SWEEP_OVERLAP_EPSILON));

  // Map a silence (source-axis bounds from deriveSilences) to the timeline axis.
  // deriveSilences builds each gap from word.end → next word.start, so we reuse
  // the surrounding words' clip mapping. We locate the word whose source range
  // brackets the silence and project through its clip offset; when no clip tag
  // exists the coords already are timeline-axis (clip at timelineStart=0).
  const silenceTimelineRange = (sil: DerivedSilence): { start: number; end: number; clipId?: string } => {
    const before = words.find((w) => Math.abs(w.end - sil.start) < SWEEP_OVERLAP_EPSILON);
    const after = words.find((w) => Math.abs(w.start - sil.end) < SWEEP_OVERLAP_EPSILON);
    const startAxis = before ? wordTimelineRange(manifest, before).end : sil.start;
    const endAxis = after ? wordTimelineRange(manifest, after).start : sil.end;
    return { start: startAxis, end: endAxis, clipId: before?.clipId ?? after?.clipId };
  };

  const out: SweepCandidate[] = [];

  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    const nx = words[i + 1];

    // "you know" bigram → one candidate spanning both words
    if (/^you[,.]?$/i.test(w.text) && nx && /^know[,.!?]?$/i.test(nx.text)) {
      const a = wordTimelineRange(manifest, w);
      const b = wordTimelineRange(manifest, nx);
      const start = Math.min(a.start, b.start);
      const end = Math.max(a.end, b.end);
      if (!overlapped(start, end)) {
        out.push({ id: `sw-${w.id}`, kind: 'filler', start, end, text: `${w.text} ${nx.text}`, clipId: w.clipId });
      }
      i += 1; // consume the "know"
      continue;
    }

    if (SWEEP_FILLER_RE.test(w.text)) {
      const r = wordTimelineRange(manifest, w);
      if (!overlapped(r.start, r.end)) {
        out.push({ id: `sw-${w.id}`, kind: 'filler', start: r.start, end: r.end, text: w.text, clipId: w.clipId });
      }
    }
  }

  for (const sil of derivedSilences) {
    const r = silenceTimelineRange(sil);
    if (!overlapped(r.start, r.end)) {
      out.push({ id: `sw-${sil.id}`, kind: 'silence', start: r.start, end: r.end, text: '', clipId: r.clipId });
    }
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

// ─── Static agent info (design vanity) ───────────────────────────────────────
//
// Mirrors the prototype's `data.agent` fixture (data.js L260-268). The AgentPanel
// renders this header (kind/name/cwd/pid/protocol/session) to match the design.
// It is intentionally static — the real attached-agent identity isn't surfaced
// through the API yet; when it is, replace this with the live value.

export type AgentInfo = {
  kind: string;
  name: string;
  attached: boolean;
  cwd: string;
  pid: number;
  protocolVersion: number;
  session: string;
};

export const AGENT_INFO: AgentInfo = {
  kind: 'cli',
  name: 'claude-code',
  attached: true,
  cwd: '~/etvideoscript/workspaces/sweet-bakery-os-ep-00',
  pid: 32417,
  protocolVersion: 2,
  session: '2026-05-16-1340',
};
