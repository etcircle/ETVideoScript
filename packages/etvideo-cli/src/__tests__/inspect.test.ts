import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkspace, loadManifestV3, saveManifestV3 } from '@etvideoscript/core';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts');

function run(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8' });
}

function wavSilence(): Buffer {
  const samples = 160;
  const dataBytes = samples * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(dataBytes, 40);
  return b;
}

describe('ets inspect', () => {
  it('reports audio present when v3 clips have per-clip extracted audio', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ets-inspect-cli-'));
    const workspace = join(root, 'episode-001');
    try {
      await createWorkspace({ workspacePath: workspace, projectId: 'episode-001', title: 'Episode 001' });
      const manifest = loadManifestV3(workspace);
      manifest.assets = [{ assetId: 'asset_video_001', kind: 'video', path: 'input/source.mp4', durationSec: 1, provenance: 'imported', video: { width: 1920, height: 1080, fps: 30 } }];
      manifest.tracks[0].clips = [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 1, timelineStart: 0 }];
      saveManifestV3(workspace, manifest, { revision: false });
      mkdirSync(join(workspace, 'media/clip_001'), { recursive: true });
      writeFileSync(join(workspace, 'media/clip_001/extracted-audio.wav'), wavSilence());

      const result = run(['--workspace', workspace, '--json', 'inspect']);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).files.audio).toBe(true);
      expect(existsSync(join(workspace, 'media/extracted-audio.wav'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
