"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JobStage } from '../../../../lib/api';
import { API } from '../../../../lib/api';
import { useEditorStore } from '../../../../store/editorStore';
import {
  decidePanelState,
  latestFailedRenderJob,
  latestRenderDraftJob,
  operationTimelineRange,
  projectDuration,
} from '../../../../store/selectors';
import { PanelState } from './state/PanelState';

// ─── Types ────────────────────────────────────────────────────────────────────

const ASPECTS = ['16:9', '9:16', '1:1', '4:5'] as const;
type AspectId = typeof ASPECTS[number];

// Aspect dimensions for the SVG glyph
const ASPECT_DIM: Record<AspectId, { w: number; h: number }> = {
  '16:9': { w: 22, h: 12 },
  '9:16': { w: 11, h: 18 },
  '1:1': { w: 14, h: 14 },
  '4:5': { w: 12, h: 15 },
};

type RenderFailureSummary = { stage: string; reason: string; fullLog: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function meaningfulLogLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (
    /^(ffmpeg version|built with|configuration:|libav\w+|Input #|Output #|Stream mapping:|Press \[q\]|frame=)/i.test(
      trimmed,
    )
  )
    return false;
  return true;
}

export function summarizeRenderFailure(
  fullLog = '',
  stages: JobStage[] = [],
): RenderFailureSummary {
  const failedStage = [...stages].reverse().find((stage) => stage.status === 'failed');
  const stage = failedStage?.phase || failedStage?.name || 'render';
  const stageError = failedStage?.error?.trim();
  const stderrLine = fullLog
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(meaningfulLogLine)
    .at(-1);
  const reason = (stderrLine || stageError || 'The render worker exited with an error.')
    .replace(/\s+/g, ' ')
    .slice(0, 220);
  return { stage, reason, fullLog: fullLog || stageError || reason };
}

// ─── AspectGlyph ─────────────────────────────────────────────────────────────

function AspectGlyph({ aspect }: { aspect: AspectId }) {
  const { w, h } = ASPECT_DIM[aspect] ?? ASPECT_DIM['16:9'];
  const cx = 12 - w / 2;
  const cy = 10 - h / 2;
  return (
    <svg viewBox="0 0 24 20" width="24" height="20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x={cx} y={cy} width={w} height={h} rx="1" />
    </svg>
  );
}

// ─── RenderErrorSurface ───────────────────────────────────────────────────────

function RenderErrorSurface({
  summary,
  onRetry,
}: {
  summary: RenderFailureSummary;
  onRetry: () => void;
}) {
  return (
    <div className="render-error-surface" role="status" tabIndex={0}>
      <div className="render-error-kicker">{summary.stage}</div>
      <h2>draft render failed</h2>
      <p>{summary.reason}</p>
      <details>
        <summary>full log</summary>
        <pre>{summary.fullLog}</pre>
      </details>
      <button type="button" onClick={onRetry}>
        Retry render draft
      </button>
    </div>
  );
}

// ─── CenterPreview ────────────────────────────────────────────────────────────

