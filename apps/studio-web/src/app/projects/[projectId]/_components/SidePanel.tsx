"use client";
import { useRef, useState } from 'react';
import { useEditorStore } from '../../../../store/editorStore';
import { approvedOperations, proposedOperations } from '../../../../store/selectors';
import { AgentPanel } from './panels/AgentPanel';
import { SuggestionsPanel } from './panels/SuggestionsPanel';
import { ManifestPanel } from './panels/ManifestPanel';
import { ClipsPanel } from './panels/ClipsPanel';
import { InspectPanel } from './panels/InspectPanel';
import { ElementsPanel } from './panels/ElementsPanel';
import { MediaPanel } from './panels/MediaPanel';

// Close SVG icon (1.5 stroke, currentColor)
function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

// Panel id → design title / kicker from the app.jsx PANEL_TITLES / PANEL_KICKERS maps
const PANEL_TITLES: Record<string, string> = {
  ai:          'AI',
  suggestions: 'Suggestions',
  manifest:    'Changes',
  clips:       'Clips',
  inspect:     'Inspect',
  elements:    'Elements',
  media:       'Media',
};

const PANEL_KICKERS: Record<string, string> = {
  ai_agent:    'AI · attached',
  ai_terminal: 'AI · agent shell',
  suggestions: 'AI · awaiting approval',
  manifest:    'history · edits/manifest.json',
  clips:       'distribute · social',
  inspect:     'selection · playhead',
  elements:    'text · captions · packs',
  media:       'project clips',
};

export function SidePanel() {
  const activePanel  = useEditorStore((s) => s.activePanel);
  const setPanel     = useEditorStore((s) => s.setPanel);
  const panelWidth   = useEditorStore((s) => s.panelWidth);
  const setPanelWidth = useEditorStore((s) => s.setPanelWidth);
  const aiTab        = useEditorStore((s) => s.aiTab);
  const setAiTab     = useEditorStore((s) => s.setAiTab);
  const manifest     = useEditorStore((s) => s.manifest);
  const approveOp    = useEditorStore((s) => s.approveOperation);

  const [resizing, setResizing] = useState(false);
  const resizingRef = useRef(false);

  // Derive kicker: AI panel kicker depends on current tab
  const kickerKey = activePanel === 'ai' ? `ai_${aiTab}` : (activePanel ?? '');
  const kicker    = PANEL_KICKERS[kickerKey] ?? '';
  const title     = activePanel ? PANEL_TITLES[activePanel] ?? activePanel : '';

  // "Approve all" action — surfaced in .sp-actions for the suggestions panel
  const proposedOps = proposedOperations(manifest);
  async function approveAll() {
    for (const op of proposedOps) {
      if (op.status === 'proposed') await approveOp(op.id);
    }
  }

  // Left-edge resize handle
  function onStartResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!activePanel) return;
    event.preventDefault();
    const startX = event.clientX;
    const startW = panelWidth;
    resizingRef.current = true;
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    function move(e: PointerEvent) {
      setPanelWidth(startW + startX - e.clientX);
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      resizingRef.current = false;
      setResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const open = Boolean(activePanel);

  return (
    <aside
      className={`side-panel${open ? ' open' : ''}${resizing ? ' resizing' : ''}`}
      aria-hidden={!open}
      aria-label={open ? `${title} panel` : undefined}
      style={{ width: open ? panelWidth : 0 }}
    >
      {/* Left-edge drag handle */}
      <div
        className="sp-resize"
        onPointerDown={open ? onStartResize : undefined}
        title="Drag to resize panel"
        aria-hidden="true"
      />

      {/* Header */}
      <header className="sp-head">
        <div className="sp-titles">
          {kicker && <div className="sp-kicker">{kicker}</div>}
          <h3>{title}</h3>
        </div>
        <div className="sp-actions">
          {/* Approve-all action in Suggestions */}
          {activePanel === 'suggestions' && proposedOps.length > 1 && (
            <button
              type="button"
              className="sp-action"
              onClick={() => { void approveAll(); }}
              title="Approve all pending proposals"
            >
              Approve all
            </button>
          )}
          <button
            type="button"
            className="sp-close"
            onClick={() => setPanel(null)}
            aria-label="Close panel"
            title="Close panel"
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      {/* Agent / Terminal tabs — only for the AI panel */}
      {activePanel === 'ai' && (
        <div className="sp-tabs" role="tablist" aria-label="AI panel views">
          <button
            role="tab"
            type="button"
            className={`sp-tab${aiTab === 'agent' ? ' active' : ''}`}
            aria-selected={aiTab === 'agent'}
            onClick={() => setAiTab('agent')}
          >
            Agent
          </button>
          <button
            role="tab"
            type="button"
            className={`sp-tab${aiTab === 'terminal' ? ' active' : ''}`}
            aria-selected={aiTab === 'terminal'}
            onClick={() => setAiTab('terminal')}
          >
            Terminal
          </button>
        </div>
      )}

      {/* Body */}
      <div className="sp-body">
        {activePanel === 'ai'          ? <AgentPanel />       :
         activePanel === 'suggestions' ? <SuggestionsPanel /> :
         activePanel === 'manifest'    ? <ManifestPanel />    :
         activePanel === 'clips'       ? <ClipsPanel />       :
         activePanel === 'inspect'     ? <InspectPanel />     :
         activePanel === 'elements'    ? <ElementsPanel />    :
         activePanel === 'media'       ? <MediaPanel />       : null}
      </div>
    </aside>
  );
}
