"use client";
import type { ManifestV3 } from '@etvideoscript/core/browser';
import { useEditorStore } from '../../../../../store/editorStore';
import {
  approvedOperations,
  decidePanelState,
  designOps,
  proposedOperations,
} from '../../../../../store/selectors';
import { PanelState } from '../state/PanelState';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function isRejectedUnsynthesizedVoicePatch(
  op: ManifestV3['operations'][number]
): boolean {
  return op.type === 'voice_patch' && op.status === 'rejected' && !op.assetId;
}

// Timecode formatter  m:ss.d
function formatTC(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

// Glyph for the .ch-type badge
const TYPE_GLYPH: Record<string, string> = {
  cut: '−', mute: '⊘', voice_patch: '↺', speed: '»', overlay: '◇', transition: '⤫',
};

// ─── Component ───────────────────────────────────────────────────────────────

export function ManifestPanel() {
  const state    = useEditorStore();
  const manifest = state.manifest;

  const panelState = decidePanelState({
    loading: state.loading,
    panel: 'manifest',
    project: state.project,
    diagnostics: state.diagnostics,
    transcript: state.transcript,
    jobs: state.jobs,
    providerRequests: state.providerRequests,
    empty: !manifest?.operations.length,
  });

  if (panelState !== 'ready' && panelState !== 'provider-failed') {
    return (
      <PanelState
        state={panelState}
        title={panelState === 'empty' ? 'No changes yet' : undefined}
        hint={
          panelState === 'empty'
            ? 'Edits land here as you approve them — each one stays referenceable and revertible.'
            : undefined
        }
      />
    );
  }

  if (!manifest?.operations.length) {
    return (
      <PanelState
        state="empty"
        title="No changes yet"
        hint="Edits land here as you approve them — each one stays referenceable and revertible."
      />
    );
  }

  // Get flat design-shaped ops for display; keep real ops for count/status queries
  const flat         = designOps(manifest, state.transcript);
  const allApplied   = approvedOperations(manifest);
  const allProposed  = proposedOperations(manifest);

  // applied list in reverse chronological order (most-recent first)
  const applied = flat.filter((o) => o.status === 'approved').slice().reverse();
  const byYou   = allApplied.filter((o) => o.proposedBy === 'user').length;
  const byAgent = allApplied.length - byYou;

  // Navigation: jump to op's start time + switch to audit mode
  function jumpTo(start: number) {
    state.seek(start);
    state.setTranscriptMode('edited');
    state.setPanel('manifest');
  }

  // Revert: sets status to 'disabled' — reversible, never deletes
  function revertOp(id: string) {
    void state.disableOperation(id, 'Reverted from Changes panel');
  }

  // Navigate to suggestions panel when there are proposals
  function openSuggestions() {
    state.setPanel('suggestions');
  }

  return (
    <div className="view-changes">
      {/* Summary strip */}
      <div className="ch-summary">
        <span className="ch-count">{applied.length}</span>
        <span className="ch-summary-text">
          change{applied.length === 1 ? '' : 's'} applied
          <span className="ch-summary-meta">
            {byYou} by you · {byAgent} by agent
            {manifest.manifestVersion != null ? ` · manifest v${manifest.manifestVersion}` : ''}
          </span>
        </span>
      </div>

      {/* Change list */}
      <div className="ch-list">
        {applied.length === 0 ? (
          <p className="muted-block">No applied edits yet.</p>
        ) : (
          applied.map((op) => (
            <div className={`ch-item ${op.type}`} key={op.id}>
              <div className="ch-item-head">
                <span className={`ch-type ${op.type}`}>
                  <span className="g">{TYPE_GLYPH[op.type] ?? '•'}</span>
                  {op.type.replace('_', ' ')}
                </span>
                <span className={`ch-src ${op.source}`}>
                  <span className="ch-src-dot" />
                  by {op.source === 'you' ? 'you' : op.proposedBy}
                </span>
                <span className="ch-time">
                  {formatTC(op.start)}–{formatTC(op.end)}
                </span>
              </div>

              {/* Reason / label */}
              <div className="ch-reason">{op.reason || op.text || '—'}</div>

              {/* voice_patch quote: original → replacement */}
              {op.type === 'voice_patch' && op.originalText && (
                <div className="ch-quote">
                  <span className="strike">{op.originalText}</span>
                  {' → '}
                  <span className="ins">"{op.text}"</span>
                </div>
              )}

              {/* Per-item actions */}
              <div className="ch-actions">
                <button
                  type="button"
                  className="ch-btn"
                  onClick={() => jumpTo(op.start)}
                  title="Seek to this change and show in Audit trail"
                >
                  Jump to change
                </button>
                <button
                  type="button"
                  className="ch-btn danger"
                  onClick={() => revertOp(op.id)}
                  title="Disable this op — source is preserved, re-enable from manifest"
                >
                  Revert
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Pending note linking to Suggestions when proposals exist */}
      {allProposed.length > 0 && (
        <button
          type="button"
          className="ch-pending-note"
          onClick={openSuggestions}
        >
          <span className="ch-pending-dot" />
          {allProposed.length} pending suggestion{allProposed.length === 1 ? '' : 's'}
          {' — review in '}
          <em>Suggest</em>
        </button>
      )}
    </div>
  );
}
