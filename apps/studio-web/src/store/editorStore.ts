"use client";

import { create } from 'zustand';
import type { AssetV3, ClipV3, ManifestV3, OperationV3, OutputV3, ProviderRequestCostSummary, TrackV3 } from '@etvideoscript/core/browser';
import { ApiError, addAsset as addAssetApi, addClip as addClipApi, addOutput as addOutputApi, addTrack as addTrackApi, cancelJob as cancelJobApi, createCloneChainVoicePatch as createCloneChainVoicePatchApi, createGeneration as createGenerationApi, createOperation as createOperationApi, createVoicePatch as createVoicePatchApi, detachAudio as detachAudioApi, disableOperation as disableOperationApi, disableStudioCleanup as disableStudioCleanupApi, getProject, getProjectDiagnostics, getProjectJob, getProjectJobs, getProviderRequestSummary, getVoiceStatus as getVoiceStatusApi, patchAsset as patchAssetApi, patchClip as patchClipApi, patchOperation as patchOperationApi, patchOutput as patchOutputApi, patchTrack as patchTrackApi, prepareVoice as prepareVoiceApi, proposeOutputs as proposeOutputsApi, removeAsset as removeAssetApi, removeClip as removeClipApi, removeOutput as removeOutputApi, removeTrack as removeTrackApi, reorderTracks as reorderTracksApi, runStudioCleanup as runStudioCleanupApi, setBrandPack as setBrandPackApi, speechToSpeechVoicePatch as speechToSpeechVoicePatchApi, triggerRenderDraft as triggerRenderDraftApi, triggerTranscribe as triggerTranscribeApi, uploadRecordingAsset as uploadRecordingAssetApi, uploadVideoAsset as uploadVideoAssetApi, type AddTrackInput, type CloneChainVoicePatchInput, type CloneChainVoicePatchResponse, type CreateGenerationInput, type CreateOperationInput, type CreateVoicePatchInput, type Diagnostics, type GenerationKind, type Job, type OperationResponse, type ProjectDetail, type StructureResponse, type TranscriptDoc, type UpdateOperationInput, type VoiceStatus } from '../lib/api';
import { latestRenderDraftJob } from './selectors';

export type ActivePanel = 'ai' | 'suggestions' | 'manifest' | 'clips' | 'inspect' | 'elements' | 'media' | null;
export type PreviewKind = 'source' | 'draft' | 'final';
// 'preview' is the clean, render-shaped projection: cuts removed, voice patches inlined,
// mute words faded but visible. Added 2026-05-24 per the post-ripple UX handoff — users
// care about "what the rendered output will say", not the EDITED view's revertable pills.
export type TranscriptMode = 'edited' | 'original' | 'preview';
export type Aspect = '16:9' | '9:16' | '1:1' | '4:5';
export type AiTab = 'agent' | 'terminal';
export type SelectionState = { start: number; end: number; text?: string; wordIds?: string[]; opId?: string } | null;

type UiState = {
  activePanel: ActivePanel;
  currentTime: number;
  playing: boolean;
  selection: SelectionState;
  previewKind: PreviewKind;
  transcriptMode: TranscriptMode;
  aspect: Aspect;
  aiTab: AiTab;
  transcriptWidth: number;
  transcriptCollapsed: boolean;
  previewCollapsed: boolean;
  timelineHeight: number;
  timelineCollapsed: boolean;
  panelWidth: number;
  timelineZoom: number;
  theme: 'light' | 'dark';
  renderDialogOpen: boolean;
  // v4 design-refresh surfaces (Wave 2). Transient UI unless noted persisted.
  paletteOpen: boolean;
  shortcutSheetOpen: boolean;
  // Inline proposal popover anchored to a proposed-mark click in the transcript.
  proposalPopover: { opId: string; x: number; y: number } | null;
  // Clean-up sweep: walking through filler/silence candidates one at a time.
  sweepActive: boolean;
  sweepIndex: number;
  sweepSkipped: string[];
  // Playback speed cycle [0.75,1,1.25,1.5,2]; persisted (etv.playSpeed).
  playSpeed: number;
  // Skip-silences during playback; persisted (etv.skipSilences), default true.
  skipSilences: boolean;
  // Transient redo stack for the pragmatic undo/redo (disable-last / restore-last).
  // Holds opIds that were undone (disabled) and can be redone (restored). Cleared on
  // any fresh edit (createOperation / approveOperation).
  undoneOpIds: string[];
};

export type StudioSoundStatus = 'idle' | 'running' | 'on' | 'error';

type DataState = {
  projectId: string;
  project: ProjectDetail['project'] | null;
  manifest: ManifestV3 | null;
  transcript: TranscriptDoc | null;
  jobs: Job[];
  proposedOutputs: OutputV3[];
  diagnostics: Diagnostics | null;
  providerRequests: Array<Record<string, unknown>>;
  costSummary: ProviderRequestCostSummary | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  acknowledgedRenderJobId: string | null;
  /** Transient UI status for the Studio Sound card. Not persisted. */
  studioSoundStatus: StudioSoundStatus;
  /**
   * S1b: the project's prepared voice clone, as GET /voice/status derives it from durable
   * facts (voices library + clone reservation + latest prepare job + the D6 freshness
   * contract). Never inferred locally — a restart is exactly when 'unknown-outcome' must
   * become visible, and only the server can see that.
   */
  voice: VoiceStatus;
  /** Disclosure text from the last prepare POST (D7). Cleared on project switch. */
  voicePrepareDisclosure: string | null;
  /** True between the prepare POST and the first status that reflects it (optimistic). */
  voicePreparing: boolean;
  // Timestamp of the last manifest mutation in this session — set to Date.now() on every
  // applyStructure/applyOperation. The auto-render lifecycle uses this as a "the user has
  // been actively editing here" signal: refresh() only schedules a catch-up auto-render
  // when this is non-null. Reset on project switch.
  lastAutoEditAt: number | null;
  // User toggle. Default true. When false, no auto-renders fire; the stale banner shows
  // a Render Now button instead. Persisted to localStorage so the choice survives reloads.
  autoRenderEnabled: boolean;
  // True once the user has clicked a tab in the center preview. Until then refresh() may
  // correct an initially-wrong default (e.g. hydrate landed on source because the jobs
  // list was missing the historical render-draft job, but the draft.mp4 file actually
  // exists on disk — first diagnostics refresh flips to draft). Once the user has chosen
  // explicitly, we never override their choice.
  previewKindLockedByUser: boolean;
};

