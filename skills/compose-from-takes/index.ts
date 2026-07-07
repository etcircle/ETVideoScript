#!/usr/bin/env node
import { WebSocket } from 'ws';
import type { ServerMessage } from '@etvideoscript/agent-protocol';

function arg(name: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
// Mutating tools (takes_align, compose_apply) require a requestId for the API's idempotency
// tracking; matches RequestIdSchema in @etvideoscript/agent-protocol (8-128 chars, [a-zA-Z0-9_-]).
function newRequestId(tool: string) { return `${tool}-${Date.now()}-${Math.floor(performance.now())}`; }

function callFactory(ws: WebSocket, pending: Map<string, (m: ServerMessage) => void>) {
  return (tool: string, params: unknown) => new Promise<ServerMessage>((resolveCall) => {
    const id = `${tool}-${Date.now()}-${Math.floor(performance.now())}`;
    pending.set(id, resolveCall);
    ws.send(JSON.stringify({ kind: 'tool_call', id, protocolVersion: 3, tool, params }));
  });
}

export async function main() {
  const wsUrl = arg('--ws-url'); const token = arg('--token'); const group = arg('--group') || 'main';
  if (!wsUrl) throw new Error('Missing --ws-url');
  const url = token ? `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : wsUrl;
  const ws = new WebSocket(url, { headers: { origin: 'http://127.0.0.1:4318' } });
  const pending = new Map<string, (m: ServerMessage) => void>();
  ws.on('message', (data) => { const m = JSON.parse(String(data)) as ServerMessage; if (m.kind === 'tool_result' || m.kind === 'tool_error') pending.get(m.callId || m.id)?.(m); });
  const call = callFactory(ws, pending);
  await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const ready = new Promise<void>((res) => ws.once('message', () => res()));
  ws.send(JSON.stringify({ kind: 'hello', id: 'hello-compose-from-takes', protocolVersion: 3, agent: { name: 'ets-skill', skill: 'compose-from-takes' } }));
  await ready;

  const brief = await call('brief_show', {});
  if (brief.kind === 'tool_error') { console.error(`compose-from-takes: no brief - run 'ets brief init' first. ${brief.error.message}`); ws.close(); return { skill: 'compose-from-takes', status: 'no-brief' }; }

  const align = await call('takes_align', { requestId: newRequestId('takes-align'), groupId: group });
  if (align.kind !== 'tool_result') throw new Error(align.kind === 'tool_error' ? align.error.message : 'align failed');
  const alignment = align.result.result as { spans: Array<{ spanId: string }>; candidates: Array<{ spanId: string; clipId: string; coverage: number; matchQuality: number; metrics: { fillerCount: number; falseStartCount: number } }> };

  const composite = (c: { matchQuality: number; metrics: { fillerCount: number; falseStartCount: number } }) => c.matchQuality - 0.05 * c.metrics.fillerCount - 0.05 * c.metrics.falseStartCount;
  const selections = alignment.spans.map((span, i) => {
    const best = alignment.candidates.filter((c) => c.spanId === span.spanId).sort((a, b) => composite(b) - composite(a))[0];
    return best ? { order: i + 1, clipId: best.clipId, spanIds: [span.spanId], rationale: `Highest composite delivery of span ${span.spanId}` } : null;
  }).filter(Boolean).map((sel, i) => ({ ...sel!, order: i + 1 }));

  const composition = { schemaVersion: 1 as const, groupId: group, selections, gaps: [] };
  const apply = await call('compose_apply', { requestId: newRequestId('compose-apply'), composition });
  if (apply.kind === 'tool_error') throw new Error(apply.error.message);
  const summary = { skill: 'compose-from-takes', status: 'applied', selections: selections.length };
  console.log(JSON.stringify(summary));
  ws.close();
  return summary;
}

if (process.argv[1]?.endsWith('skills/compose-from-takes/index.ts') || process.argv[1]?.endsWith('skills/compose-from-takes/index.js')) void main();
