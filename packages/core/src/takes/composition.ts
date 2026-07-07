import type { ManifestV3 } from '../manifest/schema';
import type { TranscriptWord } from '../schemas';
import type { AlignmentArtifact, CompositionFile, SpanCandidate } from './schema';

export const COMPOSE_PAD = { headSec: 0.12, tailSec: 0.12 } as const;
const BOUNDARY_WARN_THRESHOLD = 0.5;

export interface MaterializedClipPlan {
  order: number; clipId: string; assetId: string;
  sourceStart: number; sourceEnd: number; timelineStart: number; durationSec: number;
  spanIds?: string[]; orphanId?: string; chapterTitle?: string;
}
export interface CompositionIssue { rule: string; message: string; spanId?: string; clipId?: string }
export interface CompositionValidation { errors: CompositionIssue[]; warnings: CompositionIssue[]; plan: MaterializedClipPlan[] }

export function validateComposition(manifest: ManifestV3, alignment: AlignmentArtifact, composition: CompositionFile, takeTranscripts?: Map<string, TranscriptWord[]>): CompositionValidation {
  const errors: CompositionIssue[] = [];
  const warnings: CompositionIssue[] = [];

  const group = manifest.takeGroups.find((g) => g.groupId === composition.groupId);
  if (!group) errors.push({ rule: 'V1', message: `Unknown take group: ${composition.groupId}` });
  if (alignment.groupId !== composition.groupId) errors.push({ rule: 'V1', message: `Alignment groupId ${alignment.groupId} != composition groupId ${composition.groupId}` });
  if (errors.length) return { errors, warnings, plan: [] };

  const spanOrdinal = new Map(alignment.spans.map((s) => [s.spanId, s.ordinal]));
  const candidateOf = new Map<string, SpanCandidate>();
  for (const c of alignment.candidates) candidateOf.set(`${c.spanId}\0${c.clipId}`, c);
  const orphanOf = new Map(alignment.orphans.map((o) => [o.orphanId, o]));
  const assetOfClip = new Map<string, string>();
  const durationOfAsset = new Map(manifest.assets.map((a) => [a.assetId, a.durationSec]));
  for (const track of manifest.tracks) for (const clip of track.clips) assetOfClip.set(clip.clipId, clip.assetId);

  // V4 order dense 1..N
  const orders = composition.selections.map((s) => s.order).sort((a, b) => a - b);
  if (orders.some((o, i) => o !== i + 1)) errors.push({ rule: 'V4', message: `Selection orders must be unique and 1..N dense, got ${orders.join(',')}` });

  // V5 span/orphan used once
  const usedSpans = new Set<string>();
  for (const sel of composition.selections) {
    for (const spanId of sel.spanIds ?? []) { if (usedSpans.has(spanId)) errors.push({ rule: 'V5', message: `span used more than once`, spanId }); usedSpans.add(spanId); }
    if (sel.orphanId) { if (usedSpans.has(sel.orphanId)) errors.push({ rule: 'V5', message: `orphan used more than once`, spanId: sel.orphanId }); usedSpans.add(sel.orphanId); }
  }

  const ordered = [...composition.selections].sort((a, b) => a.order - b.order);
  const plan: MaterializedClipPlan[] = [];
  let timelineStart = 0;
  let prevMaxOrdinal = 0;

  for (const sel of ordered) {
    if (!group!.clipIds.includes(sel.clipId)) { errors.push({ rule: 'V2', message: `clip not in group`, clipId: sel.clipId }); continue; }
    const assetId = assetOfClip.get(sel.clipId);
    if (!assetId) { errors.push({ rule: 'V2', message: `clip has no asset`, clipId: sel.clipId }); continue; }

    let firstCandidate: SpanCandidate | undefined;
    let lastCandidate: SpanCandidate | undefined;
    let selWordStart: number;
    let selWordEnd: number;

    if (sel.orphanId) {
      const orphan = orphanOf.get(sel.orphanId);
      if (!orphan) { errors.push({ rule: 'V2', message: `unknown orphan`, spanId: sel.orphanId }); continue; }
      if (orphan.clipId !== sel.clipId) { errors.push({ rule: 'V2', message: `orphan ${sel.orphanId} belongs to ${orphan.clipId}, not ${sel.clipId}`, clipId: sel.clipId }); continue; }
      selWordStart = orphan.takeWordStart; selWordEnd = orphan.takeWordEnd;
    } else {
      const spanIds = sel.spanIds!;
      const ordinals = spanIds.map((id) => spanOrdinal.get(id));
      if (ordinals.some((o) => o === undefined)) { errors.push({ rule: 'V2', message: `unknown spanId in ${spanIds.join(',')}`, clipId: sel.clipId }); continue; }
      const sorted = (ordinals as number[]).slice().sort((a, b) => a - b);
      if (sorted.some((o, i) => i > 0 && o !== sorted[i - 1] + 1)) { errors.push({ rule: 'V3', message: `spans not contiguous: ${spanIds.join(',')}`, clipId: sel.clipId }); continue; }
      const cands = spanIds.map((id) => candidateOf.get(`${id}\0${sel.clipId}`));
      if (cands.some((c) => !c)) { errors.push({ rule: 'V3', message: `no candidate for one of ${spanIds.join(',')} on ${sel.clipId}`, clipId: sel.clipId }); continue; }
      const present = cands as SpanCandidate[];
      firstCandidate = present.reduce((a, b) => (spanOrdinal.get(a.spanId)! <= spanOrdinal.get(b.spanId)! ? a : b));
      lastCandidate = present.reduce((a, b) => (spanOrdinal.get(a.spanId)! >= spanOrdinal.get(b.spanId)! ? a : b));
      selWordStart = firstCandidate.takeWordStart; selWordEnd = lastCandidate.takeWordEnd;

      // W4 reorder
      const minOrdinal = Math.min(...(ordinals as number[]));
      if (minOrdinal < prevMaxOrdinal) warnings.push({ rule: 'W4', message: `spans ${spanIds.join(',')} appear out of reference order`, clipId: sel.clipId });
      prevMaxOrdinal = Math.max(prevMaxOrdinal, Math.max(...(ordinals as number[])));

      // W1 seam risk (tail of this vs head of next handled after loop via plan metrics)
      // W3 low coverage/truncated
      for (const c of present) if (c.coverage < 0.8 || c.truncated) warnings.push({ rule: 'W3', message: `candidate ${c.spanId}/${c.clipId} coverage ${c.coverage}${c.truncated ? ' truncated' : ''}`, spanId: c.spanId, clipId: c.clipId });
    }

    // V6 trim leaves >= 1 word
    const head = sel.trim?.headWords ?? 0;
    const tail = sel.trim?.tailWords ?? 0;
    const startWord = selWordStart + head;
    const endWord = selWordEnd - tail;
    if (startWord > endWord) { errors.push({ rule: 'V6', message: `trim removes all words for ${sel.clipId}`, clipId: sel.clipId }); continue; }

    // Source times (spec §10 step 1): when the take transcript is available, use per-word
    // timings so (a) trim shifts the times, and (b) the COMPOSE_PAD is clamped to the
    // neighbouring UNSELECTED word so it cannot bleed adjacent audio. `startWord`/`endWord`
    // are original take-word indices AFTER trim. Fall back to candidate span boundaries +
    // [0, assetDuration] only when no transcript is passed (pure rule-logic tests).
    const assetDur = durationOfAsset.get(assetId) ?? Infinity;
    const takeWords = takeTranscripts?.get(sel.clipId);
    let sourceStart: number;
    let sourceEnd: number;
    if (takeWords && takeWords[startWord] && takeWords[endWord]) {
      const prevWordEnd = startWord > 0 ? takeWords[startWord - 1].end : 0;
      const nextWordStart = endWord < takeWords.length - 1 ? takeWords[endWord + 1].start : assetDur;
      sourceStart = Math.max(0, prevWordEnd, takeWords[startWord].start - COMPOSE_PAD.headSec);
      sourceEnd = Math.min(assetDur, nextWordStart, takeWords[endWord].end + COMPOSE_PAD.tailSec);
    } else {
      const baseStart = sel.orphanId ? orphanOf.get(sel.orphanId)!.tStart : firstCandidate!.tStart;
      const baseEnd = sel.orphanId ? orphanOf.get(sel.orphanId)!.tEnd : lastCandidate!.tEnd;
      sourceStart = Math.max(0, baseStart - COMPOSE_PAD.headSec);
      sourceEnd = Math.min(assetDur, baseEnd + COMPOSE_PAD.tailSec);
    }
    if (!(sourceStart < sourceEnd)) { errors.push({ rule: 'V7', message: `empty source range for ${sel.clipId}`, clipId: sel.clipId }); continue; }

    const durationSec = sourceEnd - sourceStart;
    plan.push({ order: plan.length + 1, clipId: `clip_comp_${String(plan.length + 1).padStart(3, '0')}`, assetId, sourceStart, sourceEnd, timelineStart, durationSec, spanIds: sel.spanIds, orphanId: sel.orphanId, chapterTitle: sel.chapterTitle });
    timelineStart += durationSec;
  }

  // W1 seams: between consecutive plan entries, look up tail/head boundary scores from candidates
  for (let i = 0; i + 1 < ordered.length; i++) {
    const cur = ordered[i];
    const next = ordered[i + 1];
    const curTail = cur.spanIds ? candidateOf.get(`${cur.spanIds[cur.spanIds.length - 1]}\0${cur.clipId}`)?.metrics.tailBoundaryScore : undefined;
    const nextHead = next.spanIds ? candidateOf.get(`${next.spanIds[0]}\0${next.clipId}`)?.metrics.headBoundaryScore : undefined;
    if ((curTail !== undefined && curTail < BOUNDARY_WARN_THRESHOLD) || (nextHead !== undefined && nextHead < BOUNDARY_WARN_THRESHOLD)) {
      warnings.push({ rule: 'W1', message: `risky seam between selection ${cur.order} and ${next.order} (tail ${curTail ?? 'na'}, head ${nextHead ?? 'na'})` });
    }
  }

  // W2 dropped spans
  const declaredGapSpans = new Set(composition.gaps.flatMap((g) => g.spanIds));
  for (const span of alignment.spans) {
    if (!usedSpans.has(span.spanId) && !declaredGapSpans.has(span.spanId)) warnings.push({ rule: 'W2', message: `span ${span.spanId} dropped and not declared in gaps`, spanId: span.spanId });
  }

  return { errors, warnings, plan: errors.length ? [] : plan };
}