type Actions = {
  hydrate: (projectId: string, initial: ProjectDetail) => void;
  load: (projectId?: string) => Promise<void>;
  refresh: () => Promise<void>;
  refreshDerived: () => Promise<void>;
  pollJobs: () => Promise<void>;
  triggerRenderDraft: () => Promise<void>;
  triggerTranscribe: () => Promise<void>;
  cancelRenderJob: (jobId: string) => Promise<void>;
  addTrack: (track: AddTrackInput) => Promise<void>;
  removeTrack: (trackId: string) => Promise<void>;
  reorderTracks: (order: { trackId: string; order: number }[]) => Promise<void>;
  patchTrack: (trackId: string, patch: Partial<Pick<TrackV3, 'name' | 'locked' | 'muted' | 'solo' | 'hidden' | 'fx'>>) => Promise<void>;
  addClip: (trackId: string, clip: ClipV3) => Promise<void>;
  moveClip: (clipId: string, timelineStart: number) => Promise<void>;
  trimClip: (clipId: string, sourceStart: number, sourceEnd: number) => Promise<void>;
  removeClip: (clipId: string) => Promise<void>;
  detachAudio: (clipId: string) => Promise<void>;
  addAsset: (asset: AssetV3) => Promise<void>;
  patchAsset: (assetId: string, patch: Partial<Omit<AssetV3, 'assetId'>>) => Promise<void>;
  removeAsset: (assetId: string) => Promise<void>;
  setBrandPack: (brandPackId: string | null) => Promise<void>;
  uploadVideoAsset: (file: File) => Promise<void>;
  uploadRecording: (blob: Blob, source: 'screen' | 'cam' | 'voice', durationSec: number) => Promise<void>;
  addOutput: (output: OutputV3) => Promise<void>;
  patchOutput: (outputId: string, patch: Partial<Omit<OutputV3, 'outputId'>>) => Promise<void>;
  removeOutput: (outputId: string) => Promise<void>;
  proposeOutputs: () => Promise<void>;
  createOperation: (operation: CreateOperationInput) => Promise<OperationV3 | null>;
  createVoicePatch: (input: CreateVoicePatchInput) => Promise<OperationV3 | null>;
  createSpeechToSpeechPatch: (formData: FormData) => Promise<OperationV3 | null>;
  /**
   * Run (or reuse cached) ElevenLabs Voice Isolator over the project's base
   * audio and set manifest.studioCleanup. Returns the cost disclosure string
   * so the UI can surface it without a separate state field.
   *
   * Paid-services policy: configuring ElevenLabs is consent; no per-call modal.
   * Sets studioSoundStatus to 'running' while in-flight, then 'on' on success.
   */
  runStudioSound: () => Promise<{ costDisclosure: string; cached: boolean } | null>;
  /**
   * Set studioCleanup.status to 'disabled'. Reversible — re-running runStudioSound
   * will reuse the cached asset (no paid call needed).
   */
  disableStudioSound: () => Promise<void>;
  /** Re-read GET /voice/status. Safe to call often; never mutates server state. */
  refreshVoiceStatus: () => Promise<VoiceStatus | null>;
  /**
   * POST /voice/prepare — queue (or join) the prepare-voice job, then poll it to a terminal.
   *
   * `auto` marks the EAGER kick after Studio Sound (D7): it re-reads the status first and
   * declines to start when a clone is ready, one is already preparing, or the last attempt
   * ended in 'unknown-outcome' — ⟨F2⟩ forbids auto-retrying an unknown paid outcome, only an
   * explicit user re-prepare may bill again.
   */
  prepareVoice: (opts?: { auto?: boolean }) => Promise<{ costDisclosure?: string; cached?: boolean } | null>;
  /**
   * D9 clone-chain patch. Unlike createVoicePatch this THROWS on failure (the typed 409s —
   * clone-not-ready / clone-stale / clone-unknown-outcome / paid-step-unknown-outcome — drive
   * different UI affordances and must reach the caller as ApiError, not a store error string).
   *
   * `supersedeOperationIds` are the type-over mute ops this generation replaces. They are
   * disabled HERE, against the project the POST was issued for, because that cleanup is
   * required regardless of where the user has navigated to meanwhile.
   *
   * Returns `status: 'stale'` when the user left the project mid-generation: the result is real
   * and was persisted server-side, but the caller must not run UI side effects for it.
   */
  createCloneChainVoicePatch: (input: CloneChainVoicePatchInput & { supersedeOperationIds?: string[] }) => Promise<{ status: 'applied' | 'stale'; projectId: string; response: CloneChainVoicePatchResponse }>;
  createGeneration: (kind: GenerationKind, prompt: string, opts?: Omit<CreateGenerationInput, 'kind' | 'prompt'>) => Promise<void>;
  updateOperation: (operationId: string, patch: UpdateOperationInput) => Promise<void>;
  approveOperation: (operationId: string) => Promise<void>;
  rejectOperation: (operationId: string) => Promise<void>;
  disableOperation: (operationId: string, reason?: string) => Promise<void>;
  restoreOperation: (operationId: string) => Promise<void>;
  seek: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  setPanel: (panel: ActivePanel) => void;
  setSelection: (selection: SelectionState) => void;
  setPreviewKind: (kind: PreviewKind) => void;
  setPreviewCollapsed: (collapsed: boolean) => void;
  setTranscriptMode: (mode: TranscriptMode) => void;
  setAspect: (aspect: Aspect) => void;
  setAiTab: (tab: AiTab) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setTranscriptWidth: (width: number) => void;
  setTranscriptCollapsed: (collapsed: boolean) => void;
  setTimelineHeight: (height: number) => void;
  setTimelineCollapsed: (collapsed: boolean) => void;
  setPanelWidth: (width: number) => void;
  setTimelineZoom: (zoom: number) => void;
  setRenderDialogOpen: (open: boolean) => void;
  setAutoRenderEnabled: (enabled: boolean) => void;
  // v4 design-refresh actions (Wave 2).
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  setShortcutSheetOpen: (open: boolean) => void;
  setProposalPopover: (popover: { opId: string; x: number; y: number } | null) => void;
  startSweep: () => void;
  closeSweep: () => void;
  setSweepIndex: (index: number) => void;
  addSweepSkipped: (id: string) => void;
  setPlaySpeed: (speed: number) => void;
  cyclePlaySpeed: () => void;
  setSkipSilences: (enabled: boolean) => void;
  toggleSkipSilences: () => void;
  // Pragmatic undo/redo over the manifest's reversible ops. undo() disables the most
  // recently created ENABLED, non-proposed op; redo() restores the last undone op.
  undo: () => void;
  redo: () => void;
  // Derived getters (computed from manifest + undoneOpIds at call time). Exposed as
  // methods so Zustand re-runs the consuming selector on every state change. This store
  // keeps derived logic in selectors.ts / standalone fns, so methods fit the idiom.
  canUndo: () => boolean;
  canRedo: () => boolean;
  undoLabel: () => string | null;
  redoLabel: () => string | null;
};

export type EditorStore = UiState & DataState & Actions;

