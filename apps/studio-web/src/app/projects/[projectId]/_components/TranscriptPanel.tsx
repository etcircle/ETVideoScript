"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { buildRenderPlanV3, deriveEditedScriptFromTimeMapV3, derivePreviewScriptFromTimeMapV3, type OperationV3, type V3EditedScriptToken, type V3PreviewScriptToken } from '@etvideoscript/core/browser';
import { ApiError, getCloneChainEstimate, getSettingsProviders, getTtsEstimate, getVoicePatchProgress, getVoices, getWorkspaceSettings, newRequestId, type CloneChainEstimate, type ProviderRecord, type TranscriptDoc, type VoicePatchProgress, type VoiceRecord, type WorkspaceSettings } from '../../../../lib/api';
import { VoiceSampleRecorder } from '../../../settings/voice-sample-recorder';
import { useEditorStore } from '../../../../store/editorStore';
import { clipSpanTargetsForWords } from '../../../../store/editTargets';
import { decidePanelState, operationTimelineRange, toneClass, transcriptModeLabel } from '../../../../store/selectors';
import { deriveSilences, deriveSweepCandidates } from '../../../../store/designData';
import { PanelState } from './state/PanelState';
import { boundaryFromCaret, caretFromBoundary, deletedWordIndexForCaret, moveCaretBoundary, selectionFromBoundaries, type TranscriptCaret } from './transcriptCaret';
// S1b clone-chain decision logic lives beside the component so the money-relevant parts
// (replay-vs-rebill, the two-unit cost model) are unit-testable without rendering React.
import { cloneChainIntentKey, cloneChainRemedy, requestIdIsSpent, CLONE_CHAIN_CALLS } from './cloneChain';

// P3-A normalization: strip trailing punctuation, lowercase
function normalizeFiller(text: string) { return text.replace(/[.,!?;:]+$/, '').toLowerCase(); }
const DEFAULT_FILLER_WORDS = ['um', 'uh', 'like', 'you know', 'basically', 'literally', 'right', 'so', 'okay', 'actually', 'honestly', 'seriously', 'kind of', 'sort of'];

type BadgeSegment = Record<string, unknown>;

const MOCK_TTS_PROVIDER: ProviderRecord = { id: 'tts.mock', kind: 'tts', name: 'mock', tier: 'local', enabled: true, default: false };
const STOCK_VOICES: Record<string, readonly string[]> = { 'tts.mock': ['eve'], 'tts.xai': ['eve'] };
// NOTE: there is deliberately NO pricing table here. Every cost figure in this panel — legacy
// path included — comes from the server's estimator, which prices with the same adapters and the
// same cap arithmetic the real call uses. A client-side mirror could not see costPerUnit
// overrides, could not know which ledger rows count toward a cap, and drifted the moment either
// changed.
const AVAILABLE_MODELS: Partial<Record<string, readonly string[]>> = {
  'tts.elevenlabs': ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5']
};

// ─── S1b clone chain ─────────────────────────────────────────────────────────
// The chain is the ear-locked recipe: TTS in the prepared clone, then EL speech-to-speech onto
// the SAME clone, then the seam baked on the cleaned bed. Two paid calls, one user action. The
// voice and the models are fixed server-side (⟨Q6⟩ rejects provider/voice/model with a 400), so
// the confirm step has nothing to pick — it collapses to "your voice".
/**
 * A cost estimate together with the intent it was computed for. Comparing `key` against the
 * current intent at render is what makes "no priced estimate for THIS request" an explicit,
 * blocking state rather than an absence nobody checks.
 */
type EstimateState = { key: string; status: 'loading' | 'ready' | 'error'; value: CloneChainEstimate | null };

function stepLabel(status: string) {
  return status === 'succeeded' ? '✓' : status === 'failed' ? '✕' : status === 'running' ? '…' : '·';
}

// Design GMARK table (transcript.jsx line 207)
const GMARK: Record<string, { g: string; cls: string; label: string }> = {
  cut:             { g: '−', cls: 'cut',   label: 'cut' },
  voice_patch:     { g: '↺', cls: 'voice', label: 're-record' },
  speed:           { g: '»', cls: 'speed', label: 'speed' },
  mute:            { g: '⊘', cls: 'mute',  label: 'mute' },
  transcript_amend:{ g: '✎', cls: 'voice', label: 'correct' },
  overlay:         { g: '◇', cls: 'over',  label: 'overlay' },
  transition:      { g: '⤫', cls: 'over',  label: 'transition' },
};

function gmark(type: string) {
  return GMARK[type] ?? { g: '•', cls: 'cut', label: type };
}

