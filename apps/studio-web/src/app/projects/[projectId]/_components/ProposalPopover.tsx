"use client";

import { useEffect, useRef } from 'react';
import { useEditorStore } from '../../../../store/editorStore';
import { designOps } from '../../../../store/selectors';

/**
 * Inline proposal popover (v4 design refresh — S7).
 *
 * Ports `commands-v4.jsx` ProposalPopover (L179-219). Anchored to a proposed-mark
 * click in the transcript: the store holds `proposalPopover = { opId, x, y }`, this
 * component resolves the op through the `designOps` adapter (so it reads the same flat
 * shape — timeline-axis start/end, confidence, reason, voice_patch text/originalText,
 * proposedBy — as every other v4 surface) and renders the fixed `.prop-pop` card.
 *
 * Approve → approveOperation(opId) + close. Reject → rejectOperation(opId) + close.
 * Esc / click-outside / Enter (= approve) close, matching the prototype's keydown
 * handler exactly. CSS lives in v4.css (`.prop-pop*`); no styling is added here.
 */

/** Compact m:ss timecode — matches the prototype's window.formatTC. */
function formatTC(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function ProposalPopover() {
  const ref = useRef<HTMLDivElement>(null);
  const pop = useEditorStore((state) => state.proposalPopover);
  const manifest = useEditorStore((state) => state.manifest);
  const transcript = useEditorStore((state) => state.transcript);
  const setProposalPopover = useEditorStore((state) => state.setProposalPopover);
  const approveOperation = useEditorStore((state) => state.approveOperation);
  const rejectOperation = useEditorStore((state) => state.rejectOperation);

  // Resolve the op through the flat design adapter, like every other v4 surface.
  const op = pop ? designOps(manifest, transcript).find((candidate) => candidate.id === pop.opId) ?? null : null;

  // Esc / click-outside / Enter handling — mirrors commands-v4.jsx L182-195.
  useEffect(() => {
    if (!pop || !op) return;
    function off(e: MouseEvent) {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) {
        setProposalPopover(null);
      }
    }
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setProposalPopover(null);
      } else if (e.key === 'Enter') {
        // Enter is the quick-approve shortcut, but if focus is on a button inside
        // the popover (e.g. Reject), let that button's native activation win
        // instead of force-approving.
        const active = document.activeElement;
        if (
          ref.current &&
          active instanceof HTMLElement &&
          ref.current.contains(active) &&
          active.tagName === 'BUTTON'
        ) {
          return;
        }
        e.preventDefault();
        void approveOperation(op!.id);
        setProposalPopover(null);
      }
    }
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', off);
      document.removeEventListener('keydown', key);
    };
  }, [pop, op, approveOperation, setProposalPopover]);

  if (!pop || !op) return null;

  // Position: clamp to viewport so the card never spills off-screen (prototype L197-198).
  const left = Math.max(12, Math.min(pop.x - 60, window.innerWidth - 332));
  const top = Math.min(pop.y + 14, window.innerHeight - 210);

  return (
    <div className="prop-pop" ref={ref} style={{ left, top }}>
      <div className="prop-pop-head">
        <span className={`prop-pop-type ${op.type}`}>{op.type.replace('_', ' ')}</span>
        <span className="prop-pop-time">{formatTC(op.start)}–{formatTC(op.end)}</span>
        {op.confidence != null && (
          <span className="prop-pop-conf">conf {Math.round(op.confidence * 100)}%</span>
        )}
      </div>
      <div className="prop-pop-reason">{op.reason}</div>
      {op.type === 'voice_patch' && (
        <div className="prop-pop-quote">
          <s>{op.originalText}</s> → <em>&ldquo;{op.text}&rdquo;</em>
        </div>
      )}
      <div className="prop-pop-from">suggested by {op.proposedBy || 'agent'}</div>
      <div className="prop-pop-actions">
        <button onClick={() => { void rejectOperation(op.id); setProposalPopover(null); }}>Reject</button>
        <button
          className="approve"
          onClick={() => { void approveOperation(op.id); setProposalPopover(null); }}
        >
          Approve <span className="k">⏎</span>
        </button>
      </div>
    </div>
  );
}
