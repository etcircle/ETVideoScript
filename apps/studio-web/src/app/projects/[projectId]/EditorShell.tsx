"use client";
import { useEffect, useCallback } from 'react';
import type { ProjectDetail } from '../../../lib/api';
import { useEditorStore } from '../../../store/editorStore';
import { TopBar } from './_components/TopBar';
import { SidebarRail } from './_components/SidebarRail';
import { SidePanel } from './_components/SidePanel';
import { TranscriptPanel } from './_components/TranscriptPanel';
import { CenterPreview } from './_components/CenterPreview';
import { Timeline } from './_components/Timeline';
import { RenderDialog } from './_components/RenderDialog';
import { CommandPalette } from './_components/CommandPalette';
import { ShortcutSheet } from './_components/ShortcutSheet';
import { ProposalPopover } from './_components/ProposalPopover';
import { CleanupStrip } from './_components/CleanupStrip';
import { PanelState } from './_components/state/PanelState';
import { decidePanelState, projectDuration } from '../../../store/selectors';
import { clipSpanTargetsForRange } from '../../../store/editTargets';
import { deriveSilences, deriveSweepCandidates } from '../../../store/designData';

export default function EditorShell({ projectId, initial }: { projectId: string; initial: ProjectDetail }) {
  const state = useEditorStore();

  useEffect(() => { state.hydrate(projectId, initial); }, [projectId]);

  // Sync theme to document when store changes
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = state.theme === 'dark' ? 'dark' : 'light';
    }
  }, [state.theme]);

  // ─ v4: global keyboard shortcuts ──────────────────────────────────────────
  // Ported from the design prototype (js/app-v4.jsx L457-480), adapted for the
  // React/Zustand app. We read fresh state via getState() on every keypress
  // (no stale closures) so the listener can mount exactly once, like the
  // prototype's deps-less effect.
  //
  // CRITICAL: the seek / cut / mute / sweep-cut branches BAIL when focus is
  // inside the transcript pane (`.transcript-pane`) — TranscriptPanel already
  // owns in-transcript arrow/backspace/type-over caret editing and we must not
  // double-handle. Those keys are only handled when focus is OUTSIDE the
  // transcript editing context. The typing-guard (input/textarea/contentEditable)
  // is applied to everything except ⌘K / ⌘Z / ⇧⌘Z, matching the prototype.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = (target?.tagName || '').toLowerCase();
      const typing =
        tag === 'input' || tag === 'textarea' || Boolean(target?.isContentEditable);
      // Focused interactive controls own their own activation keys (Space / Enter).
      // Don't let the global handler hijack those — otherwise Space on a focused
      // toolbar button toggles playback instead of clicking the button.
      const interactive =
        tag === 'button' ||
        tag === 'a' ||
        tag === 'select' ||
        tag === 'summary' ||
        target?.getAttribute?.('role') === 'button';
      const mod = e.metaKey || e.ctrlKey;
      const store = useEditorStore.getState();

      // ⌘K — palette toggle (fires even while typing).
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        store.togglePalette();
        return;
      }
      if (typing) return;
      // ⌘Z / ⇧⌘Z — undo / redo (still fire while focus is in an input is guarded
      // above; here focus is non-typing).
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      // While the palette is open it owns its own ↑↓⏎esc; don't double-handle.
      if (store.paletteOpen) return;

      // Space — play / pause (global). Skip when a button/link/select is focused
      // so its native activation works.
      if (e.key === ' ') {
        if (interactive) return;
        e.preventDefault();
        store.setPlaying(!store.playing);
        return;
      }

      // The transcript pane owns arrow / backspace / type-over caret editing.
      // Bail on those branches whenever focus is inside it.
      const inTranscript = Boolean(target?.closest?.('.transcript-pane'));

      if (e.key === 'ArrowLeft') {
        if (inTranscript) return;
        e.preventDefault();
        store.seek(Math.max(0, store.currentTime - (e.shiftKey ? 10 : 2)));
        return;
      }
      if (e.key === 'ArrowRight') {
        if (inTranscript) return;
        e.preventDefault();
        const dur = projectDuration(store.manifest, store.transcript) || 0;
        store.seek(Math.min(dur, store.currentTime + (e.shiftKey ? 10 : 2)));
        return;
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && store.selection) {
        if (inTranscript) return;
        e.preventDefault();
        cutOrMuteSelection('cut');
        return;
      }
      if (e.key.toLowerCase() === 'm' && store.selection && !mod) {
        if (inTranscript) return;
        e.preventDefault();
        cutOrMuteSelection('mute');
        return;
      }
      // ⏎ — cut the candidate currently under review in the clean-up sweep.
      if (e.key === 'Enter' && store.sweepActive && !store.proposalPopover) {
        if (inTranscript || interactive) return;
        e.preventDefault();
        cutCurrentSweepCandidate();
        return;
      }
      // ? — shortcut cheat sheet.
      if (e.key === '?') {
        store.setShortcutSheetOpen(true);
        return;
      }
      // Esc — close every transient overlay and clear the selection.
      if (e.key === 'Escape') {
        store.setPaletteOpen(false);
        store.setShortcutSheetOpen(false);
        store.setProposalPopover(null);
        store.closeSweep();
        store.setSelection(null);
        return;
      }
    }

    // Turn the active range selection into a cut/mute op via the same
    // selection→createOperation path the timeline transport uses
    // (Timeline.createRangeOperation): one cut/mute op per clip-span target.
    function cutOrMuteSelection(type: 'cut' | 'mute') {
      const store = useEditorStore.getState();
      const sel = store.selection;
      if (!sel || sel.end <= sel.start) return;
      const targets = clipSpanTargetsForRange(store.manifest, sel.start, sel.end);
      for (const target of targets) {
        void store.createOperation({ type, target, reason: `Manual ${type} (keyboard)` });
      }
    }

    // Cut the current sweep candidate — mirrors CleanupStrip.onCut (the strip
    // owns the buttons; ⏎ is the keyboard equivalent). Same derivation, same
    // clip-span target conversion, same index re-clamp.
    function cutCurrentSweepCandidate() {
      const store = useEditorStore.getState();
      if (!store.sweepActive) return;
      const words = store.transcript?.words ?? [];
      const silences = deriveSilences(words);
      const all = deriveSweepCandidates(
        store.transcript,
        store.manifest,
        silences,
        store.manifest?.operations ?? [],
      );
      const candidates = all.filter((c) => !store.sweepSkipped.includes(c.id));
      const n = candidates.length;
      if (n === 0) return;
      const i = Math.min(store.sweepIndex, Math.max(0, n - 1));
      const cur = candidates[i];
      if (!cur) return;
      const reason =
        cur.kind === 'silence'
          ? `Dead air ${(cur.end - cur.start).toFixed(2)}s`
          : `Filler "${cur.text}"`;
      // Anchor to the candidate's OWN clip — mirrors CleanupStrip.cutCandidate so
      // the keyboard ⏎ path never cuts unrelated overlapping tracks (music / SFX /
      // captions). With no clip identity, restrict to the primary video track
      // instead of every overlapping clip.
      const targets = cur.clipId
        ? clipSpanTargetsForRange(store.manifest, cur.start, cur.end).filter((t) => t.clipId === cur.clipId)
        : clipSpanTargetsForRange(store.manifest, cur.start, cur.end, 'video');
      for (const target of targets) {
        void store.createOperation({ type: 'cut', target, reason });
      }
      // The cut range is now covered by an enabled op, so the candidate drops out
      // of the next derivation; keep the index pointed at the next remaining one.
      store.setSweepIndex(Math.min(i, Math.max(0, n - 2)));
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const mainState = decidePanelState({
    loading: state.loading,
    panel: 'main',
    project: state.project,
    diagnostics: state.diagnostics,
    transcript: state.transcript,
    jobs: state.jobs,
  });

  // Transcript pane resize (drag right edge → wider/narrower)
  const onTranscriptResizeDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startW = state.transcriptWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (e: PointerEvent) => state.setTranscriptWidth(startW + e.clientX - startX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [state.transcriptWidth, state.setTranscriptWidth]);

  // Timeline resize (drag up from gutter → taller timeline)
  const onTimelineResizeDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startH = state.timelineHeight;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    const move = (e: PointerEvent) => state.setTimelineHeight(startH - (e.clientY - startY));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [state.timelineHeight, state.setTimelineHeight]);

  const trxW = state.transcriptCollapsed ? 44 : state.transcriptWidth;
  const tlH = state.timelineCollapsed ? 38 : state.timelineHeight;

  return (
    <div
      className="app"
      data-tx-collapsed={state.transcriptCollapsed ? 'true' : 'false'}
      data-tl-collapsed={state.timelineCollapsed ? 'true' : 'false'}
      style={{ ['--tl-h' as string]: `${tlH}px` }}
    >
      <TopBar />

      <div className="main" style={{ ['--trx-w' as string]: `${trxW}px` }}>
        {/* Transcript pane */}
        <div className={`transcript-pane${state.transcriptCollapsed ? ' collapsed' : ''}`}>
          {state.transcriptCollapsed ? (
            <button
              className="pane-rail"
              onClick={() => state.setTranscriptCollapsed(false)}
              title="Expand transcript"
            >
              <span className="pane-rail-chev">›</span>
              <span className="pane-rail-label">Transcript</span>
            </button>
          ) : (
            <>
              <TranscriptPanel />
              {/* v4: clean-up sweep bar — docks at the bottom of the transcript
                  column, matching the prototype (app-v4.jsx L689). Self-gates on
                  `sweepActive`, so it's inert otherwise. */}
              <CleanupStrip />
            </>
          )}
        </div>

        {/* Vertical resize gutter */}
        <div
          className={`tx-resize${state.transcriptCollapsed ? ' disabled' : ''}`}
          onPointerDown={state.transcriptCollapsed ? undefined : onTranscriptResizeDown}
          onDoubleClick={() => state.setTranscriptCollapsed(!state.transcriptCollapsed)}
          title={state.transcriptCollapsed ? 'Click chevron to expand' : 'Drag to resize · double-click to collapse'}
        />

        {/* Center preview */}
        <div className={`center-pane${state.previewCollapsed ? ' collapsed' : ''}`}>
          {state.previewCollapsed ? (
            <button
              className="pane-rail"
              onClick={() => state.setPreviewCollapsed(false)}
              title="Expand preview"
            >
              <span className="pane-rail-chev">‹</span>
              <span className="pane-rail-label">Preview</span>
            </button>
          ) : mainState === 'cold-start' ? (
            <PanelState state="cold-start" />
          ) : (
            <CenterPreview />
          )}
        </div>

        {/* Spacer grows when center-pane is collapsed */}
        <div className="main-spacer" />

        {/* Side panel (slides open) */}
        <SidePanel />

        {/* Right rail (64px icon nav) */}
        <SidebarRail />
      </div>

      {/* Horizontal resize gutter above timeline */}
      <div
        className={`tl-resize${state.timelineCollapsed ? ' disabled' : ''}`}
        onPointerDown={state.timelineCollapsed ? undefined : onTimelineResizeDown}
        onDoubleClick={() => state.setTimelineCollapsed(!state.timelineCollapsed)}
        role="separator"
        aria-orientation="horizontal"
        tabIndex={0}
        title={state.timelineCollapsed ? 'Click rail to expand' : 'Drag to resize · double-click to collapse'}
      />

      <Timeline />

      <RenderDialog />

      {/* v4: command palette, shortcut sheet, inline proposal popover — fixed
          overlays that self-source open/anchor state from the store (matching
          the prototype's app-v4.jsx L925-927). */}
      <CommandPalette />
      <ShortcutSheet />
      <ProposalPopover />

      {state.error
        ? <div className="toast error-text" role="alert">{state.error}</div>
        : state.notice
          ? <div className="toast" role="status">{state.notice}</div>
          : null}
    </div>
  );
}
