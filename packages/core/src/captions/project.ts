import type { ManifestV3 } from '../manifest/schema';
import type { PillView } from '../operations/base';
import { getOperationKind } from '../operations/registry';
import type { TranscriptWords } from '../schemas';
import type { TimeMap } from '../timeMap/types';
import { outputTime } from '../timeMap/compose';

export type V3CaptionCue = { start: number; end: number; text: string; clipId?: string; sourceStart?: number; sourceEnd?: number };

type PendingCue = V3CaptionCue & { rank: number };

function cueText(text: string): string { return text.trim(); }

function groupCues(words: PendingCue[]): V3CaptionCue[] {
  const cues: V3CaptionCue[] = [];
  let current: V3CaptionCue | null = null;
  let currentRank = -1;
  for (const word of words.sort((a, b) => a.start - b.start || a.end - b.end || a.rank - b.rank)) {
    const shouldJoin = current && currentRank === 0 && word.rank === 0 && current.clipId === word.clipId && word.start - current.end <= 0.8 && `${current.text} ${word.text}`.length <= 90;
    if (shouldJoin) {
      current!.text = `${current!.text} ${word.text}`;
      current!.end = word.end;
      current!.sourceEnd = word.sourceEnd;
    } else {
      current = { start: word.start, end: word.end, text: word.text, clipId: word.clipId, sourceStart: word.sourceStart, sourceEnd: word.sourceEnd };
      currentRank = word.rank;
      cues.push(current);
    }
  }
  return cues;
}

export function projectCaptions(manifest: ManifestV3, transcript: TranscriptWords, timeMap: TimeMap): V3CaptionCue[] {
  const cues: PendingCue[] = [];
  const defaultClipId = manifest.tracks.flatMap((track) => track.clips)[0]?.clipId ?? '';
  for (const word of transcript.words) {
    const text = cueText(word.text);
    if (!text) continue;
    const clipId = word.clipId || defaultClipId;
    const start = outputTime(timeMap, clipId, word.start);
    const end = outputTime(timeMap, clipId, word.end);
    if (start == null || end == null || end <= start) continue;
    cues.push({ start, end, text, clipId, sourceStart: word.start, sourceEnd: word.end, rank: 0 });
  }
  const approvedViews = manifest.operations
    .filter((op) => op.status === 'approved' && getOperationKind(op.type).affectsTimeline)
    .map((op) => ({ op, view: getOperationKind(op.type).transcriptView(op) }))
    .filter((entry): entry is { op: ManifestV3['operations'][number]; view: PillView } => !!entry.view);

  for (const { op, view } of approvedViews) {
    const text = cueText(typeof view.details?.text === 'string' ? view.details.text : '');
    if (!text) continue;
    if (!('clipId' in op.target)) continue;
    const start = outputTime(timeMap, op.target.clipId, view.start);
    const end = outputTime(timeMap, op.target.clipId, view.end);
    if (start == null || end == null || end <= start) continue;
    cues.push({ start, end, text, clipId: op.target.clipId, sourceStart: view.start, sourceEnd: view.end, rank: 1 });
  }
  return groupCues(cues);
}

function srtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function vttTime(seconds: number): string { return srtTime(seconds).replace(',', '.'); }

export function captionsToSrt(cues: V3CaptionCue[]): string {
  return `${cues.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}`).join('\n\n')}\n`;
}

export function captionsToVtt(cues: V3CaptionCue[]): string {
  return `WEBVTT\n\n${cues.map((cue) => `${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${cue.text}`).join('\n\n')}\n`;
}