const storage = {
  getNumber(key: string, fallback: number) {
    if (typeof window === 'undefined') return fallback;
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  },
  getBool(key: string, fallback = false) {
    if (typeof window === 'undefined') return fallback;
    const value = window.localStorage.getItem(key);
    return value == null ? fallback : value === '1';
  },
  getString<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
    if (typeof window === 'undefined') return fallback;
    const value = window.localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  },
  set(key: string, value: string | number | boolean) {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

// Playback-speed cycle for the preview transport (v4). Cycling wraps back to the start.
const PLAY_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

// The undo target: the most-recently-created ENABLED, non-proposed operation. "Enabled"
// means it's currently contributing to the render (status 'approved'); a disabled/rejected
// op is already off, and a 'proposed'/'awaiting_approval' op hasn't been committed by the
// user so it isn't an undo-able edit. Sort by createdAt desc and take the first match.
// Returns null when there's nothing to undo.
function undoTargetOp(manifest: ManifestV3 | null): OperationV3 | null {
  const ops = manifest?.operations;
  if (!ops || ops.length === 0) return null;
  let best: OperationV3 | null = null;
  let bestMs = -Infinity;
  for (const op of ops) {
    if (op.status !== 'approved') continue;
    const ms = Date.parse(op.createdAt);
    const t = Number.isFinite(ms) ? ms : -Infinity;
    // >= so that, among equal timestamps, later entries (closer to the end of the array =
    // more recently appended) win — matching "most recently created".
    if (t >= bestMs) {
      bestMs = t;
      best = op;
    }
  }
  return best;
}

function latestSucceededRenderDraftJobId(jobs: Job[] = []) {
  return jobs.find((job) => job.type === 'render-draft' && job.status === 'succeeded' && job.completedAt)?.jobId || null;
}

function latestSucceededRenderDraftCompletedAt(jobs: Job[] = []): string | null {
  return jobs.find((job) => job.type === 'render-draft' && job.status === 'succeeded' && job.completedAt)?.completedAt || null;
}

// True when at least one render-draft job has ever completed for this project (i.e. draft.mp4
// likely exists). Used at hydrate time to pick the initial preview tab — diagnostics aren't
// loaded yet, but jobs come down with the project detail.
function hasEverRenderedDraft(jobs: Job[] = []): boolean {
  return jobs.some((job) => job.type === 'render-draft' && job.status === 'succeeded' && job.completedAt);
}

// Module-scoped because the store is a singleton in this app. Keeping it outside the store
// lets us coalesce edit bursts without each setState() recreating closures over a stored
// timer id. Cleared whenever the project switches or hydrate() runs.
let autoRenderTimer: ReturnType<typeof setTimeout> | null = null;

function cancelAutoRender() {
  if (autoRenderTimer) {
    clearTimeout(autoRenderTimer);
    autoRenderTimer = null;
  }
}

/**
 * The typed preflight failures POST /voice/prepare answers with (voiceRoutes.ts
 * VoicePrepareErrorCode). These are states of the project, not failures of the request, so the
 * voice chip owns them; anything OUTSIDE this set is a genuine error and must surface.
 */
const VOICE_PREFLIGHT_ERROR_CODES = new Set([
  'transcript-not-word-accurate',
  'cleaned-source-unavailable',
  'multi-clip-unsupported',
  'insufficient-clean-windows',
  'voice-slot-limit'
]);

// Generation counter for the prepare-voice poller. Bumped on every hydrate/load so a poll
// loop started for project A stops the moment the user navigates to project B — the loop is
// an await chain, not a timer, so there is nothing to clearTimeout.
let voicePollSeq = 0;

/**
 * Poll a prepare-voice job to its terminal, mirroring pollJobToCompletion but reading BOTH
 * sources: the job (for the decoding → selecting-windows → cloning stages the chip shows) and
 * /voice/status (the authoritative state — it also runs restart reconciliation, so it is what
 * turns a dangling 'preparing' into 'unknown-outcome').
 *
 * The job may 404 briefly (the reservation is written before the queued record is visible to a
 * fresh read on some filesystems), so a job read failure is never fatal to the loop.
 */
async function pollVoicePreparation(projectId: string, jobId: string | null, set: (partial: Partial<EditorStore>) => void, get: () => EditorStore) {
  const seq = voicePollSeq;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await delay(1500);
    if (seq !== voicePollSeq || get().projectId !== projectId) return;
    if (jobId) {
      try {
        const response = await getProjectJob(projectId, jobId);
        if (seq !== voicePollSeq || get().projectId !== projectId) return;
        set({ jobs: upsertJob(get().jobs, response.job) });
      } catch { /* job log not readable yet — the status below is the authority anyway */ }
    }
    let status: VoiceStatus;
    try {
      status = await getVoiceStatusApi(projectId);
    } catch {
      continue;
    }
    if (seq !== voicePollSeq || get().projectId !== projectId) return;
    set({ voice: status, voicePreparing: status.state === 'preparing' });
    if (status.state !== 'preparing') return;
  }
  // Gave up watching (10 minutes). Leave the last known state alone rather than inventing a
  // terminal the server never reported — a paid clone may still be in flight.
  if (seq === voicePollSeq && get().projectId === projectId) set({ voicePreparing: false });
}

// Schedules a debounced render-draft for the active project. Coalesces multiple manifest
// mutations made within ~1.5s into a single render. Refuses to fire if a render is already
// in flight (the next refresh() will retry if the result lands stale). Best-effort — failures
// are logged but never surface as a user-visible error, because the user didn't ask for this
// render explicitly. CENTRAL TO ITEM 4 OF THE 2026-05-24 POST-RIPPLE UX HANDOFF: edits used
// to be recorded in the manifest but the draft render lagged behind, so the user perceived
// "the video doesn't change when I edit." This closes that loop.
function scheduleAutoRender(get: () => EditorStore) {
  cancelAutoRender();
  const initialState = get();
  if (!initialState.autoRenderEnabled) return;
  autoRenderTimer = setTimeout(async function fireAutoRender() {
    autoRenderTimer = null;
    const state = get();
    if (!state.projectId || !state.autoRenderEnabled) return;
    // Cancel-on-edit (2026-05-26 user feedback): if a render-draft is in-flight and the user
    // has made edits since that render STARTED, cancel the in-flight render and immediately
    // launch a fresh one against the current manifest. The old back-off-and-retry behavior
    // serialized renders — many edits in a row stacked behind a slow render and the preview
    // lagged the user's last edit by minutes. Cancellation throws away wall-clock ffmpeg
    // work but bounds the latency from "last edit" to "fresh preview" at one render
    // duration, not stacked renders. If the in-flight render started AFTER the last edit
    // (no edits to apply), leave it alone — it will produce the right result.
    const running = state.jobs.find((j) => j.type === 'render-draft' && !isTerminalJobStatus(j.status));
    if (running) {
      const lastEditMs = state.lastAutoEditAt ?? 0;
      const inflightStartedMs = running.createdAt ? Date.parse(running.createdAt) : 0;
      const hasEditsSinceRunningStart = lastEditMs > 0 && Number.isFinite(inflightStartedMs) && lastEditMs > inflightStartedMs;
      if (!hasEditsSinceRunningStart) {
        // In-flight render started AFTER the last edit; it will produce the right result.
        // Keep waiting; a future fireAutoRender call (post-render staleness check) handles
        // the case where the render finishes but the server still reports 'stale'.
        return;
      }
      // Cancel best-effort; don't block the new render on the cancellation roundtrip. The
      // server marks the cancelled job in its history; the new render writes its own temp
      // file via renderPlanV3's atomic temp+rename. Failures here are non-fatal — at worst
      // the old render finishes and the next fireAutoRender catches the stale state.
      try {
        await cancelJobApi(state.projectId!, running.jobId);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('Auto-render cancel failed (continuing with new render):', error);
      }
    }
    // Decide whether there's actually work to do. Two complementary signals:
    //  (a) lastAutoEditAt > lastSuccessfulRender.completedAt — we KNOW there are edits
    //      newer than the last render. Session-local timestamps; updated synchronously.
    //  (b) server diagnostics report draft 'stale' — the server compared the manifest
    //      content hash against the last render's input and decided they differ.
    //
    // Either signal is sufficient. Need both negative to skip. This catches a subtle race
    // (Codex P2 2026-05-24 pass 5): an in-flight render started with manifest@T1, user
    // edits to manifest@T2 mid-render (T2 > T1, lastAutoEditAt = T2). The render completes
    // at T3 (T3 > T2). Now lastEditMs <= lastRenderMs, BUT the render's output reflects T1
    // and the server still says 'stale'. Without the freshness check, we'd skip and the
    // catch-up scheduled by refresh() would loop endlessly with no rendering — preview
    // never converges. Conversely, the timestamp check covers Codex P2-2: stale-diagnostics
    // races where the server view hasn't caught up yet but we know we've edited.
    const latestRenderAt = latestSucceededRenderDraftCompletedAt(state.jobs);
    const lastRenderMs = latestRenderAt ? Date.parse(latestRenderAt) : 0;
    const lastEditMs = state.lastAutoEditAt ?? 0;
    const hasEditsAfterRender = lastEditMs > 0 && Number.isFinite(lastRenderMs) && lastEditMs > lastRenderMs;
    const serverSaysStale = state.diagnostics?.renderFreshness?.draft?.state === 'stale';
    if (!hasEditsAfterRender && !serverSaysStale) return;
    // Pin the project id so a late response can't bleed into a different project the user
    // navigated to. hydrate() cancels the debounce timer but cannot cancel an in-flight
    // request; the post-await guard absorbs that race. (Codex P2-3 2026-05-24.)
    const projectIdAtCall = state.projectId;
    try {
      const response = await triggerRenderDraftApi(projectIdAtCall);
      if (get().projectId !== projectIdAtCall) return;
      // No notice: "Queued draft render…" would spam on every keystroke debounce. The UI
      // surfaces the in-flight state via the freshness/rendering banner in CenterPreview.
      // (Manual triggerRenderDraft() still sets a notice — it's an explicit user action.)
      useEditorStore.setState({
        jobs: [response.job, ...get().jobs.filter((j) => j.jobId !== response.job.jobId)]
      });
      await get().refresh();
    } catch (error) {
      // Auto-render is best-effort. Never surface as a user-visible error since they didn't
      // explicitly request it — the stale banner will keep showing, signaling to retry.
      // eslint-disable-next-line no-console
      console.warn('Auto-render failed:', error);
    }
  }, 1500);
}

