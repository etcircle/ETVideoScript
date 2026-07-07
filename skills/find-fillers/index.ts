#!/usr/bin/env node
import { WebSocket } from 'ws';
import type { ServerMessage, TranscriptWord } from '@etvideoscript/agent-protocol';
import { FILLER_LEXICON } from '@etvideoscript/core';

export type TimedClipProposal = { requestId: string; clipId: string; start: number; end: number; reason: string };

function arg(name: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
function wordClipId(word: TranscriptWord): string { return word.clipId || 'clip_001'; }

export function findFillerMuteProposals(words: TranscriptWord[]): TimedClipProposal[] {
  return words
    .filter((word) => FILLER_LEXICON.includes((word.normalized || word.text).toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')))
    .map((word, index) => ({
      requestId: `fillers-${String(index).padStart(4, '0')}`,
      clipId: wordClipId(word),
      start: word.start,
      end: word.end,
      reason: `Mute filler word: ${word.text}`
    }));
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
  const projectId = arg('--project-id') || 'unknown';
  if (!wsUrl) throw new Error('Missing --ws-url');
  const url = token ? `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : wsUrl;
  const ws = new WebSocket(url, { headers: { origin: 'http://127.0.0.1:4318' } });
  const pending = new Map<string, (message: ServerMessage) => void>();
  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    if (message.kind === 'tool_result' || message.kind === 'tool_error') pending.get(message.callId || message.id)?.(message);
  });
  const call = callFactory(ws, pending);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const ready = new Promise<void>((resolve) => ws.once('message', () => resolve()));
  ws.send(JSON.stringify({ kind: 'hello', id: 'hello-find-fillers', protocolVersion: 3, agent: { name: 'ets-skill', skill: 'find-fillers' } }));
  await ready;
  const transcript = await call('get_transcript', {});
  if (transcript.kind !== 'tool_result') throw new Error(transcript.kind === 'tool_error' ? transcript.error.message : 'get_transcript failed');
  const words = (transcript.result.result as { words: TranscriptWord[] }).words;
  const proposals = findFillerMuteProposals(words);
  for (const proposal of proposals) {
    const response = await call('propose_operation', { requestId: proposal.requestId, type: 'mute', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: proposal.clipId, start: proposal.start, end: proposal.end }, reason: proposal.reason });
    if (response.kind === 'tool_error') throw new Error(response.error.message);
  }
  console.log(JSON.stringify({ skill: 'find-fillers', projectId, proposed: proposals.length }));
  ws.close();
}

if (process.argv[1]?.endsWith('skills/find-fillers/index.ts') || process.argv[1]?.endsWith('skills/find-fillers/index.js')) void main();
