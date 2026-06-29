import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { assertInside } from '../filesystem';
import { ManifestSchemaV2, ProjectSchema, type ManifestOperationV2 } from '../schemas';
import { ManifestV3Schema, type ManifestV3 } from '../manifest/schema';
import { validateManifestV3Document } from '../manifest/validate';

export interface DroppedOperation {
  id: string;
  type: string;
  reason: string;
}

export interface V2ToV3MigrationResult {
  converted: boolean;
  droppedOperations: DroppedOperation[];
  warnings: string[];
}

const CARRIED_TYPES = new Set(['cut', 'mute', 'voice_patch']);
const DROPPED_TYPES = new Set(['keep', 'lipsync_patch', 'caption_override', 'audio_enhance']);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function normalizeWorkspacePath(workspace: string, path: string): string {
  const absolute = assertInside(workspace, path);
  return relative(workspace, absolute).split('\\').join('/');
}

function assetIdFor(index: number): string {
  return `asset_${String(index + 1).padStart(3, '0')}`;
}

export function buildManifestV3FromV2Workspace(workspacePath: string): { manifest: ManifestV3; project: Record<string, unknown>; droppedOperations: DroppedOperation[]; warnings: string[] } {
  const workspace = resolve(workspacePath);
  const v2 = ManifestSchemaV2.parse(readJson(join(workspace, 'edits/manifest.json')));
  const project = ProjectSchema.parse(readJson(join(workspace, 'project.json')));
  const warnings: string[] = ['v2-to-v3 assumes v2 clips are gapless and derives timelineStart as the running sum of preceding clip source durations.'];
  const droppedOperations: DroppedOperation[] = [];
  const clipSources = new Map(project.clipSources.map((source) => [source.clipId, source]));
  const assetByPath = new Map<string, string>();
  const assets: ManifestV3['assets'] = [];

  function ensureAssetForPath(path: string, metadata: { durationSec?: number; width?: number; height?: number; fps?: number; videoCodec?: string; audioCodec?: string; pixelFormat?: string; audioSampleRate?: number }, kind: 'video' | 'audio' = 'video', provenance: 'imported' | 'recorded' | 'generated' = 'imported', providerRequestId?: string | null): string {
    const safePath = normalizeWorkspacePath(workspace, path);
    const existing = assetByPath.get(safePath);
    if (existing) return existing;
    const id = assetIdFor(assets.length);
    assetByPath.set(safePath, id);
    assets.push({
      assetId: id,
      kind,
      path: safePath,
      durationSec: metadata.durationSec ?? 0,
      provenance,
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(kind === 'video' ? { video: { width: metadata.width ?? 1, height: metadata.height ?? 1, fps: metadata.fps ?? 1, codec: metadata.videoCodec || undefined, pixelFormat: metadata.pixelFormat || undefined } } : {}),
      ...((metadata.audioSampleRate != null || metadata.audioCodec) ? { audio: { ...(metadata.audioSampleRate != null ? { sampleRate: metadata.audioSampleRate } : {}), codec: metadata.audioCodec || undefined } } : {})
    });
    return id;
  }

  const clipToTrack = new Map<string, string>();
  const tracks = v2.tracks.map((track, trackIndex) => {
    let timelineStart = 0;
    return {
      trackId: track.trackId,
      kind: 'video' as const,
      name: `Video ${trackIndex + 1}`,
      order: trackIndex,
      locked: false,
      muted: false,
      solo: false,
      hidden: false,
      clips: track.clips.map((clip) => {
        const source = clipSources.get(clip.clipId);
        if (!source) throw new Error(`Cannot migrate v2 workspace: missing clip source metadata for ${clip.clipId}`);
        const assetId = ensureAssetForPath(clip.assetPath, source, 'video', 'imported');
        const migrated = {
          clipId: clip.clipId,
          assetId,
          sourceStart: clip.sourceStart,
          sourceEnd: clip.sourceEnd,
          timelineStart,
          ...(clip.transitionAfter ? { transitionAfter: clip.transitionAfter } : {})
        };
        clipToTrack.set(clip.clipId, track.trackId);
        timelineStart += clip.sourceEnd - clip.sourceStart;
        return migrated;
      })
    };
  });

  const operations = (v2.operations as Array<ManifestOperationV2 & { clipId: string }>).flatMap((op) => {
    if (!CARRIED_TYPES.has(op.type)) {
      if (DROPPED_TYPES.has(op.type)) droppedOperations.push({ id: op.id, type: op.type, reason: `${op.type} is dropped from v3` });
      else droppedOperations.push({ id: op.id, type: op.type, reason: 'unsupported operation type' });
      return [];
    }
    const trackId = clipToTrack.get(op.clipId);
    if (!trackId) throw new Error(`Cannot migrate v2 workspace: operation ${op.id} references unknown clipId ${op.clipId}`);
    const base = {
      id: op.id,
      type: op.type,
      status: op.status,
      target: { kind: 'clip-span' as const, trackId, clipId: op.clipId, start: op.start, end: op.end },
      ...(op.reason ? { reason: op.reason } : {}),
      proposedBy: op.createdBy,
      createdBy: op.createdBy,
      createdAt: op.createdAt
    };
    if (op.type !== 'voice_patch') return [base];
    const assetId = op.asset ? ensureAssetForPath(op.asset, { durationSec: op.durationGeneratedSec ?? op.durationRequestedSec ?? (op.end - op.start) }, 'audio', 'generated', op.providerRequestId ?? undefined) : undefined;
    return [{
      ...base,
      text: op.text,
      ...(assetId ? { assetId } : {}),
      ...(op.providerRequestId !== undefined ? { providerRequestId: op.providerRequestId } : {}),
      ...(op.durationGeneratedSec !== undefined ? { durationGeneratedSec: op.durationGeneratedSec } : {}),
      ...(op.durationRequestedSec !== undefined ? { durationRequestedSec: op.durationRequestedSec } : {}),
      ...(op.durationWarning ? { durationWarning: op.durationWarning } : {})
    }];
  });

  const manifest = ManifestV3Schema.parse({
    manifestVersion: 3,
    projectId: v2.projectId,
    createdAt: v2.createdAt,
    updatedAt: v2.updatedAt,
    assets,
    tracks,
    operations,
    outputs: [{ outputId: 'output_full_001', kind: 'full', aspects: ['16:9'], status: 'manual' }],
    renderPresets: v2.renderPresets
  });
  const validation = validateManifestV3Document(manifest, { assetExists: (assetId) => assets.some((asset) => asset.assetId === assetId) });
  if (!validation.valid) throw new Error(`Converted v3 manifest failed validation:\n${validation.errors.join('\n')}`);
  warnings.push(...validation.warnings);
  return { manifest, project: { ...project, manifestVersion: 3 }, droppedOperations, warnings };
}

export function migrateV2WorkspaceToV3(workspacePath: string): V2ToV3MigrationResult {
  const workspace = resolve(workspacePath);
  const { manifest, project, droppedOperations, warnings } = buildManifestV3FromV2Workspace(workspace);
  if (!existsSync(join(workspace, 'edits'))) throw new Error('Cannot migrate v2 workspace: missing edits directory');
  writeFileSync(join(workspace, 'edits/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(workspace, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  return { converted: true, droppedOperations, warnings };
}