// A succeeded render-draft is "fresh" when the manifest hasn't been touched since the render
// finished. If the user has edited the manifest (added voice_patches, cuts, etc.) after the
// last render, draft.mp4 no longer reflects current state and we should NOT auto-switch
// preview to it — that would silently play stale audio. Both timestamps come from
// nowIso()/new Date().toISOString() so a string compare works, but we parse to be defensive
// about future ISO offset/timezone variants. Missing manifestUpdatedAt is treated as "not
// fresh" (fail-closed): if we can't prove the draft matches the manifest, don't auto-switch.
//
// KNOWN NARROW LIMITATION: completedAt >= updatedAt proves the render FINISHED after the last
// manifest edit, not that the render USED that manifest. If a concurrent CLI/agent edits the
// manifest while a render is in flight, the in-flight render uses the pre-edit manifest but
// the completedAt timestamp may still land after the new updatedAt. For a single-user product
// this is rare. A stronger check would be a manifest-hash captured by the render job at start
// time — left for a future slice when concurrent editing becomes a real scenario.
function isDraftFresh(jobs: Job[] = [], manifestUpdatedAt?: string | null): boolean {
  const renderAt = latestSucceededRenderDraftCompletedAt(jobs);
  if (!renderAt || !manifestUpdatedAt) return false;
  const renderMs = Date.parse(renderAt);
  const manifestMs = Date.parse(manifestUpdatedAt);
  if (!Number.isFinite(renderMs) || !Number.isFinite(manifestMs)) return false;
  return renderMs >= manifestMs;
}

