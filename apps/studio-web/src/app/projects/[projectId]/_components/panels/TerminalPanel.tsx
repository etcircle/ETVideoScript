"use client";
import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../../../../../store/editorStore';

/**
 * TerminalPanel — design TerminalView re-skin.
 *
 * Real wiring: The job list from the editor store is shown as term-line entries
 * so the user can see live job status. A command input is stubbed for the
 * future WS agent wiring (currently disabled, matching the existing behaviour).
 * The DOM matches the design's .terminal-pane / .terminal-head / .terminal-body
 * / .term-line / .terminal-input structure exactly.
 */

type TermLine = {
  ts: string;
  cls: string; // 'ok' | 'dim' | 'agent' | 'cmd' | 'arrow' | 'skill'
  text: string;
};

function nowTS(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function TerminalPanel() {
  const jobs = useEditorStore((s) => s.jobs);
  const [input, setInput] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  // Build terminal lines from boot message + job stream
  const bootLines: TermLine[] = [
    { ts: '00:00:00', cls: 'ok',  text: 'agent protocol idle' },
    { ts: '00:00:00', cls: 'dim', text: 'read-only shell · no mutating tool calls' },
  ];

  const jobLines: TermLine[] = jobs.slice(0, 20).map((job) => {
    const cls =
      job.status === 'succeeded' ? 'ok' :
      job.status === 'running'   ? 'agent' :
      job.status === 'failed'    ? 'arrow' :
      'dim';
    const detail = job.stages?.[0]?.phase ?? job.error ?? job.jobId;
    return {
      ts: job.createdAt ? new Date(job.createdAt).toTimeString().slice(0, 8) : '—',
      cls,
      text: `[job] ${job.type} → ${job.status}${detail ? ` · ${detail}` : ''}`,
    };
  });

  const lines: TermLine[] = [...bootLines, ...jobLines];

  // Auto-scroll to bottom when lines change
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [lines.length]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // WS agent command wiring is deferred (Phase 5c).
    // For now, just clear the input so the form doesn't freeze.
    setInput('');
  }

  return (
    <div className="terminal-pane in-panel">
      <div className="terminal-head">
        <div className="l">
          <span className="lights">
            <span className="l-dot live" />
            <span className="l-dot live" />
            <span className="l-dot" />
          </span>
          <span>claude &middot; ws/agent</span>
        </div>
        <div className="r">
          <button type="button" disabled>logs</button>
          <button type="button" disabled>copy</button>
          <button type="button" disabled title="Detach agent">detach</button>
        </div>
      </div>

      <div className="terminal-body" ref={bodyRef}>
        {lines.map((line, i) => (
          <div className={`term-line ${line.cls}`} key={i}>
            <span className="ts">{line.ts} </span>
            <span>{line.text}</span>
          </div>
        ))}
      </div>

      <form className="terminal-input" onSubmit={handleSubmit}>
        <span className="prompt">›</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="ask the agent · e.g. 'tighten the intro to 30 seconds'"
          autoComplete="off"
          disabled
          aria-label="Agent command input (coming in Phase 5c)"
        />
        <span className="hint">⏎</span>
      </form>
    </div>
  );
}
