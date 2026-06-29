"use client";
import { Fragment, useEffect } from 'react';
import { useEditorStore } from '../../../../store/editorStore';

// ── Shortcut cheat sheet ("?") ─────────────────────────────────────
// Ported verbatim from prototype js/commands-v4.jsx L222-254 (static 10 rows).
// Self-sources `shortcutSheetOpen` from the store; closes via setShortcutSheetOpen(false)
// on Esc, scrim click, or the × button.

const ROWS: [string, string][] = [
  ['Play / pause', 'Space'],
  ['Seek ±2s (⇧ = ±10s)', '← →'],
  ['Undo / redo', '⌘Z · ⇧⌘Z'],
  ['Command palette', '⌘K'],
  ['Cut selection', '⌫'],
  ['Mute selection', 'M'],
  ['Cut candidate (clean-up open)', '⏎'],
  ['Correct a word', 'double-click it'],
  ['Dismiss / close', 'esc'],
  ['This sheet', '?'],
];

export function ShortcutSheet() {
  const open = useEditorStore((s) => s.shortcutSheetOpen);
  const setShortcutSheetOpen = useEditorStore((s) => s.setShortcutSheetOpen);

  // Esc closes the sheet.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShortcutSheetOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setShortcutSheetOpen]);

  if (!open) return null;

  const close = () => setShortcutSheetOpen(false);

  return (
    <div
      className="ks-scrim"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="ks" role="dialog" aria-label="Keyboard shortcuts">
        <div className="ks-head">
          <h3>Keyboard shortcuts</h3>
          <button className="ks-close" onClick={close} title="Close">×</button>
        </div>
        <div className="ks-grid">
          {ROWS.map(([label, keys]) => (
            <Fragment key={label}>
              <span className="ks-label">{label}</span>
              <span className="ks-keys"><kbd>{keys}</kbd></span>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