export function isTerminalJobStatus(status: Job['status']) {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function upsertJob(jobs: Job[], job: Job) {
  return [job, ...jobs.filter((candidate) => candidate.jobId !== job.jobId)];
}

function pendingUploadJob(jobId: string, clipId: string): Job {
  return { jobId, type: 'upload-video', status: 'queued', stages: [{ name: 'upload', status: 'queued', clipId, phase: 'queued' }], createdAt: new Date().toISOString() };
}

function pendingRecordingJob(jobId: string, clipId: string): Job {
  return { jobId, type: 'record-clip', status: 'queued', stages: [{ name: 'upload', status: 'queued', clipId, phase: 'queued' }], createdAt: new Date().toISOString() };
}

function applyStructure(set: any, get: () => EditorStore, response: StructureResponse, notice?: string) {
  set({ manifest: response.manifest, error: null, lastAutoEditAt: Date.now(), ...(notice ? { notice } : {}) });
  void get().refreshDerived();
  scheduleAutoRender(get);
}

function applyOperation(set: any, get: () => EditorStore, response: OperationResponse, notice?: string) {
  // Always bump lastAutoEditAt + schedule the auto-render. The earlier Wave 1
  // attempt to skip non-render ops (e.g. transcript_amend) left the draft
  // permanently stale: the manifest fingerprint moved on disk but the
  // freshness path that clears stale never fires. The render itself is cheap
  // when bytes don't change (FFmpeg redo on identical inputs is fast), and
  // the scheduler debounces, so this is the safe correctness choice until
  // Wave 3's optimistic store has a real reconciliation contract.
  set({ manifest: response.manifest, error: null, lastAutoEditAt: Date.now(), ...(notice ? { notice } : {}) });
  void get().refreshDerived();
  scheduleAutoRender(get);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollJobToCompletion(projectId: string, jobId: string, set: (partial: Partial<EditorStore>) => void, get: () => EditorStore) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const response = await getProjectJob(projectId, jobId);
    set({ jobs: upsertJob(get().jobs, response.job) });
    if (isTerminalJobStatus(response.job.status)) {
      if (response.job.status === 'succeeded') await get().refresh();
      return response.job;
    }
    await delay(1000);
  }
  throw new Error(`Timed out waiting for ${jobId}`);
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  projectId: '',
  project: null,
  manifest: null,
  transcript: null,
  jobs: [],
  proposedOutputs: [],
  diagnostics: null,
  providerRequests: [],
  costSummary: null,
  loading: false,
  error: null,
  notice: null,
  acknowledgedRenderJobId: null,
  studioSoundStatus: 'idle' as StudioSoundStatus,
  voice: { state: 'none' } as VoiceStatus,
  voicePrepareDisclosure: null,
  voicePreparing: false,
  lastAutoEditAt: null,
  autoRenderEnabled: true,
  previewKindLockedByUser: false,
  activePanel: null,
  currentTime: 0,
  playing: false,
  selection: null,
  previewKind: 'source',
  // Default to 'preview' (clean render-shaped script). EDITED is the working view with
  // pills; ORIGINAL is the raw transcript. Per 2026-05-24 handoff: users care about what
  // the rendered output will say, not the revertable-pill view.
  transcriptMode: 'preview',
  aspect: '16:9',
  aiTab: 'agent',
  transcriptWidth: 560,
  transcriptCollapsed: false,
  previewCollapsed: false,
  timelineHeight: 210,
  timelineCollapsed: false,
  panelWidth: 420,
  timelineZoom: 1,
  theme: 'light',
  renderDialogOpen: false,
  // v4 design-refresh surfaces. playSpeed/skipSilences hydrate from localStorage in
  // hydrate() (alongside the other persisted UI prefs); the SSR-safe defaults here keep
  // the first server/client render deterministic.
  paletteOpen: false,
  shortcutSheetOpen: false,
  proposalPopover: null,
  sweepActive: false,
  sweepIndex: 0,
  sweepSkipped: [],
  playSpeed: 1,
  skipSilences: true,
  undoneOpIds: [],
  hydrate(projectId, initial) {
    // Different project than whatever was loaded previously — drop any pending auto-render
    // timer so it doesn't fire against the new project's state.
    cancelAutoRender();
    // …and stop any in-flight prepare-voice poll, which is scoped to the OLD project.
    voicePollSeq += 1;
    set({
      projectId,
      project: initial.project,
      manifest: initial.manifest,
      transcript: initial.transcript,
      jobs: initial.jobs || [],
      proposedOutputs: [],
      diagnostics: null,
      providerRequests: [],
      costSummary: null,
      loading: false,
      error: null,
      notice: null,
      selection: null,
      currentTime: 0,
      // Rehydrate Studio Sound state from the persisted manifest so a project that
      // already has an approved studio-cleanup shows the applied/revertable state
      // (not "run") on load (codex P2).
      studioSoundStatus: (initial.manifest?.studioCleanup?.status === 'approved' ? 'on' : 'idle') as StudioSoundStatus,
      // Voice state is server-derived; start from 'none' and let refresh() fill it in rather
      // than guessing from the manifest (the clone lives in the voices library, not here).
      voice: { state: 'none' },
      voicePrepareDisclosure: null,
      voicePreparing: false,
      lastAutoEditAt: null,
      previewKindLockedByUser: false,
      // Default to DRAFT whenever a draft has ever been rendered for this project (regardless
      // of freshness). Per the 2026-05-24 post-ripple UX handoff: users care about "the final
      // of where things are going", not the original source. If the draft is stale, the
      // stale banner (and Item 4's auto-rerender on the next user edit) keep it honest.
      // Fall back to 'source' only when no draft has ever rendered (e.g. fresh import).
      // If the jobs list has been pruned and the historical render-draft is gone but
      // draft.mp4 actually exists on disk, the first refresh() will correct this to 'draft'
      // via the diagnostics-based fixup below (Hermes browser smoke 2026-05-24).
      previewKind: hasEverRenderedDraft(initial.jobs || []) ? 'draft' : 'source',
      acknowledgedRenderJobId: latestSucceededRenderDraftJobId(initial.jobs || [])
    });
    if (typeof window !== 'undefined') {
      const theme = storage.getString('etv.theme', 'light', ['light', 'dark'] as const);
      document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
      // Honor the user's previously-chosen preview tab across reloads. Without persisting
      // this, an explicit SOURCE click was forgotten on reload and the auto-default flipped
      // back to DRAFT (Hermes browser smoke pass 2, 2026-05-24). Codex P2 pass 2: scope the
      // persisted choice per-project, because a `draft` selection on project A would
      // otherwise leak to project B (where draft.mp4 may not exist yet) and skip the
      // hydrate default. setPreviewKind below writes the value + marks locked.
      const storedPreviewKind = window.localStorage.getItem(`etv.previewKind.${projectId}`) as PreviewKind | null;
      const validPreviewKind: PreviewKind | null = storedPreviewKind === 'source' || storedPreviewKind === 'draft' || storedPreviewKind === 'final' ? storedPreviewKind : null;
      set({
        theme,
        transcriptWidth: storage.getNumber('etv.transcriptWidth', 560),
        transcriptCollapsed: storage.getBool('etv.transcriptCollapsed'),
        previewCollapsed: storage.getBool('etv.previewCollapsed'),
        timelineHeight: storage.getNumber('etv.timelineHeight', 210),
        timelineCollapsed: storage.getBool('etv.timelineCollapsed'),
        panelWidth: storage.getNumber('etv.panelWidth', 420),
        aiTab: storage.getString('etv.aiTab', 'agent', ['agent', 'terminal'] as const),
        timelineZoom: storage.getNumber('etv.tlZoom', 1),
        autoRenderEnabled: storage.getBool('etv.autoRender', true),
        playSpeed: storage.getNumber('etv.playSpeed', 1),
        skipSilences: storage.getBool('etv.skipSilences', true),
        ...(validPreviewKind ? { previewKind: validPreviewKind, previewKindLockedByUser: true } : {})
      });
    }
    void get().refresh();
  },
  async load(projectId = get().projectId) {
    set({ loading: true, error: null });
    try {
      const detail = await getProject(projectId);
      voicePollSeq += 1;
      set({ projectId, project: detail.project, manifest: detail.manifest, transcript: detail.transcript, jobs: detail.jobs || [], proposedOutputs: [], loading: false,
        // Reflect any persisted studio-cleanup on project switch (codex P2).
        studioSoundStatus: (detail.manifest?.studioCleanup?.status === 'approved' ? 'on' : 'idle') as StudioSoundStatus,
        voice: { state: 'none' }, voicePrepareDisclosure: null, voicePreparing: false });
      await get().refresh();
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },
  async refresh() {
    const { projectId } = get();
    if (!projectId) return;
    try {
      const [detail, diag, provider] = await Promise.all([
        getProject(projectId),
        getProjectDiagnostics(projectId).catch((): { diagnostics: Diagnostics | null } => ({ diagnostics: null })),
        getProviderRequestSummary(projectId).catch(() => ({ providerRequests: [] as Array<Record<string, unknown>>, costSummary: null }))
      ]);
      // PROJECT GUARD, before the first mutation and not after the last one. These responses
      // describe the project that was open when the request went out; if the user has since
      // navigated, writing them would put project A's manifest, jobs and diagnostics into
      // project B's store. Guarding here protects every caller of refresh(), not just the one
      // that noticed.
      if (get().projectId !== projectId) return;
      set({ project: detail.project, manifest: detail.manifest, transcript: detail.transcript, jobs: detail.jobs || [], diagnostics: diag.diagnostics, providerRequests: provider.providerRequests || [], costSummary: provider.costSummary || null, error: null });
      // Voice freshness is a function of the manifest's studioCleanup generation (D6), so the
      // one place that reloads the manifest is the right place to re-derive it. Fire-and-forget:
      // a voice-status failure must never fail the whole refresh.
      void get().refreshVoiceStatus();
      // Hermes browser smoke 2026-05-24: hydrate sets previewKind from `initial.jobs`, which
      // may be missing the historical render-draft job if the jobs log was pruned across
      // server restarts. diag.diagnostics.files.draft.exists is the authoritative on-disk
      // signal — if a draft.mp4 is sitting on disk and the user hasn't clicked a tab yet,
      // correct the initially-wrong source default. Only runs once per session (locked by
      // setPreviewKind).
      const corrected = get();
      if (!corrected.previewKindLockedByUser && corrected.previewKind === 'source' && diag.diagnostics?.files?.draft?.exists) {
        set({ previewKind: 'draft' });
      }
      // Mid-session auto-switch: when a NEW render-draft completes, flip the preview to draft
      // so the user immediately hears their edits. Gated on freshness (manifest unchanged since
      // render) so an in-flight manifest edit while the render was running doesn't auto-promote
      // a now-stale draft. The new-jobId check still prevents re-firing for a render that was
      // already acknowledged earlier in the session.
      const succeeded = (detail.jobs || []).find((job) => job.type === 'render-draft' && job.status === 'succeeded' && job.completedAt);
      if (succeeded && succeeded.jobId !== get().acknowledgedRenderJobId && isDraftFresh(detail.jobs || [], detail.manifest?.updatedAt)) {
        set({ previewKind: 'draft', notice: 'Draft render complete. Preview switched to draft.', acknowledgedRenderJobId: succeeded.jobId });
      } else if (succeeded && succeeded.jobId !== get().acknowledgedRenderJobId) {
        // Don't auto-switch (draft is stale) but still acknowledge so we don't keep re-evaluating
        // the same finished job on every refresh tick.
        set({ acknowledgedRenderJobId: succeeded.jobId });
      }
      // ITEM 4 CATCH-UP: if the user kept editing while the previous auto-render was in
      // flight, the just-refreshed diagnostics will still report 'stale'. Schedule another
      // auto-render to converge. Gated on lastAutoEditAt so we don't auto-render on hydrate
      // for projects whose draft was already stale from a prior session — the user might
      // just be reviewing, not editing.
      const post = get();
      const stillStale = post.diagnostics?.renderFreshness?.draft?.state === 'stale';
      const hasRunning = (detail.jobs || []).some((j) => j.type === 'render-draft' && !isTerminalJobStatus(j.status));
      if (stillStale && post.lastAutoEditAt != null && !hasRunning && post.autoRenderEnabled) {
        scheduleAutoRender(get);
      }
    } catch (error) {
      if (get().projectId !== projectId) return;
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
  async refreshDerived() {
    const { projectId } = get();
    if (!projectId) return;
    const [diag, provider] = await Promise.all([
      getProjectDiagnostics(projectId).catch((): { diagnostics: Diagnostics | null } => ({ diagnostics: null })),
      getProviderRequestSummary(projectId).catch(() => ({ providerRequests: [] as Array<Record<string, unknown>>, costSummary: null }))
    ]);
    if (get().projectId !== projectId) return;
    set({ diagnostics: diag.diagnostics, providerRequests: provider.providerRequests || [], costSummary: provider.costSummary || null });
  },
  async pollJobs() {
    const { projectId } = get();
    if (!projectId) return;
    const jobs = await getProjectJobs(projectId);
    if (get().projectId !== projectId) return;
    set({ jobs: jobs.jobs });
  },
  async triggerRenderDraft() {
    const { projectId } = get();
    if (!projectId) return;
    set({ error: null, notice: 'Queued draft render…' });
    try {
      const response = await triggerRenderDraftApi(projectId);
      set({ jobs: [response.job, ...get().jobs.filter((job) => job.jobId !== response.job.jobId)] });
      await get().refresh();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
  async triggerTranscribe() {
    const { projectId } = get();
    if (!projectId) return;
    set({ error: null, notice: 'Queued re-transcribe…' });
    try {
      const response = await triggerTranscribeApi(projectId);
      set({ jobs: [response.job, ...get().jobs.filter((job) => job.jobId !== response.job.jobId)] });
      await get().refresh();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
  async cancelRenderJob(jobId) {
    const { projectId } = get();
    if (!projectId) return;
    try {
      const response = await cancelJobApi(projectId, jobId);
      set({ jobs: [response.job, ...get().jobs.filter((job) => job.jobId !== jobId)], notice: `Cancelled ${jobId}` });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
  async addTrack(track) { try { applyStructure(set, get, await addTrackApi(get().projectId, track), 'Track added.'); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async removeTrack(trackId) { try { applyStructure(set, get, await removeTrackApi(get().projectId, trackId), 'Track removed.'); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async reorderTracks(order) { try { applyStructure(set, get, await reorderTracksApi(get().projectId, order)); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async patchTrack(trackId, patch) { try { applyStructure(set, get, await patchTrackApi(get().projectId, trackId, patch)); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async addClip(trackId, clip) { try { applyStructure(set, get, await addClipApi(get().projectId, trackId, clip), 'Clip added to timeline.'); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async moveClip(clipId, timelineStart) { try { applyStructure(set, get, await patchClipApi(get().projectId, clipId, { timelineStart })); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async trimClip(clipId, sourceStart, sourceEnd) { try { applyStructure(set, get, await patchClipApi(get().projectId, clipId, { sourceStart, sourceEnd })); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async removeClip(clipId) { try { applyStructure(set, get, await removeClipApi(get().projectId, clipId), 'Clip removed.'); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async detachAudio(clipId) { try { applyStructure(set, get, await detachAudioApi(get().projectId, clipId), 'Audio detached to dialog track.'); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async addAsset(asset) { try { applyStructure(set, get, await addAssetApi(get().projectId, asset), 'Asset added.'); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async patchAsset(assetId, patch) { try { applyStructure(set, get, await patchAssetApi(get().projectId, assetId, patch)); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async removeAsset(assetId) { try { applyStructure(set, get, await removeAssetApi(get().projectId, assetId), 'Asset removed.'); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async setBrandPack(brandPackId) { try { applyStructure(set, get, await setBrandPackApi(get().projectId, brandPackId), brandPackId ? 'Brand pack applied.' : 'Brand pack cleared.'); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async uploadVideoAsset(file) { try { const projectId = get().projectId; const response = await uploadVideoAssetApi(projectId, file); let job = pendingUploadJob(response.jobId, response.clipId); try { job = (await getProjectJob(projectId, response.jobId)).job; } catch {} set({ jobs: upsertJob(get().jobs, job), notice: 'Upload queued…', error: null }); void pollJobToCompletion(projectId, response.jobId, set, get).then((done) => set({ notice: done.status === 'succeeded' ? 'Upload complete.' : `Upload ${done.status}.` })).catch((error) => set({ error: error instanceof Error ? error.message : String(error) })); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async uploadRecording(blob, source, durationSec) { try { const projectId = get().projectId; const response = await uploadRecordingAssetApi(projectId, blob, source, durationSec); let job = pendingRecordingJob(response.jobId, response.clipId); try { job = (await getProjectJob(projectId, response.jobId)).job; } catch {} set({ jobs: upsertJob(get().jobs, job), notice: 'Recording queued…', error: null }); void pollJobToCompletion(projectId, response.jobId, set, get).then((done) => set({ notice: done.status === 'succeeded' ? 'Recording saved.' : `Recording ${done.status}.` })).catch((error) => set({ error: error instanceof Error ? error.message : String(error) })); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async addOutput(output) { try { applyStructure(set, get, await addOutputApi(get().projectId, output), 'Output added.'); set({ proposedOutputs: get().proposedOutputs.filter((candidate) => candidate.outputId !== output.outputId) }); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async patchOutput(outputId, patch) { try { applyStructure(set, get, await patchOutputApi(get().projectId, outputId, patch)); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async removeOutput(outputId) { try { applyStructure(set, get, await removeOutputApi(get().projectId, outputId), 'Output removed.'); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async proposeOutputs() { try { const response = await proposeOutputsApi(get().projectId); set({ proposedOutputs: response.outputs, notice: `${response.outputs.length} output candidate${response.outputs.length === 1 ? '' : 's'} proposed.`, error: null }); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async createOperation(operation) { try { const response = await createOperationApi(get().projectId, operation); applyOperation(set, get, response, `${response.operation.type} operation added.`); set({ undoneOpIds: [] }); return response.operation; } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); return null; } },
  async createVoicePatch(input) { try { const response = await createVoicePatchApi(get().projectId, input); applyOperation(set, get, response, 'Voice patch added.'); set({ undoneOpIds: [] }); return response.operation; } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); return null; } },
  async createSpeechToSpeechPatch(formData) { try { const response = await speechToSpeechVoicePatchApi(get().projectId!, formData); applyOperation(set, get, response, 'Take recorded.'); set({ undoneOpIds: [] }); return response.operation; } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); return null; } },
  async createGeneration(kind, prompt, opts) { try { const response = await createGenerationApi(get().projectId, { kind, prompt, ...(opts || {}) }); applyStructure(set, get, response, 'Generated.'); set({ undoneOpIds: [] }); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async updateOperation(operationId, patch) { try { applyOperation(set, get, await patchOperationApi(get().projectId, operationId, patch), 'Operation updated.'); set({ undoneOpIds: [] }); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async approveOperation(operationId) {
    try {
      applyOperation(set, get, await patchOperationApi(get().projectId, operationId, { status: 'approved' }), 'Operation approved.');
      // A fresh edit invalidates the redo stack.
      set({ undoneOpIds: [] });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
  async rejectOperation(operationId) { try { applyOperation(set, get, await patchOperationApi(get().projectId, operationId, { status: 'rejected' }), 'Operation rejected.'); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async disableOperation(operationId, reason) { try { applyOperation(set, get, await disableOperationApi(get().projectId, operationId, reason), 'Operation disabled.'); } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); } },
  async restoreOperation(operationId) {
    try {
      applyOperation(set, get, await patchOperationApi(get().projectId, operationId, { status: 'approved' }), 'Operation restored.');
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
  async runStudioSound() {
    const { projectId } = get();
    if (!projectId) return null;
    set({ studioSoundStatus: 'running', error: null });
    try {
      const response = await runStudioCleanupApi(projectId);
      // Update the manifest optimistically — the route already saved it server-side.
      set({ manifest: response.manifest, studioSoundStatus: 'on', lastAutoEditAt: Date.now() });
      void get().refreshDerived();
      scheduleAutoRender(get);
      // D7 EAGER KICK: the clone trains on the cleaned recording, so a fresh cleanup is exactly
      // when the voice must be (re)prepared. Fire-and-forget — the CleanupStrip voice chip owns
      // the disclosure and the progress; a prepare failure must not turn a successful Studio
      // Sound run into an error. prepareVoice({auto}) itself decides whether billing is allowed.
      void get().prepareVoice({ auto: true });
      return { costDisclosure: response.costDisclosure, cached: response.cached };
    } catch (error) {
      set({ studioSoundStatus: 'error', error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },
  async disableStudioSound() {
    const { projectId } = get();
    if (!projectId) return;
    try {
      const response = await disableStudioCleanupApi(projectId);
      set({ manifest: response.manifest, studioSoundStatus: 'idle', lastAutoEditAt: Date.now() });
      void get().refreshDerived();
      void get().refreshVoiceStatus();
      scheduleAutoRender(get);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
  async refreshVoiceStatus() {
    const { projectId } = get();
    if (!projectId) return null;
    try {
      const status = await getVoiceStatusApi(projectId);
      // Late-response guard: a status for the project we just navigated away from must not
      // land on the new project's chip.
      if (get().projectId !== projectId) return null;
      set({ voice: status, ...(status.state === 'preparing' ? {} : { voicePreparing: false }) });
      return status;
    } catch {
      // The status endpoint is a read of durable state; a transient failure means "unknown",
      // not "none" — leave the last known value in place.
      return null;
    }
  },
  async prepareVoice(opts) {
    const { projectId } = get();
    if (!projectId) return null;
    const auto = opts?.auto === true;
    if (auto) {
      // FAIL CLOSED on an unreadable status. The local `voice` value is 'none' right after
      // hydration, so falling back to it would let a single failed GET turn an eager kick into
      // a paid clone for a project whose DURABLE state is 'unknown-outcome' — precisely the
      // re-bill ⟨F2⟩ forbids. Only an authoritative answer may authorize an automatic call;
      // the user can still prepare explicitly.
      const current = await get().refreshVoiceStatus();
      if (!current) return null;
      // ⟨F2⟩: an unknown paid outcome is NEVER auto-retried — only an explicit user
      // re-prepare may bill again. 'ready'/'preparing' need no second call either.
      if (current.state === 'ready' || current.state === 'preparing' || current.state === 'unknown-outcome') return null;
      if (get().voicePreparing) return null;
    }
    set({ voicePreparing: true, error: null });
    try {
      const response = await prepareVoiceApi(projectId);
      if (get().projectId !== projectId) return null;
      if (response.status) {
        // 200 + cached: the clone already existed and nothing was billed.
        set({ voice: response.status, voicePreparing: false, voicePrepareDisclosure: null });
        return { cached: true };
      }
      const jobId = response.job?.jobId ?? null;
      set({
        voice: { state: 'preparing', ...(jobId ? { jobId } : {}) },
        voicePreparing: true,
        ...(response.costDisclosure ? { voicePrepareDisclosure: response.costDisclosure } : {})
      });
      void pollVoicePreparation(projectId, jobId, set, get);
      return { ...(response.costDisclosure ? { costDisclosure: response.costDisclosure } : {}) };
    } catch (error) {
      if (get().projectId !== projectId) return null;
      set({ voicePreparing: false });
      // ONLY a recognized 409 preflight (no transcript, Studio Sound not run, …) is absorbed
      // into the chip: /voice/status carries the same errorCode + message, so the chip already
      // explains it. Everything else — auth, network, 5xx, an unrecognized code — is a real
      // failure of an action the user (or the eager kick) took, and silently swallowing it
      // behind an unchanged chip is how a broken key looks like "nothing happened".
      const preflight = error instanceof ApiError && error.status === 409 && !!error.errorCode && VOICE_PREFLIGHT_ERROR_CODES.has(error.errorCode);
      void get().refreshVoiceStatus();
      if (!preflight) set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },
  async createCloneChainVoicePatch({ supersedeOperationIds, ...input }) {
    // Pinned at POST time: a generation can outlive the project the user is looking at, and
    // refreshing + scheduling a render for whatever project is CURRENT when it resolves would
    // both hide the result and kick an unrelated render.
    const projectIdAtCall = get().projectId;
    const response = await createCloneChainVoicePatchApi(projectIdAtCall, input);
    // REQUIRED cleanup, done here and addressed to the project the patch belongs to. The
    // type-over mute ops this generation replaces must be disabled even if the user has
    // navigated away — and a caller-side `disableOperation` would resolve against whatever
    // project is current, applying project A's operation ids to project B.
    for (const operationId of supersedeOperationIds ?? []) {
      try { await disableOperationApi(projectIdAtCall, operationId, 'Replaced by generated voice patch'); }
      catch { /* the patch landed; a stranded mute is recoverable and must not fail the result */ }
    }
    if (get().projectId !== projectIdAtCall) {
      // STALE: the result is real but it belongs to a project the user has left. Report it so
      // the caller performs no further UI side effects rather than applying them here.
      return { status: 'stale' as const, projectId: projectIdAtCall, response };
    }
    // ⟨Q1⟩: the clone-chain terminal is finalized BEFORE the manifest mutation, so the response
    // deliberately carries no manifest. Reload it (and the render freshness that follows from
    // it) rather than patching the op in locally from a partial shape.
    set({ lastAutoEditAt: Date.now(), undoneOpIds: [] });
    await get().refresh();
    if (get().projectId !== projectIdAtCall) return { status: 'stale' as const, projectId: projectIdAtCall, response };
    scheduleAutoRender(get);
    return { status: 'applied' as const, projectId: projectIdAtCall, response };
  },
  seek(time) { set({ currentTime: Math.max(0, time) }); },
  setPlaying(playing) { set({ playing }); },
  setPanel(panel) { set((state) => ({ activePanel: state.activePanel === panel ? null : panel })); },
  setSelection(selection) { set({ selection }); },
  setPreviewKind(previewKind) {
    const projectId = get().projectId;
    if (projectId) storage.set(`etv.previewKind.${projectId}`, previewKind);
    set({ previewKind, previewKindLockedByUser: true });
  },
  setPreviewCollapsed(collapsed) { storage.set('etv.previewCollapsed', collapsed); set({ previewCollapsed: collapsed }); },
  setTranscriptMode(transcriptMode) { set({ transcriptMode }); },
  setAspect(aspect) { set({ aspect }); },
  setAiTab(aiTab) { storage.set('etv.aiTab', aiTab); set({ aiTab }); },
  setTheme(theme) { storage.set('etv.theme', theme); if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light'; set({ theme }); },
  setTranscriptWidth(width) { const next = clamp(width, 260, 900); storage.set('etv.transcriptWidth', next); set({ transcriptWidth: next }); },
  setTranscriptCollapsed(collapsed) { storage.set('etv.transcriptCollapsed', collapsed); set({ transcriptCollapsed: collapsed }); },
  setTimelineHeight(height) { const next = clamp(height, 120, 460); storage.set('etv.timelineHeight', next); set({ timelineHeight: next }); },
  setTimelineCollapsed(collapsed) { storage.set('etv.timelineCollapsed', collapsed); set({ timelineCollapsed: collapsed }); },
  setPanelWidth(width) { const next = clamp(width, 320, 1100); storage.set('etv.panelWidth', next); set({ panelWidth: next }); },
  setTimelineZoom(zoom) { const next = clamp(zoom, 0.5, 6); storage.set('etv.tlZoom', next); set({ timelineZoom: next }); }
  ,setRenderDialogOpen(open) { set({ renderDialogOpen: open }); }
  ,setAutoRenderEnabled(enabled) {
    storage.set('etv.autoRender', enabled);
    set({ autoRenderEnabled: enabled });
    if (!enabled) cancelAutoRender();
    else if (get().diagnostics?.renderFreshness?.draft?.state === 'stale' && get().lastAutoEditAt != null) {
      // Re-enabling while there are unrendered edits — kick off the catch-up.
      scheduleAutoRender(get);
    }
  }
  // ── v4 design-refresh surfaces (Wave 2) ─────────────────────────────────────
  ,setPaletteOpen(open) { set({ paletteOpen: open }); }
  ,togglePalette() { set((state) => ({ paletteOpen: !state.paletteOpen })); }
  ,setShortcutSheetOpen(open) { set({ shortcutSheetOpen: open }); }
  ,setProposalPopover(popover) { set({ proposalPopover: popover }); }
  ,startSweep() { set({ sweepActive: true, sweepIndex: 0, sweepSkipped: [] }); }
  ,closeSweep() { set({ sweepActive: false, sweepIndex: 0, sweepSkipped: [] }); }
  ,setSweepIndex(index) { set({ sweepIndex: Math.max(0, Math.floor(index)) }); }
  ,addSweepSkipped(id) { set((state) => (state.sweepSkipped.includes(id) ? {} : { sweepSkipped: [...state.sweepSkipped, id] })); }
  ,setPlaySpeed(speed) { const next = Number.isFinite(speed) && speed > 0 ? speed : 1; storage.set('etv.playSpeed', next); set({ playSpeed: next }); }
  ,cyclePlaySpeed() {
    const current = get().playSpeed;
    const idx = PLAY_SPEEDS.indexOf(current as (typeof PLAY_SPEEDS)[number]);
    // If the current value isn't on the cycle (idx === -1), start from the beginning.
    const next = PLAY_SPEEDS[(idx + 1) % PLAY_SPEEDS.length];
    storage.set('etv.playSpeed', next);
    set({ playSpeed: next });
  }
  ,setSkipSilences(enabled) { storage.set('etv.skipSilences', enabled); set({ skipSilences: enabled }); }
  ,toggleSkipSilences() { const next = !get().skipSilences; storage.set('etv.skipSilences', next); set({ skipSilences: next }); }
  // Pragmatic, SAFE undo/redo. We never delete manifest history — undo() disables the most
  // recent enabled op (status→'disabled', reversible) and pushes its id onto a transient
  // redo stack; redo() restores (status→'approved') the last undone op. The redo stack is
  // cleared by any fresh edit (createOperation/approveOperation) so it can't restore an op
  // that no longer makes sense after newer edits.
  ,undo() {
    const target = undoTargetOp(get().manifest);
    if (!target) return;
    // Re-entrancy guard: disableOperation is optimistic/async and the local
    // manifest stays 'approved' until the server refresh lands. Without this,
    // a rapid second ⌘Z would pick the SAME op again and disable it twice. If
    // it's already in the redo stack we've issued its disable — wait for the
    // refresh (which removes it from undoTargetOp) before undoing the next op.
    if (get().undoneOpIds.includes(target.id)) return;
    set((state) => ({ undoneOpIds: [...state.undoneOpIds, target.id] }));
    // disableOperation refreshes the manifest + schedules an auto-render.
    void get().disableOperation(target.id, 'Undo');
  }
  ,redo() {
    const stack = get().undoneOpIds;
    if (stack.length === 0) return;
    const opId = stack[stack.length - 1];
    set({ undoneOpIds: stack.slice(0, -1) });
    void get().restoreOperation(opId);
  }
  ,canUndo() { return undoTargetOp(get().manifest) != null; }
  ,canRedo() { return get().undoneOpIds.length > 0; }
  ,undoLabel() { return undoTargetOp(get().manifest)?.type ?? null; }
  ,redoLabel() {
    const stack = get().undoneOpIds;
    if (stack.length === 0) return null;
    const opId = stack[stack.length - 1];
    return get().manifest?.operations.find((op) => op.id === opId)?.type ?? null;
  }
}));

export function useRenderJob() {
  return useEditorStore((state) => latestRenderDraftJob(state.jobs));
}
