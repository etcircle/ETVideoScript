import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertInside, createWorkspace, defaultManifest, loadProject, saveManifestV3, saveProject, validateManifestV3Document, writeManifestRevision, type ManifestV3 } from '../index';

const clipSource = { clipId: 'clip_001', path: 'input/source.mp4', originalFilename: 'source.mp4', sha256: 'abc', durationSec: 10, width: 640, height: 360, fps: 30, audioSampleRate: 48000, videoCodec: '', audioCodec: '', pixelFormat: '' };
function manifestWithClip(projectId: string, durationSec = 10): ManifestV3 {
  return {
    ...defaultManifest(projectId),
    assets: [{ assetId: 'asset_video_001', kind: 'video', path: 'input/source.mp4', durationSec, provenance: 'imported', video: { width: 640, height: 360, fps: 30 }, audio: { sampleRate: 48000 } }],
    tracks: [{ trackId: 'track_video_001', kind: 'video', name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: durationSec, timelineStart: 0 }] }]
  };
}

describe('workspace filesystem', () => {
  it('creates the required folders and preserves repeat init', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-'));
    try {
      const workspace = join(root, 'episode-001');
      await createWorkspace({ workspacePath: workspace, projectId: 'episode-001', title: 'Episode 001' });
      writeFileSync(join(workspace, 'input', 'keep.txt'), 'do not delete');
      await createWorkspace({ workspacePath: workspace, projectId: 'episode-001', title: 'Episode 001 renamed' });
      expect(assertInside(workspace, 'edits/manifest.json')).toContain('manifest.json');
      expect(readdirSync(workspace).some((name: string) => name.includes('.tmp-'))).toBe(false);
      expect(() => assertInside(workspace, '../escape.mp4')).toThrow(/outside workspace/);
      expect(() => assertInside(workspace, '/tmp/escape.mp4')).toThrow(/outside workspace/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('writes manifest revisions before replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-'));
    try {
      const workspace = join(root, 'episode-001');
      await createWorkspace({ workspacePath: workspace, projectId: 'episode-001', title: 'Episode 001' });
      const revision = await writeManifestRevision(workspace);
      expect(revision).toMatch(/edits\/revisions\/manifest-0001.json$/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('validates v3 manifest operations against clip duration and persists project status separately', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-'));
    try {
      const workspace = join(root, 'episode-001');
      await createWorkspace({ workspacePath: workspace, projectId: 'episode-001', title: 'Episode 001' });
      const project = loadProject(workspace);
      saveProject({ ...project, clipSources: [clipSource], status: { ...project.status, imported: true, manifestValid: true } });
      const now = new Date().toISOString();
      const manifest = { ...manifestWithClip('episode-001'), operations: [{ id: 'op_cut_0001', type: 'cut' as const, status: 'approved' as const, target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 9, end: 20 }, reason: 'bad', proposedBy: 'user' as const, createdBy: 'user' as const, createdAt: now }] };
      const result = validateManifestV3Document(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.join('\n')).toContain('after clip clip_001 duration');
      expect(loadProject(workspace).status.manifestValid).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports missing approved voice-patch assetIds as validation errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-'));
    try {
      const workspace = join(root, 'episode-001');
      await createWorkspace({ workspacePath: workspace, projectId: 'episode-001', title: 'Episode 001' });
      const now = new Date().toISOString();
      const manifest = { ...manifestWithClip('episode-001', 30), operations: [{ id: 'op_voice_0001', type: 'voice_patch' as const, status: 'approved' as const, target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 1, end: 2 }, text: 'fixed', assetId: 'asset_voice_missing', proposedBy: 'user' as const, createdBy: 'user' as const, createdAt: now }] };
      saveManifestV3(workspace, manifestWithClip('episode-001', 30), { revision: false });
      const result = validateManifestV3Document(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.join('\n')).toContain('approved voice patch asset does not exist');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
