"use client";

/**
 * CommandPalette — the v4 ⌘K "jump to anything" surface.
 *
 * Ported 1:1 from the design prototype's `CommandPalette`
 * (js/commands-v4.jsx L56-145): same `.cp-scrim` / `.cp` / `.cp-inputrow` /
 * `.cp-list` / `.cp-group` / `.cp-item` / `.cp-foot` markup (all classes from
 * v4.css), same search filter, ↑↓ navigation, ⏎ run, Esc / scrim close, and
 * mouse-enter-sets-active behaviour.
 *
 * Unlike the prototype (which received a `commands` array prop built in
 * app-v4.jsx), this component is self-contained: it reads everything it needs
 * straight from `useEditorStore` and builds the command list internally
 * (modelled on app-v4.jsx L487-509 `paletteCommands`). It is mounted by the
 * integration agent; open/close is driven by `paletteOpen` / `setPaletteOpen`.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivePanel } from '../../../../store/editorStore';
import { useEditorStore } from '../../../../store/editorStore';
import { proposedOperations } from '../../../../store/selectors';
import { SKILLS, deriveSilences, deriveSweepCandidates } from '../../../../store/designData';

// A single palette command. Mirrors the prototype's command shape so the markup
// below maps 1:1 onto v4.css's `.cp-*` rows.
type Command = {
  id: string;
  group: string;
  glyph?: string;
  label: string;
  hint?: string;
  kbd?: string;
  keywords?: string;
  hidden?: boolean;
  run: () => void;
};

// The seven side-panel keys, with the titles the rail uses ("Open <title>").
// Mirrors the prototype's PANEL_TITLES (app-v4.jsx L977-985), remapped to the
// React store's ActivePanel enum (`suggestions` where the prototype said
// `proposals`).
const PANEL_TITLES: Record<NonNullable<ActivePanel>, string> = {
  ai: 'AI',
  suggestions: 'Suggestions',
  manifest: 'Changes',
  clips: 'Clips',
  inspect: 'Inspect',
  elements: 'Elements',
  media: 'Media',
};

const PANEL_ORDER: NonNullable<ActivePanel>[] = [
  'ai',
  'suggestions',
  'manifest',
  'clips',
  'inspect',
  'elements',
  'media',
];

export function CommandPalette() {
  // Self-source state from the store (same idiom as the other panels/dialogs).
  const open = useEditorStore((s) => s.paletteOpen);
  const setPaletteOpen = useEditorStore((s) => s.setPaletteOpen);

  const playing = useEditorStore((s) => s.playing);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const playSpeed = useEditorStore((s) => s.playSpeed);
  const cyclePlaySpeed = useEditorStore((s) => s.cyclePlaySpeed);
  const skipSilences = useEditorStore((s) => s.skipSilences);
  const toggleSkipSilences = useEditorStore((s) => s.toggleSkipSilences);

  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const canUndo = useEditorStore((s) => s.canUndo());
  const canRedo = useEditorStore((s) => s.canRedo());
  const undoLabel = useEditorStore((s) => s.undoLabel());
  const redoLabel = useEditorStore((s) => s.redoLabel());

  const startSweep = useEditorStore((s) => s.startSweep);

  const manifest = useEditorStore((s) => s.manifest);
  const transcript = useEditorStore((s) => s.transcript);
  const approveOperation = useEditorStore((s) => s.approveOperation);

  const triggerRenderDraft = useEditorStore((s) => s.triggerRenderDraft);
  const setRenderDialogOpen = useEditorStore((s) => s.setRenderDialogOpen);
  const runStudioSound = useEditorStore((s) => s.runStudioSound);

  const setTranscriptMode = useEditorStore((s) => s.setTranscriptMode);
  const theme = useEditorStore((s) => s.theme);
  const setTheme = useEditorStore((s) => s.setTheme);
  const setShortcutSheetOpen = useEditorStore((s) => s.setShortcutSheetOpen);
  const setPanel = useEditorStore((s) => s.setPanel);

  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  function close() {
    setPaletteOpen(false);
  }

  // Reset query + focus the input when the palette opens (prototype L63-68).
  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      const t = setTimeout(() => {
        inputRef.current?.focus();
      }, 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Derived counts that drive command hints / visibility.
  const proposalCount = useMemo(() => proposedOperations(manifest).length, [manifest]);
  const sweepCount = useMemo(() => {
    const words = transcript?.words ?? [];
    const silences = deriveSilences(words);
    return deriveSweepCandidates(transcript, manifest, silences, manifest?.operations ?? []).length;
  }, [transcript, manifest]);

  // Build the command list from store actions + designData SKILLS. Modelled on
  // the prototype's `paletteCommands` (app-v4.jsx L487-509), grouped
  // Playback / Edit / Project / View / Panels / Agent skills.
  const commands = useMemo<Command[]>(() => {
    function approveAll() {
      for (const op of proposedOperations(manifest)) {
        void approveOperation(op.id);
      }
    }
    // No real "run skill" store action exists yet — surface a lightweight toast
    // stub via the store's `notice` field (the same channel the store itself
    // uses for transient status), so the affordance is visible and runnable.
    function runSkill(name: string) {
      useEditorStore.setState({ notice: `Skill “${name}” is not wired yet — coming soon.` });
    }

    const list: Command[] = [
      // ── Playback ────────────────────────────────────────────────
      {
        id: 'play',
        group: 'Playback',
        glyph: playing ? '❚❚' : '▶',
        label: playing ? 'Pause' : 'Play',
        kbd: 'Space',
        keywords: 'play pause space',
        run: () => setPlaying(!playing),
      },
      {
        id: 'speed',
        group: 'Playback',
        glyph: '»',
        label: `Playback speed · ${playSpeed}×`,
        hint: 'cycle 0.75–2×',
        keywords: 'speed rate fast slow',
        run: cyclePlaySpeed,
      },
      {
        id: 'skipsil',
        group: 'Playback',
        glyph: '⊘',
        label: skipSilences ? 'Stop skipping silences' : 'Skip silences while playing',
        keywords: 'silence dead air skip',
        run: toggleSkipSilences,
      },
      // ── Edit ────────────────────────────────────────────────────
      {
        id: 'undo',
        group: 'Edit',
        glyph: '↺',
        label: `Undo · ${undoLabel || ''}`,
        kbd: '⌘Z',
        keywords: 'undo revert',
        hidden: !canUndo,
        run: undo,
      },
      {
        id: 'redo',
        group: 'Edit',
        glyph: '↻',
        label: `Redo · ${redoLabel || ''}`,
        kbd: '⇧⌘Z',
        keywords: 'redo',
        hidden: !canRedo,
        run: redo,
      },
      {
        id: 'sweep',
        group: 'Edit',
        glyph: '✦',
        label: 'Clean up fillers & dead air',
        hint: `${sweepCount} candidate${sweepCount === 1 ? '' : 's'}`,
        keywords: 'clean up sweep filler um uh silence',
        run: startSweep,
      },
      {
        id: 'approveall',
        group: 'Edit',
        glyph: '✓',
        label: `Approve all suggestions (${proposalCount})`,
        keywords: 'approve accept suggestions proposals',
        hidden: proposalCount === 0,
        run: approveAll,
      },
      // ── Project ─────────────────────────────────────────────────
      {
        id: 'render',
        group: 'Project',
        glyph: '⏵',
        label: 'Render draft',
        keywords: 'render draft preview',
        run: () => {
          void triggerRenderDraft();
        },
      },
      {
        id: 'renderdlg',
        group: 'Project',
        glyph: '⏵',
        label: 'Render…',
        hint: 'multi-aspect · clips',
        keywords: 'render export aspect clips dialog',
        run: () => setRenderDialogOpen(true),
      },
      {
        id: 'studio',
        group: 'Project',
        glyph: '✦',
        label: 'Studio Sound',
        hint: 'denoise · dereverb · normalize',
        keywords: 'studio sound denoise dereverb normalize enhance audio',
        run: () => {
          void runStudioSound();
        },
      },
      // ── View ────────────────────────────────────────────────────
      {
        id: 'mode-draft',
        group: 'View',
        glyph: '¶',
        label: 'Transcript · Draft',
        keywords: 'transcript mode draft preview',
        run: () => setTranscriptMode('preview'),
      },
      {
        id: 'mode-audit',
        group: 'View',
        glyph: '¶',
        label: 'Transcript · Edits',
        hint: 'every change visible',
        keywords: 'transcript mode edits audit changes',
        run: () => setTranscriptMode('edited'),
      },
      {
        id: 'mode-original',
        group: 'View',
        glyph: '¶',
        label: 'Transcript · Original',
        keywords: 'transcript mode original raw',
        run: () => setTranscriptMode('original'),
      },
      {
        id: 'theme',
        group: 'View',
        glyph: '◐',
        label: theme === 'dark' ? 'Theme · switch to Paper' : 'Theme · switch to Ink',
        keywords: 'theme dark light paper ink',
        run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
      {
        id: 'shortcuts',
        group: 'View',
        glyph: '?',
        label: 'Keyboard shortcuts',
        kbd: '?',
        keywords: 'shortcuts keyboard help cheat sheet',
        run: () => setShortcutSheetOpen(true),
      },
      // ── Panels ──────────────────────────────────────────────────
      ...PANEL_ORDER.map<Command>((p) => ({
        id: `panel-${p}`,
        group: 'Panels',
        glyph: '▸',
        label: `Open ${PANEL_TITLES[p]}`,
        keywords: `panel ${PANEL_TITLES[p]}`,
        run: () => setPanel(p),
      })),
      // ── Agent skills ────────────────────────────────────────────
      ...SKILLS.map<Command>((s) => ({
        id: `skill-${s.name}`,
        group: 'Agent skills',
        glyph: '›',
        label: `Run ${s.name}`,
        hint: s.desc,
        keywords: `skill ${s.name} ${s.desc}`,
        run: () => runSkill(s.name),
      })),
    ];
    return list;
  }, [
    playing,
    playSpeed,
    skipSilences,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    sweepCount,
    proposalCount,
    theme,
    manifest,
    approveOperation,
    setPlaying,
    cyclePlaySpeed,
    toggleSkipSilences,
    undo,
    redo,
    startSweep,
    triggerRenderDraft,
    setRenderDialogOpen,
    runStudioSound,
    setTranscriptMode,
    setTheme,
    setShortcutSheetOpen,
    setPanel,
  ]);

  // Search filter (prototype L70-76): match against label + group + keywords.
  const filtered = useMemo(() => {
    const visible = commands.filter((c) => !c.hidden);
    const needle = q.trim().toLowerCase();
    if (!needle) return visible;
    return visible.filter((c) =>
      `${c.label} ${c.group || ''} ${c.keywords || ''}`.toLowerCase().includes(needle)
    );
  }, [q, commands]);

  // Reset the active row whenever the query changes (prototype L78).
  useEffect(() => {
    setIdx(0);
  }, [q]);

  // Keep the active row in view — manual scroll, no scrollIntoView (prototype L81-89).
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>('.cp-item.active');
    if (!el) return;
    if (el.offsetTop < list.scrollTop + 8) {
      list.scrollTop = el.offsetTop - 8;
    } else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight - 8) {
      list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight + 8;
    }
  }, [idx, filtered.length]);

  if (!open) return null;

  function run(c: Command) {
    close();
    c.run?.();
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[idx]) run(filtered[idx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  let lastGroup: string | null = null;
  return (
    <div
      className="cp-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="cp" role="dialog" aria-label="Command palette">
        <div className="cp-inputrow">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="7" cy="7" r="4.2"></circle>
            <path d="M10.2 10.2L14 14"></path>
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Type a command — play, undo, clean up, render, skill…"
            spellCheck={false}
          />
          <span className="cp-esc">esc</span>
        </div>
        <div className="cp-list" ref={listRef}>
          {filtered.length === 0 && <div className="cp-empty">No matching commands</div>}
          {filtered.map((c, i) => {
            const showGroup = c.group !== lastGroup;
            lastGroup = c.group;
            return (
              <Fragment key={c.id}>
                {showGroup && <div className="cp-group">{c.group}</div>}
                <button
                  className={`cp-item ${i === idx ? 'active' : ''}`}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => run(c)}
                >
                  <span className="cp-glyph">{c.glyph || '›'}</span>
                  <span className="cp-label">{c.label}</span>
                  <span className="cp-hint">{c.hint || ''}</span>
                  {c.kbd && <span className="cp-kbd">{c.kbd}</span>}
                </button>
              </Fragment>
            );
          })}
        </div>
        <div className="cp-foot">
          <span>↑↓ navigate</span>
          <span>⏎ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
