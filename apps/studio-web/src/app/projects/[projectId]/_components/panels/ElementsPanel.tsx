"use client";
import { useState } from 'react';
import { BRAND_PACKS, type BrandPack } from '@etvideoscript/core/browser';
import { CAPTION_STYLES, type CaptionStyle } from '../../../../../store/designData';
import { useEditorStore } from '../../../../../store/editorStore';
import { videoClipAtTime, videoClipBoundaryAtTime, clipSpanTargetForRange } from '../../../../../store/editTargets';
import { decidePanelState } from '../../../../../store/selectors';
import { PanelState } from '../state/PanelState';

// ── Helper exported for tests (unchanged contract) ────────────────────────────
export function isActiveBrandPack(manifestBrandPackId: string | undefined | null, packId: string) {
  return manifestBrandPackId === packId;
}

// ── Element groups (design-matched) ──────────────────────────────────────────
const ELEMENT_GROUPS: Array<{ name: string; kind: 'text' | 'shape' | 'transition' | 'marker'; items: Array<{ id: string; label: string }> }> = [
  {
    name: 'Text',
    kind: 'text',
    items: [
      { id: 'lower-third', label: 'Lower third' },
      { id: 'title-card',  label: 'Title card'  },
      { id: 'subtitle',    label: 'Subtitle'     },
      { id: 'callout',     label: 'Callout'      },
      { id: 'chapter',     label: 'Chapter'      },
      { id: 'pull-quote',  label: 'Pull quote'   },
    ],
  },
  {
    name: 'Shapes',
    kind: 'shape',
    items: [
      { id: 'rect',     label: 'Rectangle' },
      { id: 'circle',   label: 'Circle'    },
      { id: 'triangle', label: 'Triangle'  },
      { id: 'arrow',    label: 'Arrow'     },
      { id: 'line',     label: 'Line'      },
      { id: 'bracket',  label: 'Bracket'   },
    ],
  },
  {
    name: 'Transitions',
    kind: 'transition',
    items: [
      { id: 'cut',      label: 'Hard cut' },
      { id: 'fade',     label: 'Fade'     },
      { id: 'dissolve', label: 'Dissolve' },
      { id: 'wipe',     label: 'Wipe'     },
      { id: 'zoom',     label: 'Zoom in'  },
      { id: 'whip',     label: 'Whip pan' },
    ],
  },
  {
    name: 'Markers',
    kind: 'marker',
    items: [
      { id: 'pin',      label: 'Pin'      },
      { id: 'star',     label: 'Star'     },
      { id: 'flag',     label: 'Flag'     },
      { id: 'numbered', label: 'Numbered' },
    ],
  },
];

