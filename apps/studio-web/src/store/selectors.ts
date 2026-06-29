import type { ManifestV3, OperationV3, OverlayView, PillView } from '@etvideoscript/core/browser';
import { getOperationKind } from '@etvideoscript/core/browser';
import type { Diagnostics, Job, TranscriptDoc, TranscriptWord } from '../lib/api';
import type { TranscriptMode } from './editorStore';

export type PanelStateKind = 'loading' | 'cold-start' | 'no-transcript' | 'render-failed' | 'provider-failed' | 'empty' | 'ready';
export type PanelName = 'ai' | 'suggestions' | 'manifest' | 'clips' | 'inspect' | 'elements' | 'media';

export function renderProgressLabel(job: Pick<Job, 'stages'>) {
  // Returns text only. A separate `renderProgressPercent` feeds a real HTML progress
  // strip in the topbar so the toast doesn't rely on unicode block characters that
  // render inconsistently across fonts and looked dated (user feedback 2026-05-25).
  const stage = job.stages?.find((candidate) => candidate.name === 'render') || job.stages?.[0];
  const percent = Math.round(stage?.percent ?? 0);
  return `${percent}% · ${stage?.phase || 'Rendering draft'}`;
}

export function renderProgressPercent(job: Pick<Job, 'stages'>): number {
  const stage = job.stages?.find((candidate) => candidate.name === 'render') || job.stages?.[0];
  return Math.max(0, Math.min(100, Math.round(stage?.percent ?? 0)));
}

export function isImported(diagnostics: Diagnostics | null, project?: { status?: Record<string, unknown> } | null) {
  const status = diagnostics?.status || project?.status || {};
  if ('imported' in status) return Boolean(status.imported);
  return Boolean(diagnostics?.files?.source?.exists);
}

export function latestRenderDraftJob(jobs: Job[] = []) {
  return jobs.find((job) => job.type === 'render-draft' && ['queued', 'running', 'waiting_for_approval'].includes(job.status));
}

export function latestFailedRenderJob(jobs: Job[] = []) {
  // Only surface a failed render when it is the MOST RECENT render-draft job.
  // A successful (or queued/running) render that came after a transient failure
  // must supersede it — otherwise one stale failure pins the preview into
  // render-failed forever, even after dozens of successful renders.
  // Invalid createdAt sorts oldest (Number.NEGATIVE_INFINITY) so a malformed
  // entry can't poison the reducer and trap a stale failure. Ties go to the
  // first occurrence in array order (the API returns newest-first).
  let latest: Job | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const job of jobs) {
    if (job.type !== 'render-draft') continue;
    const ms = Date.parse(job.createdAt);
    const score = Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
    if (score > latestMs) { latest = job; latestMs = score; }
  }
  return latest && latest.status === 'failed' ? latest : undefined;
}

export function hasProviderFailure(providerRequests: Array<Record<string, unknown>> = []) {
  return providerRequests.some((request) => ['failed', 'op_update_failed'].includes(String(request.status || '')));
}

export function decidePanelState(input: {
  loading: boolean;
  panel?: PanelName | 'main' | 'preview' | 'transcript' | 'timeline';
  project?: { status?: Record<string, unknown> } | null;
  diagnostics: Diagnostics | null;
  transcript: TranscriptDoc | null;
  jobs?: Job[];
  providerRequests?: Array<Record<string, unknown>>;
  empty?: boolean;
}): PanelStateKind {
  if (input.loading) return 'loading';
  if (!isImported(input.diagnostics, input.project)) return 'cold-start';
  const failedRender = Boolean(latestFailedRenderJob(input.jobs || []) || input.diagnostics?.renderFreshness?.draft?.state === 'error');
  if ((input.panel === 'preview' || input.panel === 'main') && failedRender) return 'render-failed';
  if ((input.panel === 'ai' || input.panel === 'manifest' || input.panel === 'suggestions') && hasProviderFailure(input.providerRequests || [])) return 'provider-failed';
  const needsTranscript = ['transcript', 'suggestions', 'clips'].includes(String(input.panel));
  if (needsTranscript && (!input.transcript || !input.diagnostics?.transcript)) return 'no-transcript';
  if (input.empty) return 'empty';
  return 'ready';
}

export function projectDuration(manifest?: ManifestV3 | null, transcript?: TranscriptDoc | null) {
  const tracks = manifest?.tracks || [];
  const trackEnd = Math.max(0, ...tracks.flatMap((track) => track.clips.map((clip) => clip.timelineStart + Math.max(0, clip.sourceEnd - clip.sourceStart))));
  return Math.max(trackEnd, transcript?.durationSec || 0, 1);
}

