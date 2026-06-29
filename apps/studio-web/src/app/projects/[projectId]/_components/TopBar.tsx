"use client";
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useEditorStore, useRenderJob } from '../../../../store/editorStore';
import {
  latestFailedRenderJob,
  renderProgressLabel,
  renderProgressPercent,
} from '../../../../store/selectors';

// ─── ProjectMenu ─────────────────────────────────────────────────────────────
// The ··· overflow menu. Captions/Re-transcribe/Export are wired to existing
// store actions where they exist; the rest are presentational until implemented.

function ProjectMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const triggerTranscribe = useEditorStore((s) => s.triggerTranscribe);
  const setPanel = useEditorStore((s) => s.setPanel);
  const jobs = useEditorStore((s) => s.jobs);
  const diagnostics = useEditorStore((s) => s.diagnostics);
  const audioReady = Boolean(diagnostics?.files?.audio?.exists);
  const transcribeJob = jobs.find(
    (job) => job.type === 'transcribe' && ['queued', 'running'].includes(job.status),
  );

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  type MenuItem =
    | { sep: true }
    | { label: string; hint?: string; onClick?: () => void; disabled?: boolean };

  const items: MenuItem[] = [
    {
      label: 'Captions',
      hint: 'style · burn-in',
      onClick: () => { setPanel('elements'); setOpen(false); },
    },
    {
      label: transcribeJob ? 'Transcribing…' : 'Re-transcribe',
      hint: 'provider · whisper',
      disabled: !!transcribeJob || !audioReady,
      onClick: () => { void triggerTranscribe(); setOpen(false); },
    },
    { label: 'Replace source media', hint: '' },
    { sep: true },
    { label: 'Export manifest', hint: '.json' },
    { label: 'Project settings', hint: '' },
  ];

  return (
    <div className="tb-ovf-wrap" ref={ref}>
      <button
        type="button"
        className={`tb-ovf${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Project · captions · re-transcribe · export"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3.2" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="12.8" cy="8" r="1.4" />
        </svg>
      </button>
      {open && (
        <div className="tb-menu" role="menu">
          {items.map((item, idx) => {
            if ('sep' in item) {
              return <div key={`sep-${idx}`} className="tb-menu-sep" />;
            }
            return (
              <button
                key={item.label}
                role="menuitem"
                type="button"
                className="tb-menu-item"
                disabled={item.disabled}
                onClick={item.onClick ?? (() => setOpen(false))}
              >
                <span>{item.label}</span>
                {item.hint ? <span className="hint">{item.hint}</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── TopBar ───────────────────────────────────────────────────────────────────

export function TopBar() {
  const project = useEditorStore((s) => s.project);
  const jobs = useEditorStore((s) => s.jobs);
  const diagnostics = useEditorStore((s) => s.diagnostics);
  const triggerRenderDraft = useEditorStore((s) => s.triggerRenderDraft);
  const cancelRenderJob = useEditorStore((s) => s.cancelRenderJob);
  const setRenderDialogOpen = useEditorStore((s) => s.setRenderDialogOpen);
  const togglePalette = useEditorStore((s) => s.togglePalette);

  const renderJob = useRenderJob();
  const failed = latestFailedRenderJob(jobs);
  const draftFreshnessError =
    diagnostics?.renderFreshness?.draft?.state === 'error'
      ? diagnostics.renderFreshness.draft
      : null;
  const hasFailed = Boolean(failed || draftFreshnessError);
  const failedReason = failed?.error || draftFreshnessError?.reason || '';

  const draftReady = Boolean(diagnostics?.files?.draft?.exists);
  const isRendering = Boolean(renderJob);
  const percent = renderJob ? renderProgressPercent(renderJob) : 0;

  // Primary button label
  let primaryLabel: string;
  if (renderJob) {
    primaryLabel = renderProgressLabel(renderJob);
  } else if (hasFailed) {
    primaryLabel = 'render failed — retry';
  } else if (draftReady) {
    primaryLabel = 'render again';
  } else {
    primaryLabel = 'render draft';
  }

  function handlePrimary() {
    if (renderJob) {
      void cancelRenderJob(renderJob.jobId);
    } else {
      void triggerRenderDraft();
    }
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        {/* Brand mark */}
        <Link className="brand" href="/projects" aria-label="Projects">
          <svg
            className="brand-mark"
            viewBox="0 0 32 32"
            aria-hidden="true"
          >
            <circle
              cx="14"
              cy="16"
              r="11"
              fill="none"
              stroke="var(--brand-navy)"
              strokeWidth="2.4"
              strokeDasharray="42 5"
              transform="rotate(-25 14 16)"
            />
            <circle cx="24" cy="9" r="3.6" fill="var(--accent)" />
          </svg>
          <span className="brand-name">
            ETVideo<em>Script</em>
          </span>
        </Link>

        {/* Breadcrumb */}
        <div className="crumb">
          <span className="crumb-root">Projects</span>
          <span className="sep">/</span>
          <span className="current">{project?.title || 'Project'}</span>
        </div>
      </div>

      <div className="topbar-right">
        {/* ⌘K command palette button — opens the v4 CommandPalette. */}
        <button
          type="button"
          className="tb-btn tb-icon"
          onClick={togglePalette}
          title="Jump to anything (⌘K)"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="7" cy="7" r="4.2" />
            <path d="M10.2 10.2L14 14" />
          </svg>
          <span className="kbd">⌘K</span>
        </button>

        <span className="tb-divider" aria-hidden="true" />

        {/* Render cluster */}
        <div className="tb-group" role="group" aria-label="Render">
          <button
            type="button"
            className="tb-btn ghost"
            onClick={() => setRenderDialogOpen(true)}
            disabled={isRendering}
            title="Render dialog · multi-aspect"
          >
            render…
          </button>
          <button
            type="button"
            className={`tb-btn primary${hasFailed ? ' danger' : ''}`}
            onClick={handlePrimary}
            disabled={false}
            title={renderJob ? 'Click to cancel' : failedReason || undefined}
          >
            {primaryLabel}
            {!renderJob && !hasFailed && (
              <span style={{ marginLeft: 4, fontSize: '0.65rem', opacity: 0.7 }}>⏎</span>
            )}
          </button>
        </div>

        {/* ··· overflow project menu */}
        <ProjectMenu />
      </div>
    </header>
  );
}
