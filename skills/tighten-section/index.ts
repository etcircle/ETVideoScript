#!/usr/bin/env node
import { WebSocket } from 'ws';
import type { ServerMessage, TranscriptWord } from '@etvideoscript/agent-protocol';

export type CutProposal = { requestId: string; clipId: string; start: number; end: number; reason: string };

function arg(name: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
function rangeArg() { const raw = arg('--range'); if (!raw) throw new Error('Missing --range start,end'); const [start, end] = raw.split(',').map(Number); if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Invalid --range start,end'); return { start, end }; }
function wordClipId(word: TranscriptWord): string { return word.clipId || 'clip_001'; }

export function tightenSectionProposals(words: TranscriptWord[]): CutProposal[] {
  for (let i = 0; i < words.length - 3; i += 1) {
    const targetClipId = wordClipId(words[i + 2]!);
    if (wordClipId(words[i + 3]!) !== targetClipId) continue;
    const a = `${words[i]!.normalized} ${words[i + 1]!.normalized}`.toLowerCase();
    const b = `${words[i + 2]!.normalized} ${words[i + 3]!.normalized}`.toLowerCase();
    if (a === b) {
      return [{
        requestId: 'tighten-0001',
        clipId: targetClipId,
        start: words[i + 2]!.start,
        end: words[i + 3]!.end,
        reason: `Remove repeated phrase: ${words[i + 2]!.text} ${words[i + 3]!.text}`
      }];
    }
  }
  return [];
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
  ws.send(JSON.stringify({ kind: 'hello', id: 'hello-tighten-section', protocolVersion: 3, agent: { name: 'ets-skill', skill: 'tighten-section' } }));
  await ready;
  const transcript = await call('get_transcript', { rangeSec: range });
  if (transcript.kind !== 'tool_result') throw new Error(transcript.kind === 'tool_error' ? transcript.error.message : 'get_transcript failed');
  const words = (transcript.result.result as { words: TranscriptWord[] }).words;
  const proposals = tightenSectionProposals(words);
  for (const proposal of proposals) {
    const response = await call('propose_operation', { requestId: proposal.requestId, type: 'cut', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: proposal.clipId, start: proposal.start, end: proposal.end }, reason: proposal.reason });
    if (response.kind === 'tool_error') throw new Error(response.error.message);
  }
  console.log(JSON.stringify({ skill: 'tighten-section', projectId, proposed: proposals.length }));
  ws.close();
}

if (process.argv[1]?.endsWith('skills/tighten-section/index.ts') || process.argv[1]?.endsWith('skills/tighten-section/index.js')) void main();
