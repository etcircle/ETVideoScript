"use client";

import { useEffect, useMemo } from 'react';
import { useEditorStore } from '../../../../store/editorStore';
import { clipSpanTargetsForRange } from '../../../../store/editTargets';
import { deriveSilences, deriveSweepCandidates, type SweepCandidate } from '../../../../store/designData';

/**
 * CleanupStrip — the v4 "clean-up sweep" bottom bar.
 *
 * Ported 1:1 from the design prototype (commands-v4.jsx L148-176 markup +
 * app-v4.jsx L383-454 sweep flow), re-grounded on the REAL coordinate model:
 *
 *  - candidates come from `deriveSweepCandidates` (designData.ts), which maps
 *    transcript fillers + the "you know" bigram + derived silences onto the
 *    TIMELINE axis and excludes ranges already covered by an enabled op;
 *  - "Skip" pushes the candidate id onto `sweepSkipped` (it then drops out of the
 *    memo, so the list shrinks and the index naturally lands on the next one);
 *  - "Cut" / "Cut all N" call the existing `createOperation({type:'cut', target})`
 *    flow — converting the candidate's timeline-axis span into a clip-span target
 *    via `clipSpanTargetsForRange` (the same primitive TranscriptPanel cuts use);
 *  - the strip self-sources every bit of state from the store, like the panels.
 *
 * Renders nothing unless `sweepActive`. Mounted alongside the editor shell.
 */

/** Format seconds to a compact timecode string, e.g. 0:01:23.4 (matches the panels). */
function formatTC(sec: number): string {
  const v = Math.max(0, sec);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = (v % 60).toFixed(1).padStart(4, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${s}`;
  return `${m}:${s}`;
}

export function CleanupStrip() {
  const sweepActive = useEditorStore((s) => s.sweepActive);
  const sweepIndex = useEditorStore((s) => s.sweepIndex);
  const sweepSkipped = useEditorStore((s) => s.sweepSkipped);
  const transcript = useEditorStore((s) => s.transcript);
  const manifest = useEditorStore((s) => s.manifest);
  const setSweepIndex = useEditorStore((s) => s.setSweepIndex);
  const addSweepSkipped = useEditorStore((s) => s.addSweepSkipped);
  const closeSweep = useEditorStore((s) => s.closeSweep);
  const createOperation = useEditorStore((s) => s.createOperation);
  const seek = useEditorStore((s) => s.seek);

  // Derive candidates on the real coordinate model, then drop the skipped ones —
  // mirroring the prototype's `sweepCandidates` memo (app-v4.jsx L383-405). Recomputes
  // when the manifest's operations change so accepted cuts stop reappearing.
  const operations = manifest?.operations;
  const candidates: SweepCandidate[] = useMemo(() => {
    if (!sweepActive) return [];
    const words = transcript?.words ?? [];
    const silences = deriveSilences(words);
    const all = deriveSweepCandidates(transcript, manifest, silences, operations ?? []);
    return all.filter((c) => !sweepSkipped.includes(c.id));
    // operations is the live op array; including it re-derives after each cut.
  }, [sweepActive, transcript, manifest, operations, sweepSkipped]);

  const n = candidates.length;
  const i = Math.min(sweepIndex, Math.max(0, n - 1));
  const cur = candidates[i] ?? null;

  // Seek the playhead to the candidate under review (prototype app-v4.jsx L410-412).
  const curId = cur?.id ?? null;
  const curStart = cur?.start ?? 0;
  useEffect(() => {
    if (sweepActive && curId != null) seek(Math.max(0, curStart));
  }, [sweepActive, curId, curStart, seek]);

  // Build the cut op(s) for a candidate's timeline-axis span. A single candidate
  // usually maps to one clip-span target, but a span crossing a clip boundary can
  // yield several — we create one cut op per target (TranscriptPanel does the same).
  // Anchor to the candidate's OWN clip (the clip its words belong to / the clip
  // bracketing a silence) so a sweep never cuts unrelated overlapping tracks
  // (music / SFX / captions). With no clip identity (legacy/untagged transcript)
  // we still must NOT fan out to every overlapping clip — restrict to the primary
  // video track, where the screen-recording speech (and thus fillers) lives.
  function cutCandidate(c: SweepCandidate) {
    const targets = c.clipId
      ? clipSpanTargetsForRange(manifest, c.start, c.end).filter((t) => t.clipId === c.clipId)
      : clipSpanTargetsForRange(manifest, c.start, c.end, 'video');
    const reason =
      c.kind === 'silence'
        ? `Dead air ${(c.end - c.start).toFixed(2)}s`
        : `Filler "${c.text}"`;
    for (const target of targets) {
      void createOperation({ type: 'cut', target, reason });
    }
  }

  if (!sweepActive) return null;

  function onStep(delta: number) {
    const max = Math.max(0, n - 1);
    setSweepIndex(Math.max(0, Math.min(max, i + delta)));
  }

  function onSkip() {
    if (!cur) return;
    addSweepSkipped(cur.id);
    // The skipped candidate drops out of the memo on the next render; clamp the
    // index so we stay in range (the list got shorter by one).
    setSweepIndex(Math.min(i, Math.max(0, n - 2)));
  }

  function onCut() {
    if (!cur) return;
    cutCandidate(cur);
    // The cut range is now covered by an enabled op, so this candidate drops out of
    // the memo. Keep the index pointed at the next remaining candidate.
    setSweepIndex(Math.min(i, Math.max(0, n - 2)));
  }

  function onCutAll() {
    if (!n) return;
    for (const c of candidates) cutCandidate(c);
    setSweepIndex(0);
  }

  return (
    <div className="sweep-bar">
      <span className="sweep-kicker">✦ Clean up</span>
      {n === 0 ? (
        <span className="sweep-done">All clean — no fillers or dead air left. ⌘Z to undo.</span>
      ) : (
        <>
          <span className="sweep-count">{i + 1}/{n}</span>
          <span className={`sweep-chip ${cur!.kind}`}>{cur!.kind === 'silence' ? '⊘ dead air' : '− filler'}</span>
          <span className="sweep-text">
            {cur!.kind === 'silence' ? `${(cur!.end - cur!.start).toFixed(2)}s of silence` : `“${cur!.text}”`}
          </span>
          <span className="sweep-time">{formatTC(cur!.start)}</span>
          <span className="sweep-spacer"></span>
          <button className="sweep-nav" onClick={() => onStep(-1)} disabled={i === 0} title="Previous">‹</button>
          <button className="sweep-nav" onClick={() => onStep(1)} disabled={i >= n - 1} title="Next">›</button>
          <button className="sweep-skip" onClick={onSkip} title="Leave this one in">Skip</button>
          <button className="sweep-cut" onClick={onCut} title="Cut this one (⏎)">Cut <span className="k">⏎</span></button>
          <button className="sweep-all" onClick={onCutAll} title="Cut every remaining filler & dead-air candidate (each is a separate, reversible cut)">Cut all {n}</button>
        </>
      )}
      <button className="sweep-close" onClick={closeSweep} title="Close (esc)">×</button>
    </div>
  );
}

export default CleanupStrip;
