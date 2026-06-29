#!/usr/bin/env node
import { WebSocket } from 'ws';
import type { ServerMessage, TranscriptWord } from '@etvideoscript/agent-protocol';

export type VoicePatchProposal = { requestId: string; clipId: string; start: number; end: number; text: string; provider: 'mock'; voice: string; reason: string };

function arg(name: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
function rangeArg() { const raw = arg('--range'); if (!raw) throw new Error('Missing --range start,end'); const [start, end] = raw.split(',').map(Number); if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Invalid --range start,end'); return { start, end }; }
function wordClipId(word: TranscriptWord): string { return word.clipId || 'clip_001'; }

export function polishNarrationProposals(words: TranscriptWord[]): VoicePatchProposal[] {
  const groups: TranscriptWord[][] = [];
  for (const word of words) {
    const last = groups.at(-1);
    if (!last || wordClipId(last[0]!) !== wordClipId(word)) groups.push([word]);
    else last.push(word);
  }
  return groups.map((group, index) => ({
    requestId: `polish-${String(index + 1).padStart(4, '0')}`,
    clipId: wordClipId(group[0]!),
    start: group[0]!.start,
    end: group.at(-1)!.end,
    text: group.map((word) => word.text).join(' ').toUpperCase(),
    provider: 'mock' as const,
    voice: 'eve',
    reason: 'Polish narration copy with mock voice'
  })).filter((proposal) => proposal.text.trim());
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
  const wsUrl = arg('--ws-url'); const token = arg('--token'); const projectId = arg('--project-id') || 'unknown'; if (!wsUrl) throw new Error('Missing --ws-url');
  const url = token ? `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : wsUrl;
  const ws = new WebSocket(url, { headers: { origin: 'http://127.0.0.1:4318' } });
  const pending = new Map<string, (message: ServerMessage) => void>();
  ws.on('message', (data) => { const message = JSON.parse(String(data)) as ServerMessage; if (message.kind === 'tool_result' || message.kind === 'tool_error') pending.get(message.callId || message.id)?.(message); });
  const call = callFactory(ws, pending);
  const range = rangeArg();
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const ready = new Promise<void>((resolve) => ws.once('message', () => resolve()));
  ws.send(JSON.stringify({ kind: 'hello', id: 'hello-polish-narration', protocolVersion: 3, agent: { name: 'ets-skill', skill: 'polish-narration' } }));
  await ready;
  const transcript = await call('get_transcript', { rangeSec: range });
  if (transcript.kind !== 'tool_result') throw new Error(transcript.kind === 'tool_error' ? transcript.error.message : 'get_transcript failed');
  const words = (transcript.result.result as { words: TranscriptWord[] }).words;
  const proposals = polishNarrationProposals(words);
  for (const proposal of proposals) {
    const response = await call('propose_operation', { requestId: proposal.requestId, type: 'voice_patch', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: proposal.clipId, start: proposal.start, end: proposal.end }, text: proposal.text, provider: proposal.provider, voice: proposal.voice, reason: proposal.reason });
    if (response.kind === 'tool_error') throw new Error(response.error.message);
  }
  console.log(JSON.stringify({ skill: 'polish-narration', projectId, proposed: proposals.length }));
  ws.close();
}

if (process.argv[1]?.endsWith('skills/polish-narration/index.ts') || process.argv[1]?.endsWith('skills/polish-narration/index.js')) void main();
