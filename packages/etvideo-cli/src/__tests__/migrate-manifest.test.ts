import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts');
const now = '2026-05-23T00:00:00.000Z';

function run(args: string[], workspace: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, '--json', '--workspace', workspace, ...args], {
    encoding: 'utf8',
    env: { ...process.env }
  });
}

const baseManifest = {
  manifestVersion: 3,
  projectId: 'test-migrate',
  createdAt: now,
  updatedAt: now,
  assets: [
    { assetId: 'asset_video_001', kind: 'video', path: 'assets/video/source.mp4', durationSec: 10, provenance: 'imported', video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000 } },
    { assetId: 'asset_voice_001', kind: 'audio', path: 'assets/voice/patch.wav', durationSec: 1.5, provenance: 'generated', audio: { sampleRate: 48000 } }
  ],
  tracks: [
    { trackId: 'track_video_001', kind: 'video', name: 'Base video', order: 0, locked: false, muted: false, solo: false, hidden: false,
      clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 10, timelineStart: 0 }] }
  ],
  outputs: [{ outputId: 'output_001', kind: 'full', aspects: ['16:9'], status: 'manual' }],
  renderPresets: { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: '1920x1080', videoBitrate: '6000k', audioBitrate: '192k' } },
  operations: [] as unknown[]
};

function makePatchOp(id: string, extras: Record<string, unknown> = {}) {
  return { id, type: 'voice_patch', status: 'approved', proposedBy: 'agent', createdBy: 'agent', createdAt: now,
    target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 2, end: 3 },
    text: 'replacement', assetId: 'asset_voice_001', ...extras };
}

function setup(ops: unknown[]): string {
  const workspace = mkdtempSync(join(tmpdir(), 'ets-migrate-'));
  mkdirSync(join(workspace, 'edits'), { recursive: true });
  writeFileSync(join(workspace, 'edits/manifest.json'), JSON.stringify({ ...baseManifest, operations: ops }, null, 2));
  return workspace;
}

function readManifest(workspace: string) {
  return JSON.parse(readFileSync(join(workspace, 'edits/manifest.json'), 'utf8'));
}

describe('ets migrate-manifest CLI', () => {
  it('migrates approved voice_patch ops without durationGeneratedSec', () => {
    const workspace = setup([makePatchOp('op_vp_001')]);
    try {
      const result = run(['migrate-manifest', '--voice-patch-ripple'], workspace);
      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body.total).toBe(1);
      expect(body.migrated.map((op: { id: string }) => op.id)).toEqual(['op_vp_001']);
      expect(body.dryRun).toBe(false);
      const manifest = readManifest(workspace);
      const op = manifest.operations.find((o: { id: string }) => o.id === 'op_vp_001');
      expect(op.status).toBe('disabled');
      expect(op.disabledReason).toBe('legacy_model_requires_recreate');
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it('skips ops that already have durationGeneratedSec', () => {
    const workspace = setup([makePatchOp('op_vp_new', { durationGeneratedSec: 1.2 })]);
    try {
      const result = run(['migrate-manifest', '--voice-patch-ripple'], workspace);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ total: 0, migrated: [] });
      const op = readManifest(workspace).operations[0];
      expect(op.status).toBe('approved');
      expect(op.disabledReason).toBeUndefined();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it('dry-run reports targets without writing', () => {
    const workspace = setup([makePatchOp('op_vp_001')]);
    try {
      const before = readManifest(workspace).operations[0].status;
      const result = run(['migrate-manifest', '--voice-patch-ripple', '--dry-run'], workspace);
      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body.total).toBe(1);
      expect(body.dryRun).toBe(true);
      const after = readManifest(workspace).operations[0].status;
      expect(after).toBe(before);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it('is idempotent — running twice does not double-flag', () => {
    const workspace = setup([makePatchOp('op_vp_001')]);
    try {
      run(['migrate-manifest', '--voice-patch-ripple'], workspace);
      const result2 = run(['migrate-manifest', '--voice-patch-ripple'], workspace);
      expect(result2.status).toBe(0);
      expect(JSON.parse(result2.stdout)).toMatchObject({ total: 0, migrated: [] });
      const ops = readManifest(workspace).operations;
      expect(ops.filter((o: { disabledReason?: string }) => o.disabledReason === 'legacy_model_requires_recreate').length).toBe(1);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it('exits 1 when no migration flag is provided', () => {
    const workspace = setup([]);
    try {
      const result = run(['migrate-manifest'], workspace);
      expect(result.status).toBe(1);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
});

describe('ets validate-manifest --json legacyOps surface', () => {
  it('includes legacyOps in --json output for disabled legacy voice_patch ops', () => {
    const workspace = setup([makePatchOp('op_vp_legacy', { status: 'disabled', disabledReason: 'legacy_model_requires_recreate' })]);
    try {
      const result = run(['validate-manifest'], workspace);
      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body.valid).toBe(true);
      expect(body.legacyOps).toEqual([{ id: 'op_vp_legacy', type: 'voice_patch' }]);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it('returns empty legacyOps when no legacy ops exist', () => {
    const workspace = setup([makePatchOp('op_vp_001', { durationGeneratedSec: 1.2 })]);
    try {
      const result = run(['validate-manifest'], workspace);
      const body = JSON.parse(result.stdout);
      expect(body.legacyOps).toEqual([]);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
});
