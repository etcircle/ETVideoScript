"use client";
import { useMemo, useState } from 'react';
import type { OutputV3 } from '@etvideoscript/core/browser';
import { useEditorStore } from '../../../../store/editorStore';
import { ASPECT_RATIOS } from '../../../../store/designData';
import { MiniAspect } from './panels/ClipsPanel';

export function RenderDialog() {
  const state = useEditorStore();
  const [mode, setMode] = useState<'full' | 'clips'>('full');
  const [selectedAspects, setSelectedAspects] = useState<string[]>([state.aspect]);

  // Real manifest clips — flattened from all tracks
  const manifestClips = useMemo(
    () =>
      (state.manifest?.tracks ?? []).flatMap((track) =>
        track.clips.map((clip) => ({ ...clip, trackName: track.name }))
      ),
    [state.manifest]
  );

  const [clipIds, setClipIds] = useState<string[]>(
    () => manifestClips.slice(0, 2).map((c) => c.clipId)
  );

  // Real manifest outputs (the defined exports)
  const manifestOutputs: OutputV3[] = state.manifest?.outputs ?? [];

  if (!state.renderDialogOpen) return null;

  const outputCount =
    mode === 'full' ? selectedAspects.length : selectedAspects.length * clipIds.length;

  function toggleAspect(id: string) {
    setSelectedAspects((cur) =>
      cur.includes(id) ? cur.filter((a) => a !== id) : [...cur, id]
    );
  }

  function toggleClip(clipId: string) {
    setClipIds((cur) =>
      cur.includes(clipId) ? cur.filter((id) => id !== clipId) : [...cur, clipId]
    );
  }

  function close() {
    state.setRenderDialogOpen(false);
  }

  async function handleRender() {
    if (!selectedAspects.length) return;
    if (mode === 'full') {
      // Real render-draft: triggers the server job via the existing action
      await state.triggerRenderDraft();
    } else {
      // Save clip output definitions to the manifest, then trigger render
      for (const clipId of clipIds) {
        const clip = manifestClips.find((c) => c.clipId === clipId);
        if (!clip) continue;
        await state.addOutput({
          outputId: `out_clip_${clipId}_${Date.now()}`,
          kind: 'clip',
          rangeSec: {
            start: clip.timelineStart,
            end: clip.timelineStart + (clip.sourceEnd - clip.sourceStart),
          },
          aspects: selectedAspects,
          title: clipId,
          status: 'manual',
        } as OutputV3);
      }
    }
    close();
  }

  const isRendering = state.jobs?.some?.(
    (j) => j.type === 'render-draft' && j.status === 'running'
  ) ?? false;

  const summaryRight =
    mode === 'clips'
      ? `${clipIds.length} clip${clipIds.length === 1 ? '' : 's'} × ${selectedAspects.length} aspect${selectedAspects.length === 1 ? '' : 's'}`
      : `1 timeline × ${selectedAspects.length} aspect${selectedAspects.length === 1 ? '' : 's'}`;

  return (
    <div
      className="rd-overlay"
      role="dialog"
      aria-modal="true"
      onClick={close}
    >
      <div className="rd-sheet" onClick={(e) => e.stopPropagation()}>

        {/* ── Header ── */}
        <header className="rd-head">
          <div className="rd-titles">
            <div className="rd-kicker">RENDER · MULTI-OUTPUT</div>
            <h3>Render <em>draft</em></h3>
          </div>
          <button className="rd-close" onClick={close} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        {/* ── What ── */}
        <section className="rd-section">
          <header className="rd-section-head">
            <h4>What</h4>
          </header>
          <div className="rd-mode">
            <button
              className={`rd-mode-btn${mode === 'full' ? ' active' : ''}`}
              onClick={() => setMode('full')}
            >
              <span className="rd-mode-label">Full timeline</span>
              <span className="rd-mode-sub">The whole manifest · one render per aspect</span>
            </button>
            <button
              className={`rd-mode-btn${mode === 'clips' ? ' active' : ''}`}
              onClick={() => setMode('clips')}
              disabled={manifestClips.length === 0 && manifestOutputs.length === 0}
            >
              <span className="rd-mode-label">
                Selected clips{' '}
                <span className="rd-mode-count">
                  · {manifestClips.length}
                </span>
              </span>
              <span className="rd-mode-sub">Render social clips · one per aspect per clip</span>
            </button>
          </div>
        </section>

        {/* ── Aspect ratios ── */}
        <section className="rd-section">
          <header className="rd-section-head">
            <h4>
              Aspect ratios{' '}
              <span className="muted">{selectedAspects.length} selected</span>
            </h4>
          </header>
          <div className="rd-aspects">
            {ASPECT_RATIOS.map((ar) => {
              const on = selectedAspects.includes(ar.id);
              return (
                <button
                  key={ar.id}
                  className={`rd-aspect${on ? ' on' : ''}`}
                  onClick={() => toggleAspect(ar.id)}
                  aria-pressed={on}
                >
                  <span className="rd-aspect-glyph">
                    <MiniAspect id={ar.id} size={28} />
                  </span>
                  <span className="rd-aspect-meta">
                    <span className="rd-aspect-id">{ar.label}</span>
                    <span className="rd-aspect-name">{ar.name}</span>
                    <span className="rd-aspect-use">{ar.use}</span>
                  </span>
                  <span className="rd-aspect-mark" aria-hidden="true">
                    {on ? '✓' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* ── Clips checklist (only in clips mode) ── */}
        {mode === 'clips' && (
          <section className="rd-section">
            <header className="rd-section-head">
              <h4>
                Clips{' '}
                <span className="muted">
                  {clipIds.length}/{manifestClips.length} selected
                </span>
              </h4>
            </header>
            {manifestClips.length === 0 ? (
              <div className="muted-block">
                No clips yet — run <em>find-clips</em> from the Clips panel.
              </div>
            ) : (
              <div className="rd-clip-list">
                {manifestClips.map((clip) => {
                  const on = clipIds.includes(clip.clipId);
                  const dur = (clip.sourceEnd - clip.sourceStart).toFixed(1);
                  return (
                    <label key={clip.clipId} className={`rd-clip-row${on ? ' on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleClip(clip.clipId)}
                      />
                      <span className="rd-clip-tag">
                        <MiniAspect id="9:16" size={11} /> clip
                      </span>
                      <span className="rd-clip-title">{clip.clipId}</span>
                      <span className="rd-clip-time">{dur}s</span>
                    </label>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* ── Footer ── */}
        <footer className="rd-foot">
          <div className="rd-summary">
            <div className="rd-summary-l">
              <span className="rd-summary-k">Will produce</span>
              <span className="rd-summary-v">
                {outputCount} output{outputCount === 1 ? '' : 's'}
              </span>
            </div>
            <div className="rd-summary-r">{summaryRight}</div>
          </div>
          <div className="rd-actions">
            <button className="rd-btn" onClick={close}>cancel</button>
            <button
              className="rd-btn primary"
              onClick={handleRender}
              disabled={outputCount === 0 || isRendering}
            >
              {isRendering
                ? 'rendering…'
                : `render ${outputCount > 0 ? `${outputCount} output${outputCount === 1 ? '' : 's'}` : '…'} ↵`}
            </button>
          </div>
        </footer>

      </div>
    </div>
  );
}
