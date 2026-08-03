"use client";

import { useEffect, useMemo } from 'react';
import { useEditorStore } from '../../../../store/editorStore';

/**
 * VoiceChip — S1b item 10: the prepared-voice state next to Studio Sound.
 *
 * The clone trains on the CLEANED recording, so this chip lives in the same Audio section as
 * Studio Sound: the eager auto-kick fires from there, and its disclosure has to be readable
 * from there too (D7 — configuring a provider is consent, but every call still shows an
 * estimate and activity).
 *
 * Every state shown here is server-derived (`GET /voice/status`). Nothing is inferred locally:
 * 'unknown-outcome' in particular exists precisely because a crash between the remote clone
 * create and the local persist is only visible to the server's reservation record, and it must
 * never be auto-retried — that is a paid call whose outcome nobody knows.
 *
 *   none            → "Prepare your voice"      (prepare)
 *   preparing       → "Preparing your voice…"   (spinner + the job's current stage)
 *   ready           → "Your voice is ready"     (re-prepare)
 *   stale           → "Your voice is out of date" + banner (re-prepare)
 *   unknown-outcome → "Needs attention"         (re-prepare — explicit user action only)
 *
 * Re-skin culture: this reuses the existing `.studio-run` card language verbatim (same glyph /
 * title / sub / cta / spinner slots as the Studio Sound button) rather than inventing a new
 * visual system.
 */

/** Human copy for the typed prepare failures the job/status can report. */
const PREPARE_ERROR_COPY: Record<string, string> = {
  'transcript-not-word-accurate': 'needs a word-accurate transcript',
  'cleaned-source-unavailable': 'needs Studio Sound on the current recording',
  'multi-clip-unsupported': 'multiple base-recording clips — not supported yet',
  'insufficient-clean-windows': 'not enough clean speech to train on',
  'voice-slot-limit': 'ElevenLabs voice slots are full — free one in Settings → Voices',
  'unknown-outcome': 'a clone call may or may not have been billed — re-prepare to be sure',
  interrupted: 'interrupted before any paid call',
  'clone-failed': 'the clone call failed'
};

const STAGE_COPY: Record<string, string> = {
  decoding: 'reading the cleaned recording',
  'selecting-windows': 'picking the cleanest speech',
  cloning: 'creating the voice'
};

/** Provider/job error text is arbitrary length; the banner is one line of chrome. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** D7 cost disclosure for the call the button is about to make. */
export const PREPARE_PRICE_LINE = 'ElevenLabs instant voice clone · 1 call · billed by plan tier';

export type VoiceChipState = 'none' | 'preparing' | 'ready' | 'stale' | 'unknown-outcome';

export interface VoiceChipView {
  title: string;
  sub: string;
  cta: 'prepare' | 're-prepare';
  /** Rendered as a `.panel-banner` above the chip when present. */
  banner: string | null;
}

/**
 * Pure state → copy mapping (exported for test; the component is a thin render of it).
 *
 * The 'none' sub-line is the PRICE LINE, always. It used to be `errorCopy ?? price`, which had
 * two failure modes on the state the user sees most often:
 *   • a preflight/failed-job errorCode replaced the cost disclosure the D7 paid-services rule
 *     requires on the very button that makes the paid call, and
 *   • an errorCode with no entry in PREPARE_ERROR_COPY rendered the RAW machine code
 *     ('clone-failed', 'cancelled') as if it were UI copy.
 * The error is not dropped — it moves to the banner, which is where 'stale' already explains
 * itself, and only ever as human copy (typed map, else the server's `message`).
 */
