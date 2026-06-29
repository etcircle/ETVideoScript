"use client";
import { useEffect, useState } from 'react';
import { useEditorStore } from '../../../../store/editorStore';
import { getGenerationEstimate, type GenerationEstimate, type GenerationKind } from '../../../../lib/api';

type Props = { kind: GenerationKind | null; onClose: () => void };
type DialogState = 'idle' | 'generating' | 'error';

const labels: Record<GenerationKind, { title: string; kicker: string; hint: string }> = {
  'image-gen': {
    title: 'Generate image',
    kicker: 'MEDIA · IMAGE',
    hint: 'A cinematic product photo of a matte black espresso machine on a walnut counter…',
  },
  'video-gen': {
    title: 'Generate video',
    kicker: 'MEDIA · VIDEO',
    hint: 'Slow-motion b-roll of sunlight moving across a modern office desk, 16:9…',
  },
  'music-gen': {
    title: 'Generate music',
    kicker: 'MEDIA · MUSIC',
    hint: 'Warm upbeat synth bed for a product demo, subtle drums, no vocals…',
  },
};

function currencySymbol(currency: string | undefined | null): string {
  if (currency === 'GBP') return '£';
  if (currency === 'EUR') return '€';
  return '$';
}

function unitLabel(kind: GenerationKind, defaults: GenerationEstimate['defaults']): string {
  if (kind === 'image-gen') return `${defaults.count} image${defaults.count === 1 ? '' : 's'}`;
  if (kind === 'video-gen') return `${defaults.durationSec}s of video`;
  return `${Math.round(defaults.durationMs / 1000)}s of audio`;
}

export function formatCostLabel(
  estimate: GenerationEstimate | null,
  kind: GenerationKind,
  status: 'loading' | 'error' | 'ready'
): string {
  if (status === 'loading') return 'Loading cost estimate…';
  if (status === 'error' || !estimate) return 'Cost estimate unavailable — proceed at provider rate';
  if (estimate.tier === 'local') {
    const suffix = estimate.configured ? '' : ', default';
    return `${estimate.providerName} — free (local provider${suffix})`;
  }
  if (!estimate.configured)
    return `No paid ${kind} provider configured — set one in Settings → Providers`;
  const cost = estimate.cost;
  if (!cost || cost.estimated == null)
    return `${estimate.providerName} — paid (rate not configured; see Settings → Providers)`;
  const value =
    cost.estimated < 0.01 ? cost.estimated.toFixed(4) : cost.estimated.toFixed(2);
  return `${estimate.providerName} — ~${currencySymbol(cost.currency)}${value} for ${unitLabel(kind, estimate.defaults)} (paid)`;
}

export function GenerationDialog({ kind, onClose }: Props) {
  const createGeneration = useEditorStore((s) => s.createGeneration);
  const projectId = useEditorStore((s) => s.projectId);
  const [prompt, setPrompt] = useState('');
  const [dialogState, setDialogState] = useState<DialogState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<GenerationEstimate | null>(null);
  const [estimateStatus, setEstimateStatus] = useState<'loading' | 'error' | 'ready'>('loading');

  useEffect(() => {
    if (!kind || !projectId) { setEstimateStatus('error'); return; }
    let cancelled = false;
    setEstimate(null);
    setEstimateStatus('loading');
    getGenerationEstimate(projectId, kind)
      .then((result) => { if (!cancelled) { setEstimate(result); setEstimateStatus('ready'); } })
      .catch(() => { if (!cancelled) { setEstimate(null); setEstimateStatus('error'); } });
    return () => { cancelled = true; };
  }, [kind, projectId]);

  if (!kind) return null;

  const copy = labels[kind];
  const costLabel = formatCostLabel(estimate, kind, estimateStatus);
  const isGenerating = dialogState === 'generating';

  async function submit() {
    const text = prompt.trim();
    if (!text || isGenerating) return;
    setDialogState('generating');
    setError(null);
    try {
      await createGeneration(kind!, text);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDialogState('error');
    }
  }

  return (
    <div className="rd-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="rd-sheet" onClick={(e) => e.stopPropagation()}>

        {/* ── Header ── */}
        <header className="rd-head">
          <div className="rd-titles">
            <div className="rd-kicker">{copy.kicker}</div>
            <h3>{copy.title}</h3>
          </div>
          <button className="rd-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        {/* ── Prompt + cost disclosure ── */}
        <section className="rd-section">
          <label className="field-stack">
            <span>Prompt</span>
            <textarea
              className="gen-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={copy.hint}
              rows={6}
              disabled={isGenerating}
              autoFocus
            />
          </label>

          <div className="media-row" style={{ marginTop: 10 }}>
            <span className="stamp">cost</span>
            <strong>{costLabel}</strong>
            <small>{kind}</small>
          </div>

          {isGenerating && (
            <div className="media-row">
              <span className="stamp">running</span>
              <strong>Generating…</strong>
              <small>Provider call is running now.</small>
            </div>
          )}

          {error ? <p className="panel-error">{error}</p> : null}
        </section>

        {/* ── Footer ── */}
        <footer className="rd-foot">
          <div className="rd-summary">
            <div className="rd-summary-l">
              <span className="rd-summary-k">Provider</span>
              <span className="rd-summary-v" style={{ fontSize: '0.95rem' }}>
                {estimate?.providerName ?? '—'}
              </span>
            </div>
            <div className="rd-summary-r">{kind}</div>
          </div>
          <div className="rd-actions">
            <button className="rd-btn" disabled={isGenerating} onClick={onClose}>
              cancel
            </button>
            <button
              className="rd-btn primary"
              disabled={!prompt.trim() || isGenerating}
              onClick={submit}
            >
              {isGenerating ? 'generating…' : 'generate ↵'}
            </button>
          </div>
        </footer>

      </div>
    </div>
  );
}