// ── Caption style preview glyph (mirrors design's CaptionGlyph) ───────────────
function CaptionGlyph({ style }: { style: CaptionStyle }) {
  const { fg, accent } = style.swatch;
  if (style.id === 'shorts-bold') {
    return (
      <span className="caption-glyph shorts-bold" style={{ color: accent }}>
        <span className="bg" style={{ background: fg, color: '#171411' }}>SWEET BAKERY OS</span>
      </span>
    );
  }
  if (style.id === 'talk-show') {
    return (
      <span className="caption-glyph talk-show" style={{ color: fg, textShadow: '0 1px 2px ' + accent }}>
        is a chat-first OS
      </span>
    );
  }
  if (style.id === 'clean') {
    return (
      <span className="caption-glyph clean" style={{ color: fg, borderTop: '1px solid ' + accent }}>
        Sweet Bakery OS
      </span>
    );
  }
  if (style.id === 'ted') {
    return (
      <span className="caption-glyph ted" style={{ color: fg, fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}>
        A business operating system
      </span>
    );
  }
  if (style.id === 'podcast') {
    return (
      <span className="caption-glyph podcast" style={{ color: fg }}>
        <span className="bar" style={{ background: accent }} />
        <span>Manifest <em>is</em> the timeline</span>
      </span>
    );
  }
  return null;
}

// ── Brand pack preview glyph ─────────────────────────────────────────────────
function PackGlyph({ pack }: { pack: BrandPack }) {
  const p = pack.preview;
  if (p.kind === 'paper') return (
    <svg viewBox="0 0 100 56" preserveAspectRatio="xMidYMid slice">
      <rect width="100" height="56" fill={p.bg} />
      <circle cx="22" cy="28" r="7" fill="none" stroke={p.ink} strokeWidth="1.2" strokeDasharray="11 2" />
      <circle cx="29" cy="22" r="2.5" fill={p.accent} />
      <text x="40" y="26" fontFamily="Instrument Serif" fontSize="9" fill={p.ink}>ETCircle</text>
      <rect x="40" y="32" width="40" height="1.4" fill={p.ink} opacity="0.4" />
      <rect x="40" y="36" width="24" height="1.2" fill={p.ink} opacity="0.3" />
    </svg>
  );
  if (p.kind === 'bold') return (
    <svg viewBox="0 0 100 56" preserveAspectRatio="xMidYMid slice">
      <rect width="100" height="56" fill={p.bg} />
      <rect x="18" y="22" width="64" height="14" fill={p.accent} rx="2" />
      <text x="50" y="33" textAnchor="middle" fontFamily="Geist" fontWeight="700" fontSize="9" fill={p.bg}>HOOK LINE</text>
    </svg>
  );
  if (p.kind === 'wave') return (
    <svg viewBox="0 0 100 56" preserveAspectRatio="xMidYMid slice">
      <rect width="100" height="56" fill={p.bg} />
      {Array.from({ length: 20 }, (_, i) => {
        const h = 6 + Math.abs(Math.sin(i * 1.2)) * 18;
        return <rect key={i} x={6 + i * 4.5} y={28 - h / 2} width="2" height={h} fill={p.accent} opacity={0.55 + (i % 3) * 0.15} />;
      })}
      <rect x="14" y="42" width="72" height="1.4" fill={p.ink} opacity="0.5" />
    </svg>
  );
  // screen / fallback
  return (
    <svg viewBox="0 0 100 56" preserveAspectRatio="xMidYMid slice">
      <rect width="100" height="56" fill={p.bg} />
      <rect x="8" y="8" width="84" height="32" fill="none" stroke={p.ink} strokeWidth="0.8" />
      <rect x="14" y="14" width="38" height="2" fill={p.ink} opacity="0.6" />
      <rect x="14" y="20" width="48" height="1.4" fill={p.ink} opacity="0.4" />
      <rect x="14" y="24" width="24" height="1.4" fill={p.ink} opacity="0.4" />
      <circle cx="80" cy="32" r="6" fill={p.accent} />
      <rect x="8" y="44" width="84" height="6" fill={p.accent} opacity="0.9" />
    </svg>
  );
}

// ── Per-element kind preview glyphs (mirrors design's ElementGlyph) ───────────
function ElementGlyph({ kind, id }: { kind: string; id: string }) {
  if (kind === 'text') {
    if (id === 'lower-third') return (
      <svg viewBox="0 0 80 48"><rect x="6" y="32" width="44" height="9" fill="var(--ink)" opacity="0.85"/><rect x="6" y="32" width="44" height="2" fill="var(--accent)"/><rect x="8" y="35" width="20" height="2" fill="var(--paper)"/><rect x="8" y="38" width="14" height="1.5" fill="var(--paper)" opacity="0.7"/></svg>
    );
    if (id === 'title-card') return (
      <svg viewBox="0 0 80 48"><rect x="2" y="2" width="76" height="44" fill="none" stroke="var(--line-strong)" strokeWidth="1"/><rect x="14" y="18" width="52" height="4" fill="var(--ink)"/><rect x="20" y="26" width="40" height="2" fill="var(--ink-3)"/></svg>
    );
    if (id === 'subtitle') return (
      <svg viewBox="0 0 80 48"><rect x="14" y="34" width="52" height="6" rx="1" fill="var(--ink)" opacity="0.82"/><rect x="20" y="36" width="40" height="2" fill="var(--paper)"/></svg>
    );
    if (id === 'callout') return (
      <svg viewBox="0 0 80 48"><rect x="18" y="10" width="44" height="22" rx="3" fill="var(--paper-card)" stroke="var(--accent)" strokeWidth="1.2"/><path d="M40 32l-4 6 8-2z" fill="var(--paper-card)" stroke="var(--accent)" strokeWidth="1.2"/><rect x="22" y="18" width="24" height="2" fill="var(--ink)"/><rect x="22" y="22" width="18" height="1.5" fill="var(--ink-3)"/></svg>
    );
    if (id === 'chapter') return (
      <svg viewBox="0 0 80 48"><rect x="6" y="20" width="6" height="8" fill="var(--accent)"/><rect x="16" y="22" width="38" height="2" fill="var(--ink)"/><rect x="16" y="26" width="24" height="1.5" fill="var(--ink-3)"/></svg>
    );
    if (id === 'pull-quote') return (
      <svg viewBox="0 0 80 48"><text x="8" y="22" fontFamily="var(--font-serif)" fontSize="18" fill="var(--accent-text)" fontStyle="italic">&ldquo;</text><rect x="16" y="14" width="50" height="2.5" fill="var(--ink)"/><rect x="16" y="20" width="42" height="2.5" fill="var(--ink)"/><rect x="16" y="26" width="36" height="2.5" fill="var(--ink-3)"/></svg>
    );
  }
  if (kind === 'shape') {
    if (id === 'rect')     return <svg viewBox="0 0 48 48"><rect x="10" y="14" width="28" height="20" fill="none" stroke="var(--ink)" strokeWidth="1.6"/></svg>;
    if (id === 'circle')   return <svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="12" fill="none" stroke="var(--ink)" strokeWidth="1.6"/></svg>;
    if (id === 'triangle') return <svg viewBox="0 0 48 48"><path d="M24 10l12 22H12z" fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeLinejoin="round"/></svg>;
    if (id === 'arrow')    return <svg viewBox="0 0 48 48"><path d="M10 24h24M28 18l6 6-6 6" fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>;
    if (id === 'line')     return <svg viewBox="0 0 48 48"><path d="M10 24h28" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round"/></svg>;
    if (id === 'bracket')  return <svg viewBox="0 0 48 48"><path d="M14 12h-4v24h4M34 12h4v24h-4" fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round"/></svg>;
  }
  if (kind === 'transition') {
    if (id === 'cut')      return <svg viewBox="0 0 64 32"><rect x="2"  y="6" width="26" height="20" fill="var(--paper-3)"/><rect x="36" y="6" width="26" height="20" fill="var(--ink-2)" opacity="0.7"/></svg>;
    if (id === 'fade')     return <svg viewBox="0 0 64 32"><defs><linearGradient id="el-fg" x1="0" x2="1"><stop offset="0%" stopColor="var(--paper-3)"/><stop offset="100%" stopColor="var(--ink)" stopOpacity="0.65"/></linearGradient></defs><rect x="2" y="6" width="60" height="20" fill="url(#el-fg)"/></svg>;
    if (id === 'dissolve') return <svg viewBox="0 0 64 32"><rect x="2"  y="6" width="60" height="20" fill="var(--paper-3)"/><circle cx="18" cy="16" r="2" fill="var(--ink)" opacity="0.4"/><circle cx="28" cy="22" r="1.6" fill="var(--ink)" opacity="0.55"/><circle cx="38" cy="12" r="1.4" fill="var(--ink)" opacity="0.65"/><circle cx="46" cy="20" r="2" fill="var(--ink)" opacity="0.75"/><circle cx="54" cy="14" r="1.8" fill="var(--ink)" opacity="0.85"/></svg>;
    if (id === 'wipe')     return <svg viewBox="0 0 64 32"><rect x="2" y="6" width="60" height="20" fill="var(--paper-3)"/><rect x="2" y="6" width="36" height="20" fill="var(--ink-2)" opacity="0.75"/><path d="M38 6v20" stroke="var(--accent)" strokeWidth="1.4"/></svg>;
    if (id === 'zoom')     return <svg viewBox="0 0 64 32"><rect x="6"  y="6" width="52" height="20" fill="none" stroke="var(--line-strong)"/><rect x="20" y="11" width="24" height="10" fill="none" stroke="var(--ink)" strokeWidth="1.4"/><path d="M6 6l14 5M58 6l-14 5M6 26l14-5M58 26l-14-5" stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="2 2"/></svg>;
    if (id === 'whip')     return <svg viewBox="0 0 64 32"><path d="M4 16q12 -14 28 0t28 0" fill="none" stroke="var(--ink)" strokeWidth="1.4"/><path d="M58 12l4 4-4 4" fill="none" stroke="var(--ink)" strokeWidth="1.4"/></svg>;
  }
  if (kind === 'marker') {
    if (id === 'pin')      return <svg viewBox="0 0 48 48"><path d="M24 8a8 8 0 0 1 8 8c0 6-8 16-8 16s-8-10-8-16a8 8 0 0 1 8-8z" fill="none" stroke="var(--ink)" strokeWidth="1.6"/><circle cx="24" cy="16" r="2.5" fill="var(--accent)"/></svg>;
    if (id === 'star')     return <svg viewBox="0 0 48 48"><path d="M24 10l4 8 9 1.4-6.5 6.3 1.5 9-8-4.3-8 4.3 1.5-9-6.5-6.3 9-1.4z" fill="none" stroke="var(--ink)" strokeWidth="1.4"/></svg>;
    if (id === 'flag')     return <svg viewBox="0 0 48 48"><path d="M14 8v32" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round"/><path d="M14 10h18l-4 6 4 6H14z" fill="var(--accent)" opacity="0.8" stroke="var(--ink)" strokeWidth="1.2" strokeLinejoin="round"/></svg>;
    if (id === 'numbered') return <svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="11" fill="none" stroke="var(--ink)" strokeWidth="1.4"/><text x="24" y="28" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="11" fill="var(--ink)">1</text></svg>;
  }
  return <svg viewBox="0 0 48 48"><rect x="10" y="14" width="28" height="20" fill="none" stroke="var(--ink-3)" strokeWidth="1.4"/></svg>;
}

// ── Main component ────────────────────────────────────────────────────────────
export function ElementsPanel() {
  const state = useEditorStore();
  const [message, setMessage] = useState<string | null>(null);
  const [activeCaptionStyle, setActiveCaptionStyle] = useState<string | null>(CAPTION_STYLES[0]?.id ?? null);
  const panelState = decidePanelState({
    loading: state.loading,
    panel: 'elements',
    project: state.project,
    diagnostics: state.diagnostics,
    transcript: state.transcript,
    jobs: state.jobs,
    providerRequests: state.providerRequests,
  });
  if (panelState !== 'ready') return <PanelState state={panelState} />;

  // ── Real operation builders (unchanged logic from previous version) ──────
  function rangeAtPlayhead() {
    const selection = state.selection && state.selection.end > state.selection.start ? state.selection : null;
    if (selection) return clipSpanTargetForRange(state.manifest, selection.start, selection.end, 'video');
    const entry = videoClipAtTime(state.manifest, state.currentTime);
    if (!entry) return null;
    const duration = Math.max(0, entry.clip.sourceEnd - entry.clip.sourceStart);
    const start = Math.max(0, Math.min(duration, state.currentTime - entry.clip.timelineStart));
    return { kind: 'clip-span' as const, trackId: entry.track.trackId, clipId: entry.clip.clipId, start, end: Math.min(duration, start + 3) };
  }

  function createCaption(styleId: string) {
    const captionTrack = state.manifest?.tracks.find((track) => track.kind === 'caption');
    if (!captionTrack) { setMessage('Add a caption track first.'); return; }
    void state.createOperation({ type: 'caption_style', target: { kind: 'track', trackId: captionTrack.trackId }, styleId, reason: `Caption style: ${styleId}` });
  }

  function createOverlay(kind: 'text' | 'shape', item: string) {
    const target = rangeAtPlayhead();
    if (!target || target.end <= target.start) { setMessage('Place the playhead on a clip first.'); return; }
    void state.createOperation({ type: 'overlay', target, source: kind === 'text' ? { kind: 'text', text: item } : { kind: 'shape', shape: item }, rect: { x: 0.12, y: 0.12, width: 0.42, height: 0.16 }, zIndex: 10, opacity: 1, reason: `Manual ${kind} overlay: ${item}` });
  }

  function createTransition(item: string) {
    const target = videoClipBoundaryAtTime(state.manifest, state.currentTime);
    if (!target) { setMessage('Place the playhead on a clip boundary first.'); return; }
    void state.createOperation({ type: 'transition', target, transitionType: item === 'dip-to-black' ? 'dip-to-black' : item === 'fade' ? 'fade' : 'crossfade', durationMs: 300, reason: `Manual transition: ${item}` });
  }

  function onAddElement(groupKind: string, id: string) {
    setMessage(null);
    if (groupKind === 'caption_style') return createCaption(id);
    if (groupKind === 'text') return createOverlay('text', id);
    if (groupKind === 'shape') return createOverlay('shape', id);
    if (groupKind === 'transition') return createTransition(id);
    // Markers: placeholder for a later chunk
    setMessage(`${groupKind} / ${id} is a placeholder for a later chunk.`);
  }

  return (
    <div className="view-elements">
      {message && <div className="panel-banner">{message}</div>}

      {/* ── Captions ──────────────────────────────────────────── */}
      <section className="view-section">
        <header className="view-section-head">
          <h4>Captions</h4>
          <span className="muted">{CAPTION_STYLES.length} presets</span>
        </header>
        <div className="caption-grid">
          {CAPTION_STYLES.map((cs) => (
            <button
              key={cs.id}
              type="button"
              className={`caption-tile ${activeCaptionStyle === cs.id ? 'active' : ''}`}
              onClick={() => {
                setActiveCaptionStyle(cs.id);
                onAddElement('caption_style', cs.id);
              }}
              title={cs.hint}
            >
              <div
                className="caption-preview"
                style={{
                  background: cs.swatch.bg === 'transparent'
                    ? 'repeating-conic-gradient(var(--paper-3) 0% 25%, var(--paper-2) 0% 50%) 50%/12px 12px'
                    : cs.swatch.bg,
                }}
              >
                <CaptionGlyph style={cs} />
              </div>
              <span className="caption-label">{cs.label}</span>
              <span className="caption-hint">{cs.hint}</span>
            </button>
          ))}
        </div>
      </section>

      {/* ── Brand packs ───────────────────────────────────────── */}
      <section className="view-section">
        <header className="view-section-head">
          <h4>Packs</h4>
          <span className="muted">brand kits</span>
        </header>
        <div className="pack-grid">
          {BRAND_PACKS.map((pack) => (
            <div
              key={pack.id}
              className={`pack-tile ${isActiveBrandPack(state.manifest?.brandPackId, pack.id) ? 'active' : ''} ${pack.installed ? 'installed' : ''}`}
              onClick={() => void state.setBrandPack(pack.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') void state.setBrandPack(pack.id); }}
              aria-pressed={isActiveBrandPack(state.manifest?.brandPackId, pack.id)}
            >
              <div className="pack-preview" style={{ background: pack.preview.bg }}>
                <PackGlyph pack={pack} />
                {pack.installed && <span className="pack-installed">installed</span>}
              </div>
              <div className="pack-meta">
                <span className="pack-label">{pack.label}</span>
                <span className="pack-desc">{pack.desc}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="pack-footer">
          <button type="button" className="skill-chip" disabled>› save current as pack</button>
          <button type="button" className="skill-chip" disabled>› import .etpack</button>
        </div>
      </section>

      {/* ── Text / Shapes / Transitions / Markers grids ───────── */}
      {ELEMENT_GROUPS.map((group) => (
        <section key={group.kind} className="view-section">
          <header className="view-section-head">
            <h4>{group.name}</h4>
            <span className="muted">{group.items.length}</span>
          </header>
          <div className="element-grid">
            {group.items.map((it) => (
              <button
                key={it.id}
                type="button"
                className="element-tile"
                disabled={group.kind === 'marker'}
                onClick={() => onAddElement(group.kind, it.id)}
                title={`Add ${it.label}`}
              >
                <div className={`element-preview kind-${group.kind}`}>
                  <ElementGlyph kind={group.kind} id={it.id} />
                </div>
                <span className="element-label">{it.label}</span>
              </button>
            ))}
          </div>
        </section>
      ))}

      {/* ── How ───────────────────────────────────────────────── */}
      <section className="view-section">
        <header className="view-section-head"><h4>How</h4></header>
        <div className="muted-block">
          Click a tile to drop it at the current playhead &mdash; appears in the manifest as a
          new overlay op. Caption styles apply to the burn-in caption track.
        </div>
      </section>
    </div>
  );
}
