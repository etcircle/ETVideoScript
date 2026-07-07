import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { assertInside } from '../filesystem';
import { loadManifestV3, saveManifestV3 } from '../manifest/io';
import { probeRecordingMedia } from '../media';
import { addAsset } from '../assets/operations';
import { addClip, addTrack } from '../tracks/operations';
import { TakesError } from './schema';

export interface ImportTakeResult { assetId: string; clipId: string; path: string; durationSec: number }

const STAGING_TRACK_ID = 'track_takes';

function nextTakeIndex(workspaceDir: string): number {
  const takesDir = assertInside(resolve(workspaceDir), 'input/takes');
  if (!existsSync(takesDir)) return 1;
  let max = 0;
  for (const name of readdirSync(takesDir)) {
    const m = /^take-(\d+)\./.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export function importTake(workspaceDir: string, sourceFilePath: string, opts: { groupId: string; label?: string }): ImportTakeResult {
  const source = resolve(sourceFilePath);
  if (!existsSync(source)) throw new TakesError('COMPOSE_VALIDATION', `Take source not found: ${sourceFilePath}`);
  const workspace = resolve(workspaceDir);
  const probe = probeRecordingMedia(source);
  if (!probe.hasVideo || probe.durationSec <= 0) throw new TakesError('COMPOSE_VALIDATION', `Not a usable video take: ${sourceFilePath}`);

  const index = nextTakeIndex(workspace);
  const nn = String(index).padStart(2, '0');
  const ext = extname(source) || '.mp4';
  const relPath = `input/takes/take-${nn}${ext}`;
  const target = assertInside(workspace, relPath);
  mkdirSync(assertInside(workspace, 'input/takes'), { recursive: true });
  if (existsSync(target)) throw new TakesError('COMPOSE_VALIDATION', `Take target already exists (unexpected): ${relPath}`);
  copyFileSync(source, target);

  const assetId = `asset_take_${nn}`;
  const clipId = `clip_take_${nn}`;
  let manifest = loadManifestV3(workspace);
  manifest = addAsset(manifest, {
    assetId, kind: 'video', path: relPath, durationSec: probe.durationSec, provenance: 'imported',
    video: probe.video ? { width: probe.video.width, height: probe.video.height, fps: probe.video.fps, codec: probe.video.codec, pixelFormat: probe.video.pixelFormat } : undefined,
    audio: probe.audio ? { sampleRate: probe.audio.sampleRate, channels: probe.audio.channels, codec: probe.audio.codec } : undefined
  }).manifest;

  if (!manifest.tracks.some((t) => t.role === 'staging')) {
    manifest = addTrack(manifest, { trackId: STAGING_TRACK_ID, kind: 'video', name: 'Takes', order: 1000, locked: false, muted: false, solo: false, role: 'staging', hidden: true, clips: [] }).manifest;
  }
  const stagingTrack = manifest.tracks.find((t) => t.role === 'staging')!;
  manifest = addClip(manifest, { trackId: stagingTrack.trackId, clip: { clipId, assetId, sourceStart: 0, sourceEnd: probe.durationSec, timelineStart: 0 } }).manifest;

  const group = manifest.takeGroups.find((g) => g.groupId === opts.groupId);
  if (group) group.clipIds.push(clipId);
  else manifest.takeGroups.push({ groupId: opts.groupId, label: opts.label ?? opts.groupId, clipIds: [clipId] });

  saveManifestV3(workspace, manifest, { revision: true });
  return { assetId, clipId, path: relPath, durationSec: probe.durationSec };
}