export function proposedOperations(manifest?: ManifestV3 | null): OperationV3[] {
  return (manifest?.operations || []).filter((op) => op.status === 'proposed');
}

export function approvedOperations(manifest?: ManifestV3 | null): OperationV3[] {
  return (manifest?.operations || []).filter((op) => op.status === 'approved');
}

export function transcriptPills(operations: OperationV3[] = []): PillView[] {
  return operations.map((op) => getOperationKind(op.type).transcriptView(op)).filter((view): view is PillView => Boolean(view));
}

export function timelineOverlays(operations: OperationV3[] = []): OverlayView[] {
  return operations.map((op) => getOperationKind(op.type).timelineView(op));
}

export function operationTimelineRange(manifest: ManifestV3 | null | undefined, op: OperationV3): { start: number; end: number } | null {
  const track = manifest?.tracks.find((candidate) => candidate.trackId === op.target.trackId);
  if (!track) return null;

  if (op.target.kind === 'track') {
    return { start: 0, end: projectDuration(manifest) };
  }

  const clip = track.clips.find((candidate) => candidate.clipId === op.target.clipId);
  if (!clip) return null;

  if (op.target.kind === 'clip-boundary') {
    const boundary = clip.timelineStart + Math.max(0, clip.sourceEnd - clip.sourceStart);
    return { start: boundary, end: boundary };
  }

  return {
    start: clip.timelineStart + op.target.start,
    end: clip.timelineStart + op.target.end
  };
}

export function wordTimelineRange(
  manifest: ManifestV3 | null | undefined,
  word: { start: number; end: number; clipId?: string }
): { start: number; end: number } {
  if (!word.clipId) return { start: word.start, end: word.end };

  const clip = manifest?.tracks.flatMap((track) => track.clips).find((candidate) => candidate.clipId === word.clipId);
  if (!clip) return { start: word.start, end: word.end };

  return {
    start: clip.timelineStart + word.start,
    end: clip.timelineStart + word.end
  };
}

export function toneClass(tone?: string) {
  return `tone-${tone || 'neutral'}`;
}

// ─── Transcript-mode label helper ────────────────────────────────────────────
// Maps the real TranscriptMode enum → the UI label and CSS view-class the
// design prototype expects. Components use these for tab labels and body class;
// the store enum stays unchanged.
export type TranscriptModeLabel = { label: string; view: 'draft' | 'audit' | 'original' };

export function transcriptModeLabel(mode: TranscriptMode): TranscriptModeLabel {
  switch (mode) {
    case 'preview':  return { label: 'Draft',       view: 'draft' };
    case 'edited':   return { label: 'Audit trail', view: 'audit' };
    case 'original': return { label: 'Original',    view: 'original' };
  }
}

// ─── Design-flat operation shape ─────────────────────────────────────────────
// The design prototype reads a flat shape from operations[]. This adapter
// converts real nested ops into that shape so every component reads the same
// contract without re-implementing the clip-local → timeline coordinate math.
//
// Key transforms:
//   op.target.{start,end} (clip-local)  →  start/end (timeline axis via operationTimelineRange)
//   speed: op.rate → factor, op.bed → audioBed
//   voice_patch: op.text stays; originalText reconstructed from covered transcript words
//   proposedBy actor enum → source: 'you' | 'agent'
//   op.meta: overlay/transition typed fields forwarded under meta for the elements panel

export type DesignOp = {
  id: string;
  type: string;
  status: string;
  clipId: string;
  /** Timeline-axis start (seconds). */
  start: number;
  /** Timeline-axis end (seconds). */
  end: number;
  reason?: string;
  /** Per-op ASR/model confidence 0-1 (proposals). */
  confidence?: number;
  /** Raw OperationActor value — 'user' | 'agent' | 'system'. */
  proposedBy: string;
  /** Derived provenance dot: 'you' for user/manual, 'agent' for agent/system. */
  source: 'you' | 'agent';
  // voice_patch
  text?: string;
  /** Reconstructed from the transcript words covered by the op span. */
  originalText?: string;
  /** Provider id hint for display; sourced from op.voiceRef?.providerId if present. */
  provider?: string;
  // speed
  /** Speed multiplier (design: factor; real schema: rate). */
  factor?: number;
  /** Audio bed style (design: audioBed; real schema: bed). */
  audioBed?: string;
  // overlay / transition typed meta
  meta?: Record<string, unknown>;
};

