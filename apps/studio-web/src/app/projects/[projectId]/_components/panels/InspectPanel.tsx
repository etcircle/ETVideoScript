"use client";
import { useEditorStore } from '../../../../../store/editorStore';
import { decidePanelState, designOps, operationTimelineRange, wordTimelineRange } from '../../../../../store/selectors';
import { PanelState } from '../state/PanelState';

/** Format seconds to a compact timecode string, e.g. 0:01:23.4 */
function formatTC(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${s}`;
  return `${m}:${s}`;
}

const OP_GLYPH: Record<string, string> = {
  cut: '−', mute: '⊘', voice_patch: '↺', speed: '»', overlay: '◇', transition: '⤫',
};

export function InspectPanel() {
  const state = useEditorStore();
  const { selection, currentTime, manifest, transcript } = state;
  const panelState = decidePanelState({
    loading: state.loading,
    panel: 'inspect',
    project: state.project,
    diagnostics: state.diagnostics,
    transcript: state.transcript,
    jobs: state.jobs,
    providerRequests: state.providerRequests,
  });
  if (panelState !== 'ready') return <PanelState state={panelState} />;

  const words = transcript?.words ?? [];
  const segments = transcript?.segments ?? [];

  // Word and segment under playhead — compare on the TIMELINE axis so clip-local
  // word times in later clips resolve correctly (hermes P2). The segment under the
  // playhead is the matched word's own segment (clip-robust); fall back to a
  // time-based scan only when no word is under the playhead.
  const playWord = words.find((w) => {
    const r = wordTimelineRange(manifest, w);
    return currentTime >= r.start && currentTime < r.end;
  }) ?? null;
  const playSeg = (playWord
    ? segments.find((s) => (s as { id?: string }).id === playWord.segmentId)
    : segments.find((s) => {
        const start = (s as { start?: number }).start ?? 0;
        const end = (s as { end?: number }).end ?? 0;
        return currentTime >= start && currentTime < end;
      })) ?? null;

  // Ops covering the current playhead time
  const allOps = designOps(manifest, transcript);
  const inRange = allOps.filter((op) => currentTime >= op.start && currentTime <= op.end);

  return (
    <div className="view-inspect">
      {/* ── Selection ──────────────────────────────────────────── */}
      <section className="view-section">
        <header className="view-section-head">
          <h4>Selection</h4>
        </header>
        {selection ? (
          <div className="kv-card">
            <div className="kv-row">
              <span className="k">range</span>
              <span className="v mono">{formatTC(selection.start)}–{formatTC(selection.end)}</span>
            </div>
            <div className="kv-row">
              <span className="k">duration</span>
              <span className="v mono">{(selection.end - selection.start).toFixed(2)}s</span>
            </div>
            {(selection.text) && (
              <div className="kv-row block">
                <span className="k">text</span>
                <span className="v serif">&ldquo;{selection.text}&rdquo;</span>
              </div>
            )}
          </div>
        ) : (
          <div className="muted-block">Drag across words in the transcript to inspect a range.</div>
        )}
      </section>

      {/* ── Playhead ───────────────────────────────────────────── */}
      <section className="view-section">
        <header className="view-section-head">
          <h4>Playhead</h4>
        </header>
        <div className="kv-card">
          <div className="kv-row">
            <span className="k">time</span>
            <span className="v mono">{formatTC(currentTime)}</span>
          </div>
          {playSeg && (
            <div className="kv-row">
              <span className="k">segment</span>
              <span className="v">
                {(playSeg as { label?: string; id?: string; segmentId?: string }).label
                  ?? (playSeg as { id?: string; segmentId?: string }).segmentId
                  ?? (playSeg as { id?: string }).id
                  ?? '—'}
              </span>
            </div>
          )}
          {playWord && (
            <div className="kv-row">
              <span className="k">word</span>
              <span className="v serif">&ldquo;{playWord.text}&rdquo;</span>
            </div>
          )}
          {playWord && playWord.confidence != null && (
            <div className="kv-row">
              <span className="k">confidence</span>
              <span className="v mono">{(playWord.confidence * 100).toFixed(0)}%</span>
            </div>
          )}
        </div>
      </section>

      {/* ── Edits in range ─────────────────────────────────────── */}
      <section className="view-section">
        <header className="view-section-head">
          <h4>Edits in range</h4>
        </header>
        <div className="muted-block">
          {allOps.length} total &middot; {allOps.filter((o) => o.status === 'approved').length} applied
        </div>
        {inRange.length > 0 && (
          <div className="kv-card" style={{ marginTop: 8 }}>
            {inRange.map((op) => (
              <div className="kv-row" key={op.id}>
                <span className={`k ch-type ${op.type}`}>
                  {OP_GLYPH[op.type] ?? '•'} {op.type.replace('_', ' ')}
                </span>
                <span className="v mono">{formatTC(op.start)}–{formatTC(op.end)}</span>
              </div>
            ))}
          </div>
        )}
        {inRange.length === 0 && allOps.length > 0 && (
          <div className="muted-block" style={{ marginTop: 4 }}>No operations under the playhead.</div>
        )}
      </section>
    </div>
  );
}
