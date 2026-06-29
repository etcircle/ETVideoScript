#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import type { ServerMessage, TranscriptWord } from '@etvideoscript/agent-protocol';
type ClipRole = 'intro' | 'body' | 'outro';
type ManifestV3Shape = { tracks: Array<{ trackId: string; clips: Array<{ clipId: string; assetPath?: string; sourceStart: number; sourceEnd: number }> }> };
export type ClipOrderProposal = { clipId: string; role: ClipRole; firstWords: string };
export type CutProposal = { requestId: string; trackId: string; clipId: string; start: number; end: number; reason: string };
export type AssemblePlan = { proposedOrder: string[]; orderJustification: string; cuts: CutProposal[]; reorderSupported: boolean };

function arg(name: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
function wordClipId(word: TranscriptWord): string { return word.clipId || 'clip_001'; }
function normalizedText(words: TranscriptWord[]): string { return words.map((word) => word.normalized || word.text).join(' ').toLowerCase(); }
function firstWords(words: TranscriptWord[], count = 30): string { return words.slice(0, count).map((word) => word.text).join(' '); }

function classifyClip(words: TranscriptWord[]): ClipRole {
  const opening = normalizedText(words.slice(0, 30));
  const closing = normalizedText(words.slice(-30));
  if (/\b(thanks for watching|see you next|subscribe|bye)\b/i.test(closing)) return 'outro';
  if (/\b(hello|welcome|today we|in this video)\b/i.test(opening)) return 'intro';
  return 'body';
}

function wordsByClip(words: TranscriptWord[]): Map<string, TranscriptWord[]> {
  const byClip = new Map<string, TranscriptWord[]>();
  for (const word of words) {
    const clipId = wordClipId(word);
    const list = byClip.get(clipId) ?? [];
    list.push(word);
    byClip.set(clipId, list);
  }
  return byClip;
}

export function proposeClipOrder(currentOrder: string[], words: TranscriptWord[]): { order: string[]; proposals: ClipOrderProposal[]; justification: string } {
  const byClip = wordsByClip(words);
  const proposals = currentOrder.map((clipId) => {
    const clipWords = byClip.get(clipId) ?? [];
    return { clipId, role: classifyClip(clipWords), firstWords: firstWords(clipWords) };
  });
  const rank: Record<ClipRole, number> = { intro: 0, body: 1, outro: 2 };
  const originalIndex = new Map(currentOrder.map((clipId, index) => [clipId, index]));
  const order = [...proposals].sort((a, b) => rank[a.role] - rank[b.role] || (originalIndex.get(a.clipId) ?? 0) - (originalIndex.get(b.clipId) ?? 0)).map((proposal) => proposal.clipId);
  const unchanged = order.join('\0') === currentOrder.join('\0');
  const reason = unchanged ? 'Upload order is already narrative-correct by heuristic roles' : 'Heuristic roles suggest a different narrative order';
  return { order, proposals, justification: `${reason}: ${proposals.map((p) => `${p.clipId}=${p.role}`).join(', ')}` };
}

export function proposeTighteningCuts(manifest: ManifestV3Shape, words: TranscriptWord[]): CutProposal[] {
  const byClip = wordsByClip(words);
  const clips = manifest.tracks.flatMap((track) => track.clips.map((clip) => ({ trackId: track.trackId, clip })));
  const cuts: CutProposal[] = [];
  for (const { trackId, clip } of clips) {
    const clipWords = [...(byClip.get(clip.clipId) ?? [])].sort((a, b) => a.start - b.start || a.end - b.end);
    if (!clipWords.length) continue;
    const first = clipWords[0]!;
    const last = clipWords.at(-1)!;
    const clipStart = clip.sourceStart;
    const clipEnd = clip.sourceEnd;
    const headEnd = Number(Math.min(first.start, clipStart + 0.5).toFixed(3));
    if (headEnd > clipStart) {
      cuts.push({ requestId: `assemble-cut-${String(cuts.length + 1).padStart(4, '0')}`, trackId, clipId: clip.clipId, start: clipStart, end: headEnd, reason: `Tighten dead air before first word: ${first.text}` });
    }
    const tailStart = Number(Math.max(last.end, clipEnd - 0.5).toFixed(3));
    if (tailStart < clipEnd) {
      cuts.push({ requestId: `assemble-cut-${String(cuts.length + 1).padStart(4, '0')}`, trackId, clipId: clip.clipId, start: tailStart, end: clipEnd, reason: `Tighten dead air after last word: ${last.text}` });
    }
  }
  return cuts;
}

export function buildAssemblePlan(manifest: ManifestV3Shape, words: TranscriptWord[]): AssemblePlan {
  const currentOrder = manifest.tracks[0]?.clips.map((clip) => clip.clipId) ?? [];
  const order = proposeClipOrder(currentOrder, words);
  return { proposedOrder: order.order, orderJustification: order.justification, cuts: proposeTighteningCuts(manifest, words), reorderSupported: false };
}

function callFactory(ws: WebSocket, pending: Map<string, (message: ServerMessage) => void>) {
  return function call(tool: string, params: unknown) {
    const id = `${tool}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return new Promise<ServerMessage>((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ kind: 'tool_call', id, protocolVersion: 3, tool, params }));
    });
  };
}

export async function main() {
  const wsUrl = arg('--ws-url');
  const token = arg('--token');
  const workspace = arg('--workspace');
  const projectId = arg('--project-id') || 'unknown';
  const narrativeHint = arg('--narrative-hint') || '';
  if (!wsUrl) throw new Error('Missing --ws-url');
  if (!workspace) throw new Error('Missing --workspace');

  const manifest = JSON.parse(readFileSync(join(resolve(workspace), 'edits/manifest.json'), 'utf8')) as ManifestV3Shape;
  const url = token ? `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : wsUrl;
  const ws = new WebSocket(url, { headers: { origin: 'http://127.0.0.1:4318' } });
  const pending = new Map<string, (message: ServerMessage) => void>();
  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    if (message.kind === 'tool_result' || message.kind === 'tool_error') pending.get(message.callId || message.id)?.(message);
  });
  const call = callFactory(ws, pending);
  await new Promise<void>((resolveOpen, reject) => { ws.once('open', resolveOpen); ws.once('error', reject); });
  const ready = new Promise<void>((resolveReady) => ws.once('message', () => resolveReady()));
  ws.send(JSON.stringify({ kind: 'hello', id: 'hello-assemble-from-clips', protocolVersion: 3, agent: { name: 'ets-skill', skill: 'assemble-from-clips' } }));
  await ready;

  const transcript = await call('get_transcript', {});
  if (transcript.kind !== 'tool_result') throw new Error(transcript.kind === 'tool_error' ? transcript.error.message : 'get_transcript failed');
  const words = (transcript.result.result as { words: TranscriptWord[] }).words;
  const plan = buildAssemblePlan(manifest, words);
  const currentOrder = manifest.tracks[0]?.clips.map((clip) => clip.clipId) ?? [];
  if (plan.proposedOrder.join('\0') !== currentOrder.join('\0')) {
    console.error(`assemble-from-clips: proposed reorder skipped; agent-protocol v2 exposes no clip-reorder tool. ${plan.orderJustification}`);
  }
  if (narrativeHint.trim()) console.error(`assemble-from-clips: narrative hint noted: ${narrativeHint.trim()}`);

  let cutsEmitted = 0;
  for (const cut of plan.cuts) {
    const response = await call('propose_operation', { requestId: cut.requestId, type: 'cut', target: { kind: 'clip-span', trackId: cut.trackId, clipId: cut.clipId, start: cut.start, end: cut.end }, reason: cut.reason });
    if (response.kind === 'tool_error') throw new Error(response.error.message);
    cutsEmitted += 1;
  }
  const renderState = await call('get_render_state', {});
  if (renderState.kind !== 'tool_result') throw new Error(renderState.kind === 'tool_error' ? renderState.error.message : 'get_render_state failed');
  const manifestValid = Boolean((renderState.result.result as { manifestValid?: boolean }).manifestValid);
  const summary = { proposedOrder: plan.proposedOrder, orderJustification: plan.orderJustification, cutsEmitted, manifestStateAfter: manifestValid ? 'valid' : 'invalid' };
  console.log(JSON.stringify(summary));
  ws.close();
  return summary;
}

if (process.argv[1]?.endsWith('skills/assemble-from-clips/index.ts') || process.argv[1]?.endsWith('skills/assemble-from-clips/index.js')) void main();