/** Derive provenance dot from the raw OperationActor value. */
function opSource(proposedBy: string): 'you' | 'agent' {
  return proposedBy === 'user' ? 'you' : 'agent';
}

/**
 * Reconstruct the text covered by an op from the transcript words.
 *
 * Both the op span and each word are compared on the TIMELINE axis via
 * `wordTimelineRange` (codex P2): tagged words map through clip.timelineStart,
 * untagged words are already timeline-axis. The op's flattened timeline range
 * (`operationTimelineRange`) is passed in, so a voice patch on a later clip
 * matches the right words instead of mis-pulling clip-local-coincident text.
 * Returns undefined when no words overlap (no transcript loaded, or no match).
 */
function reconstructOriginalText(
  manifest: ManifestV3 | null | undefined,
  words: TranscriptWord[],
  rangeStart: number,
  rangeEnd: number
): string | undefined {
  const covered = words.filter((w) => {
    const wr = wordTimelineRange(manifest, w);
    return wr.start < rangeEnd && wr.end > rangeStart;
  });
  if (!covered.length) return undefined;
  return covered.map((w) => w.text).join(' ');
}

/**
 * `designOps` — adapter selector.
 *
 * Given the real manifest and the optional loaded transcript, returns the flat
 * design-shaped operation array. Timeline axis coordinates come from
 * `operationTimelineRange` — no clip math is duplicated here.
 *
 * Only ops with resolvable timeline ranges are included (ops whose target clip is
 * missing from the manifest are silently omitted, consistent with PillView
 * behaviour).
 *
 * @param manifest  The live ManifestV3 (may be null while loading).
 * @param transcript  The loaded TranscriptDoc (may be null; used only for originalText).
 */
export function designOps(
  manifest: ManifestV3 | null | undefined,
  transcript: TranscriptDoc | null | undefined
): DesignOp[] {
  const ops = manifest?.operations ?? [];
  const words: TranscriptWord[] = transcript?.words ?? [];

  return ops.flatMap((op: OperationV3) => {
    const range = operationTimelineRange(manifest, op);
    if (!range) return [];

    // clipId — present on clip-span and clip-boundary targets; absent on track targets
    const clipId = 'clipId' in op.target ? op.target.clipId : '';

    const base: DesignOp = {
      id: op.id,
      type: op.type,
      status: op.status,
      clipId,
      start: range.start,
      end: range.end,
      reason: op.reason,
      confidence: op.confidence,
      proposedBy: op.proposedBy,
      source: opSource(op.proposedBy),
    };

    // Per-type field projection
    if (op.type === 'speed') {
      const s = op as OperationV3 & { rate?: number; bed?: string };
      return [{ ...base, factor: s.rate, audioBed: s.bed }];
    }

    if (op.type === 'voice_patch') {
      const vp = op as OperationV3 & { text?: string; voiceRef?: { providerId?: string; voiceId?: string } };
      // Compare on the timeline axis (range from operationTimelineRange) so the
      // reconstruction is correct for clips not at timeline 0 (codex P2).
      const originalText = reconstructOriginalText(manifest, words, range.start, range.end);
      return [{
        ...base,
        text: vp.text,
        originalText,
        provider: vp.voiceRef?.providerId,
      }];
    }

    if (op.type === 'transcript_amend') {
      // Inline text correction (double-click a word). Project the schema's
      // `amendedText` onto `text` so panels that read `dop.text` render the
      // corrected word, and reconstruct `originalText` from the covered words on
      // the timeline axis (mirrors voice_patch) so the audit view can show the
      // before → after diff. transcript_amend is display-only (affectsTimeline:
      // false), so its range is the clip-local span flattened to timeline coords.
      const ta = op as OperationV3 & { amendedText?: string };
      const originalText = reconstructOriginalText(manifest, words, range.start, range.end);
      return [{
        ...base,
        text: ta.amendedText,
        originalText,
      }];
    }

    if (op.type === 'overlay') {
      const ov = op as OperationV3 & { source?: unknown; zIndex?: number; rect?: unknown; opacity?: number };
      return [{ ...base, meta: { source: ov.source, zIndex: ov.zIndex, rect: ov.rect, opacity: ov.opacity } }];
    }

    if (op.type === 'transition') {
      const tr = op as OperationV3 & { transitionType?: string; durationMs?: number };
      return [{ ...base, meta: { kind: tr.transitionType, durationMs: tr.durationMs } }];
    }

    return [base];
  });
}
