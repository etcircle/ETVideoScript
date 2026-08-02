"use client";
import { useState } from 'react';
import { useEditorStore } from '../../../../../store/editorStore';
import { decidePanelState, hasProviderFailure } from '../../../../../store/selectors';
import { SKILLS } from '../../../../../store/designData';
import { PanelState } from '../state/PanelState';
import { TerminalPanel } from './TerminalPanel';
import { VoiceChip } from '../VoiceChip';

// ─── Studio Sound cost disclosure ────────────────────────────────────────────
// ElevenLabs Voice Isolator is a paid call (~$0.10/min of audio). Per paid-services
// policy: configuring ElevenLabs is consent; disclose cost every time before the user
// commits to a run. No per-call modal — show the disclosure inline in the card.
const STUDIO_SOUND_COST_TEXT = 'ElevenLabs Voice Isolator · ~$0.10/min · runs once, result cached';
// S1b D7: Studio Sound eagerly kicks off the voice clone, because the clone trains on the
// CLEANED recording — a new cleanup makes any existing clone stale. Disclosed here so the
// second paid call is visible before the user commits to the first.
const STUDIO_SOUND_CHAIN_TEXT = 'Running Studio Sound also prepares your voice — 1 ElevenLabs clone call (billed by plan tier).';

export function AgentPanel() {
  const state = useEditorStore();
  const [runningSkill, setRunningSkill] = useState<string | null>(null);

  const panelState = decidePanelState({
    loading: state.loading,
    panel: 'ai',
    project: state.project,
    diagnostics: state.diagnostics,
    transcript: state.transcript,
    providerRequests: state.providerRequests,
  });

  const failed = state.providerRequests.find(
    (r) => ['failed', 'op_update_failed'].includes(String(r.status || ''))
  );

  const studioOn      = state.studioSoundStatus === 'on';
  const studioRunning = state.studioSoundStatus === 'running';
  const studioError   = state.studioSoundStatus === 'error';

  async function handleStudioSound() {
    if (studioRunning) return;
    if (studioOn) {
      await state.disableStudioSound();
    } else {
      await state.runStudioSound();
    }
  }

  // Agent identity fields (process-level data isn't available client-side; show
  // the known proto / agent kind statically; pid/session are presentational).
  const agentLabel = 'Claude Code';
  const agentCmd   = 'claude';

  if (state.aiTab === 'terminal') return <TerminalPanel />;

  if (panelState !== 'ready' && panelState !== 'provider-failed') {
    return <PanelState state={panelState} />;
  }

  return (
    <div className="view-agent">
      {/* Provider failure banner */}
      {hasProviderFailure(state.providerRequests) && (
        <div className="panel-banner error-text">
          Provider request failed:{' '}
          {String(failed?.error || failed?.message || failed?.providerStatus || 'unknown error')}
        </div>
      )}

      {/* Agent identity card */}
      <section className="agent-card">
        <div className="agent-id">
          <div className="name">
            <span className="pulse" />
            {agentLabel}
            <code>· attached</code>
          </div>
        </div>
        <div className="agent-id-meta">
          <span>{agentCmd}</span>
          <span className="sep">·</span>
          <span>proto v3</span>
          <span className="sep">·</span>
          <span>session read-only</span>
        </div>
        <div className="skills" style={{ paddingTop: 10, paddingBottom: 10 }}>
          <button type="button" className="skill-chip" disabled>claude-code</button>
          <button type="button" className="skill-chip" disabled>codex</button>
          <button type="button" className="skill-chip" disabled>hermes</button>
        </div>
      </section>

      {/* Studio Sound card */}
      <section className="view-section">
        <header className="view-section-head">
          <h4>Audio</h4>
          <span className="muted">{studioOn ? 'studio sound · on' : 'A1 dialog'}</span>
        </header>
        <button
          type="button"
          className={`studio-run${studioRunning ? ' busy' : ''}${studioOn ? ' on' : ''}`}
          onClick={() => { void handleStudioSound(); }}
          disabled={studioRunning}
          title="Studio Sound · denoise · dereverb · normalize all dialog tracks"
        >
          <span className="studio-glyph">✦</span>
          <span className="studio-text">
            <span className="studio-title">
              {studioRunning ? 'Enhancing…' : studioOn ? 'Studio Sound applied' : 'Studio Sound'}
            </span>
            <span className="studio-sub">
              {studioError
                ? 'error — check provider settings'
                : studioRunning
                  ? 'processing · please wait'
                  : STUDIO_SOUND_COST_TEXT}
            </span>
          </span>
          {studioRunning
            ? <span className="studio-spin" aria-label="Running" />
            : <span className="studio-cta">{studioOn ? 're-run' : 'run'}</span>}
        </button>
        {/*
          D7: the eager auto-kick is disclosed BEFORE the user presses run, not after it fires.
          Per the paid-services policy a configured provider is consent — but the user still has
          to be able to see, up front, that this button leads to a second paid call.
        */}
        <p className="studio-note">{STUDIO_SOUND_CHAIN_TEXT}</p>
        <VoiceChip />
      </section>

      {/* Skills — flat strip, matching the design's AgentView */}
      <section className="view-section">
        <header className="view-section-head">
          <h4>Skills</h4>
          <span className="muted">{SKILLS.length} available</span>
        </header>
        <div className="skills">
          {SKILLS.map((s) => {
            const isRunning = runningSkill === s.name;
            return (
              <button
                key={s.name}
                type="button"
                className={`skill-chip${isRunning ? ' running' : ''}`}
                title={s.desc}
                disabled={Boolean(runningSkill) && !isRunning}
                onClick={() => {
                  // Skills are currently presentational — the real skill runner is
                  // wired through the agent WebSocket session, not a direct API call.
                  // Show a transient running state for UX completeness.
                  if (isRunning) return;
                  setRunningSkill(s.name);
                  setTimeout(() => setRunningSkill(null), 2000);
                }}
              >
                {isRunning ? <span className="spin" aria-hidden="true" /> : <span aria-hidden="true">›</span>}
                {s.name}
              </button>
            );
          })}
        </div>
      </section>

      {/* Recent section */}
      <section className="view-section">
        <header className="view-section-head">
          <h4>Recent</h4>
        </header>
        <div className="muted-block">
          Run a skill from the strip above, or select transcript words and ask the
          agent for a cut. Proposals appear in the <em>Suggest</em> panel.
        </div>
      </section>
    </div>
  );
}
