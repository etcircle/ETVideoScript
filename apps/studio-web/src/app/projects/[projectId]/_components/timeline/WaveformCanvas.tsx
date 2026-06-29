"use client";
import { useEffect, useMemo, useRef } from 'react';
import type { ClipTimelineEntry, WaveformPeaks } from './waveform';
import { operationToneAt, type TimelineOperationView, type WaveBarTone } from './operationTones';

// Hex fallbacks mirror editor.css design tokens. Resolved from CSS vars at
// draw-time when possible so the waveform tracks theme changes without drift.
const TONE_FALLBACK: Record<Exclude<WaveBarTone, null>, string> = {
  cut: '#d8a279',
  mute: '#102a3a',
  voice_patch: '#6e8b5b'
};
const TONE_VAR: Record<Exclude<WaveBarTone, null>, string> = {
  cut: '--wave-cut',
  mute: '--ink-blue',
  voice_patch: '--live'
};
// Resting waveform reads as neutral ink (matches the design prototype's
// `.wave .bar { background: var(--ink-2); opacity: .55 }`) so the salmon
// silence/op overlays stand out against it instead of blending in.
const DEFAULT_FALLBACK = '#3a342b';
const DEFAULT_VAR = '--ink-2';
const TONE_ALPHA: Record<Exclude<WaveBarTone, null>, number> = {
  cut: 0.55,
  mute: 0.65,
  voice_patch: 0.85
};
const DEFAULT_ALPHA = 0.55;

function resolveColor(styles: CSSStyleDeclaration, varName: string, fallback: string): string {
  const value = styles.getPropertyValue(varName).trim();
  return value || fallback;
}

type Column = { amp: number; tone: WaveBarTone };

export function buildWaveColumns(input: {
  clipPeaks: Record<string, WaveformPeaks>;
  clipTimeline: ClipTimelineEntry[];
  operations: TimelineOperationView[];
  duration: number;
  cssWidth: number;
}): Column[] {
  const { clipPeaks, clipTimeline, operations, duration, cssWidth } = input;
  if (duration <= 0 || cssWidth <= 0) return [];
  const columns: Column[] = Array.from({ length: cssWidth }, () => ({ amp: 0, tone: null }));
  for (const clip of clipTimeline) {
    const doc = clipPeaks[clip.clipId];
    if (!doc || !doc.peaks?.length || !doc.resolutionHz) continue;
    const clipLeftPx = (clip.outputStartOffset / duration) * cssWidth;
    const clipWidthPx = Math.max(0, (clip.durationSec / duration) * cssWidth);
    if (clipWidthPx <= 0) continue;
    // Iterate over destination columns the clip touches (instead of a local x
    // range) so fractional clipLeftPx alignment can't drop the trailing edge
    // pixel and partial-coverage columns sample only the time they actually
    // cover. Credit: codex review note on resampling correctness.
    const startX = Math.max(0, Math.floor(clipLeftPx));
    const endX = Math.min(cssWidth, Math.ceil(clipLeftPx + clipWidthPx));
    for (let destX = startX; destX < endX; destX += 1) {
      const localStartPx = Math.max(0, destX - clipLeftPx);
      const localEndPx = Math.min(clipWidthPx, destX + 1 - clipLeftPx);
      const tStart = (localStartPx / clipWidthPx) * clip.durationSec;
      const tEnd = (localEndPx / clipWidthPx) * clip.durationSec;
      const iStart = Math.max(0, Math.floor(tStart * doc.resolutionHz));
      const iEnd = Math.min(doc.peaks.length, Math.max(iStart + 1, Math.ceil(tEnd * doc.resolutionHz)));
      let peak = 0;
      for (let i = iStart; i < iEnd; i += 1) {
        const [min, max] = doc.peaks[i]!;
        const m = Math.max(Math.abs(min), Math.abs(max));
        if (m > peak) peak = m;
      }
      if (peak > columns[destX].amp) columns[destX].amp = peak;
    }
  }
  // Viewport-relative normalization: divide by global max so the loudest pixel
  // currently in view reaches full height, then gamma=0.65 to keep quiet
  // content visible without crushing peaks. This is a *display* normalization,
  // not absolute loudness — multi-clip projects with different recording
  // levels won't be visually comparable. Acceptable trade-off; revisit if a
  // user reports it (codex P2 noted).
  let globalMax = 0;
  for (const c of columns) if (c.amp > globalMax) globalMax = c.amp;
  if (globalMax > 0) {
    for (const c of columns) c.amp = Math.pow(c.amp / globalMax, 0.65);
  }
  // Tag each column with its operation tone (operations are already filtered
  // upstream to the current track only).
  for (let x = 0; x < cssWidth; x += 1) {
    const tStart = (x / cssWidth) * duration;
    const tEnd = ((x + 1) / cssWidth) * duration;
    columns[x].tone = operationToneAt(operations, tStart, tEnd);
  }
  return columns;
}

export function WaveformCanvas({ clipPeaks, clipTimeline, pxWidth, height, duration, operations, ariaLabel }: {
  clipPeaks: Record<string, WaveformPeaks>;
  clipTimeline: ClipTimelineEntry[];
  pxWidth: number;
  height: number;
  duration: number;
  operations: TimelineOperationView[];
  ariaLabel: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const columns = useMemo(() => buildWaveColumns({ clipPeaks, clipTimeline, operations, duration, cssWidth: Math.floor(pxWidth) }), [clipPeaks, clipTimeline, operations, duration, pxWidth]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const cssW = Math.floor(pxWidth);
    const cssH = Math.floor(height);
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    // Resolve colors from CSS vars once per draw so theme changes flow through
    // without code edits. Fall back to inlined hexes if the var is unset.
    const styles = window.getComputedStyle(canvas);
    const defaultColor = resolveColor(styles, DEFAULT_VAR, DEFAULT_FALLBACK);
    const toneColor: Record<Exclude<WaveBarTone, null>, string> = {
      cut: resolveColor(styles, TONE_VAR.cut, TONE_FALLBACK.cut),
      mute: resolveColor(styles, TONE_VAR.mute, TONE_FALLBACK.mute),
      voice_patch: resolveColor(styles, TONE_VAR.voice_patch, TONE_FALLBACK.voice_patch)
    };
    const midY = cssH / 2;
    const halfH = cssH * 0.46;
    const minAmpPx = 0.5; // hairline so silent regions still register the centre line
    for (let x = 0; x < columns.length; x += 1) {
      const col = columns[x];
      const amp = Math.max(minAmpPx / Math.max(1, halfH), col.amp);
      const tone = col.tone;
      ctx.fillStyle = tone ? toneColor[tone] : defaultColor;
      ctx.globalAlpha = tone ? TONE_ALPHA[tone] : DEFAULT_ALPHA;
      const h = amp * halfH;
      ctx.fillRect(x, midY - h, 1, h * 2);
    }
    ctx.globalAlpha = 1;
  }, [columns, pxWidth, height]);

  return <canvas ref={canvasRef} className="tl-wave-canvas" role="img" aria-label={ariaLabel} />;
}