function formatClock(seconds: number) {
  const safe = Math.max(0, seconds || 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function numberField(obj: BadgeSegment | undefined, names: string[]) {
  for (const name of names) {
    const value = obj?.[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function arrayField(obj: BadgeSegment | undefined, names: string[]) {
  for (const name of names) {
    const value = obj?.[name];
    if (Array.isArray(value)) return value;
  }
  return null;
}

function hookPercent(segment?: BadgeSegment) {
  const value = numberField(segment, ['hookPct', 'hookPercent', 'hookScore', 'hookConfidence', 'highlightScore']);
  if (value == null) return null;
  return Math.round(value <= 1 ? value * 100 : value);
}

function silenceCount(segment?: BadgeSegment) {
  const direct = numberField(segment, ['silenceCount', 'silencesCount', 'detectedSilences']);
  if (direct != null) return Math.max(0, Math.round(direct));
  const list = arrayField(segment, ['silences', 'silenceRanges', 'detectedSilenceRanges']);
  return list?.length ?? 0;
}

// Hook/silence badges are kept on the speaker line even though the design
// strips them from its static prototype — they carry real diagnostic value
// (hook = AI-identified hook moment, silence = detected dead air) that the
// user relies on. They're visually subordinate (small, no chrome on the main
// read) and the existing .tx-hl-stamp/.tx-sil-stamp rules from editor.css
// remain in effect.
function HookBadge({ pct, onSeek }: { pct: number | null; onSeek: () => void }) {
  if (pct == null) return null;
  return <button type="button" className="tx-hl-stamp" onClick={onSeek} title="Seek to detected hook">★ hook · {pct}%</button>;
}

function SilenceBadge({ count }: { count: number }) {
  if (!count) return null;
  return <span className="tx-sil-stamp" title={`${count} detected silence${count === 1 ? '' : 's'} in this segment`}><span className="sil-dot" aria-hidden="true" />▌ {count} silence{count === 1 ? '' : 's'}</span>;
}

function opClass(type?: string) {
  if (type === 'voice_patch') return 'voice';
  return type || 'proposed';
}

function pillLabel(token: Extract<V3EditedScriptToken, { type: 'operation_marker' }>, opType?: string, status?: string) {
  const proposed = status === 'proposed' || status === 'awaiting_approval';
  const words = wordCountLabel(token.hiddenWordIds.length);
  const text = typeof token.view.details?.text === 'string' ? token.view.details.text : '';
  if (opType === 'voice_patch') return <>{proposed ? 'proposed ' : ''}re-recorded {text ? <span className="text-replaced">"{text}"</span> : null}</>;
  if (opType === 'speed') {
    const rate = typeof token.view.details?.rate === 'number' ? `${token.view.details.rate}×` : token.view.label;
    const bed = typeof token.view.details?.bed === 'string' ? token.view.details.bed : '';
    return <>{proposed ? 'proposed ' : ''}speed {rate}<span className="tx-pill-meta">{words}{bed ? ` · ${bed}` : ''}</span></>;
  }
  if (opType === 'mute' && text) return <><span className="draft-original">{token.hiddenText}</span><span className="draft-chip">{text}</span></>;
  const label = opType === 'mute' ? 'muted' : opType === 'transcript_amend' ? (text || 'amended') : opType || token.view.label.toLowerCase();
  return proposed ? <>proposed {label} · {words}</> : <>{label} {words}</>;
}

function wordCountLabel(count: number) {
  return `${count} ${count === 1 ? 'word' : 'words'}`;
}

/**
 * P2-7: format in the currency the SERVER reported. Not every provider bills in dollars (Cartesia
 * quotes credits), and printing '$' in front of a credit figure is a lie about what the user is
 * being charged. Non-ISO codes fall back to a prefixed label rather than throwing in Intl.
 */
function money(value: number | null | undefined, currency: string | null = 'USD') {
  if (value == null) return '—';
  const code = currency ?? 'USD';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
  } catch {
    return `${code} ${value.toFixed(4)}`;
  }
}

function resolveProviderDefault(providers: ProviderRecord[], settings: WorkspaceSettings | null) {
  // Honor an explicit defaultVoice.providerId first — even if it's 'tts.mock' and real providers
  // also exist, because the user may have deliberately pinned mock for offline-dev work.
  const defaultVoice = settings?.taskOptions.tts.defaultVoice;
  if (defaultVoice && providers.some((provider) => provider.id === defaultVoice.providerId)) return defaultVoice.providerId;
  const realProviders = providers.filter((provider) => provider.id !== 'tts.mock');
  return realProviders.find((provider) => provider.default)?.id ?? realProviders[0]?.id ?? 'tts.mock';
}

type TranscriptWord = TranscriptDoc['words'][number];
type WordRange = { start: number; end: number };

type WordProps = {
  word: TranscriptWord;
  index: number;
  start: number;
  end: number;
  muted?: boolean;
  /** Speed effect: word is inside an approved speed op. */
  fx?: 'speed';
  /** Speed factor (e.g. 4) — present when fx === 'speed'. */
  factor?: number;
  /** True on the last word covered by a speed op — triggers the factor superscript. */
  speedLast?: boolean;
  /** True when a proposed/awaiting_approval op covers this word. */
  proposed?: boolean;
  current: boolean;
  selected: boolean | null;
  caretSide: TranscriptCaret['side'] | null;
  editing: boolean;
  editText: string;
  synthPending: boolean;
  synthError: string | null;
  liveOverdubDisabled: boolean;
  filler: boolean;
  /** view !== 'draft': show low-confidence dotted underline when conf < 0.6 */
  showLowConf: boolean;
  /** True when an active clean-up sweep is highlighting this word as its current candidate. */
  sweepHot: boolean;
  onEditText: (value: string) => void;
  onCommitEdit: (word: TranscriptWord, nextWord?: TranscriptWord) => void;
  onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>, word: TranscriptWord, index: number, range: WordRange) => void;
  onMouseDownWord: (event: MouseEvent<HTMLButtonElement>, word: TranscriptWord, index: number, range: WordRange) => void;
  onMouseMoveWord: (event: MouseEvent<HTMLButtonElement>, index: number) => void;
  onMouseEnterWord: (event: MouseEvent<HTMLButtonElement>, index: number) => void;
  onMouseUpWord: (word: TranscriptWord, range: WordRange) => void;
  onEnterEditMode: (word: TranscriptWord) => void;
  /** Proposed op id covering this word (only set for .is-prop words) — opens the inline review popover. */
  proposedOpId?: string | null;
  onProposalClick?: (opId: string, event: MouseEvent<HTMLButtonElement>) => void;
};

const Word = memo(function Word({
  word, index, start, end, muted, fx, factor, speedLast, proposed,
  current, selected, caretSide,
  editing, editText, synthPending, synthError, liveOverdubDisabled,
  filler, showLowConf, sweepHot,
  onEditText, onCommitEdit, onInputKeyDown,
  onMouseDownWord, onMouseMoveWord, onMouseEnterWord, onMouseUpWord, onEnterEditMode,
  proposedOpId, onProposalClick,
}: WordProps) {
  if (editing) {
    return <><input
      className={`tx-word-input${synthPending ? ' synth-pending' : ''}`}
      value={editText}
      autoFocus
      style={{ width: `${Math.max(32, editText.length * 7.5 + 8)}px` }}
      onChange={(e) => onEditText(e.target.value)}
      onBlur={() => { onCommitEdit(word); }}
      onKeyDown={(e) => onInputKeyDown(e, word, index, { start, end })}
    />{synthError ? <span className="tx-synth-error" role="alert">{synthError}</span> : null}{liveOverdubDisabled ? <span className="tx-overdub-disabled">Live overdub off</span> : null}</>;
  }

  // Low-confidence: conf < 0.6, only when showLowConf, not overridden by selection/current.
  const lowConf = showLowConf && !muted && !selected && !current
    && word.confidence != null && word.confidence < 0.6;

  const cls = [
    'tx-word',
    current         ? 'current'   : '',
    muted           ? 'muted'     : '',
    fx === 'speed'  ? 'fx-speed'  : '',
    proposed        ? 'is-prop'   : '',
    selected        ? 'selected'  : '',
    caretSide       ? `has-caret caret-${caretSide}` : '',
    filler          ? 'filler'    : '',
    lowConf         ? 'lowconf'   : '',
    sweepHot        ? 'sweep-hot' : '',
  ].filter(Boolean).join(' ');

  const title = lowConf
    ? `low confidence · ${Math.round((word.confidence ?? 0) * 100)}% — double-check`
    : `${start.toFixed(2)}–${end.toFixed(2)}`;

  return <><button
    data-word-id={word.id}
    data-start={word.start}
    type="button"
    className={cls}
    title={title}
    onMouseDown={(event) => onMouseDownWord(event, word, index, { start, end })}
    onMouseMove={(event) => onMouseMoveWord(event, index)}
    onMouseEnter={(event) => onMouseEnterWord(event, index)}
    onMouseUp={() => onMouseUpWord(word, { start, end })}
    onClick={(event) => { if (proposed && proposedOpId && onProposalClick) onProposalClick(proposedOpId, event); }}
    onDoubleClick={() => onEnterEditMode(word)}
  >{word.text}</button>{speedLast && factor != null ? <span className="tx-speedsup" aria-hidden="true">{factor}×</span> : null}</>;
});

type PreviewTokenProps = {
  token: V3PreviewScriptToken;
  indexForWord: (id: string) => number;
  wordById: Map<string, TranscriptWord>;
  renderWord: (word: TranscriptWord, index: number, muted?: boolean, outputRange?: WordRange, decorators?: WordDecorators) => ReactNode;
  sourceRangeForWord: (word: TranscriptWord) => WordRange;
  seek: (start: number, end?: number, text?: string, wordIds?: string[], opId?: string) => void;
  caretSide: TranscriptCaret['side'] | null;
  onMouseDownReplacement: (args: { event: MouseEvent<HTMLButtonElement>; leftWord: TranscriptWord | undefined; rightWord: TranscriptWord | undefined; leftIndex: number; rightIndex: number; range: WordRange; text: string; replacedWordIds: string[]; operationId: string | undefined }) => void;
  onMouseUpReplacement: (event: MouseEvent<HTMLButtonElement>) => void;
};

const PreviewToken = memo(function PreviewToken({ token, indexForWord, wordById, renderWord, sourceRangeForWord, seek, caretSide, onMouseDownReplacement, onMouseUpReplacement }: PreviewTokenProps) {
  if (token.type === 'word') {
    return <>{renderWord(token.word, indexForWord(token.word.id), token.muted, { start: token.outputStart, end: token.outputEnd })}</>;
  }
  // In Draft mode the design reads voice_patch text as PLAIN inline text —
  // no tx-vp chrome (the blue underline is Audit-only).
  const flavor = token.opType === 'voice_patch' ? 're-recorded' : token.opType === 'mute' ? 'proposed' : 'amended';
  const title = flavor === 're-recorded'
    ? `re-recorded — was: "${token.hiddenText}"`
    : flavor === 'proposed'
      ? `proposed — was: "${token.hiddenText}" · open Audit Trail to generate`
      : `amended — was: "${token.hiddenText}"`;
  const firstWord = wordById.get(token.replacedWordIds[0] || '');
  const lastWord = wordById.get(token.replacedWordIds[token.replacedWordIds.length - 1] || '');
  const leftIndex = firstWord ? indexForWord(firstWord.id) : -1;
  const rightIndex = lastWord ? indexForWord(lastWord.id) : -1;
  const range: WordRange = {
    start: token.outputStart ?? (firstWord ? sourceRangeForWord(firstWord).start : 0),
    end: token.outputEnd ?? (lastWord ? sourceRangeForWord(lastWord).end : (firstWord ? sourceRangeForWord(firstWord).end : 0))
  };
  return <button
    type="button"
    className={`tx-preview-replacement ${flavor} ${caretSide ? `has-caret caret-${caretSide}` : ''}`}
    title={title}
    onMouseDown={(event) => onMouseDownReplacement({ event, leftWord: firstWord, rightWord: lastWord, leftIndex, rightIndex, range, text: token.text, replacedWordIds: token.replacedWordIds, operationId: token.operationId })}
    onMouseUp={onMouseUpReplacement}
  >{token.text}</button>;
});

type WordDecorators = {
  fx?: 'speed';
  factor?: number;
  speedLast?: boolean;
  proposed?: boolean;
};

type EditedTokenProps = {
  token: V3EditedScriptToken;
  operation: OperationV3 | undefined;
  range: WordRange | null;
  renderWord: (word: TranscriptWord, index: number, muted?: boolean, outputRange?: WordRange, decorators?: WordDecorators) => ReactNode;
  indexForWord: (id: string) => number;
  seek: (start: number, end?: number, text?: string, wordIds?: string[], opId?: string) => void;
  openDraftGenerate: (token: Extract<V3EditedScriptToken, { type: 'operation_marker' }>) => void;
  disableOperation: (operationId: string, reason?: string) => Promise<void>;
  onProposalClick: (opId: string, event: MouseEvent<HTMLButtonElement>) => void;
};

const EditedToken = memo(function EditedToken({ token, operation, range, renderWord, indexForWord, seek, openDraftGenerate, disableOperation, onProposalClick }: EditedTokenProps) {
  if (token.type === 'word') {
    // Audit mode: individual word tokens — renderWord applies .fx-speed / .is-prop
    // via decorators, and .muted via the muted prop. .tx-elide and .tx-vp come from
    // the operation_marker branch.
    const decorators: WordDecorators = {};
    if (token.fx) { decorators.fx = token.fx; decorators.factor = token.factor; decorators.speedLast = token.speedLast; }
    if (token.proposed) decorators.proposed = true;
    return <>{renderWord(token.word, indexForWord(token.word.id), token.muted, undefined, decorators)}</>;
  }
  const type = operation?.type || token.view.kind;
  const status = operation?.status || token.view.status;
  const revertable = operation && operation.status !== 'disabled';
  const hasDraft = type === 'mute' && typeof token.view.details?.text === 'string' && !!token.view.details.text.trim();

  // In Audit mode: render cut as .tx-elide seam, voice_patch as .tx-vp, others
  // as .tx-pill (the pill carries the Generate/Revert affordances which the
  // design omits but we must preserve).
  if (type === 'cut') {
    const coveredText = token.hiddenText;
    const wordCount = token.hiddenWordIds.length;
    return <span
      className="tx-elide"
      title={`cut ${wordCount} ${wordCount === 1 ? 'word' : 'words'} · "${coveredText}"`}
      onClick={() => { if (range) seek(range.start, range.end, coveredText, token.hiddenWordIds, token.operationId); }}
    >⋯</span>;
  }

  if (type === 'voice_patch') {
    const text = typeof token.view.details?.text === 'string' ? token.view.details.text : token.hiddenText;
    const originalText = token.hiddenText;
    return <><span
      className="tx-vp"
      title={`re-recorded · was "${originalText}"`}
      onClick={() => { if (range) seek(range.start, range.end, text, token.hiddenWordIds, token.operationId); }}
    >{text}</span>{revertable ? <button type="button" className="tx-pill-revert" aria-label="Revert this edit" title="Revert this edit" onClick={(e) => { e.stopPropagation(); void disableOperation(token.operationId, 'Reverted from transcript'); }}>×</button> : null}</>;
  }

  // mute, speed, transcript_amend, proposed → .tx-pill with full affordances
  const isProposed = status === 'proposed' || status === 'awaiting_approval';
  return <span className={`tx-pill ${opClass(type)} ${hasDraft ? 'draft' : ''} ${isProposed ? 'proposed' : ''} ${toneClass(token.view.tone)}`} title={token.hiddenText}>
    <button type="button" className="tx-pill-body" onClick={(event) => {
      // A proposed pill opens the inline review popover (prototype onProposalClick);
      // an applied pill seeks to its range.
      if (isProposed) { onProposalClick(token.operationId, event); return; }
      if (range) seek(range.start, range.end, token.hiddenText, token.hiddenWordIds, token.operationId);
    }}>
      <span className="glyph" aria-hidden="true">{gmark(type || '').g}</span>
      <span>{pillLabel(token, type, status)}</span>
    </button>
    {hasDraft ? <button type="button" className="tx-draft-generate" onClick={(e) => { e.stopPropagation(); openDraftGenerate(token); }}>Generate</button> : null}
    {revertable ? <button type="button" className="tx-pill-revert" aria-label="Revert this edit" title="Revert this edit" onClick={(e) => { e.stopPropagation(); void disableOperation(token.operationId, 'Reverted from transcript'); }}>×</button> : null}
  </span>;
});

// ─── SpeedAction popover (design app.jsx:1031) ──────────────────────────────
// Ported to TypeScript, self-contained. Responsible for the
// `.speed-action/.speed-pop` popover that lives inside `.sel-bar .actions`.
type SpeedActionProps = {
  open: boolean;
  setOpen: (v: boolean) => void;
  factor: 2 | 4 | 8 | 16;
  bed: string;
  setFactor: (v: 2 | 4 | 8 | 16) => void;
  setBed: (v: string) => void;
  onApply: () => void;
  selectionDuration: number;
};

const SPEED_FACTORS: Array<2 | 4 | 8 | 16> = [2, 4, 8, 16];
const SPEED_BEDS = [
  { id: 'music',   label: 'Music bed',    hint: 'background track',        glyph: '♪' },
  { id: 'silence', label: 'Silence',      hint: 'mute the audio',          glyph: '⊘' },
  { id: 'pitched', label: 'Pitched',      hint: 'keep voice · faster',     glyph: '♫' },
];

function SpeedAction({ open, setOpen, factor, bed, setFactor, setBed, onApply, selectionDuration }: SpeedActionProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function clickOff(e: globalThis.MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', clickOff);
    return () => document.removeEventListener('mousedown', clickOff);
  }, [open, setOpen]);

  const sped = selectionDuration / factor;

  return (
    <div className="speed-action" ref={ref}>
      <button
        type="button"
        className={`speed-btn${open ? ' open' : ''}`}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        title="Speed-ramp this section · for tool waits &amp; dead air"
      >
        <span className="glyph">»</span> Speed up <span className="caret">▾</span>
      </button>
      {open && (
        <div className="speed-pop">
          <div className="speed-pop-kicker">Speed ramp · {selectionDuration.toFixed(1)}s → {sped.toFixed(1)}s</div>
          <div className="speed-pop-section">
            <div className="speed-pop-label">Factor</div>
            <div className="speed-chips">
              {SPEED_FACTORS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`speed-chip${factor === f ? ' on' : ''}`}
                  onClick={() => setFactor(f)}
                >{f}×</button>
              ))}
            </div>
          </div>
          <div className="speed-pop-section">
            <div className="speed-pop-label">Audio bed</div>
            <div className="speed-bed-chips">
              {SPEED_BEDS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={`speed-bed-chip${bed === b.id ? ' on' : ''}`}
                  onClick={() => setBed(b.id)}
                  title={b.hint}
                >
                  <span className="bed-glyph" aria-hidden="true">{b.glyph}</span>
                  {b.label}
                </button>
              ))}
            </div>
          </div>
          <div className="speed-pop-foot">
            <div className="speed-pop-hint">
              {bed === 'music'   && 'Drop a music bed underneath while the visual zips by.'}
              {bed === 'silence' && 'Mute the source audio for the whole ramp.'}
              {bed === 'pitched' && 'Keep the original voice — sped up & pitched.'}
            </div>
            <button type="button" className="speed-apply" onClick={onApply}>
              Apply <span className="glyph">»</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function wordRangeFromClipStarts(clipStarts: Map<string, number>, word: { start: number; end: number; clipId?: string }): WordRange {
  const clipStart = word.clipId ? clipStarts.get(word.clipId) : undefined;
  if (clipStart == null) return { start: word.start, end: word.end };
  return { start: clipStart + word.start, end: clipStart + word.end };
}

export function TranscriptPanel() {
  const projectId = useEditorStore((s) => s.projectId);
  const project = useEditorStore((s) => s.project);
  const manifest = useEditorStore((s) => s.manifest);
  const transcript = useEditorStore((s) => s.transcript);
  const diagnostics = useEditorStore((s) => s.diagnostics);
  const loading = useEditorStore((s) => s.loading);
  const transcriptMode = useEditorStore((s) => s.transcriptMode);
  const seekAction = useEditorStore((s) => s.seek);
  const setSelection = useEditorStore((s) => s.setSelection);
  const setTranscriptMode = useEditorStore((s) => s.setTranscriptMode);
  const setTranscriptCollapsed = useEditorStore((s) => s.setTranscriptCollapsed);
  const createOperation = useEditorStore((s) => s.createOperation);
  const createVoicePatch = useEditorStore((s) => s.createVoicePatch);
  const createSpeechToSpeechPatch = useEditorStore((s) => s.createSpeechToSpeechPatch);
  // S1b: the project's prepared clone. `ready` is what switches the confirm step from the
  // legacy provider/voice picker to the collapsed "your voice" chain.
  const voice = useEditorStore((s) => s.voice);
  const prepareVoice = useEditorStore((s) => s.prepareVoice);
  const refreshVoiceStatus = useEditorStore((s) => s.refreshVoiceStatus);
  const createCloneChainVoicePatch = useEditorStore((s) => s.createCloneChainVoicePatch);
  const updateOperation = useEditorStore((s) => s.updateOperation);
  const disableOperation = useEditorStore((s) => s.disableOperation);
  const uploadVideoAsset = useEditorStore((s) => s.uploadVideoAsset);
  // v4 clean-up sweep + inline proposal popover surfaces (store-sourced like the panels).
  const sweepActive = useEditorStore((s) => s.sweepActive);
  const sweepIndex = useEditorStore((s) => s.sweepIndex);
  const sweepSkipped = useEditorStore((s) => s.sweepSkipped);
  const startSweep = useEditorStore((s) => s.startSweep);
  const setProposalPopover = useEditorStore((s) => s.setProposalPopover);
  const router = useRouter();
  const words = transcript?.words || [];

  // ─── Design view-class derivation ────────────────────────────────────────
  // transcriptMode (store enum: 'preview'|'edited'|'original') → design view
  // ('draft'|'audit'|'original') via transcriptModeLabel from selectors.
  const { view } = transcriptModeLabel(transcriptMode);
  const showLowConf = view !== 'draft';
  const showGutter  = view === 'audit';

  const [drag, setDrag] = useState<{ anchor: number; focus: number } | null>(null);
  const [caret, setCaret] = useState<TranscriptCaret | null>(null);
  const [fileDragOver, setFileDragOver] = useState(false);
  const transcriptBodyRef = useRef<HTMLDivElement | null>(null);
  const dragAnchorBoundaryRef = useRef<number | null>(null);
  const [editingWordId, setEditingWordId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [synthPending, setSynthPending] = useState(false);
  const [synthError, setSynthError] = useState<string | null>(null);
  const synthSeqRef = useRef(0);
  const overdubOpRef = useRef<string | null>(null);
  const skipPickerCloseRef = useRef(false);
  const [replacement, setReplacement] = useState('');
  const [replacePickerOpen, setReplacePickerOpen] = useState(false);
  const [draftMuteOpIds, setDraftMuteOpIds] = useState<string[]>([]);
  const [generateFromMuteOpIds, setGenerateFromMuteOpIds] = useState<string[]>([]);
  const [recordPickerOpen, setRecordPickerOpen] = useState(false);
  const [recordBlob, setRecordBlob] = useState<Blob | null>(null);
  const [recordVoiceId, setRecordVoiceId] = useState('');
  const [recordBusy, setRecordBusy] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [ttsProviders, setTtsProviders] = useState<ProviderRecord[]>([]);
  const [voices, setVoices] = useState<VoiceRecord[]>([]);
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState('tts.mock');
  const [selectedVoice, setSelectedVoice] = useState('eve');
  const [selectedModel, setSelectedModel] = useState('');
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [speedRate, setSpeedRate] = useState<2 | 4 | 8 | 16>(4);
  const [speedBed, setSpeedBed] = useState('music');
  const [speedOpen, setSpeedOpen] = useState(false);
  const [rippleBadge, setRippleBadge] = useState<{ deltaSec: number } | null>(null);
  const rippleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ─── clone-chain generation state ─────────────────────────────────────────
  const [chainBusy, setChainBusy] = useState(false);
  const [chainProgress, setChainProgress] = useState<VoicePatchProgress | null>(null);
  /**
   * Server-computed cost + cap verdict, TAGGED with the intent it answers.
   *
   * Untagged state made the disclosure gate bypassable: during the debounce window, or after a
   * failed fetch, the estimate was simply null and Confirm stayed live — so the user could
   * commit to a paid sequence nobody had priced. Staleness is now decided at render by comparing
   * this key against the current intent, not by a passive effect that might not have run yet.
   */
  const [chainEstimate, setChainEstimate] = useState<EstimateState | null>(null);
  /** The same, for the legacy single-call TTS path. */
  const [legacyEstimate, setLegacyEstimate] = useState<EstimateState | null>(null);
  /** Bumped by the retry affordance to re-run a failed estimate fetch. */
  const [estimateNonce, setEstimateNonce] = useState(0);
  const [chainError, setChainError] = useState<{ message: string; errorCode?: string; retryReplays?: boolean } | null>(null);
  /**
   * D5/⟨R6⟩: ONE client-generated requestId per user action, reused on transport retry — that
   * is what makes a retry replay the root terminal instead of paying twice. It is deliberately
   * NOT regenerated on a network failure, and IS discarded whenever the intent changes (a
   * different selection or different text hashes differently and would 409) or when the server
   * produced a terminal for it.
   */
  const chainRequestIdRef = useRef<string | null>(null);
  /**
   * The COMPLETE intent the live requestId belongs to. Coordinates alone are not an identity:
   * the same start/end on a different clip (or a different project) is a different request that
   * the server hashes differently, and reusing the id there is a guaranteed
   * `request-id-conflict`.
   */
  const chainIntentRef = useRef<string | null>(null);
  const chainProgressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * Generation token for progress polls. A poll from a superseded attempt can still be in
   * flight when a newer one starts; without this its response would paint stale step states
   * over the current generation.
   */
  const chainProgressSeqRef = useRef(0);

  const panelState = decidePanelState({ loading, panel: 'transcript', project, diagnostics, transcript });
  const timeMap = useMemo(() => manifest ? buildRenderPlanV3(manifest).timeMap : null, [manifest]);
  const clipStarts = useMemo(() => {
    const starts = new Map<string, number>();
    for (const track of manifest?.tracks || []) {
      for (const clip of track.clips) starts.set(clip.clipId, clip.timelineStart);
    }
    return starts;
  }, [manifest?.tracks]);
  // ─── Clean-up sweep: candidate count (head button) + current hot range ──────
  // Mirror CleanupStrip's derivation exactly (deriveSweepCandidates on the real
  // coordinate model, minus skipped ids). The count drives the .tp-clean-count
  // badge; the candidate at sweepIndex defines which words get .sweep-hot.
  const operationsForSweep = manifest?.operations;
  const sweepCandidates = useMemo(() => {
    const silences = deriveSilences(transcript?.words ?? []);
    const all = deriveSweepCandidates(transcript, manifest, silences, operationsForSweep ?? []);
    return all.filter((c) => !sweepSkipped.includes(c.id));
  }, [transcript, manifest, operationsForSweep, sweepSkipped]);
  const sweepHotRange = useMemo(() => {
    if (!sweepActive || sweepCandidates.length === 0) return null;
    const i = Math.min(sweepIndex, Math.max(0, sweepCandidates.length - 1));
    const cur = sweepCandidates[i];
    return cur ? { start: cur.start, end: cur.end } : null;
  }, [sweepActive, sweepCandidates, sweepIndex]);

  // Proposed/awaiting-approval ops on the timeline axis — used to resolve which op
  // a clicked .is-prop word belongs to so the inline ProposalPopover can open.
  const proposedOpRanges = useMemo(() => {
    return (manifest?.operations ?? [])
      .filter((op) => op.status === 'proposed' || op.status === 'awaiting_approval')
      .map((op) => ({ opId: op.id, range: operationTimelineRange(manifest, op) }))
      .filter((entry): entry is { opId: string; range: { start: number; end: number } } => Boolean(entry.range));
  }, [manifest]);
  const proposedOpIdForRange = useCallback((range: WordRange): string | null => {
    const hit = proposedOpRanges.find(
      (entry) => range.start >= entry.range.start - 0.01 && range.end <= entry.range.end + 0.01
    );
    return hit?.opId ?? null;
  }, [proposedOpRanges]);

  const edited = useMemo(() => {
    if (transcriptMode !== 'edited' || !transcript || !manifest || !timeMap) return null;
    return deriveEditedScriptFromTimeMapV3(transcript as Parameters<typeof deriveEditedScriptFromTimeMapV3>[0], manifest, timeMap);
  }, [transcriptMode, transcript, manifest, timeMap]);
  const preview = useMemo(() => {
    if (transcriptMode !== 'preview' || !transcript || !manifest || !timeMap) return null;
    return derivePreviewScriptFromTimeMapV3(transcript as Parameters<typeof derivePreviewScriptFromTimeMapV3>[0], manifest, timeMap);
  }, [transcriptMode, transcript, manifest, timeMap]);
  const segmentById = useMemo(() => new Map((transcript?.segments || []).map((segment) => [segment.id || segment.segmentId || '', segment])), [transcript?.segments]);
  const wordById = useMemo(() => new Map(words.map((word) => [word.id, word])), [words]);
  const wordIndexById = useMemo(() => new Map(words.map((word, index) => [word.id, index])), [words]);
  const groups = useMemo(() => {
    const bySegment = new Map<string, typeof words>();
    for (const word of words) {
      const segmentWords = bySegment.get(word.segmentId);
      if (segmentWords) segmentWords.push(word);
      else bySegment.set(word.segmentId, [word]);
    }
    return Array.from(bySegment.entries());
  }, [words]);
  const editedGroups = useMemo(() => {
    if (!edited) return [];
    const bySegment = new Map<string, V3EditedScriptToken[]>();
    for (const token of edited.tokens) {
      const segmentId = token.type === 'word' ? token.word.segmentId : wordById.get(token.hiddenWordIds[0] || '')?.segmentId;
      if (!segmentId) continue;
      const segmentTokens = bySegment.get(segmentId);
      if (segmentTokens) segmentTokens.push(token);
      else bySegment.set(segmentId, [token]);
    }
    return Array.from(bySegment.entries());
  }, [edited, wordById]);
  const previewGroups = useMemo(() => {
    if (!preview) return [];
    const chunks: Array<{ segmentId: string; tokens: V3PreviewScriptToken[] }> = [];
    let current: { segmentId: string; tokens: V3PreviewScriptToken[] } | null = null;
    for (const token of preview.tokens) {
      const segmentId = token.type === 'word' ? token.word.segmentId : wordById.get(token.replacedWordIds[0] || '')?.segmentId;
      if (!segmentId) continue;
      if (!current || current.segmentId !== segmentId) {
        if (current) chunks.push(current);
        current = { segmentId, tokens: [] };
      }
      current.tokens.push(token);
    }
    if (current) chunks.push(current);
    return chunks;
  }, [preview, wordById]);
  const previewVisibleWordIds = useMemo(() => {
    if (!preview) return null;
    const ids = new Set<string>();
    for (const token of preview.tokens) if (token.type === 'word') ids.add(token.word.id);
    return ids;
  }, [preview]);
  const selectedRaw = drag ? words.slice(Math.min(drag.anchor, drag.focus), Math.max(drag.anchor, drag.focus) + 1) : [];
  const selected = transcriptMode === 'preview' && previewVisibleWordIds
    ? selectedRaw.filter((word) => previewVisibleWordIds.has(word.id))
    : selectedRaw;
  const selectionStart = selected[0] ? wordRangeFromClipStarts(clipStarts, selected[0]).start : 0;
  const selectionEnd = selected.at(-1) ? wordRangeFromClipStarts(clipStarts, selected.at(-1)!).end : 0;
  const selectionText = selected.map((word) => word.text).join(' ');

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    Promise.all([
      getSettingsProviders().catch(() => null),
      getVoices().catch(() => ({ voices: [] as VoiceRecord[] })),
      getWorkspaceSettings(projectId).catch(() => null)
    ]).then(([settings, voiceLibrary, workspace]) => {
      if (cancelled) return;
      setTtsProviders((settings?.registry.providers || []).filter((provider) => provider.kind === 'tts' && provider.enabled !== false));
      setVoices(voiceLibrary.voices);
      setWorkspaceSettings(workspace?.settings ?? null);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  const providerOptions = useMemo(() => ttsProviders.some((provider) => provider.id === 'tts.mock') ? ttsProviders : [...ttsProviders, MOCK_TTS_PROVIDER], [ttsProviders]);
  const defaultProviderId = useMemo(() => resolveProviderDefault(providerOptions, workspaceSettings), [providerOptions, workspaceSettings]);
  const selectedProvider = providerOptions.find((provider) => provider.id === selectedProviderId) || providerOptions.find((provider) => provider.id === defaultProviderId) || MOCK_TTS_PROVIDER;
  const modelOptions = AVAILABLE_MODELS[selectedProvider.id] || [];
  const effectiveModel = selectedModel || selectedProvider.model || modelOptions[0] || '';
  const voiceOptions = useMemo(() => {
    if (selectedProvider.id === 'tts.elevenlabs') return voices.filter((voice) => voice.provider === 'elevenlabs').map((voice) => voice.voiceId);
    return [...(STOCK_VOICES[selectedProvider.id] || ['eve'])];
  }, [selectedProvider.id, voices]);
  const elevenlabsVoices = useMemo(() => voices.filter((v) => v.provider === 'elevenlabs'), [voices]);

  // ─── clone chain: availability, estimate, cap ───────────────────────────────
  // The chain runs only when a clone is READY for the CURRENT cleanup generation. Every other
  // voice state keeps the legacy picker exactly as it was (D9/⟨R6⟩ — legacy behaviour is
  // preserved everywhere) and adds a prepare CTA on top.
  const cloneChainReady = voice.state === 'ready';
  const chainChars = replacement.trim().length;
  // The STS step bills by the duration of its SOURCE (the TTS output), whose exact length is
  // unknown until the first call runs — the selection's duration is the honest pre-call proxy,
  // and it is sent to the server, which does the actual pricing.
  const chainStsSourceSec = Math.max(0, selectionEnd - selectionStart);

  // ─── estimate gating: no priced disclosure, no Confirm ──────────────────────
  // The keys pin an estimate to the exact request it prices. Anything else — the debounce
  // window, a failed fetch, a changed selection — is "not priced yet", and a paid action the
  // user has not been shown the price of must not be one keypress away. The server now runs the
  // same ordered admission before the first paid call, so this gate is a disclosure guarantee
  // rather than the last line of defence.
  const chainEstimateKey = JSON.stringify(['chain', projectId, chainChars, chainStsSourceSec]);
  const legacyEstimateKey = JSON.stringify(['legacy', projectId, selectedProvider.id, effectiveModel, chainChars]);
  const chainEst = chainEstimate?.key === chainEstimateKey ? chainEstimate : null;
  const legacyEst = legacyEstimate?.key === legacyEstimateKey ? legacyEstimate : null;
  // "Priced" means EVERY paid step carries a number — not merely that the request returned.
  // A step the provider cannot cost is money nobody has disclosed, and under a cap the engine
  // refuses it anyway; either way Confirm must not be live.
  //
  // It gates ONLY the Confirm predicate. The estimate itself stays bound whenever the server
  // answered, because the unpriceable cases (provider disabled, provider missing, an
  // uncostable call) are exactly the ones whose refusal copy the user needs to see — and
  // hiding the value behind `fullyPriced` made that banner unreachable.
  const fullyPriced = (state: EstimateState | null) =>
    state?.status === 'ready' && state.value != null && state.value.steps.length > 0 && state.value.steps.every((step) => typeof step.estimated === 'number');
  const chainPriced = fullyPriced(chainEst);
  const legacyPriced = fullyPriced(legacyEst);
  const chainEstimateValue = chainEst?.status === 'ready' ? chainEst.value : null;
  const legacyEstimateValue = legacyEst?.status === 'ready' ? legacyEst.value : null;
  const chainCapExceeded = chainEstimateValue?.wouldExceedCap === true;
  const capExceeded = legacyEstimateValue?.wouldExceedCap === true;
  // The last failure requires a human to resolve it — Confirm must not reissue the request.
  const chainBlocked = chainError != null && cloneChainRemedy(chainError) === 'operator';
  const chainStep = (step: 'tts' | 'sts') => chainProgress?.steps.find((entry) => entry.step === step)?.status ?? 'pending';

  useEffect(() => {
    if (!providerOptions.some((provider) => provider.id === selectedProviderId)) setSelectedProviderId(defaultProviderId);
  }, [defaultProviderId, providerOptions, selectedProviderId]);
  useEffect(() => {
    if (skipPickerCloseRef.current) { skipPickerCloseRef.current = false; return; }
    setReplacePickerOpen(false); setRecordPickerOpen(false); setRecordBlob(null); setRecordError(null);
  }, [selectionStart, selectionEnd]);
  useEffect(() => () => { if (rippleTimerRef.current) clearTimeout(rippleTimerRef.current); }, []);
  useEffect(() => () => { if (chainProgressTimerRef.current) clearInterval(chainProgressTimerRef.current); }, []);
  // Switching project invalidates everything about an in-flight generation's UI: the id belongs
  // to another workspace, and any late progress response must be dropped.
  useEffect(() => {
    chainRequestIdRef.current = null;
    chainIntentRef.current = null;
    chainProgressSeqRef.current += 1;
    if (chainProgressTimerRef.current) { clearInterval(chainProgressTimerRef.current); chainProgressTimerRef.current = null; }
    setChainError(null);
    setChainProgress(null);
    setChainEstimate(null);
  }, [projectId]);
  // A changed selection or changed text is a different user action; clear the stale surfaces.
  // The requestId itself is validated against the FULL intent key at submit time (a coordinate
  // pair is not an identity), so it is not dropped here.
  useEffect(() => { setChainError(null); setChainProgress(null); }, [selectionStart, selectionEnd, replacement]);
  /**
   * Ask the SERVER what this generation costs and whether the cap admits it. Debounced because
   * it moves with every keystroke; the estimate is cleared while a newer answer is pending so a
   * stale figure is never shown next to a changed request.
   */
  /**
   * Price the pending generation, SERVER-SIDE, and tag the answer with the request it prices.
   *
   * Nothing here clears state on a passive schedule: the key comparison at render already makes
   * a superseded estimate invisible, and a failure becomes an explicit, retryable 'error' state
   * rather than an absence that silently unblocks Confirm.
   */
  useEffect(() => {
    if (!replacePickerOpen || !cloneChainReady || !projectId || chainChars === 0) return;
    let cancelled = false;
    setChainEstimate({ key: chainEstimateKey, status: 'loading', value: null });
    const handle = setTimeout(() => {
      void getCloneChainEstimate(projectId, { chars: chainChars, sourceDurationSec: chainStsSourceSec })
        .then((estimate) => { if (!cancelled) setChainEstimate({ key: chainEstimateKey, status: 'ready', value: estimate }); })
        // No local fallback: a guessed number presented as the cost is worse than none, and
        // proceeding unpriced is worse than either.
        .catch(() => { if (!cancelled) setChainEstimate({ key: chainEstimateKey, status: 'error', value: null }); });
    }, 350);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [replacePickerOpen, cloneChainReady, projectId, chainChars, chainStsSourceSec, chainEstimateKey, estimateNonce]);
  /** The same, for the legacy provider/voice path — no cost figure is computed client-side. */
  useEffect(() => {
    if (!replacePickerOpen || cloneChainReady || !projectId || chainChars === 0) return;
    let cancelled = false;
    setLegacyEstimate({ key: legacyEstimateKey, status: 'loading', value: null });
    const handle = setTimeout(() => {
      void getTtsEstimate(projectId, { providerId: selectedProvider.id, chars: chainChars, ...(effectiveModel ? { model: effectiveModel } : {}) })
        .then((estimate) => { if (!cancelled) setLegacyEstimate({ key: legacyEstimateKey, status: 'ready', value: estimate }); })
        .catch(() => { if (!cancelled) setLegacyEstimate({ key: legacyEstimateKey, status: 'error', value: null }); });
    }, 350);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [replacePickerOpen, cloneChainReady, projectId, chainChars, selectedProvider.id, effectiveModel, legacyEstimateKey, estimateNonce]);
  useEffect(() => {
    const preferred = workspaceSettings?.taskOptions.tts.defaultVoice;
    const nextVoice = preferred?.providerId === selectedProvider.id && voiceOptions.includes(preferred.voiceId) ? preferred.voiceId : voiceOptions[0] || '';
    if (!voiceOptions.includes(selectedVoice)) setSelectedVoice(nextVoice);
    if (!selectedModel && selectedProvider.model) setSelectedModel(selectedProvider.model);
  }, [selectedProvider.id, selectedProvider.model, selectedModel, selectedVoice, voiceOptions, workspaceSettings]);

  const fillerSet = useMemo(() => new Set((workspaceSettings?.taskOptions?.fillerWords ?? DEFAULT_FILLER_WORDS).map(normalizeFiller)), [workspaceSettings]);
  const liveOverdubDisabled = !!diagnostics?.liveOverdubDisabled;

  // Live overdub
  useEffect(() => {
    if (!editingWordId || !editText.trim()) return;
    const word = words.find((w) => w.id === editingWordId);
    if (!word || editText.trim() === word.text) return;
    if (liveOverdubDisabled || defaultProviderId === 'tts.mock') return;
    const voice = voiceOptions[0] || '';
    if (!voice) return;
    const seq = ++synthSeqRef.current;
    const handle = setTimeout(async () => {
      setSynthPending(true);
      setSynthError(null);
      if (overdubOpRef.current) {
        await disableOperation(overdubOpRef.current, 'Superseded by live overdub');
        overdubOpRef.current = null;
      }
      try {
        const targets = clipSpanTargetsForWords(manifest, [word]);
        const target = targets[0];
        if (!target || seq !== synthSeqRef.current) return;
        const op = await createVoicePatch({ clipId: target.clipId, start: target.start, end: target.end, text: editText.trim(), provider: defaultProviderId, voice, reason: 'Live overdub' });
        if (op) overdubOpRef.current = op.id;
        if (seq !== synthSeqRef.current) return;
        setEditingWordId(null);
      } catch (err) {
        if (seq !== synthSeqRef.current) return;
        setSynthError(err instanceof Error ? err.message : 'Synthesis failed');
      } finally {
        if (seq === synthSeqRef.current) setSynthPending(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [editText, editingWordId]); // eslint-disable-line react-hooks/exhaustive-deps

  const seek = useCallback((start: number, end?: number, text?: string, wordIds?: string[], opId?: string) => {
    seekAction(start);
    setSelection({ start, end: end ?? start, text, wordIds, opId });
  }, [seekAction, setSelection]);

  const selectedTargets = useCallback(() => clipSpanTargetsForWords(manifest, selected), [manifest, selected]);

  async function createClipOp(type: 'cut' | 'mute' | 'speed') {
    const targets = selectedTargets();
    if (!targets.length) return;
    setSelectionError(null);
    for (const target of targets) await createOperation(type === 'speed' ? { type, target, rate: speedRate, bed: speedBed, reason: `Manual speed ${speedRate}×` } : { type, target, reason: `Manual ${type} from transcript` });
    setDrag(null);
    setCaret(null);
  }

  function openReplacePicker() {
    // Re-price on every entry: the user may have gone to Settings and raised the very cap that
    // blocked them, and a cached refusal would keep Confirm dead until something else moved.
    setEstimateNonce((n) => n + 1);
    const targets = selectedTargets();
    if (targets.length > 1) { setSelectionError('Replacement speech must stay within a single clip.'); return; }
    const target = targets[0];
    if (!target || !replacement.trim()) return;
    setSelectionError(null);
    setSelectedProviderId(defaultProviderId);
    setReplacePickerOpen(true);
  }

  function openRecordPicker() {
    const targets = selectedTargets();
    if (targets.length > 1) { setSelectionError('Recording must stay within a single clip.'); return; }
    if (!targets[0]) return;
    setSelectionError(null);
    setRecordBlob(null);
    setRecordError(null);
    if (elevenlabsVoices.length > 0 && !elevenlabsVoices.some((v) => v.voiceId === recordVoiceId)) setRecordVoiceId(elevenlabsVoices[0]!.voiceId);
    setRecordPickerOpen(true);
  }

  const handleRecordBlob = useCallback((blob: Blob | null, _dur: number) => { setRecordBlob(blob); }, []);

  async function confirmRecordTake() {
    const targets = selectedTargets();
    if (targets.length > 1) { setSelectionError('Recording must stay within a single clip.'); return; }
    const target = targets[0];
    if (!target || !recordBlob || !recordVoiceId) return;
    setRecordBusy(true);
    setRecordError(null);
    try {
      const fd = new FormData();
      fd.append('audio', recordBlob, `take.${recordBlob.type.includes('webm') ? 'webm' : 'wav'}`);
      fd.set('voiceId', recordVoiceId);
      fd.set('start', String(target.start));
      fd.set('end', String(target.end));
      fd.set('clipId', target.clipId);
      const op = await createSpeechToSpeechPatch(fd);
      if (op) { setRecordPickerOpen(false); setRecordBlob(null); setDrag(null); }
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : String(err));
    } finally {
      setRecordBusy(false);
    }
  }

  async function confirmReplaceSpeech() {
    const targets = selectedTargets();
    if (targets.length > 1) { setSelectionError('Replacement speech must stay within a single clip.'); return; }
    const target = targets[0];
    if (!target || !replacement.trim() || !selectedVoice || capExceeded) return;
    // Same pre-disclosure gate as the clone chain: no priced estimate, no paid call.
    if (!legacyPriced) return;
    setSelectionError(null);
    if (rippleTimerRef.current) { clearTimeout(rippleTimerRef.current); rippleTimerRef.current = null; }
    setRippleBadge(null);
    const op = await createVoicePatch({ clipId: target.clipId, start: target.start, end: target.end, text: replacement.trim(), provider: selectedProvider.name, voice: selectedVoice, ...(effectiveModel ? { model: effectiveModel } : {}), voiceRef: { providerId: selectedProvider.id, voiceId: selectedVoice }, reason: 'Manual replacement speech' });
    if (op && generateFromMuteOpIds.length) {
      const replacedIds = [...generateFromMuteOpIds];
      await Promise.all(replacedIds.map((operationId) => disableOperation(operationId, 'Replaced by generated voice patch')));
      setGenerateFromMuteOpIds([]);
      setDraftMuteOpIds((ids) => ids.filter((id) => !replacedIds.includes(id)));
    }
    if (op && op.durationGeneratedSec !== undefined) {
      const deltaSec = op.durationGeneratedSec - (target.end - target.start);
      if (deltaSec > 0.05) {
        if (rippleTimerRef.current) clearTimeout(rippleTimerRef.current);
        setRippleBadge({ deltaSec });
        rippleTimerRef.current = setTimeout(() => setRippleBadge(null), 1500);
      }
    }
    setReplacePickerOpen(false);
    setReplacement('');
    setDrag(null);
  }

  /**
   * The clone-chain generate (D9 `mode: 'clone-chain'`).
   *
   * One user action = one requestId = at most one billing of each paid step. While the POST is
   * in flight we poll the step ledger (⟨R7⟩ progress endpoint) so the two paid calls are visible
   * as they happen rather than as one opaque spinner.
   */
  async function confirmCloneChainGenerate() {
    const targets = selectedTargets();
    if (targets.length > 1) { setSelectionError('Replacement speech must stay within a single clip.'); return; }
    const target = targets[0];
    const text = replacement.trim();
    if (!target || !text || chainBusy || chainCapExceeded) return;
    // Guarded here too, not only on the button: a keyboard path or a stale click must not
    // reissue a request whose blocking condition nobody has cleared, and must not commit to a
    // paid sequence the user has not been shown a price for.
    if (!chainPriced) return;
    if (chainError != null && cloneChainRemedy(chainError) === 'operator') return;
    setSelectionError(null);
    setChainError(null);
    if (rippleTimerRef.current) { clearTimeout(rippleTimerRef.current); rippleTimerRef.current = null; }
    setRippleBadge(null);
    // The id is reused ONLY for the identical intent — same project, clip, coordinates and
    // text. That is the replay case a client-generated id exists for; anything else is a
    // different request the server would hash differently.
    const intentKey = cloneChainIntentKey({ projectId, clipId: target.clipId, start: target.start, end: target.end, text });
    const requestId = chainIntentRef.current === intentKey && chainRequestIdRef.current ? chainRequestIdRef.current : newRequestId();
    chainRequestIdRef.current = requestId;
    chainIntentRef.current = intentKey;
    setChainBusy(true);
    setChainProgress(null);
    if (chainProgressTimerRef.current) clearInterval(chainProgressTimerRef.current);
    const progressSeq = chainProgressSeqRef.current + 1;
    chainProgressSeqRef.current = progressSeq;
    chainProgressTimerRef.current = setInterval(() => {
      void getVoicePatchProgress(projectId, requestId)
        // Drop anything that belongs to a superseded attempt (or another project).
        .then((progress) => { if (chainProgressSeqRef.current === progressSeq) setChainProgress(progress); })
        .catch(() => { /* the POST's own result is the authority; progress is decoration */ });
    }, 900);
    try {
      const replacedIds = [...generateFromMuteOpIds];
      // The supersede cleanup is handed to the store so it is addressed to THIS project even if
      // the user navigates away mid-generation; running it here would apply these ids to
      // whatever project happens to be current when the paid call returns.
      const result = await createCloneChainVoicePatch({
        requestId, clipId: target.clipId, start: target.start, end: target.end, text,
        reason: 'Replacement speech in your prepared voice',
        ...(replacedIds.length ? { supersedeOperationIds: replacedIds } : {})
      });
      // Terminal reached — this id has a root terminal now, so a further Confirm must be a new
      // action rather than a replay of this one.
      chainRequestIdRef.current = null;
      chainIntentRef.current = null;
      // The generation belongs to a project the user has left: it is persisted and its cleanup
      // has been applied there, but none of the surfaces below describe what is on screen now.
      if (result.status === 'stale') return;
      if (replacedIds.length) {
        setGenerateFromMuteOpIds([]);
        setDraftMuteOpIds((ids) => ids.filter((id) => !replacedIds.includes(id)));
      }
      const deltaSec = result.response.operation.durationGeneratedSec - (target.end - target.start);
      if (deltaSec > 0.05) {
        if (rippleTimerRef.current) clearTimeout(rippleTimerRef.current);
        setRippleBadge({ deltaSec });
        rippleTimerRef.current = setTimeout(() => setRippleBadge(null), 1500);
      }
      setReplacePickerOpen(false);
      setReplacement('');
      setDrag(null);
    } catch (error) {
      if (error instanceof ApiError) {
        // Only positive evidence releases the id (see requestIdIsSpent). An ambiguous 5xx — a
        // proxy timing out after the backend accepted the POST — KEEPS it, so the retry replays
        // the terminal instead of paying for the same generation twice.
        const spent = requestIdIsSpent(error, requestId);
        if (spent) {
          chainRequestIdRef.current = null;
          chainIntentRef.current = null;
        }
        const failure = { message: error.message, ...(error.errorCode ? { errorCode: error.errorCode } : {}), retryReplays: !spent };
        setChainError(failure);
        const remedy = cloneChainRemedy(failure);
        if (remedy === 'prepare-voice') void refreshVoiceStatus();
        if (remedy === 'cap') {
          // The server just told us the cap refuses this generation, which contradicts whatever
          // the estimate said. Replace it with the 409's own cap payload and mark it refused, so
          // Confirm stays blocked until a fresh price says otherwise — a stale "affordable"
          // estimate must not let the user bang on a refused request.
          const body = error.body as { cap?: CloneChainEstimate['cap']; refusal?: CloneChainEstimate['refusal']; refusalScope?: CloneChainEstimate['refusalScope']; refusedAtStep?: string } | undefined;
          setChainEstimate((current) => current == null ? current : ({
            key: current.key,
            status: 'ready',
            value: {
              ...(current.value ?? { calls: 0, steps: [], total: null, currency: null, authoritative: false, basis: 'selection-duration' as const, cap: { limit: null, spent: null, group: [] } }),
              cap: body?.cap ?? current.value?.cap ?? { limit: null, spent: null, group: [] },
              wouldExceedCap: true,
              ...(body?.refusal ? { refusal: body.refusal } : {}),
              ...(body?.refusalScope ? { refusalScope: body.refusalScope } : {}),
              ...(body?.refusedAtStep ? { refusedAtStep: body.refusedAtStep } : {})
            }
          }));
        }
      } else {
        // Transport failure — nothing is known about the server side, so KEEP the requestId and
        // let the user retry into a replay.
        setChainError({ message: error instanceof Error ? error.message : String(error), retryReplays: true });
      }
    } finally {
      if (chainProgressTimerRef.current) { clearInterval(chainProgressTimerRef.current); chainProgressTimerRef.current = null; }
      setChainBusy(false);
    }
  }

  const [throttledCurrentTime, setThrottledCurrentTime] = useState(0);
  useEffect(() => {
    let latest = useEditorStore.getState().currentTime;
    let handle: ReturnType<typeof setTimeout> | null = null;
    setThrottledCurrentTime(latest);
    const unsubscribe = useEditorStore.subscribe((next, previous) => {
      if (next.currentTime === previous.currentTime) return;
      latest = next.currentTime;
      if (handle) clearTimeout(handle);
      handle = setTimeout(() => setThrottledCurrentTime(latest), 100);
    });
    return () => {
      if (handle) clearTimeout(handle);
      unsubscribe();
    };
  }, []);

  const currentWordId = useMemo(() => {
    for (const word of words) {
      const range = wordRangeFromClipStarts(clipStarts, word);
      if (throttledCurrentTime >= range.start && throttledCurrentTime <= range.end) return word.id;
    }
    return null;
  }, [clipStarts, words, throttledCurrentTime]);

  useEffect(() => {
    if (!currentWordId) return;
    const el = document.querySelector(`[data-word-id="${currentWordId}"]`);
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' });
  }, [currentWordId]);

  function wordCaretSide(event: MouseEvent<HTMLElement>): TranscriptCaret['side'] {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX - rect.left < rect.width / 2 ? 'left' : 'right';
  }

  function cutWords(targetWords: typeof words, reason: string) {
    for (const target of clipSpanTargetsForWords(manifest, targetWords)) void createOperation({ type: 'cut', target, reason });
    setDrag(null);
    setCaret(null);
  }

  function isEditableTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false;
    return !!target.closest('input, textarea, [contenteditable="true"]');
  }

  function operationDraftText(operationId: string) {
    const op = manifest?.operations.find((candidate) => candidate.id === operationId) as ({ draftText?: string } | undefined);
    return typeof op?.draftText === 'string' ? op.draftText : '';
  }

  async function updateDraftMuteText(operationIds: string[], nextText: string) {
    if (!operationIds.length) return;
    if (!nextText) {
      await Promise.all(operationIds.map((operationId) => disableOperation(operationId, 'Empty type-over draft')));
      setDraftMuteOpIds((ids) => ids.filter((id) => !operationIds.includes(id)));
      setGenerateFromMuteOpIds((ids) => ids.filter((id) => !operationIds.includes(id)));
      return;
    }
    await Promise.all(operationIds.map((operationId) => updateOperation(operationId, { draftText: nextText })));
  }

  async function typeOverSelection(char: string) {
    const targets = selectedTargets();
    const targetKey = (t: { trackId: string; clipId: string; start: number; end: number }) =>
      `${t.trackId}:${t.clipId}:${t.start.toFixed(3)}:${t.end.toFixed(3)}`;
    const currentKey = targets.map(targetKey).sort().join('|');
    const activeOps = draftMuteOpIds
      .map((id) => manifest?.operations.find((c) => c.id === id))
      .filter((op): op is NonNullable<typeof op> => !!op && op.type === 'mute' && op.status === 'approved');
    const activeIds = activeOps.map((op) => op.id);
    const draftKey = activeOps.map((op) => targetKey((op as { target: { trackId: string; clipId: string; start: number; end: number } }).target)).sort().join('|');
    if (activeIds.length && currentKey !== '' && currentKey === draftKey) {
      await updateDraftMuteText(activeIds, operationDraftText(activeIds[0]!) + char);
      return;
    }
    if (activeIds.length) setDraftMuteOpIds([]);
    if (!targets.length) return;
    setSelectionError(null);
    const created: string[] = [];
    for (const target of targets) {
      const op = await createOperation({ type: 'mute', target, draftText: char, reason: 'Type-over draft' });
      if (op) created.push(op.id);
    }
    if (created.length) setDraftMuteOpIds(created);
  }

  function openDraftGenerate(token: Extract<V3EditedScriptToken, { type: 'operation_marker' }>) {
    const op = manifest?.operations.find((candidate) => candidate.id === token.operationId) as ({ type?: string; draftText?: string } | undefined);
    const draftText = typeof op?.draftText === 'string' ? op.draftText.trim() : '';
    if (op?.type !== 'mute' || !draftText) return;
    const indexes = token.hiddenWordIds.map((id) => wordIndexFn(id)).filter((index) => index >= 0);
    if (!indexes.length) return;
    skipPickerCloseRef.current = true;
    setDrag({ anchor: Math.min(...indexes), focus: Math.max(...indexes) });
    setCaret(null);
    setReplacement(draftText);
    setGenerateFromMuteOpIds([token.operationId]);
    setSelectionError(null);
    setSelectedProviderId(defaultProviderId);
    setReplacePickerOpen(true);
  }

  function handleTranscriptKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (isEditableTarget(event.target)) return;
    const targetKey = (t: { trackId: string; clipId: string; start: number; end: number }) =>
      `${t.trackId}:${t.clipId}:${t.start.toFixed(3)}:${t.end.toFixed(3)}`;
    const currentSelKey = selectedTargets().map(targetKey).sort().join('|');
    const matchingDrafts = draftMuteOpIds
      .map((id) => manifest?.operations.find((c) => c.id === id))
      .filter((op): op is NonNullable<typeof op> => !!op && op.type === 'mute' && op.status === 'approved');
    const draftSelKey = matchingDrafts.map((op) => targetKey((op as { target: { trackId: string; clipId: string; start: number; end: number } }).target)).sort().join('|');
    const activeDraftIds = matchingDrafts.length && currentSelKey !== '' && currentSelKey === draftSelKey ? matchingDrafts.map((op) => op.id) : [];
    if (event.key === 'Backspace' && activeDraftIds.length) {
      event.preventDefault();
      const current = operationDraftText(activeDraftIds[0]!);
      void updateDraftMuteText(activeDraftIds, current.slice(0, -1));
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && selected.length) {
      event.preventDefault();
      void typeOverSelection(event.key);
      return;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      if (selected.length) {
        event.preventDefault();
        void createClipOp('cut');
        return;
      }
      const index = deletedWordIndexForCaret(caret, event.key, words.length);
      const word = index == null ? null : words[index];
      if (!word) return;
      event.preventDefault();
      cutWords([word], `Caret ${event.key.toLowerCase()} delete`);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    event.preventDefault();
    if (drag && !event.shiftKey) {
      const collapseBoundary = direction < 0 ? Math.min(drag.anchor, drag.focus) : Math.max(drag.anchor, drag.focus) + 1;
      setDrag(null);
      setCaret(caretFromBoundary(collapseBoundary, words.length));
      return;
    }
    if (drag && event.shiftKey) return;
    const currentBoundary = boundaryFromCaret(caret ?? { wordIndex: 0, side: 'left' });
    const nextBoundary = moveCaretBoundary(caretFromBoundary(currentBoundary, words.length), direction, words.length);
    if (nextBoundary == null) return;
    if (event.shiftKey) {
      const nextSelection = selectionFromBoundaries(currentBoundary, nextBoundary);
      setDrag(nextSelection);
      setCaret(nextSelection ? null : caretFromBoundary(nextBoundary, words.length));
    } else {
      setDrag(null);
      setCaret(caretFromBoundary(nextBoundary, words.length));
    }
  }

  const wordIndexFn = useCallback((id: string) => wordIndexById.get(id) ?? -1, [wordIndexById]);
  const sourceRangeForWord = useCallback((word: TranscriptWord) => wordRangeFromClipStarts(clipStarts, word), [clipStarts]);

  const enterEditMode = useCallback((word: TranscriptWord) => {
    const range = sourceRangeForWord(word);
    seek(range.start, range.end, word.text, [word.id]);
    setEditingWordId(word.id);
    setEditText(word.text);
    setDrag(null);
    setCaret(null);
    synthSeqRef.current++;
    setSynthPending(false);
    setSynthError(null);
  }, [seek, sourceRangeForWord]);

  const commitEdit = useCallback(async (word: TranscriptWord, nextWord?: TranscriptWord) => {
    synthSeqRef.current++; setSynthPending(false);
    const trimmed = editText.trim();
    if (trimmed && trimmed !== word.text && !synthPending) {
      const targets = clipSpanTargetsForWords(manifest, [word]);
      const target = targets[0];
      if (target) await createOperation({ type: 'transcript_amend', target, amendedText: trimmed } as any);
    }
    overdubOpRef.current = null;
    if (nextWord) { setEditText(nextWord.text); setEditingWordId(nextWord.id); } else { setEditingWordId(null); }
  }, [createOperation, editText, manifest, synthPending]);

  const handleWordMouseDown = useCallback((event: MouseEvent<HTMLButtonElement>, _word: TranscriptWord, index: number, range: WordRange) => {
    if (event.button !== 0 || index < 0) return;
    const side = wordCaretSide(event);
    const nextCaret = { wordIndex: index, side } satisfies TranscriptCaret;
    dragAnchorBoundaryRef.current = boundaryFromCaret(nextCaret);
    setCaret(nextCaret);
    setDrag(null);
    transcriptBodyRef.current?.focus();
    const caretTime = side === 'left' ? range.start : range.end;
    seek(caretTime, caretTime, '', []);
  }, [seek]);

  const handleReplacementMouseDown = useCallback((args: { event: MouseEvent<HTMLButtonElement>; leftWord: TranscriptWord | undefined; rightWord: TranscriptWord | undefined; leftIndex: number; rightIndex: number; range: WordRange; text: string; replacedWordIds: string[]; operationId: string | undefined }) => {
    const { event, leftWord, leftIndex, rightIndex, range, text, replacedWordIds, operationId } = args;
    if (event.button !== 0) return;
    const side = wordCaretSide(event);
    const useIndex = side === 'left' ? leftIndex : rightIndex;
    if (useIndex < 0 || !leftWord) return;
    const nextCaret = { wordIndex: useIndex, side } satisfies TranscriptCaret;
    dragAnchorBoundaryRef.current = boundaryFromCaret(nextCaret);
    setCaret(nextCaret);
    setDrag(null);
    transcriptBodyRef.current?.focus();
    const caretTime = side === 'left' ? range.start : range.end;
    seek(caretTime, caretTime, text, replacedWordIds, operationId);
  }, [seek]);

  const handleReplacementMouseUp = useCallback(() => {
    dragAnchorBoundaryRef.current = null;
  }, []);

  const handleWordMouseMove = useCallback((event: MouseEvent<HTMLButtonElement>, index: number) => {
    if (!(event.buttons & 1) || dragAnchorBoundaryRef.current == null || index < 0) return;
    const focusCaret = { wordIndex: index, side: wordCaretSide(event) } satisfies TranscriptCaret;
    const nextSelection = selectionFromBoundaries(dragAnchorBoundaryRef.current, boundaryFromCaret(focusCaret));
    setDrag(nextSelection);
    setCaret(nextSelection ? null : focusCaret);
  }, []);

  const handleWordMouseEnter = useCallback((event: MouseEvent<HTMLButtonElement>, index: number) => {
    if (!(event.buttons & 1) || dragAnchorBoundaryRef.current == null || index < 0) return;
    const anchorBoundary = dragAnchorBoundaryRef.current;
    const focusBoundary = anchorBoundary <= index ? index + 1 : index;
    const nextSelection = selectionFromBoundaries(anchorBoundary, focusBoundary);
    setDrag(nextSelection);
    setCaret(nextSelection ? null : caretFromBoundary(focusBoundary, words.length));
  }, [words.length]);

  const handleWordMouseUp = useCallback((word: TranscriptWord, range: WordRange) => {
    dragAnchorBoundaryRef.current = null;
    if (selected.length) seek(selectionStart || range.start, selectionEnd || range.end, selectionText || word.text, selected.map((item) => item.id));
  }, [seek, selected, selectionEnd, selectionStart, selectionText]);

  const handleWordInputKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>, word: TranscriptWord, index: number, range: WordRange) => {
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault();
      const trimmed = editText.trim();
      if (!trimmed) return;
      const targets = clipSpanTargetsForWords(manifest, [word]);
      if (targets.length > 1) { setSelectionError('Voice patch must stay within a single clip.'); setEditingWordId(null); return; }
      const target = targets[0]; if (!target) return;
      skipPickerCloseRef.current = true;
      setDrag({ anchor: index, focus: index });
      setEditingWordId(null); setReplacement(trimmed);
      seek(range.start, range.end, word.text, [word.id]);
      setSelectionError(null); setSelectedProviderId(defaultProviderId); setReplacePickerOpen(true);
    } else if (e.key === 'Enter') {
      e.preventDefault(); void commitEdit(word);
    } else if (e.key === 'Escape') {
      e.preventDefault(); setEditingWordId(null);
    } else if (e.key === 'Backspace' && editText === '') {
      e.preventDefault(); setEditingWordId(null);
      const cutTargets = clipSpanTargetsForWords(manifest, [word]);
      for (const ct of cutTargets) void createOperation({ type: 'cut', target: ct, reason: 'Inline backspace-to-delete' });
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const nextIndex = e.shiftKey ? index - 1 : index + 1;
      const nextWord = words[nextIndex]; void commitEdit(word, nextWord ?? undefined);
    }
  }, [commitEdit, createOperation, defaultProviderId, editText, manifest, seek, words]);

  // Open the inline review popover for a proposed op (prototype onProposalClick:
  // seek to the op, then anchor the popover at the click point).
  const handleProposalClick = useCallback((opId: string, event: MouseEvent<HTMLButtonElement>) => {
    const op = manifest?.operations.find((candidate) => candidate.id === opId);
    const opRange = op ? operationTimelineRange(manifest, op) : null;
    if (opRange) seek(opRange.start);
    setProposalPopover({ opId, x: event.clientX, y: event.clientY });
  }, [manifest, seek, setProposalPopover]);

  const renderWord = useCallback((word: TranscriptWord, index: number, muted?: boolean, outputRange?: WordRange, decorators?: WordDecorators) => {
    const range = outputRange ?? wordRangeFromClipStarts(clipStarts, word);
    const selectedWord = drag && index >= Math.min(drag.anchor, drag.focus) && index <= Math.max(drag.anchor, drag.focus);
    const caretSide = !drag && caret?.wordIndex === index ? caret.side : null;
    // Clean-up sweep highlight: the word falls inside the current candidate's
    // timeline-axis span (prototype transcript-v4.jsx `isHot`, 0.01s epsilon).
    const sweepHot = !!sweepHotRange && range.start >= sweepHotRange.start - 0.01 && range.end <= sweepHotRange.end + 0.01;
    // Proposed words (.is-prop) carry their proposed op id so a click opens the popover.
    const proposedOpId = decorators?.proposed ? proposedOpIdForRange(range) : null;
    return <Word
      key={word.id}
      word={word}
      index={index}
      start={range.start}
      end={range.end}
      muted={muted}
      fx={decorators?.fx}
      factor={decorators?.factor}
      speedLast={decorators?.speedLast}
      proposed={decorators?.proposed}
      current={throttledCurrentTime >= range.start && throttledCurrentTime <= range.end}
      selected={selectedWord}
      caretSide={caretSide}
      editing={editingWordId === word.id}
      editText={editText}
      synthPending={synthPending}
      synthError={synthError}
      liveOverdubDisabled={liveOverdubDisabled}
      filler={fillerSet.has(normalizeFiller(word.text))}
      showLowConf={showLowConf}
      sweepHot={sweepHot}
      proposedOpId={proposedOpId}
      onProposalClick={handleProposalClick}
      onEditText={setEditText}
      onCommitEdit={(targetWord, nextWord) => { void commitEdit(targetWord, nextWord); }}
      onInputKeyDown={handleWordInputKeyDown}
      onMouseDownWord={handleWordMouseDown}
      onMouseMoveWord={handleWordMouseMove}
      onMouseEnterWord={handleWordMouseEnter}
      onMouseUpWord={handleWordMouseUp}
      onEnterEditMode={enterEditMode}
    />;
  }, [caret, clipStarts, commitEdit, drag, editText, editingWordId, enterEditMode, fillerSet, handleProposalClick, handleWordInputKeyDown, handleWordMouseDown, handleWordMouseEnter, handleWordMouseMove, handleWordMouseUp, liveOverdubDisabled, proposedOpIdForRange, showLowConf, sweepHotRange, synthError, synthPending, throttledCurrentTime]);

  // ─── Speaker-turn detection helper ─────────────────────────────────────────
  // Returns true when this segment introduces a new speaker relative to the
  // previous one (triggers .turn-start on the row and shows the speaker line).
  function speakerChanged(segmentId: string, prevSegmentId: string | null): boolean {
    if (!prevSegmentId) return true;
    const cur = segmentById.get(segmentId);
    const prev = segmentById.get(prevSegmentId);
    const curSpeaker = cur?.speaker ?? '';
    const prevSpeaker = prev?.speaker ?? '';
    return curSpeaker !== prevSpeaker;
  }

  // ─── Audit rail helper ─────────────────────────────────────────────────────
  // Collects unique ops referenced by the tokens in one segment group so we can
  // render one .tx-gmark button per op in the .tx-rail.
  function marksForEditedGroup(tokens: V3EditedScriptToken[]): Array<{ opId: string; type: string; status: string; isProposed: boolean; range: WordRange | null }> {
    const seen = new Set<string>();
    const out: Array<{ opId: string; type: string; status: string; isProposed: boolean; range: WordRange | null }> = [];
    for (const t of tokens) {
      if (t.type !== 'operation_marker') continue;
      if (seen.has(t.operationId)) continue;
      seen.add(t.operationId);
      const op = manifest?.operations.find((c) => c.id === t.operationId);
      const type = op?.type || t.view.kind;
      const status = op?.status || t.view.status;
      const isProposed = status === 'proposed' || status === 'awaiting_approval';
      const range = op ? operationTimelineRange(manifest, op) : null;
      out.push({ opId: t.operationId, type, status, isProposed, range });
    }
    return out;
  }

  // ─── Mode-tab labels ───────────────────────────────────────────────────────
  // Map store enum → design tab labels + aria-selected state
  const MODES: Array<{ mode: 'preview' | 'edited' | 'original'; label: string }> = [
    { mode: 'preview',  label: 'Draft' },
    { mode: 'edited',   label: 'Edits' },
    { mode: 'original', label: 'Original' },
  ];

  return (
    <section
      className={`transcript-pane${fileDragOver ? ' file-drag-over' : ''}`}
      aria-label="Transcript"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        if (!fileDragOver) setFileDragOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setFileDragOver(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setFileDragOver(false);
        const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type.startsWith('video/'));
        if (file) void uploadVideoAsset(file);
      }}
    >
      {/* ── Head · v3 ── */}
      <div className="tp-head tp-head-v3">
        <div className="tp-head-top">
          <h2>Transcript <em>· script</em></h2>
          <button
            type="button"
            className="tp-clean-btn"
            onClick={() => startSweep()}
            title="Review fillers &amp; dead air — cut one by one or all at once"
          >
            ✦ Clean up
            {sweepCandidates.length > 0 ? <span className="tp-clean-count">{sweepCandidates.length}</span> : null}
          </button>
          <button
            type="button"
            className="pane-collapse"
            aria-label="Collapse transcript"
            onClick={() => setTranscriptCollapsed(true)}
          >‹</button>
        </div>
        <div className="tp-mode tp-mode-3" role="tablist" aria-label="Transcript view">
          {MODES.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={transcriptMode === mode}
              className={transcriptMode === mode ? 'active' : ''}
              onClick={() => setTranscriptMode(mode)}
              title={
                mode === 'preview'  ? 'The clean final read — approved edits applied silently' :
                mode === 'edited'   ? 'Every change visible with provenance — marks + ledger' :
                                     'The raw transcript — no edits, low-confidence flagged'
              }
              dangerouslySetInnerHTML={{ __html: label }}
            />
          ))}
        </div>
      </div>

      {panelState !== 'ready'
        ? <PanelState state={panelState} />
        : (
          <div
            className={`tp-body tp-clean mode-${view}`}
            ref={transcriptBodyRef}
            tabIndex={0}
            onKeyDown={handleTranscriptKeyDown}
            onMouseLeave={() => { dragAnchorBoundaryRef.current = null; }}
          >
            {/* ── DRAFT (preview mode) ── */}
            {transcriptMode === 'preview' && preview
              ? (() => {
                  let prevSegmentId: string | null = null;
                  return previewGroups.map(({ segmentId, tokens }, chunkIndex) => {
                    const turnStart = speakerChanged(segmentId, prevSegmentId);
                    prevSegmentId = segmentId;
                    const firstToken = tokens[0];
                    const firstWord = firstToken?.type === 'word'
                      ? firstToken.word
                      : wordById.get(firstToken?.replacedWordIds[0] || '') || groups.find(([id]) => id === segmentId)?.[1][0];
                    const firstOutputStart = firstToken?.type === 'word' ? firstToken.outputStart : firstToken?.type === 'replacement' ? firstToken.outputStart ?? null : null;
                    const firstStart = firstOutputStart ?? (firstWord ? wordRangeFromClipStarts(clipStarts, firstWord).start : 0);
                    const seg = segmentById.get(segmentId) as BadgeSegment | undefined;
                    return (
                      <div className={`tx-row${turnStart ? ' turn-start' : ''}`} key={`${segmentId}-${chunkIndex}`}>
                        <div className="tx-main">
                          {turnStart && (
                            <span className="tx-speaker">
                              <span className="name">{(firstWord?.speaker || 'Speaker').toUpperCase()}</span>
                              <span className="ts">· {formatClock(firstStart)}</span>
                              <HookBadge pct={hookPercent(seg)} onSeek={() => seek(firstStart)} />
                              <SilenceBadge count={silenceCount(seg)} />
                            </span>
                          )}
                          <p>{tokens.map((token, index) => {
                            const isReplacement = token.type === 'replacement';
                            const firstReplaced = isReplacement ? wordById.get(token.replacedWordIds[0] || '') : undefined;
                            const lastReplaced  = isReplacement ? wordById.get(token.replacedWordIds[token.replacedWordIds.length - 1] || '') : undefined;
                            const leftIdx  = firstReplaced ? wordIndexFn(firstReplaced.id) : -1;
                            const rightIdx = lastReplaced  ? wordIndexFn(lastReplaced.id)  : -1;
                            const caretSide: TranscriptCaret['side'] | null = isReplacement && !drag && caret
                              ? (caret.wordIndex === leftIdx && caret.side === 'left'  ? 'left'
                                : caret.wordIndex === rightIdx && caret.side === 'right' ? 'right'
                                : null)
                              : null;
                            return <PreviewToken
                              key={token.type === 'word' ? token.word.id : `${token.operationId}-${index}`}
                              token={token}
                              indexForWord={wordIndexFn}
                              wordById={wordById}
                              renderWord={renderWord}
                              sourceRangeForWord={sourceRangeForWord}
                              seek={seek}
                              caretSide={caretSide}
                              onMouseDownReplacement={handleReplacementMouseDown}
                              onMouseUpReplacement={handleReplacementMouseUp}
                            />;
                          })}</p>
                        </div>
                      </div>
                    );
                  });
                })()
              : null
            }

            {/* ── AUDIT TRAIL (edited mode) ── */}
            {transcriptMode === 'edited' && edited
              ? (() => {
                  let prevSegmentId: string | null = null;
                  return editedGroups.map(([segmentId, tokens]) => {
                    const turnStart = speakerChanged(segmentId, prevSegmentId);
                    prevSegmentId = segmentId;
                    const firstToken = tokens[0];
                    const firstWord = firstToken?.type === 'word'
                      ? firstToken.word
                      : wordById.get(firstToken?.hiddenWordIds[0] || '') || groups.find(([id]) => id === segmentId)?.[1][0];
                    const firstStart = firstWord ? wordRangeFromClipStarts(clipStarts, firstWord).start : 0;
                    const seg = segmentById.get(segmentId) as BadgeSegment | undefined;
                    const marks = marksForEditedGroup(tokens);
                    return (
                      <div className={`tx-row${turnStart ? ' turn-start' : ''}`} key={segmentId}>
                        {/* Audit rail — 34px gutter column */}
                        <div className="tx-rail">
                          {marks.length > 0 && (
                            <div className="tx-gmarks">
                              {marks.map((m) => {
                                const def = gmark(m.type);
                                return (
                                  <button
                                    key={m.opId}
                                    type="button"
                                    className={`tx-gmark ${def.cls}${m.isProposed ? ' prop' : ''}`}
                                    title={`${m.isProposed ? 'proposed ' : ''}${def.label}${m.isProposed ? ' — click to review' : ''}`}
                                    onClick={(event) => {
                                      // Prototype transcript-v4.jsx L332: a proposed mark opens the
                                      // inline review popover; an applied mark just seeks.
                                      if (m.isProposed) {
                                        handleProposalClick(m.opId, event);
                                      } else if (m.range) {
                                        seek(m.range.start, m.range.end);
                                      }
                                    }}
                                  >{def.g}</button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                        <div className="tx-main">
                          {turnStart && (
                            <span className="tx-speaker">
                              <span className="name">{(firstWord?.speaker || 'Speaker').toUpperCase()}</span>
                              <span className="ts">· {formatClock(firstStart)}</span>
                              <HookBadge pct={hookPercent(seg)} onSeek={() => seek(firstStart)} />
                              <SilenceBadge count={silenceCount(seg)} />
                            </span>
                          )}
                          <p>{tokens.map((token, index) => {
                            const operation = token.type === 'operation_marker'
                              ? manifest?.operations.find((candidate) => candidate.id === token.operationId)
                              : undefined;
                            const range = operation ? operationTimelineRange(manifest, operation) : null;
                            return <EditedToken
                              key={token.type === 'word' ? token.word.id : `${token.operationId}-${index}`}
                              token={token}
                              operation={operation}
                              range={range}
                              renderWord={renderWord}
                              indexForWord={wordIndexFn}
                              seek={seek}
                              openDraftGenerate={openDraftGenerate}
                              disableOperation={disableOperation}
                              onProposalClick={handleProposalClick}
                            />;
                          })}</p>
                        </div>
                      </div>
                    );
                  });
                })()
              : null
            }

            {/* ── ORIGINAL (raw words, no edits) ── */}
            {transcriptMode === 'original'
              ? (() => {
                  let prevSegmentId: string | null = null;
                  return groups.map(([segmentId, segmentWords]) => {
                    const turnStart = speakerChanged(segmentId, prevSegmentId);
                    prevSegmentId = segmentId;
                    const first = segmentWords[0];
                    const firstStart = first ? wordRangeFromClipStarts(clipStarts, first).start : 0;
                    const seg = segmentById.get(segmentId) as BadgeSegment | undefined;
                    return (
                      <div className={`tx-row${turnStart ? ' turn-start' : ''}`} key={segmentId}>
                        <div className="tx-main">
                          {turnStart && (
                            <span className="tx-speaker">
                              <span className="name">{(first?.speaker || 'Speaker').toUpperCase()}</span>
                              <span className="ts">· {formatClock(firstStart)}</span>
                              <HookBadge pct={hookPercent(seg)} onSeek={() => seek(firstStart)} />
                              <SilenceBadge count={silenceCount(seg)} />
                            </span>
                          )}
                          <p>{segmentWords.map((word) => renderWord(word, wordIndexFn(word.id)))}</p>
                        </div>
                      </div>
                    );
                  });
                })()
              : null
            }

            {/* ── Selection bar (design .sel-bar) ── */}
            {selected.length ? (
              <div className="sel-bar">
                <span className="stamp sel-time">{formatClock(selectionStart)}–{formatClock(selectionEnd)}</span>
                <span className="preview-text" title={selectionText}>"{selectionText}"</span>
                {selectionError ? <em className="selection-error">{selectionError}</em> : null}
                <input
                  className="replace-input"
                  aria-label="Replacement speech text"
                  value={replacement}
                  placeholder="re-record as …"
                  onChange={(event) => { setReplacement(event.target.value); setSelectionError(null); }}
                />
                <div className="actions">
                  <button type="button" onClick={() => { setSelectionError(null); setReplacePickerOpen(false); setSpeedOpen(false); setDrag(null); }}>Cancel</button>
                  <button type="button" onClick={() => { void createClipOp('mute'); }}>Mute</button>
                  <button type="button" className="danger" onClick={() => { void createClipOp('cut'); }}>Delete</button>
                  <SpeedAction
                    open={speedOpen}
                    setOpen={setSpeedOpen}
                    factor={speedRate}
                    bed={speedBed}
                    setFactor={setSpeedRate}
                    setBed={setSpeedBed}
                    onApply={() => { void createClipOp('speed'); setSpeedOpen(false); }}
                    selectionDuration={Math.max(0, selectionEnd - selectionStart)}
                  />
                  <button type="button" onClick={openRecordPicker}>Record a take</button>
                  <button
                    type="button"
                    className="primary"
                    disabled={!replacement.trim()}
                    onClick={openReplacePicker}
                  >Replace speech</button>
                </div>
                <button
                  type="button"
                  className="sel-close"
                  onClick={() => { setSelectionError(null); setReplacePickerOpen(false); setSpeedOpen(false); setDrag(null); setSelection(null); }}
                  title="Dismiss (esc) — or click anywhere in the transcript"
                  aria-label="Dismiss selection"
                >×</button>

                {/* Record-a-take picker */}
                {recordPickerOpen ? (
                  <div className="voice-patch-picker">
                    <p className="muted" style={{ marginBottom: '0.5rem', fontSize: '0.85em' }}>Re-record this segment — ElevenLabs speech-to-speech, billed by your plan.</p>
                    {elevenlabsVoices.length === 0
                      ? <p className="voice-recorder-error">No ElevenLabs voices in library. <button type="button" className="link-button" onClick={() => router.push('/settings?tab=voices')}>Add a voice →</button></p>
                      : <>
                          <label>Voice
                            <select value={recordVoiceId} onChange={(e) => setRecordVoiceId(e.target.value)}>
                              {elevenlabsVoices.map((v) => <option key={v.id} value={v.voiceId}>{v.name}</option>)}
                            </select>
                          </label>
                          <VoiceSampleRecorder blob={recordBlob} onBlob={handleRecordBlob} disabled={recordBusy} />
                          {recordError ? <p className="voice-recorder-error" role="alert">{recordError}</p> : null}
                          <div className="voice-patch-actions">
                            <button type="button" className="primary" disabled={!recordBlob || !recordVoiceId || recordBusy} onClick={() => { void confirmRecordTake(); }}>{recordBusy ? 'Processing…' : 'Submit take'}</button>
                            <button type="button" onClick={() => { setRecordPickerOpen(false); setRecordBlob(null); setRecordError(null); }}>Cancel</button>
                          </div>
                        </>
                    }
                  </div>
                ) : null}

                {/*
                  Replace-speech confirm — clone chain.

                  When a clone is ready for the current cleanup generation there is nothing left
                  to choose: the voice IS the project's clone and the models are the locked
                  recipe (the server 400s on provider/voice/model), so the step collapses to
                  "your voice" + what it will cost + what it is doing. The legacy picker below
                  is untouched and still serves every other voice state.
                */}
                {replacePickerOpen && replacement.trim() && cloneChainReady ? (
                  <div className="voice-patch-picker chain">
                    <p className="voice-chain-head">
                      <span className="voice-chain-glyph">☺</span>
                      <span>Generate in <strong>your voice</strong></span>
                    </p>
                    {/*
                      The figures come from the server, which prices both steps with the same
                      adapters and cap arithmetic the real call uses. When it cannot price the
                      call we say so instead of showing a number we made up.
                    */}
                    <p className="voice-cost">
                      {chainEst?.status === 'error'
                        ? <>Couldn't price this generation. <button type="button" className="link-button" onClick={() => setEstimateNonce((n) => n + 1)}>Retry →</button></>
                        : chainEstimateValue == null
                          ? <>Estimating… · {CLONE_CHAIN_CALLS} ElevenLabs calls (text-to-speech, then speech-to-speech onto your clone) · {chainChars} chars</>
                          : !chainPriced
                            ? <>Cost unavailable for this call · {chainChars} chars</>
                            : chainEstimateValue!.total == null
                            // Every step IS priced here (chainPriced), so a null total means the
                            // steps disagree on currency — show them individually rather than
                            // adding figures that cannot be added.
                            ? <>Up to {chainEstimateValue!.steps.map((step) => `${step.step === 'tts' ? 'speech' : 'your voice'} ${money(step.estimated, step.currency)}`).join(' + ')} · {chainChars} chars</>
                            : <>Estimated up to <strong>~{money(chainEstimateValue!.total, chainEstimateValue!.currency)}</strong> · {chainEstimateValue!.calls} ElevenLabs calls: {chainEstimateValue!.steps.map((step) => `${step.step === 'tts' ? 'speech' : 'your voice'} ${money(step.estimated, step.currency)}`).join(' + ')}
                              {chainEstimateValue!.cap.limit != null ? <> · cap {money(chainEstimateValue!.cap.spent ?? 0, chainEstimateValue!.currency)}/{money(chainEstimateValue!.cap.limit, chainEstimateValue!.currency)}</> : null}</>}
                    </p>
                    {chainCapExceeded ? (
                      <p className="voice-cap-error">
                        {/*
                          The remedies differ, so the copy must come from the server's own
                          discriminator rather than be inferred from which step tripped: a step
                          that breaches ON ITS OWN is not "they don't fit in sequence".
                        */}
                        {chainEstimateValue?.refusal === 'unknown-estimate'
                          ? 'This call cannot be priced, so the spend cap cannot admit it — '
                          : chainEstimateValue?.refusal === 'ledger-unreadable'
                            ? 'The provider ledger cannot be totalled, so the spend cap cannot admit this call — check logs/provider-requests.jsonl, or '
                            : chainEstimateValue?.refusal === 'provider-disabled'
                              ? 'A provider this generation needs is disabled — '
                              : chainEstimateValue?.refusal === 'provider-not-found'
                              ? 'A provider this generation needs is not configured — '
                              : chainEstimateValue?.refusalScope === 'sequence-only'
                                ? 'The two calls fit individually but not in sequence — the cap would refuse the second one after billing the first. '
                                : chainEstimateValue?.refusalScope === 'step-alone'
                                  ? 'This generation is on its own larger than what the spend cap has left — '
                                  : 'Workspace cap would be exceeded — '}
                        <button type="button" className="link-button" onClick={() => router.push('/settings?tab=keys')}>review it in Settings →</button>
                      </p>
                    ) : null}
                    {chainBusy ? (
                      <p className="voice-chain-steps" role="status" aria-live="polite">
                        <span className={`voice-chain-step ${chainStep('tts')}`}>{stepLabel(chainStep('tts'))} speech</span>
                        <span className={`voice-chain-step ${chainStep('sts')}`}>{stepLabel(chainStep('sts'))} your voice</span>
                        <span className={`voice-chain-step ${chainProgress?.seam ?? 'pending'}`}>{stepLabel(chainProgress?.seam ?? 'pending')} seam</span>
                      </p>
                    ) : null}
                    {chainError ? (
                      <p className="voice-cap-error" role="alert">
                        {chainError.message}
                        {(() => {
                          switch (cloneChainRemedy(chainError)) {
                            case 'prepare-voice':
                              return <> <button type="button" className="link-button" onClick={() => { void prepareVoice(); }}>Prepare your voice →</button></>;
                            case 'new-generation':
                              return <> Start a new generation.</>;
                            case 'cap':
                              // Nothing was created and nothing was billed: the generation was
                              // refused before its first paid call. Resubmitting unchanged is
                              // refused identically, so the only move is the cap itself.
                              return <> <button type="button" className="link-button" onClick={() => router.push('/settings?tab=keys')}>Raise or remove the spend cap →</button></>;
                            case 'operator':
                              // NOT "try again": a conflicting terminal already exists, so
                              // re-Confirm re-hits the same bad state. Nothing is re-billed
                              // (the id is retained), but a human has to look at the ledger.
                              return <> This project's voice-patch ledger needs attention — check <code>logs/provider-requests.jsonl</code> in the workspace before generating again.</>;
                            case 'retry-replays':
                              // The id is still live, so Confirm resumes THIS generation.
                              return <> Confirm again to resume this generation — it will not be charged twice.</>;
                            default:
                              return null;
                          }
                        })()}
                      </p>
                    ) : null}
                    <div className="voice-patch-actions">
                      {/* An operator-blocked failure is not retryable by the user: re-issuing
                          the same request just re-hits the conflicting ledger state. */}
                      <button type="button" className="primary" disabled={chainBusy || chainCapExceeded || chainBlocked || !chainPriced} onClick={() => { void confirmCloneChainGenerate(); }}>{chainBusy ? 'Generating…' : chainPriced ? 'Confirm generate' : chainEst?.status === 'ready' || chainEst?.status === 'error' ? "Can't price this" : 'Pricing…'}</button>
                      <button type="button" disabled={chainBusy} onClick={() => setReplacePickerOpen(false)}>Cancel</button>
                    </div>
                  </div>
                ) : null}

                {/* Replace-speech picker — legacy provider/voice path (unchanged) */}
                {replacePickerOpen && replacement.trim() && !cloneChainReady ? (
                  <div className="voice-patch-picker">
                    {/*
                      D3 prepare CTA. This branch only renders when the clone is NOT ready, so
                      the legacy provider/voice path below stays available (nothing regresses for
                      a project that never prepares a voice) while pointing at the better one.
                    */}
                    <p className="voice-prepare-cta">
                      {voice.state === 'preparing'
                        ? 'Your voice is still being prepared — generating in it will be available when it finishes.'
                        : voice.state === 'stale'
                          ? 'Your prepared voice is out of date (Studio Sound changed).'
                          : voice.state === 'unknown-outcome'
                            ? 'Your last voice preparation ended with an unknown outcome.'
                            : 'No voice prepared for this recording yet.'}
                      {voice.state === 'preparing'
                        ? null
                        : <> <button type="button" className="link-button" onClick={() => { void prepareVoice(); }}>{voice.state === 'none' ? 'Prepare your voice →' : 'Re-prepare your voice →'}</button></>}
                    </p>
                    <label>Provider
                      <select value={selectedProvider.id} onChange={(event) => { setSelectedProviderId(event.target.value); setSelectedVoice(''); setSelectedModel(''); }}>
                        {providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                      </select>
                    </label>
                    <label>Voice
                      <select value={selectedVoice} disabled={!voiceOptions.length} onChange={(event) => setSelectedVoice(event.target.value)}>
                        {voiceOptions.length ? voiceOptions.map((voice) => <option key={voice} value={voice}>{voice}</option>) : <option value="">No voices in library</option>}
                      </select>
                    </label>
                    {modelOptions.length ? (
                      <label>Model
                        <select value={effectiveModel} onChange={(event) => setSelectedModel(event.target.value)}>
                          {modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
                        </select>
                      </label>
                    ) : null}
                    <p className="voice-cost">
                      {legacyEst?.status === 'error'
                        ? <>Couldn't price this call. <button type="button" className="link-button" onClick={() => setEstimateNonce((n) => n + 1)}>Retry →</button></>
                        : legacyEstimateValue == null
                          ? <>Estimating… · {replacement.trim().length} chars</>
                          : !legacyPriced
                            ? <>Cost unavailable for this provider · {replacement.trim().length} chars</>
                            : legacyEstimateValue!.total == null
                            ? <>{legacyEstimateValue!.steps.map((step) => money(step.estimated, step.currency)).join(' + ')} · {replacement.trim().length} chars</>
                            : <>Estimated <strong>{money(legacyEstimateValue!.total, legacyEstimateValue!.currency)}</strong> · {replacement.trim().length} chars
                                {legacyEstimateValue!.cap.limit != null ? <> · cap {money(legacyEstimateValue!.cap.spent ?? 0, legacyEstimateValue!.currency)}/{money(legacyEstimateValue!.cap.limit, legacyEstimateValue!.currency)}</> : null}</>}
                    </p>
                    {capExceeded ? <p className="voice-cap-error">Workspace cap would be exceeded — <button type="button" className="link-button" onClick={() => router.push('/settings?tab=keys')}>raise it in Settings →</button></p> : null}
                    <div className="voice-patch-actions">
                      <button type="button" className="primary" disabled={!selectedVoice || capExceeded || !legacyPriced} onClick={() => { void confirmReplaceSpeech(); }}>{legacyPriced ? 'Confirm generate' : legacyEst?.status === 'ready' || legacyEst?.status === 'error' ? "Can't price this" : 'Pricing…'}</button>
                      <button type="button" onClick={() => setReplacePickerOpen(false)}>Cancel</button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      }
      {rippleBadge ? <div className="ripple-badge" role="status" aria-live="polite">ripple +{rippleBadge.deltaSec.toFixed(1)}s</div> : null}
    </section>
  );
}
