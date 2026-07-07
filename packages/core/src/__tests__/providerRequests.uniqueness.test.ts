import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addOperation, appendProviderRequestEvent, createWorkspace, loadManifestV3, loadProject, readProviderRequests, saveManifestV3, saveProject, type ManifestV3 } from '../index';

const presets = {
  draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' },
  youtube: { resolution: 'source', videoBitrate: 'source-or-auto', audioBitrate: '192k' }
};
const now = '2026-05-14T00:00:00.000Z';

function manifest(projectId: string): ManifestV3 {
  return {
    manifestVersion: 3,
    projectId,
    assets: [
      { assetId: 'asset_video_001', kind: 'video', path: 'assets/video/clip_001/source.mp4', durationSec: 10, provenance: 'imported', video: { width: 640, height: 360, fps: 30 }, audio: { sampleRate: 48000 } },
      { assetId: 'asset_video_002', kind: 'video', path: 'assets/video/clip_002/source.mp4', durationSec: 10, provenance: 'imported', video: { width: 640, height: 360, fps: 30 }, audio: { sampleRate: 48000 } }
    ],
    tracks: [{ trackId: 'track_video_001', kind: 'video', name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [
      { clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 10, timelineStart: 0 },
      { clipId: 'clip_002', assetId: 'asset_video_002', sourceStart: 0, sourceEnd: 10, timelineStart: 10 }
    ] }],
    createdAt: now,
    updatedAt: now,
    operations: [],
    outputs: [],
    takeGroups: [],
    renderPresets: presets
  };
}

function providerEvent(requestId: string, operationId: string) {
  return {
    requestId,
    projectId: 'episode-001',
    provider: 'mock',
    voice: 'eve',
    language: 'en',
    textHash: `${requestId}-text`,
    bodyHash: `${requestId}-body`,
    operationId,
    status: 'pending' as const,
    createdAt: now
  };
}

describe('provider request audit uniqueness across clips', () => {
  it('records unique requestId and operationId rows for same-time voice patches in different clips', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvs-provider-unique-'));
    const workspace = join(root, 'episode-001');
    try {
      await createWorkspace({ workspacePath: workspace, projectId: 'episode-001', title: 'Episode 001' });
      const project = loadProject(workspace);
      saveProject({ ...project, clipSources: [
        { clipId: 'clip_001', path: 'assets/video/clip_001/source.mp4', originalFilename: 'a.mp4', sha256: 'hash-a', durationSec: 10, width: 640, height: 360, fps: 30, audioSampleRate: 48000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' },
        { clipId: 'clip_002', path: 'assets/video/clip_002/source.mp4', originalFilename: 'b.mp4', sha256: 'hash-b', durationSec: 10, width: 640, height: 360, fps: 30, audioSampleRate: 48000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' }
      ], status: { ...project.status, imported: true } });
      saveManifestV3(workspace, manifest('episode-001'), { revision: false });

      let current = loadManifestV3(workspace);
      const first = addOperation(current, { id: 'op_voice_patch_0001', type: 'voice_patch', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 1, end: 2 }, text: 'replacement one', status: 'awaiting_approval', providerRequestId: 'voice_req_001', proposedBy: 'agent', createdBy: 'agent', createdAt: now });
      current = first.manifest;
      const second = addOperation(current, { id: 'op_voice_patch_0002', type: 'voice_patch', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_002', start: 1, end: 2 }, text: 'replacement two', status: 'awaiting_approval', providerRequestId: 'voice_req_002', proposedBy: 'agent', createdBy: 'agent', createdAt: now });
      saveManifestV3(workspace, second.manifest);
      appendProviderRequestEvent(workspace, providerEvent('voice_req_001', first.operation.id));
      appendProviderRequestEvent(workspace, providerEvent('voice_req_002', second.operation.id));

      const rows = readProviderRequests(workspace);
      expect(rows.map((row) => row.requestId)).toEqual(['voice_req_001', 'voice_req_002']);
      expect(new Set(rows.map((row) => row.requestId)).size).toBe(2);
      expect(new Set(rows.map((row) => row.operationId)).size).toBe(2);
      expect(rows.map((row) => row.operationId)).toEqual([first.operation.id, second.operation.id]);
      const logLines = readFileSync(join(workspace, 'logs/provider-requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(logLines).toHaveLength(2);
      expect(new Set(logLines.map((row) => row.operationId)).size).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
