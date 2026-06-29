import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import type { TranscriptWord } from '@etvideoscript/agent-protocol';
import { addOperation, buildRenderPlanV3, loadManifestV3, saveManifestV3, validateManifestV3Document } from '@etvideoscript/core';
import { migrateV2WorkspaceToV3 } from '../../../packages/core/src/migrations/v2-to-v3';
import { main as assembleFromClips } from '../../../skills/assemble-from-clips/index';

function word(id: string, clipId: string, text: string, start: number, end: number): TranscriptWord {
  return { id, clipId, text, normalized: text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), start, end, speaker: 'speaker_1', confidence: 1, segmentId: `${clipId}-seg` };
}

function fixtureWords(): TranscriptWord[] {
  return [
    word('a1', 'clip_001', 'Hello', 0.6, 0.9),
    word('a2', 'clip_001', 'and', 1.0, 1.1),
    word('a3', 'clip_001', 'welcome', 1.2, 1.6),
    word('a4', 'clip_001', 'to', 1.7, 1.8),
    word('a5', 'clip_001', 'the', 1.9, 2.0),
    word('a6', 'clip_001', 'show', 2.1, 2.5),
    word('b1', 'clip_002', 'And', 0.6, 0.8),
    word('b2', 'clip_002', 'now', 0.9, 1.1),
    word('b3', 'clip_002', 'let', 1.2, 1.4),
    word('b4', 'clip_002', 'me', 1.5, 1.7),
    word('b5', 'clip_002', 'show', 1.8, 2.1),
    word('b6', 'clip_002', 'you', 2.2, 2.5),
    word('b7', 'clip_002', 'Thanks', 6.2, 6.5),
    word('b8', 'clip_002', 'for', 6.6, 6.8),
    word('b9', 'clip_002', 'watching', 6.9, 7.2),
    word('b10', 'clip_002', 'see', 7.3, 7.45),
    word('b11', 'clip_002', 'you', 7.5, 7.6),
    word('b12', 'clip_002', 'next', 7.62, 7.75),
    word('b13', 'clip_002', 'time', 7.78, 7.9)
  ];
}

function addCutOperation(workspace: string, params: { trackId: string; clipId: string; start: number; end: number; reason?: string }) {
  const manifest = loadManifestV3(workspace);
  const entry = manifest.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip }))).find(({ clip }) => clip.clipId === params.clipId);
  if (!entry) throw new Error(`clip not found: ${params.clipId}`);
  const { manifest: next, operation } = addOperation(manifest, {
    id: `op_cut_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type: 'cut',
    status: 'approved',
    target: { kind: 'clip-span', trackId: params.trackId || entry.track.trackId, clipId: params.clipId, start: params.start, end: params.end },
    reason: params.reason,
    proposedBy: 'agent',
    createdBy: 'agent',
    createdAt: new Date().toISOString()
  });
  saveManifestV3(workspace, next);
  return operation;
}

function validateWorkspaceManifest(workspace: string) {
  return validateManifestV3Document(loadManifestV3(workspace));
}

async function withMockAgentServer(workspace: string, words: TranscriptWord[], run: (url: string) => Promise<void>) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { kind: string; id: string; tool?: string; params?: any };
      if (message.kind === 'hello') {
        socket.send(JSON.stringify({ kind: 'ready', id: 'ready-assemble-test', protocolVersion: 3, sessionId: 'assemble-test', projectId: 'two-clip-homogeneous', manifestVersion: 'test' }));
        return;
      }
      if (message.kind !== 'tool_call') return;
      if (message.tool === 'get_transcript') {
        socket.send(JSON.stringify({ kind: 'tool_result', id: `${message.id}-result`, protocolVersion: 3, callId: message.id, ok: true, result: { manifestVersion: 'test', result: { words, provider: { name: 'mock', timing: 'mock' }, durationSec: 18 } } }));
        return;
      }
      if (message.tool === 'propose_operation') {
        const op = addCutOperation(workspace, { trackId: message.params.target.trackId, clipId: message.params.target.clipId, start: message.params.target.start, end: message.params.target.end, reason: message.params.reason });
        socket.send(JSON.stringify({ kind: 'tool_result', id: `${message.id}-result`, protocolVersion: 3, callId: message.id, ok: true, result: { manifestVersion: 'test', result: { operation: op } } }));
        return;
      }
      if (message.tool === 'get_render_state') {
        const validation = validateWorkspaceManifest(workspace);
        socket.send(JSON.stringify({ kind: 'tool_result', id: `${message.id}-result`, protocolVersion: 3, callId: message.id, ok: true, result: { manifestVersion: 'test', result: { manifestValid: validation.valid, manifestErrors: validation.errors, renderPlan: validation.valid ? buildRenderPlanV3(loadManifestV3(workspace)) : null } } }));
      }
    });
  });
  try {
    await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
    const port = (server.address() as AddressInfo).port;
    await run(`ws://127.0.0.1:${port}/ws/projects/two-clip-homogeneous/agent/assemble-from-clips-test`);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

describe('assemble-from-clips reference skill', () => {
  it('assembles a two-clip v3 fixture with clip-aware tightening cuts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-assemble-'));
    const fixture = resolve(process.cwd(), 'packages/core/src/__tests__/fixtures/v2-workspaces/two-clip-homogeneous');
    const workspace = join(root, 'two-clip-homogeneous');
    const originalArgv = process.argv;
    try {
      cpSync(fixture, workspace, { recursive: true });
      migrateV2WorkspaceToV3(workspace);
      const manifestPath = join(workspace, 'edits/manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.operations = [];
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      let summary: Awaited<ReturnType<typeof assembleFromClips>> | undefined;
      await withMockAgentServer(workspace, fixtureWords(), async (wsUrl) => {
        process.argv = ['node', 'skills/assemble-from-clips/index.ts', '--ws-url', wsUrl, '--token', 'test-token', '--workspace', workspace, '--project-id', 'two-clip-homogeneous'];
        summary = await assembleFromClips();
      });

      if (!summary) throw new Error('assemble-from-clips did not return a summary');
      expect(summary.proposedOrder).toEqual(['clip_001', 'clip_002']);
      expect(summary.orderJustification).toContain('Upload order is already narrative-correct');
      expect(summary.cutsEmitted).toBeGreaterThanOrEqual(1);

      const finalManifest = loadManifestV3(workspace);
      expect(finalManifest.tracks[0]?.clips.map((clip) => clip.clipId)).toEqual(['clip_001', 'clip_002']);
      expect(finalManifest.operations.filter((op) => op.type === 'cut')).toHaveLength(summary.cutsEmitted);
      const validation = validateWorkspaceManifest(workspace);
      expect(validation.errors).toEqual([]);
      expect(validation.valid).toBe(true);
      expect(() => buildRenderPlanV3(finalManifest)).not.toThrow();
    } finally {
      process.argv = originalArgv;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