export function voiceChipView(input: {
  state: VoiceChipState;
  errorCode?: string | null;
  message?: string | null;
  voiceId?: string | null;
  runningStage?: string | null;
  disclosure?: string | null;
}): VoiceChipView {
  const { state, errorCode, message, voiceId, runningStage, disclosure } = input;
  // TYPED codes only — a code we have no copy for is not copy, so it never reaches the surface.
  const errorCopy = errorCode ? PREPARE_ERROR_COPY[errorCode] ?? null : null;

  const title =
    state === 'preparing' ? 'Preparing your voice…'
    : state === 'ready' ? 'Your voice is ready'
    : state === 'stale' ? 'Your voice is out of date'
    : state === 'unknown-outcome' ? 'Your voice needs attention'
    : 'Prepare your voice';

  const sub =
    state === 'preparing'
      // While the job runs, the sub-line is the live activity; before the first stage lands it
      // falls back to the disclosure the prepare POST returned (D7 — show the estimate).
      ? (runningStage ? STAGE_COPY[runningStage] ?? runningStage : disclosure ?? 'working…')
      : state === 'ready'
        ? `cloned from the cleaned recording${voiceId ? ` · ${voiceId.slice(0, 8)}` : ''}`
        : state === 'stale'
          ? 'Studio Sound changed since the clone was made'
          : state === 'unknown-outcome'
            ? errorCopy ?? 'the last attempt ended with an unknown outcome'
            : PREPARE_PRICE_LINE;

  const banner =
    state === 'stale'
      ? (message ? truncate(message, 140) : 'Studio Sound was re-run, so the prepared voice no longer matches this recording. Re-prepare before generating.')
      // 'none' + an error means the last attempt failed or a preflight blocks preparing. The
      // chip still shows the price line; the reason belongs here, in human words.
      //
      // CURATED COPY FIRST. Preferring `message` made the actionable line unreachable exactly
      // where it matters: a voice-slot-limit failure carries a raw ElevenLabs envelope as its
      // message, so the user saw vendor JSON prose instead of "free one in Settings → Voices".
      // The provider's own text is the fallback for codes we have no copy for, truncated —
      // .panel-banner is one line of chrome, not a log viewer.
      : state === 'none' && (errorCopy || message)
        ? errorCopy ?? truncate(message!, 140)
        : null;

  return { title, sub, cta: state === 'ready' || state === 'stale' || state === 'unknown-outcome' ? 're-prepare' : 'prepare', banner };
}

export function VoiceChip() {
  const voice = useEditorStore((s) => s.voice);
  const voicePreparing = useEditorStore((s) => s.voicePreparing);
  const disclosure = useEditorStore((s) => s.voicePrepareDisclosure);
  const jobs = useEditorStore((s) => s.jobs);
  const projectId = useEditorStore((s) => s.projectId);
  const prepareVoice = useEditorStore((s) => s.prepareVoice);
  const refreshVoiceStatus = useEditorStore((s) => s.refreshVoiceStatus);

  // One read on mount so the chip is honest before the first refresh() tick lands.
  useEffect(() => { if (projectId) void refreshVoiceStatus(); }, [projectId, refreshVoiceStatus]);

  // Most-recent-by-position prepare job (the store keeps `jobs` newest-first, and a bare find()
  // over a job history otherwise returns the OLDEST match — pattern_selector_recency).
  const prepareJob = useMemo(() => jobs.find((job) => job.type === 'prepare-voice') ?? null, [jobs]);
  const runningStage = prepareJob?.stages?.find((stage) => stage.status === 'running')?.name ?? null;

  const preparing = voice.state === 'preparing' || voicePreparing;
  const state = preparing ? 'preparing' : voice.state;
  const { title, sub, cta, banner } = voiceChipView({
    state,
    errorCode: voice.errorCode ?? prepareJob?.errorCode ?? null,
    message: voice.message ?? null,
    voiceId: voice.voiceId ?? null,
    runningStage,
    disclosure
  });

  return (
    <>
      {banner ? (
        <div className="panel-banner" role="status">{banner}</div>
      ) : null}
      <button
        type="button"
        className={`studio-run voice-prepare${preparing ? ' busy' : ''}${state === 'ready' ? ' on' : ''}${state === 'unknown-outcome' ? ' attention' : ''}`}
        onClick={() => { if (!preparing) void prepareVoice(); }}
        disabled={preparing}
        title={voice.message ?? 'Clone your voice from the cleaned recording — ElevenLabs instant voice clone, 1 call.'}
      >
        <span className="studio-glyph">☺</span>
        <span className="studio-text">
          <span className="studio-title">{title}</span>
          <span className="studio-sub">{sub}</span>
        </span>
        {preparing
          ? <span className="studio-spin" aria-label="Preparing" />
          : <span className="studio-cta">{cta}</span>}
      </button>
    </>
  );
}

export default VoiceChip;
