"use client";
import { useState, useMemo } from 'react';
import type { OutputV3 } from '@etvideoscript/core/browser';
import { useEditorStore } from '../../../../../store/editorStore';
import { decidePanelState } from '../../../../../store/selectors';
import {
  deriveProposedClips, deriveHighlights,
  ASPECT_RATIOS,
  type DerivedProposedClip, type DerivedHighlight,
} from '../../../../../store/designData';
import { PanelState } from '../state/PanelState';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTC(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

// ── MiniAspect SVG glyph (shared with RenderDialog) ──────────────────────────

export function MiniAspect({ id, size = 18 }: { id: string; size?: number }) {
  const map: Record<string, { w: number; h: number }> = {
    '16:9': { w: 16, h: 9 },
    '9:16': { w: 9,  h: 16 },
    '1:1':  { w: 12, h: 12 },
    '4:5':  { w: 10, h: 13 },
  };
  const dims = map[id] ?? map['16:9']!;
  const sc = size / 18;
  const W = dims.w * sc;
  const H = dims.h * sc;
  const cx = size / 2 - W / 2;
  const cy = size / 2 - H / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x={cx} y={cy} width={W} height={H} rx="1.2" />
    </svg>
  );
}

// ── Proposed-clip thumbnail (design's paper-style mini scene) ─────────────────

function ClipThumbContent({ clip }: { clip: DerivedProposedClip }) {
  const t = clip.tags[0] ?? 'clip';
  return (
    <svg viewBox="0 0 80 100" preserveAspectRatio="xMidYMid slice">
      <rect width="80" height="100" fill="var(--ink-2)" />
      <rect x="6" y="6" width="68" height="56" fill="var(--paper-3)" opacity="0.8" />
      <circle cx="40" cy="30" r="9" fill="var(--ink-3)" />
      <path d="M22 56 q0 -14 18 -14 q18 0 18 14" fill="var(--ink-3)" />
      <rect x="6" y="70" width="68" height="22" fill="var(--accent)" opacity="0.92" />
      <text x="40" y="84" textAnchor="middle" fontFamily="Geist" fontWeight="700" fontSize="7" fill="var(--ink)" letterSpacing="0.05em">
        {t.toUpperCase()}
      </text>
    </svg>
  );
}

// ── Real-output thumbnail (the existing design for manifest outputs) ──────────

function OutputThumb({ aspect }: { aspect: string }) {
  const cls = `clip-thumb aspect-${aspect.replace(':', 'x')}`;
  return (
    <div className={cls}>
      <svg viewBox="0 0 76 120" fill="none" aria-hidden="true">
        <rect width="76" height="120" fill="var(--paper-3)" />
        <path d="M12 78c12-19 26-19 40 0" stroke="var(--line-strong)" strokeWidth="2" />
        <circle cx="31" cy="44" r="13" fill="var(--accent-bg)" stroke="var(--accent)" strokeWidth="1.5" />
        <path d="M49 37h12v22H49z" fill="var(--paper)" stroke="var(--line-strong)" />
      </svg>
      <span className="clip-thumb-meta">{aspect}</span>
    </div>
  );
}

// ── Real OutputV3 card (re-skinned to .clip-card aesthetic) ───────────────────

function OutputCard({
  output,
  onToggleStatus,
  onRemove,
}: {
  output: OutputV3;
  onToggleStatus: () => void;
  onRemove: () => void;
}) {
  const aspect = output.aspects[0] ?? '9:16';
  const range = output.rangeSec
    ? `${output.rangeSec.start.toFixed(1)}–${output.rangeSec.end.toFixed(1)}s`
    : 'full range';
  const isDisabled = output.status === 'disabled';

  return (
    <article className={`clip-card${isDisabled ? '' : ' selected'}`}>
      <label className="clip-check" aria-label={`Toggle ${output.title ?? output.outputId}`}>
        <input
          type="checkbox"
          readOnly
          checked={!isDisabled}
          onChange={onToggleStatus}
        />
        <span className="clip-checkbox" aria-hidden="true" />
      </label>

      <OutputThumb aspect={aspect} />

      <div className="clip-body">
        <div className="clip-head">
          <span className="clip-title">{output.title ?? output.outputId}</span>
          <span className="clip-score">{output.status}</span>
        </div>
        <p className="clip-hook">
          {output.kind === 'clip'
            ? 'Candidate short-form cut from the transcript timeline.'
            : 'Manifest-defined export from preserved source media.'}
        </p>
        <div className="clip-meta">
          <span>{output.kind}</span>
          <span className="clip-sep">·</span>
          <span>{range}</span>
          <span className="clip-sep">·</span>
          <span className="clip-tags">
            {output.aspects.map((a) => (
              <span className="clip-tag" key={a}>{a}</span>
            ))}
          </span>
        </div>
        <div className="clip-actions">
          <button className="clip-btn" onClick={onToggleStatus}>
            {isDisabled ? 'enable' : 'disable'}
          </button>
          <button className="clip-btn" onClick={onRemove}>remove</button>
        </div>
      </div>
    </article>
  );
}

