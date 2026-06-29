"use client";
import { useEffect, useMemo, useState } from 'react';
import { useEditorStore } from '../../../../../store/editorStore';
import { clipSpanTargetsForWords } from '../../../../../store/editTargets';
import { decidePanelState, designOps, proposedOperations } from '../../../../../store/selectors';
import { getWorkspaceSettings, type WorkspaceSettings } from '../../../../../lib/api';
import { PanelState } from '../state/PanelState';
import { ApprovalButton, isApprovable } from './OperationApproval';

function normalizeFiller(text: string) {
  return text.replace(/[.,!?;:]+$/, '').toLowerCase();
}

const DEFAULT_FILLER_WORDS = [
  'um', 'uh', 'like', 'you know', 'basically', 'literally', 'right', 'so',
  'okay', 'actually', 'honestly', 'seriously', 'kind of', 'sort of',
];

function formatTC(sec: number) {
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

export function SuggestionsPanel() {
  const state = useEditorStore();
  const manifest   = state.manifest;
  const transcript = state.transcript;
  const ops    = proposedOperations(manifest);
  const words  = transcript?.words ?? [];
  const flatOps = designOps(manifest, transcript);
  const proposedDesignOps = flatOps.filter((o) => o.status === 'proposed');

  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings | null>(null);
  const [deletingFillers, setDeletingFillers] = useState(false);

  useEffect(() => {
    if (!state.projectId) return;
    let cancelled = false;
    getWorkspaceSettings(state.projectId)
      .catch(() => null)
      .then((r) => { if (!cancelled) setWorkspaceSettings(r?.settings ?? null); });
    return () => { cancelled = true; };
  }, [state.projectId]);

  const fillerEntries = useMemo(() => {
    const raw = workspaceSettings?.taskOptions?.fillerWords ?? DEFAULT_FILLER_WORDS;
    return raw
      .map((entry) => {
        const parts = entry.trim().split(/\s+/).map(normalizeFiller).filter(Boolean);
        return { raw: entry, parts };
      })
      .filter((entry) => entry.parts.length > 0)
      .sort((a, b) => b.parts.length - a.parts.length);
  }, [workspaceSettings]);

  const cutCoverage = useMemo(() => {
    const ranges = (manifest?.operations ?? [])
      .filter((op) =>
        op.type === 'cut' &&
        (op.status === 'approved' || op.status === 'proposed' || op.status === 'awaiting_approval') &&
        op.target.kind === 'clip-span'
      )
      .map((op) => ({
        clipId: (op.target as { clipId: string }).clipId,
        start: (op.target as { start: number }).start,
        end: (op.target as { end: number }).end,
      }));
    return (word: (typeof words)[number]) =>
      Boolean(word.clipId) &&
      ranges.some(
        (r) =>
          r.clipId === word.clipId &&
          word.start >= r.start - 1e-6 &&
          word.end <= r.end + 1e-6
      );
  }, [manifest]);

  const fillerMatches = useMemo(() => {
    const matches: Array<typeof words> = [];
    const used = new Set<number>();
    for (let i = 0; i < words.length; i++) {
      if (used.has(i)) continue;
      for (const entry of fillerEntries) {
        if (i + entry.parts.length > words.length) continue;
        let ok = true;
        for (let k = 0; k < entry.parts.length; k++) {
          if (normalizeFiller(words[i + k]!.text) !== entry.parts[k]) { ok = false; break; }
        }
        if (!ok) continue;
        const window = words.slice(i, i + entry.parts.length);
        if (entry.parts.length > 1) {
          const firstClipId = window[0]!.clipId;
          const allSameClip = window.every((w) => w.clipId === firstClipId);
          if (!allSameClip) continue;
        }
        if (window.some((w) => cutCoverage(w))) {
          for (let k = 0; k < window.length; k++) used.add(i + k);
          break;
        }
        matches.push(window);
        for (let k = 0; k < entry.parts.length; k++) used.add(i + k);
        break;
      }
    }
    return matches;
  }, [words, fillerEntries, cutCoverage]);

  async function deleteAllFillers() {
    if (!fillerMatches.length) return;
    setDeletingFillers(true);
    try {
      for (const window of fillerMatches) {
        const targets = clipSpanTargetsForWords(manifest, window);
        for (const target of targets)
          await state.createOperation({ type: 'cut', target, reason: 'Bulk delete fillers' });
      }
    } finally {
      setDeletingFillers(false);
    }
  }

  const panelState = decidePanelState({
    loading: state.loading,
    panel: 'suggestions',
    project: state.project,
    diagnostics: state.diagnostics,
    transcript: state.transcript,
    providerRequests: state.providerRequests,
    empty: ops.length === 0 && fillerMatches.length === 0,
  });

  if (panelState !== 'ready' && panelState !== 'provider-failed') {
    return <PanelState state={panelState} />;
  }

  // The TYPE glyph map matches the design's ManifestView
  const TYPE_GLYPH: Record<string, string> = {
    cut: '−', mute: '⊘', voice_patch: '↺', speed: '»', overlay: '◇', transition: '⤫',
  };

  return (
    <section className="suggestions-section">
      {/* Filler detection tile */}
      {fillerMatches.length > 0 && (
        <div className="suggestion-tile">
          <div className="suggestion-tile-head">
            <h4>Filler words</h4>
            <span className="muted">{fillerMatches.length} detected</span>
          </div>
          <p className="muted suggestion-tile-body">
            Bulk-cut detected fillers like "um", "uh", "you know", "kind of". Each is a
            reversible cut you can undo from the transcript.
          </p>
          <button
            type="button"
            className="primary"
            disabled={deletingFillers}
            onClick={() => { void deleteAllFillers(); }}
          >
            {deletingFillers
              ? 'Deleting…'
              : `Delete ${fillerMatches.length} filler${fillerMatches.length === 1 ? '' : 's'}`}
          </button>
        </div>
      )}

      <header className="view-section-head">
        <h4>Proposed operations</h4>
        <span className="muted">{proposedDesignOps.length} pending</span>
      </header>

      {proposedDesignOps.length === 0 ? (
        <div className="view-empty">
          <p className="empty-head">No pending proposals</p>
          <p className="empty-sub">
            Run a skill from the <em>Agent</em> panel, or select text in the transcript to
            ask the agent for a cut.
          </p>
        </div>
      ) : (
        <div className="proposals">
          {proposedDesignOps.map((dop) => {
            // Find the underlying real operation for approve/reject
            const realOp = ops.find((o) => o.id === dop.id);
            return (
              <div className="prop" key={dop.id}>
                <div className="prop-head">
                  <div className="left">
                    <span className={`type ${dop.type}`}>
                      <span className="g">{TYPE_GLYPH[dop.type] ?? '•'}</span>
                      {dop.type.replace('_', ' ')}
                    </span>
                    <span className="time">
                      {formatTC(dop.start)}–{formatTC(dop.end)}
                    </span>
                  </div>
                  {dop.confidence != null && (
                    <span className="conf">conf {Math.round(dop.confidence * 100)}%</span>
                  )}
                </div>

                <div className="reason">{dop.reason ?? '—'}</div>

                {dop.type === 'voice_patch' && (
                  <div className="quote">
                    <span className="strike">{dop.originalText ?? 'original audio'}</span>
                    {' → '}
                    <span className="ins">"{dop.text}"</span>
                  </div>
                )}

                {dop.type === 'speed' && dop.factor != null && (
                  <div className="quote speed-quote">
                    <span className="speed-quote-factor">{dop.factor}×</span>
                    <span className="speed-quote-arrow">»</span>
                    {dop.audioBed && (
                      <span className="speed-quote-bed">{dop.audioBed} bed</span>
                    )}
                    <span className="speed-quote-dur">
                      {(dop.end - dop.start).toFixed(1)}s
                      {' → '}
                      {((dop.end - dop.start) / dop.factor).toFixed(1)}s
                    </span>
                  </div>
                )}

                {dop.proposedBy && (
                  <div className="prop-from">from {dop.proposedBy}</div>
                )}

                <div className="actions op-actions">
                  <button
                    type="button"
                    onClick={() => { void state.rejectOperation(dop.id); }}
                  >
                    Reject
                  </button>
                  {realOp && isApprovable(realOp) && (
                    <ApprovalButton
                      op={realOp}
                      onApprove={() => state.approveOperation(dop.id)}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
