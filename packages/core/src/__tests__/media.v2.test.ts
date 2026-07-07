import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWorkspace, defaultManifest, extractClipAudio, loadProject, saveManifestV3, saveProject } from '../index';

describe('media v3', () => {
  it('extractClipAudio writes per-clip audio path from a v3 clip asset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-media-v3-'));
    const workspace = join(root, 'p');
    try {
      await createWorkspace({ workspacePath: workspace, projectId: 'p', title: 'P' });
      const sourceRel = 'assets/video/clip_001/source.mp4';
      const source = join(workspace, sourceRel);
      mkdirSync(join(workspace, 'assets/video/clip_001'), { recursive: true });
      const made = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=0.2:r=25', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=16000', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', source], { encoding: 'utf8' });
      if (made.status !== 0) throw new Error(made.stderr || made.stdout);
      const project = loadProject(workspace);
      saveProject({ ...project, clipSources: [{ clipId: 'clip_001', path: sourceRel, originalFilename: 'source.mp4', sha256: 'x', durationSec: 0.2, width: 16, height: 16, fps: 25, audioSampleRate: 16000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' }], status: { ...project.status, imported: true } });
      saveManifestV3(workspace, {
        ...defaultManifest('p'),
        assets: [{ assetId: 'asset_video_001', kind: 'video', path: sourceRel, durationSec: 0.2, provenance: 'imported', video: { width: 16, height: 16, fps: 25, codec: 'h264', pixelFormat: 'yuv420p' }, audio: { sampleRate: 16000, codec: 'aac' } }],
        tracks: [{ trackId: 't', kind: 'video', name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 0.2, timelineStart: 0 }] }]
      }, { revision: false });
      const output = await extractClipAudio(workspace, 'clip_001', { logJob: false });
      expect(output).toBe('media/clip_001/extracted-audio.wav');
      expect(existsSync(join(workspace, output))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