// ── Main ClipsPanel ───────────────────────────────────────────────────────────

export function ClipsPanel() {
  const editorState = useEditorStore();
  const transcript = editorState.transcript;
  const outputs = editorState.manifest?.outputs ?? [];
  const panelState = decidePanelState({
    loading: editorState.loading,
    panel: 'clips',
    project: editorState.project,
    diagnostics: editorState.diagnostics,
    transcript,
    empty: false,
  });

  // Derived presentation-layer data from the real transcript
  const segments = useMemo(() => transcript?.segments ?? [], [transcript]);
  const proposedClips = useMemo(() => deriveProposedClips(segments), [segments]);
  const highlights = useMemo(() => deriveHighlights(segments), [segments]);

  // Selection state for the "render N clips" CTA
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(proposedClips.slice(0, 2).map((c) => c.id))
  );

  // Track which skill simulation is running (find-clips or find-highlights)
  const [runningSkill, setRunningSkill] = useState<'find-clips' | 'find-highlights' | null>(null);

  function toggleClip(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function selectAll() { setSelected(new Set(proposedClips.map((c) => c.id))); }
  function clearAll() { setSelected(new Set()); }

  // find-clips: uses the real proposeOutputs action and also re-derives locally
  async function handleFindClips() {
    setRunningSkill('find-clips');
    try {
      await editorState.proposeOutputs();
    } finally {
      setRunningSkill(null);
    }
  }

  // find-highlights: presentation-layer only (no backend endpoint yet)
  function handleFindHighlights() {
    setRunningSkill('find-highlights');
    setTimeout(() => setRunningSkill(null), 900);
  }

  // Seek action — moves the playhead via the real store `seek` action.
  function handleSeekToClip(clip: DerivedProposedClip) {
    editorState.seek(clip.start);
  }

  function handleSeekToHighlight(h: DerivedHighlight) {
    editorState.seek(h.t);
  }

  // A proposed clip's render action: open the RenderDialog pre-seeded with
  // this clip added to the manifest as a pending output, then open the dialog.
  async function handleRenderClip(clip: DerivedProposedClip) {
    // Add the derived clip as a real OutputV3 candidate so the dialog sees it
    await editorState.addOutput({
      outputId: `out_clip_${clip.id}_${Date.now()}`,
      kind: 'clip',
      rangeSec: { start: clip.start, end: clip.end },
      aspects: [clip.aspect],
      title: clip.title,
      status: 'manual',
    } as OutputV3);
    // Open the render dialog so the user can confirm and trigger the real render
    editorState.setRenderDialogOpen(true);
  }

  // CTA: open dialog with currently-selected proposed clips queued as outputs
  async function handleRenderSelected() {
    for (const clipId of selected) {
      const clip = proposedClips.find((c) => c.id === clipId);
      if (!clip) continue;
      await editorState.addOutput({
        outputId: `out_clip_${clip.id}_${Date.now()}`,
        kind: 'clip',
        rangeSec: { start: clip.start, end: clip.end },
        aspects: [clip.aspect],
        title: clip.title,
        status: 'manual',
      } as OutputV3);
    }
    editorState.setRenderDialogOpen(true);
  }

  if (panelState !== 'ready') return <PanelState state={panelState} />;

  const runningClips = runningSkill === 'find-clips';
  const runningHl = runningSkill === 'find-highlights';
  const activeOutputCount = outputs.filter((o) => o.status !== 'disabled').length;

  return (
    <div className="view-clips">
      {/* ── Discover section ── */}
      <section className="view-section">
        <header className="view-section-head">
          <h4>Discover</h4>
          <span className="muted">AI · heuristic</span>
        </header>
        <div className="clips-discover">
          <button
            className={`skill-chip${runningClips ? ' running' : ''}`}
            onClick={handleFindClips}
            disabled={Boolean(runningSkill)}
          >
            {runningClips
              ? <span className="spin" aria-hidden="true" />
              : <span aria-hidden="true">›</span>}
            find-clips
          </button>
          <button
            className={`skill-chip${runningHl ? ' running' : ''}`}
            onClick={handleFindHighlights}
            disabled={Boolean(runningSkill)}
          >
            {runningHl
              ? <span className="spin" aria-hidden="true" />
              : <span aria-hidden="true">›</span>}
            find-highlights
          </button>
          <span className="discover-hint">
            re-scan the transcript for hooks &amp; quotable moments
          </span>
        </div>
      </section>

      {/* ── Proposed clips section (derived, presentation-layer) ── */}
      <section className="view-section">
        <header className="view-section-head">
          <h4>Proposed clips <span className="muted">· {proposedClips.length}</span></h4>
          <div className="clips-selectbar">
            <button className="clips-link" onClick={selectAll}>all</button>
            <span className="muted">·</span>
            <button className="clips-link" onClick={clearAll}>none</button>
          </div>
        </header>

        {proposedClips.length === 0 ? (
          <div className="muted-block">
            No clips yet. Run <em>find-clips</em> above to scan the transcript.
          </div>
        ) : (
          <div className="clips-list">
            {proposedClips.map((clip) => {
              const dur = (clip.end - clip.start).toFixed(1);
              const isSelected = selected.has(clip.id);
              return (
                <article
                  key={clip.id}
                  className={`clip-card aspect-${clip.aspect.replace(':', 'x')}${isSelected ? ' selected' : ''}`}
                >
                  <label className="clip-check">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleClip(clip.id)}
                      aria-label={`Include ${clip.title} in render`}
                    />
                    <span className="clip-checkbox" aria-hidden="true" />
                  </label>

                  <div
                    className={`clip-thumb aspect-${clip.aspect.replace(':', 'x')}`}
                    onClick={() => handleSeekToClip(clip)}
                    title="Seek to clip start"
                    style={{ cursor: 'pointer' }}
                  >
                    <ClipThumbContent clip={clip} />
                    <span className="clip-thumb-meta">
                      <MiniAspect id={clip.aspect} size={11} /> {clip.aspect}
                    </span>
                  </div>

                  <div className="clip-body">
                    <div className="clip-head">
                      <span
                        className="clip-title"
                        onClick={() => handleSeekToClip(clip)}
                        style={{ cursor: 'pointer' }}
                      >
                        {clip.title}
                      </span>
                      <span className="clip-score" title={`Confidence ${Math.round(clip.score * 100)}%`}>
                        {Math.round(clip.score * 100)}%
                      </span>
                    </div>
                    <p className="clip-hook">"{clip.hookText}"</p>
                    <div className="clip-meta">
                      <span className="clip-time">{formatTC(clip.start)}–{formatTC(clip.end)}</span>
                      <span className="clip-sep">·</span>
                      <span>{dur}s</span>
                      <span className="clip-sep">·</span>
                      <span className="clip-tags">
                        {clip.tags.map((tag) => (
                          <span key={tag} className="clip-tag">{tag}</span>
                        ))}
                      </span>
                    </div>
                    <div className="clip-actions">
                      <button className="clip-btn" onClick={() => handleSeekToClip(clip)}>preview</button>
                      <button className="clip-btn primary" onClick={() => handleRenderClip(clip)}>
                        render {clip.aspect} ↵
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Highlights section (derived, presentation-layer) ── */}
      <section className="view-section">
        <header className="view-section-head">
          <h4>Highlights <span className="muted">· {highlights.length}</span></h4>
        </header>
        {highlights.length === 0 ? (
          <div className="muted-block">
            Highlights appear here once <em>find-highlights</em> has run.
          </div>
        ) : (
          <div className="hl-list">
            {highlights.map((h) => (
              <div
                key={h.id}
                className="hl-row"
                onClick={() => handleSeekToHighlight(h)}
                title="Seek to highlight"
                style={{ cursor: 'pointer' }}
              >
                <span className="hl-star" aria-hidden="true">
                  <svg width="11" height="11" viewBox="0 0 10 10" fill="currentColor">
                    <path d="M5 .5l1.4 3 3.1.4-2.3 2.2.6 3.1L5 7.7 2.2 9.2l.6-3.1L.5 3.9l3.1-.4z" />
                  </svg>
                </span>
                <span className="hl-label">{h.label}</span>
                <span className="hl-reason">{h.reason}</span>
                <span className="hl-time">{formatTC(h.t)}</span>
                <span className="hl-score">{Math.round(h.score * 100)}%</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Real Outputs / exports section (bound to manifest OutputV3) ── */}
      <section className="view-section">
        <header className="view-section-head">
          <h4>Outputs / exports <span className="muted">· {outputs.length}</span></h4>
        </header>
        {outputs.length === 0 ? (
          <PanelState
            state="empty"
            title="No output definitions"
            hint="Use Render… or find-clips to add exports."
          />
        ) : (
          <div className="clips-list">
            {outputs.map((output) => (
              <OutputCard
                key={output.outputId}
                output={output}
                onToggleStatus={() =>
                  editorState.patchOutput(output.outputId, {
                    status: output.status === 'disabled' ? 'manual' : 'disabled',
                  })
                }
                onRemove={() => editorState.removeOutput(output.outputId)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Sticky CTA ── */}
      <div className="clips-cta">
        <div className="cta-left">
          <span className="cta-count">{selected.size}</span>
          <span className="cta-text">
            clip{selected.size === 1 ? '' : 's'} selected
          </span>
          {activeOutputCount > 0 && (
            <>
              <span className="cta-text" style={{ color: 'var(--line-strong)' }}>·</span>
              <span className="cta-text">{activeOutputCount} active</span>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {activeOutputCount > 0 && (
            <button
              className="cta-btn"
              onClick={() => editorState.setRenderDialogOpen(true)}
              title="Open render dialog"
              style={{ opacity: 0.7 }}
            >
              render / configure ↵
            </button>
          )}
          <button
            className="cta-btn"
            onClick={handleRenderSelected}
            disabled={selected.size === 0}
            title="Queue selected clips and open render dialog"
          >
            render {selected.size > 0 ? selected.size : ''}{' '}
            {selected.size === 1 ? 'clip' : 'clips'} ↵
          </button>
        </div>
      </div>
    </div>
  );
}
