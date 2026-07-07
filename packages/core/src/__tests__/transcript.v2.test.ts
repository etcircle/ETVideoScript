import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace, defaultManifest, loadProject, saveManifestV3, saveProject, transcribeAllClips, transcribeClip } from '../index';

async function workspace3() {
  const root = mkdtempSync(join(tmpdir(), 'etvideo-transcript-v3-'));
  const workspace = join(root, 'p');
  await createWorkspace({ workspacePath: workspace, projectId: 'p', title: 'P' });
  const project = loadProject(workspace);
  const clipSources = [
    { clipId: 'a', path: 'a.mp4', sha256: 'a', durationSec: 4, width: 1, height: 1, fps: 30, audioSampleRate: 16000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' },
    { clipId: 'b', path: 'b.mp4', sha256: 'b', durationSec: 4, width: 1, height: 1, fps: 30, audioSampleRate: 16000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' }
  ];
  saveProject({ ...project, clipSources, status: { ...project.status, imported: true } });
  saveManifestV3(workspace, {
    ...defaultManifest('p'),
    assets: clipSources.map((source) => ({ assetId: `asset_${source.clipId}`, kind: 'video' as const, path: source.path, durationSec: source.durationSec, provenance: 'imported' as const, video: { width: source.width, height: source.height, fps: source.fps }, audio: { sampleRate: source.audioSampleRate } })),
    tracks: [{ trackId: 't', kind: 'video', name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: clipSources.map((source, index) => ({ clipId: source.clipId, assetId: `asset_${source.clipId}`, sourceStart: 0, sourceEnd: 4, timelineStart: index * 4 })) }]
  }, { revision: false });
  return { root, workspace };
}

describe('transcript v3', () => {
  it('per-clip transcribe writes clip words and merged top-level with clipId', async () => {
    const { root, workspace } = await workspace3();
    // Hermetic etvsDir so the test never reads the developer's ~/.etvs/providers.json.
    // Without this, an installed default like stt.homelab-whisper would be picked up even with
    // provider:'mock' explicit, because the engine still loads the registry. A disabled or
    // mid-migration mock entry there could also cause the explicit-mock path to fail.
    const etvsDir = mkdtempSync(join(tmpdir(), 'etvideo-etvs-'));
    try {
      const options = { provider: 'mock' as const, etvsDir };
      await transcribeClip(workspace, 'a', { ...options, mockText: 'hello a' });
      await transcribeClip(workspace, 'b', { ...options, mockText: 'hello b' });
      const merged = await transcribeAllClips(workspace, { ...options, mockText: 'ignored' });
      expect(existsSync(join(workspace, 'transcript/a/words.json'))).toBe(true);
      expect(existsSync(join(workspace, 'transcript/a/original.words.json'))).toBe(true);
      const top = JSON.parse(readFileSync(join(workspace, 'transcript/words.json'), 'utf8'));
      expect(top.words.every((word: any) => word.clipId)).toBe(true);
      expect(merged.words.length).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(etvsDir, { recursive: true, force: true }); }
  });

  it('ETVS_TRANSCRIBE_CONCURRENCY=2 accepts the v3 provider path', async () => {
    const { root, workspace } = await workspace3();
    const etvsDir = mkdtempSync(join(tmpdir(), 'etvideo-etvs-'));
    const old = process.env.ETVS_TRANSCRIBE_CONCURRENCY;
    process.env.ETVS_TRANSCRIBE_CONCURRENCY = '2';
    try {
      const merged = await transcribeAllClips(workspace, { provider: 'mock', mockText: 'word', etvsDir });
      expect(merged.words.length).toBeGreaterThan(0);
    } finally { process.env.ETVS_TRANSCRIBE_CONCURRENCY = old; rmSync(root, { recursive: true, force: true }); rmSync(etvsDir, { recursive: true, force: true }); }
  });
});
