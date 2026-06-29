"use client";
import { useEditorStore } from '../../../../../store/editorStore';
import type { PanelStateKind } from '../../../../../store/selectors';

const copy: Record<PanelStateKind, { title: string; hint: string }> = {
  loading: { title: 'Loading…', hint: 'Reading project files without moving anything.' },
  'cold-start': { title: 'Drop a video to start', hint: 'Drag a file anywhere on this surface, or use the button below.' },
  'no-transcript': { title: 'Needs a transcript first', hint: 'Run transcription before this surface has useful data.' },
  'render-failed': { title: 'Draft render failed', hint: 'Retry render draft when you are ready.' },
  'provider-failed': { title: 'Provider request failed', hint: 'The provider response is shown where available.' },
  empty: { title: 'Nothing here yet', hint: 'This panel will fill once the manifest has matching data.' },
  ready: { title: '', hint: '' }
};

// Cold-start was a static "Drop a video to start" label with no actionable control —
// users had to discover the side-panel Import tile to upload (user feedback 2026-05-24).
// Now any cold-start PanelState IS the drop zone: the whole panel surface accepts drag-
// drop and a click on the inline upload label opens the file picker. Codex P2 (2026-05-24)
// caught that handlers wired only to the inner label let the browser navigate away if the
// drop landed on the title/hint area, so the handlers now live on the outer container.
function ColdStartUploadLabel() {
  const uploadVideoAsset = useEditorStore((s) => s.uploadVideoAsset);
  return <label className="cold-start-upload">
    <input type="file" accept="video/*" hidden onChange={(event) => {
      const file = event.target.files?.[0];
      if (file) void uploadVideoAsset(file);
    }} />
    Upload a video
    <small>or drop one onto this panel</small>
  </label>;
}

export function PanelState({ state, title, hint, detail, action }: { state: PanelStateKind; title?: string; hint?: string; detail?: string; action?: React.ReactNode }) {
  // Hook order must be stable — call useEditorStore unconditionally even though only the
  // cold-start branch consumes it. The selector keeps the subscription scoped to a single
  // function reference so non-cold-start renders don't re-render on unrelated store changes.
  const uploadVideoAsset = useEditorStore((s) => s.uploadVideoAsset);
  if (state === 'ready') return null;
  const fallback = copy[state];
  const isColdStart = state === 'cold-start';
  const resolvedAction = action ?? (isColdStart ? <ColdStartUploadLabel /> : null);
  return <div
    className={`panel-state panel-state-${state}`}
    role="status"
    tabIndex={0}
    // stopPropagation on the drag handlers so a drop on the cold-start surface
    // doesn't ALSO bubble up to MediaPanel's `.panel-stack` drop handler — that
    // would upload the same file twice and create duplicate clips (Codex P2,
    // second pass 2026-05-24).
    onDragOver={isColdStart ? (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.classList.add('dragging');
    } : undefined}
    onDragLeave={isColdStart ? (event) => {
      event.stopPropagation();
      event.currentTarget.classList.remove('dragging');
    } : undefined}
    onDrop={isColdStart ? (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.classList.remove('dragging');
      const file = Array.from(event.dataTransfer.files).find(Boolean);
      if (file) void uploadVideoAsset(file);
    } : undefined}
  >
    <div className="serif-display panel-state-title">{title || fallback.title}</div>
    <p>{hint || fallback.hint}</p>
    {detail ? <pre>{detail}</pre> : null}
    {resolvedAction ? <div className="panel-state-action">{resolvedAction}</div> : null}
  </div>;
}

export function SkeletonLines({ count = 4 }: { count?: number }) {
  return <div className="skeleton-lines" aria-label="loading">{Array.from({ length: count }, (_, index) => <span key={index} />)}</div>;
}
