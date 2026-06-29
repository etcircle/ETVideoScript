import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildManifestV3FromV2Workspace, migrateV2WorkspaceToV3, ManifestV3Schema } from '../index';

const fixtureRoot = join(process.cwd(), 'packages/core/src/__tests__/fixtures/v2-workspaces');
const temps: string[] = [];

function copyFixture(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `etvs-v3-${name}-`));
  cpSync(join(fixtureRoot, name), workspace, { recursive: true });
  temps.push(workspace);
  return workspace;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function manifestPath(workspace: string): string {
  return join(workspace, 'edits/manifest.json');
}

function projectPath(workspace: string): string {
  return join(workspace, 'project.json');
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('v2 to v3 migration', () => {
  it('converts v2 tracks, assets and running-sum timelineStart without writing during build', () => {
    const workspace = copyFixture('two-clip-homogeneous');
    const result = buildManifestV3FromV2Workspace(workspace);
    expect(result.droppedOperations).toEqual([]);
    expect(result.manifest.manifestVersion).toBe(3);
    expect(result.manifest.assets).toHaveLength(2);
    expect(result.manifest.tracks[0]!.clips.map((clip) => clip.timelineStart)).toEqual([0, 10]);
    expect(result.manifest.operations[0]).toMatchObject({ id: 'op_cut_0001', type: 'cut', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001' } });
  });

  it('writes the structured migration result and bumps project manifestVersion', () => {
    const workspace = copyFixture('two-clip-heterogeneous');
    const result = migrateV2WorkspaceToV3(workspace);
    expect(result.converted).toBe(true);
    expect(result.warnings.join('\n')).toContain('running sum');
    const manifest = ManifestV3Schema.parse(JSON.parse(readFileSync(manifestPath(workspace), 'utf8')));
    const project = JSON.parse(readFileSync(projectPath(workspace), 'utf8')) as { manifestVersion: number };
    expect(manifest.tracks[0]!.clips.map((clip) => clip.timelineStart)).toEqual([0, 10]);
    expect(project.manifestVersion).toBe(3);
  });

  it('drops keep, lipsync_patch, caption_override and audio_enhance with reasons', () => {
    const workspace = copyFixture('two-clip-homogeneous');
    const manifest = readJson(manifestPath(workspace));
    manifest.operations.push(
      { id: 'op_keep_0001', type: 'keep', clipId: 'clip_001', start: 0, end: 1, status: 'approved', createdBy: 'user', createdAt: '2026-05-14T00:00:00.000Z' },
      { id: 'op_lipsync_0001', type: 'lipsync_patch', clipId: 'clip_001', start: 1, end: 2, status: 'approved', createdBy: 'user', createdAt: '2026-05-14T00:00:00.000Z', videoAsset: 'assets/lipsync/patch.mp4' },
      { id: 'op_caption_0001', type: 'caption_override', clipId: 'clip_001', start: 2, end: 3, status: 'approved', createdBy: 'user', createdAt: '2026-05-14T00:00:00.000Z', text: 'caption' },
      { id: 'op_audio_0001', type: 'audio_enhance', clipId: 'clip_001', start: 3, end: 4, status: 'approved', createdBy: 'user', createdAt: '2026-05-14T00:00:00.000Z', provider: 'ffmpeg-local', profile: 'podcast', filterChainVersion: 1 }
    );
    writeJson(manifestPath(workspace), manifest);

    const result = buildManifestV3FromV2Workspace(workspace);
    expect(result.droppedOperations.map((op) => op.type).sort()).toEqual(['audio_enhance', 'caption_override', 'keep', 'lipsync_patch']);
    for (const dropped of result.droppedOperations) expect(dropped.reason).toContain('dropped from v3');
    expect(result.manifest.operations.map((op) => op.type)).toEqual(['cut']);
  });

  it('carries cut, mute and voice_patch through', () => {
    const workspace = copyFixture('two-clip-homogeneous');
    const manifest = readJson(manifestPath(workspace));
    manifest.operations.push(
      { id: 'op_mute_0001', type: 'mute', clipId: 'clip_001', start: 4, end: 5, status: 'approved', createdBy: 'agent', createdAt: '2026-05-14T00:00:00.000Z' },
      { id: 'op_voice_0001', type: 'voice_patch', clipId: 'clip_002', start: 1, end: 2, status: 'proposed', createdBy: 'agent', createdAt: '2026-05-14T00:00:00.000Z', text: 'replacement' }
    );
    writeJson(manifestPath(workspace), manifest);

    const result = buildManifestV3FromV2Workspace(workspace);
    expect(result.manifest.operations.map((op) => op.type)).toEqual(['cut', 'mute', 'voice_patch']);
    expect(result.manifest.operations[1]).toMatchObject({ id: 'op_mute_0001', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001' } });
    expect(result.manifest.operations[2]).toMatchObject({ id: 'op_voice_0001', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_002' }, text: 'replacement' });
  });

  it('migrates a voice_patch asset into generated assets and rewrites the op to assetId', () => {
    const workspace = copyFixture('two-clip-homogeneous');
    const manifest = readJson(manifestPath(workspace));
    manifest.operations.push({
      id: 'op_voice_0001', type: 'voice_patch', clipId: 'clip_002', start: 1, end: 2, status: 'approved', createdBy: 'agent', createdAt: '2026-05-14T00:00:00.000Z',
      text: 'replacement', asset: 'assets/voice/patch.wav', providerRequestId: 'req_001', durationGeneratedSec: 1
    });
    writeJson(manifestPath(workspace), manifest);

    const result = buildManifestV3FromV2Workspace(workspace);
    const voice = result.manifest.operations.find((op) => op.type === 'voice_patch')!;
    expect(voice).toMatchObject({ id: 'op_voice_0001', assetId: expect.any(String) });
    expect('asset' in voice).toBe(false);
    const asset = result.manifest.assets.find((candidate) => candidate.assetId === voice.assetId)!;
    expect(asset).toMatchObject({ kind: 'audio', path: 'assets/voice/patch.wav', provenance: 'generated', providerRequestId: 'req_001' });
    expect(asset.audio?.sampleRate).toBeUndefined();
  });

  it('throws when clip source metadata is missing', () => {
    const workspace = copyFixture('two-clip-homogeneous');
    const project = readJson(projectPath(workspace));
    project.clipSources = project.clipSources.filter((source: { clipId: string }) => source.clipId !== 'clip_002');
    writeJson(projectPath(workspace), project);
    expect(() => buildManifestV3FromV2Workspace(workspace)).toThrow('missing clip source metadata');
  });

  it('throws when an asset path escapes the workspace', () => {
    const workspace = copyFixture('two-clip-homogeneous');
    const manifest = readJson(manifestPath(workspace));
    manifest.operations.push({ id: 'op_voice_0001', type: 'voice_patch', clipId: 'clip_001', start: 4, end: 5, status: 'approved', createdBy: 'agent', createdAt: '2026-05-14T00:00:00.000Z', text: 'replacement', asset: '../outside.wav' });
    writeJson(manifestPath(workspace), manifest);
    expect(() => buildManifestV3FromV2Workspace(workspace)).toThrow('Path escapes outside workspace');
  });

  it('throws when the converted manifest fails v3 validation', () => {
    const workspace = copyFixture('two-clip-homogeneous');
    const manifest = readJson(manifestPath(workspace));
    manifest.operations[0].end = 99;
    writeJson(manifestPath(workspace), manifest);
    expect(() => buildManifestV3FromV2Workspace(workspace)).toThrow('Converted v3 manifest failed validation');
  });

  it('derives timelineStart as a running sum across multiple clips', () => {
    const workspace = copyFixture('two-clip-homogeneous');
    const manifest = readJson(manifestPath(workspace));
    const project = readJson(projectPath(workspace));
    manifest.tracks[0].clips.push({ clipId: 'clip_003', assetPath: 'assets/video/clip_003/source.mp4', sourceStart: 2, sourceEnd: 7 });
    project.clipSources.push({ clipId: 'clip_003', path: 'assets/video/clip_003/source.mp4', originalFilename: 'c.mp4', sha256: 'c', durationSec: 7, width: 1280, height: 720, fps: 30, audioSampleRate: 48000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' });
    writeJson(manifestPath(workspace), manifest);
    writeJson(projectPath(workspace), project);

    const result = buildManifestV3FromV2Workspace(workspace);
    expect(result.manifest.tracks[0]!.clips.map((clip) => clip.timelineStart)).toEqual([0, 10, 18]);
  });
});