export function materializeComposition(manifest: ManifestV3, plan: MaterializedClipPlan[]): ManifestV3 {
  const clone: ManifestV3 = JSON.parse(JSON.stringify(manifest));
  const timeline = clone.tracks.find((t) => t.kind === 'video' && t.role !== 'staging') ?? clone.tracks.find((t) => t.role !== 'staging');
  if (!timeline) throw new Error('No timeline video track to materialize into');
  // Every prior timeline clip is being replaced. Any op targeting one is now stale (its
  // clip holds different footage after a re-compose), so disable it - never delete (spec
  // §10.3). Do NOT also require the id to be absent from the new plan: clip_comp numbering
  // restarts at 001, so a same-count reapply reuses the same id strings for different
  // content; excluding new ids would leave a mute/cut wrongly active on re-purposed footage.
  const replacedClipIds = new Set(timeline.clips.map((c) => c.clipId));
  timeline.clips = plan.map((p) => ({ clipId: p.clipId, assetId: p.assetId, sourceStart: p.sourceStart, sourceEnd: p.sourceEnd, timelineStart: p.timelineStart }));
  for (const op of clone.operations) {
    const target = op.target as { clipId?: string };
    if (target.clipId && replacedClipIds.has(target.clipId) && op.status !== 'disabled') op.status = 'disabled';
  }
  return clone;
}