export function CenterPreview() {
  const state = useEditorStore();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [pvZoom, setPvZoom] = useState(1);

  const duration = projectDuration(state.manifest, state.transcript);
  const running = latestRenderDraftJob(state.jobs);
  const failed = latestFailedRenderJob(state.jobs);

  const panelState = decidePanelState({
    loading: state.loading,
    panel: 'preview',
    project: state.project,
    diagnostics: state.diagnostics,
    transcript: state.transcript,
    jobs: state.jobs,
  });

  const draftFreshness = state.diagnostics?.renderFreshness?.draft;

  const previewExists =
    state.previewKind === 'source'
      ? Boolean(state.diagnostics?.files?.source?.exists || state.project?.status?.imported)
      : Boolean(state.diagnostics?.files?.[state.previewKind]?.exists);

  const renderFailure =
    panelState === 'render-failed'
      ? summarizeRenderFailure(
          failed?.error || draftFreshness?.reason || '',
          failed?.stages || [],
        )
      : null;

  // Sync video element currentTime to store
  useEffect(() => {
    const video = videoRef.current;
    if (video && Math.abs(video.currentTime - state.currentTime) > 0.3) {
      video.currentTime = state.currentTime;
    }
  }, [state.currentTime, state.previewKind]);

  // Auto-refresh while a render is in flight
  useEffect(() => {
    const id = running ? window.setInterval(() => void state.refresh(), 1500) : 0;
    return () => { if (id) window.clearInterval(id); };
  }, [running?.jobId, running?.status]);

  // v4 — keep the real <video>.playbackRate in sync with the store's playSpeed
  // (cycled via the .pv-speed-btn / command palette). Re-applied on src swap.
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = state.playSpeed;
  }, [state.playSpeed, state.previewKind]);

  // v4 — drive the real <video> from the store's play/pause state so keyboard
  // Space and the command-palette Play/Pause actually start/stop media. The click
  // handlers call video.play()/pause() directly; this covers the store-driven path.
  // Guard on video.paused so the onPlay/onPause → setPlaying round-trip can't loop.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (state.playing && video.paused) void video.play().catch(() => {});
    else if (!state.playing && !video.paused) video.pause();
  }, [state.playing]);

  // Zoom helpers
  function nudgeZoom(delta: number) {
    setPvZoom((z) => Math.max(0.5, Math.min(3, +(z + delta).toFixed(2))));
  }

  // Freshness derivations
  const isStaleAndIdle = draftFreshness?.state === 'stale' && !running;
  const freshnessState: string = (() => {
    if (!draftFreshness) return '';
    if (running || draftFreshness.state === 'rendering') return 'rendering';
    if (draftFreshness.state === 'fresh') return '';
    if (draftFreshness.state === 'stale') return 'stale';
    return draftFreshness.state;
  })();
  const freshnessLabel: string = (() => {
    if (!draftFreshness) return '';
    if (running || draftFreshness.state === 'rendering') return 'rendering';
    if (draftFreshness.state === 'fresh') return 'fresh';
    if (draftFreshness.state === 'stale') return 'stale — render now';
    if (draftFreshness.state === 'missing') return 'no draft yet';
    if (draftFreshness.state === 'error') return 'draft error';
    return draftFreshness.state;
  })();

  // Aspect helpers
  const currentAspect = (ASPECTS.includes(state.aspect as AspectId) ? state.aspect : '16:9') as AspectId;
  const aspectKey = currentAspect.replace(':', 'x');
  const [arW, arH] = currentAspect.split(':').map(Number);

  // Progress
  const progress = duration > 0 ? (state.currentTime / duration) * 100 : 0;

  // v4 — « » jump between edit points (timeline-start of each enabled cut op).
  // The prototype reads a flat o.start; here we map each enabled cut op through
  // operationTimelineRange (clip-local target → timeline axis) and take its start.
  const cutPoints = useMemo(() => {
    const ops = state.manifest?.operations ?? [];
    const points = ops
      .filter((op) => op.type === 'cut' && op.status === 'approved')
      .map((op) => operationTimelineRange(state.manifest, op)?.start)
      .filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
    return [...new Set(points)].sort((a, b) => a - b);
  }, [state.manifest]);

  function seekTo(target: number) {
    state.seek(target);
    const v = videoRef.current;
    if (v) v.currentTime = target;
  }
  function prevCut() {
    const target = [...cutPoints].reverse().find((p) => p < state.currentTime - 0.05);
    seekTo(target != null ? target : 0);
  }
  function nextCut() {
    const target = cutPoints.find((p) => p > state.currentTime + 0.05);
    seekTo(target != null ? target : duration);
  }

  // Video src: keyed on kind + updatedAt so React swaps the element on new renders
  const videoSrc = `${API}/api/projects/${state.projectId}/media/${state.previewKind}?v=${encodeURIComponent(state.diagnostics?.files?.[state.previewKind]?.updatedAt || '')}`;

  return (
    <section
      className={`center-pane${fileDragOver ? ' file-drag-over' : ''}`}
      aria-label="Preview"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        if (!fileDragOver) setFileDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setFileDragOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setFileDragOver(false);
        const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('video/'));
        if (file) void state.uploadVideoAsset(file);
      }}
    >
      <div className="preview-wrap">
        {/* ── Tab row ──────────────────────────────────────────────────── */}
        <div className="preview-tabs">
          <button
            type="button"
            className={state.previewKind === 'source' ? 'active' : ''}
            onClick={() => state.setPreviewKind('source')}
          >
            source
          </button>
          <button
            type="button"
            className={state.previewKind === 'draft' ? 'active' : ''}
            disabled={!state.diagnostics?.files?.draft?.exists}
            onClick={() => state.setPreviewKind('draft')}
          >
            draft
          </button>
          <button
            type="button"
            className={state.previewKind === 'final' ? 'active' : ''}
            disabled={!state.diagnostics?.files?.final?.exists}
            onClick={() => state.setPreviewKind('final')}
          >
            final
          </button>

          <span className="spacer" />

          {/* Freshness pill */}
          {draftFreshness && draftFreshness.state !== 'missing' && (
            isStaleAndIdle ? (
              <button
                type="button"
                className={`freshness${freshnessState ? ` ${freshnessState}` : ''} clickable`}
                onClick={() => state.triggerRenderDraft()}
                title={draftFreshness.reason || 'Draft is stale. Click to render now.'}
              >
                <span className="d" aria-hidden="true" />
                {freshnessLabel}
              </button>
            ) : (
              <span
                className={`freshness${freshnessState ? ` ${freshnessState}` : ''}`}
                title={draftFreshness.reason || ''}
              >
                <span className="d" aria-hidden="true" />
                {freshnessLabel}
              </span>
            )
          )}

          <button
            type="button"
            className="pane-collapse"
            onClick={() => state.setPreviewCollapsed(true)}
            title="Collapse preview"
          >
            ›
          </button>
        </div>

        {/* ── Main content area ─────────────────────────────────────────── */}
        {renderFailure ? (
          <RenderErrorSurface summary={renderFailure} onRetry={state.triggerRenderDraft} />
        ) : panelState !== 'ready' ? (
          <PanelState state={panelState} />
        ) : (
          <>
            {/* ── Video frame ───────────────────────────────────────────── */}
            <div className={`preview-video aspect-${aspectKey}`}>
              <div
                className={`ghost-frame aspect-${aspectKey}`}
                style={{
                  transform: `scale(${pvZoom})`,
                  transformOrigin: 'center center',
                  aspectRatio: `${arW} / ${arH}`,
                }}
              >
                {/* Real <video> element — the design uses a placeholder but we
                    host the real video inside the same ghost-frame so all
                    playback/seek/freshness wiring is preserved. */}
                {previewExists ? (
                  <video
                    ref={videoRef}
                    key={`${state.previewKind}:${state.diagnostics?.files?.[state.previewKind]?.updatedAt || ''}`}
                    src={videoSrc}
                    onLoadedMetadata={(e) => { e.currentTarget.playbackRate = state.playSpeed; }}
                    onTimeUpdate={(e) => state.seek(e.currentTarget.currentTime)}
                    onPlay={() => state.setPlaying(true)}
                    onPause={() => state.setPlaying(false)}
                  />
                ) : (
                  <>
                    <div className="placeholder-title">{state.project?.title || 'No media yet'}</div>
                    <div className="placeholder-meta">
                      {state.previewKind.toUpperCase()} ·{' '}
                      <span className="ts">
                        {formatTime(state.currentTime)} / {formatTime(duration)}
                      </span>
                    </div>
                  </>
                )}

                {/* Rendering overlay on draft tab while render is in flight */}
                {state.previewKind === 'draft' && draftFreshness?.state === 'rendering' && (
                  <div className="preview-rendering-overlay" role="status" aria-live="polite">
                    <span className="preview-rendering-dot" aria-hidden="true" />
                    <strong>Rendering preview…</strong>
                    <span className="preview-rendering-hint">
                      Keep editing — preview refreshes when ready
                    </span>
                  </div>
                )}

                {/* Safe-area overlay for non-16:9 aspect ratios */}
                {currentAspect !== '16:9' && (
                  <div className="reframe-safe" title="Auto-reframe · face-tracked safe area">
                    <span className="reframe-tag">auto-reframe · face-track</span>
                  </div>
                )}

                {/* Play overlay (hidden while render is in flight on draft tab) */}
                {!state.playing &&
                  !(state.previewKind === 'draft' && draftFreshness?.state === 'rendering') && (
                    <div className="play-overlay">
                      <div
                        className="play"
                        onClick={() => {
                          const v = videoRef.current;
                          if (v) void v.play();
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </div>
                    </div>
                  )}

                {/* Progress scrub bar at bottom of frame */}
                <div
                  className="time-scrub"
                  role="slider"
                  tabIndex={0}
                  aria-label="Seek"
                  aria-valuemin={0}
                  aria-valuemax={duration}
                  aria-valuenow={state.currentTime}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    const target = ratio * duration;
                    state.seek(target);
                    const v = videoRef.current;
                    if (v) v.currentTime = target;
                  }}
                >
                  <div className="filled" style={{ width: `${Math.min(100, progress)}%` }} />
                </div>
              </div>
            </div>

            {/* ── Meta strip ────────────────────────────────────────────── */}
            <div className="preview-meta-strip pv-one-row">
              {/* Transport controls */}
              <div className="play-controls">
                <button type="button" title="Previous edit point" onClick={prevCut}>
                  «
                </button>
                <button
                  type="button"
                  className="play-main"
                  onClick={() => {
                    const v = videoRef.current;
                    if (!v) return;
                    if (v.paused) void v.play();
                    else v.pause();
                  }}
                >
                  {state.playing ? (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-label="Pause">
                      <rect x="6" y="5" width="4" height="14" />
                      <rect x="14" y="5" width="4" height="14" />
                    </svg>
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-label="Play">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
                <button type="button" title="Next edit point" onClick={nextCut}>
                  »
                </button>
              </div>

              {/* Clock */}
              <span className="clock">{formatTime(state.currentTime)}</span>

              {/* Playback speed — cycle [0.75,1,1.25,1.5,2], drives real video.playbackRate */}
              <button
                type="button"
                className="pv-speed-btn"
                onClick={() => state.cyclePlaySpeed()}
                title="Playback speed — click to cycle"
              >
                {state.playSpeed}×
              </button>

              {/* Skip detected silences during playback */}
              <button
                type="button"
                className={`pv-skip-btn${state.skipSilences ? ' on' : ''}`}
                onClick={() => state.toggleSkipSilences()}
                title="Skip detected silences during playback"
              >
                ⊘ skip silences
              </button>

              {/* Aspect selector */}
              <span
                className="aspect-strip aspect-strip-inline"
                role="tablist"
                aria-label="Output aspect ratio"
              >
                <span className="aspect-label">aspect</span>
                {ASPECTS.map((ar) => (
                  <button
                    key={ar}
                    type="button"
                    role="tab"
                    aria-selected={ar === currentAspect}
                    className={`aspect-btn${ar === currentAspect ? ' active' : ''}`}
                    onClick={() => state.setAspect(ar)}
                  >
                    <AspectGlyph aspect={ar} />
                    <span className="aspect-tag">{ar}</span>
                  </button>
                ))}
              </span>

              <span style={{ flex: 1 }} />

              {/* Zoom controls */}
              <span className="pv-zoom">
                <button type="button" onClick={() => nudgeZoom(-0.25)} title="Zoom out">
                  −
                </button>
                <span>{Math.round(pvZoom * 100)}%</span>
                <button type="button" onClick={() => nudgeZoom(0.25)} title="Zoom in">
                  +
                </button>
                <button type="button" onClick={() => setPvZoom(1)} title="Reset zoom">
                  fit
                </button>
              </span>

              <span className="pv-status" title="1080p draft · ffmpeg ok">
                1080p · ffmpeg {state.diagnostics?.doctor?.ffmpeg ? 'ok' : 'missing'}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// ─── Util ─────────────────────────────────────────────────────────────────────

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
