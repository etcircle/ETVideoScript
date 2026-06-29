import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace, extractAllClipWaveformPeaks, extractClipWaveformPeaks, loadManifestV3, saveManifestV3 } from '../index';

function wavSilence(): Buffer {
  const samples = 160;
  const dataBytes = samples * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(dataBytes, 40);
  return b;
}

async function createWorkspaceWithTwoClips(workspace: string) {
  await createWorkspace({ workspacePath: workspace, projectId: 'p', title: 'P' });
  const manifest = loadManifestV3(workspace);
  manifest.assets = [
    { assetId: 'asset_video_001', kind: 'video', path: 'input/source-1.mp4', durationSec: 1, provenance: 'imported', video: { width: 1920, height: 1080, fps: 30 } },
    { assetId: 'asset_video_002', kind: 'video', path: 'input/source-2.mp4', durationSec: 1, provenance: 'imported', video: { width: 1920, height: 1080, fps: 30 } }
  ];
  manifest.tracks[0].clips = [
    { clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 1, timelineStart: 0 },
    { clipId: 'clip_002', assetId: 'asset_video_002', sourceStart: 0, sourceEnd: 1, timelineStart: 1 }
  ];
  saveManifestV3(workspace, manifest, { revision: false });
}

describe('waveform v2', () => {
  it('creates per-clip peaks without touching legacy top-level peaks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-waveform-v2-'));
    const workspace = join(root, 'p');
    try {
      await createWorkspace({ workspacePath: workspace, projectId: 'p', title: 'P' });
      writeFileSync(join(workspace, 'media/peaks.json'), '{"legacy":true}');
      mkdirSync(join(workspace, 'media/clip_001'), { recursive: true });
      writeFileSync(join(workspace, 'media/clip_001/extracted-audio.wav'), wavSilence());
      extractClipWaveformPeaks(workspace, 'clip_001');
      expect(existsSync(join(workspace, 'media/clip_001/peaks.json'))).toBe(true);
      expect(existsSync(join(workspace, 'media/peaks.json'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('extracts waveform peaks for every manifest clip', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-waveform-all-v2-'));
    const workspace = join(root, 'p');
    try {
      await createWorkspaceWithTwoClips(workspace);
      mkdirSync(join(workspace, 'media/clip_001'), { recursive: true });
      mkdirSync(join(workspace, 'media/clip_002'), { recursive: true });
      writeFileSync(join(workspace, 'media/clip_001/extracted-audio.wav'), wavSilence());
      writeFileSync(join(workspace, 'media/clip_002/extracted-audio.wav'), wavSilence());

      const results = extractAllClipWaveformPeaks(workspace, { resolutionHz: 50 });

      expect(results).toEqual([
        { clipId: 'clip_001', peaks: 1 },
        { clipId: 'clip_002', peaks: 1 }
      ]);
      expect(existsSync(join(workspace, 'media/clip_001/peaks.json'))).toBe(true);
      expect(existsSync(join(workspace, 'media/clip_002/peaks.json'))).toBe(true);
      expect(existsSync(join(workspace, 'media/peaks.json'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
