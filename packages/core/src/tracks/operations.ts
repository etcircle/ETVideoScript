import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { addAsset, updateAsset } from '../assets/operations';
import type { Asset } from '../assets/schema';
import { assertInside, relativeToWorkspace } from '../filesystem';
import { loadManifestV3, saveManifestV3 } from '../manifest/io';
import type { ManifestV3 } from '../manifest/schema';
import { validateManifestV3Document } from '../manifest/validate';
import { probeRecordingMedia } from '../ffprobe';
import { channelFixStereoPan, resolveChannelFixForAsset } from '../channelFixScope';
import { channelFixSidecarFresh, writeChannelFixSidecar } from '../channelFixSidecar';
import type { Clip, Track } from './schema';

function validateNext(manifest: ManifestV3): ManifestV3 {
  const result = validateManifestV3Document(manifest);
  if (!result.valid) throw new Error(`Manifest structure edit rejected:\n${result.errors.join('\n')}`);
  return manifest;
}

function touch(manifest: ManifestV3): ManifestV3 {
  return { ...manifest, updatedAt: new Date().toISOString() };
}

function findTrack(manifest: ManifestV3, trackId: string): Track {
  const track = manifest.tracks.find((candidate) => candidate.trackId === trackId);
  if (!track) throw new Error(`Track not found: ${trackId}`);
  return track;
}

function findClipEntry(manifest: ManifestV3, clipId: string): { track: Track; clip: Clip } {
  for (const track of manifest.tracks) {
    const clip = track.clips.find((candidate) => candidate.clipId === clipId);
    if (clip) return { track, clip };
  }
  throw new Error(`Clip not found: ${clipId}`);
}

export type AddTrackInput = Omit<Track, 'clips'> & { clips?: Clip[] };
export function addTrack(manifest: ManifestV3, input: AddTrackInput): { manifest: ManifestV3; track: Track } {
  if (manifest.tracks.some((track) => track.trackId === input.trackId)) throw new Error(`Track already exists: ${input.trackId}`);
  const track: Track = { ...input, clips: input.clips ?? [] };
  return { manifest: validateNext(touch({ ...manifest, tracks: [...manifest.tracks, track] })), track };
}

export function removeTrack(manifest: ManifestV3, input: { trackId: string }): { manifest: ManifestV3; track: Track } {
  const track = findTrack(manifest, input.trackId);
  if (track.clips.length > 0) throw new Error(`Cannot remove non-empty track: ${input.trackId}`);
  return { manifest: validateNext(touch({ ...manifest, tracks: manifest.tracks.filter((candidate) => candidate.trackId !== input.trackId) })), track };
}

export function reorderTracks(manifest: ManifestV3, input: { order: { trackId: string; order: number }[] }): { manifest: ManifestV3; tracks: Track[] } {
  const byId = new Map(input.order.map((entry) => [entry.trackId, entry.order]));
  for (const trackId of Array.from(byId.keys())) findTrack(manifest, trackId);
  const tracks = manifest.tracks.map((track) => byId.has(track.trackId) ? { ...track, order: byId.get(track.trackId)! } : track);
  return { manifest: validateNext(touch({ ...manifest, tracks })), tracks };
}

export function setTrackFlags(manifest: ManifestV3, input: { trackId: string; locked?: boolean; muted?: boolean; solo?: boolean; hidden?: boolean }): { manifest: ManifestV3; track: Track } {
  findTrack(manifest, input.trackId);
  let updated!: Track;
  const tracks = manifest.tracks.map((track) => {
    if (track.trackId !== input.trackId) return track;
    updated = { ...track, locked: input.locked ?? track.locked, muted: input.muted ?? track.muted, solo: input.solo ?? track.solo, hidden: input.hidden ?? track.hidden };
    return updated;
  });
  return { manifest: validateNext(touch({ ...manifest, tracks })), track: updated };
}

export function renameTrack(manifest: ManifestV3, input: { trackId: string; name: string }): { manifest: ManifestV3; track: Track } {
  if (!input.name.trim()) throw new Error('Track name must not be empty');
  findTrack(manifest, input.trackId);
  let updated!: Track;
  const tracks = manifest.tracks.map((track) => {
    if (track.trackId !== input.trackId) return track;
    updated = { ...track, name: input.name };
    return updated;
  });
  return { manifest: validateNext(touch({ ...manifest, tracks })), track: updated };
}

export function addClip(manifest: ManifestV3, input: { trackId: string; clip: Clip }): { manifest: ManifestV3; clip: Clip } {
  findTrack(manifest, input.trackId);
  if (manifest.tracks.some((track) => track.clips.some((clip) => clip.clipId === input.clip.clipId))) throw new Error(`Clip already exists: ${input.clip.clipId}`);
  const tracks = manifest.tracks.map((track) => track.trackId === input.trackId ? { ...track, clips: [...track.clips, input.clip] } : track);
  return { manifest: validateNext(touch({ ...manifest, tracks })), clip: input.clip };
}

export function moveClip(manifest: ManifestV3, input: { clipId: string; timelineStart: number }): { manifest: ManifestV3; clip: Clip } {
  findClipEntry(manifest, input.clipId);
  let updated!: Clip;
  const tracks = manifest.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => {
    if (clip.clipId !== input.clipId) return clip;
    updated = { ...clip, timelineStart: input.timelineStart };
    return updated;
  }) }));
  return { manifest: validateNext(touch({ ...manifest, tracks })), clip: updated };
}

export function trimClip(manifest: ManifestV3, input: { clipId: string; sourceStart: number; sourceEnd: number }): { manifest: ManifestV3; clip: Clip } {
  findClipEntry(manifest, input.clipId);
  let updated!: Clip;
  const tracks = manifest.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => {
    if (clip.clipId !== input.clipId) return clip;
    updated = { ...clip, sourceStart: input.sourceStart, sourceEnd: input.sourceEnd };
    return updated;
  }) }));
  return { manifest: validateNext(touch({ ...manifest, tracks })), clip: updated };
}

export function removeClip(manifest: ManifestV3, input: { clipId: string }): { manifest: ManifestV3; clip: Clip } {
  const { clip } = findClipEntry(manifest, input.clipId);
  const tracks = manifest.tracks.map((track) => ({ ...track, clips: track.clips.filter((candidate) => candidate.clipId !== input.clipId) }));
  return { manifest: validateNext(touch({ ...manifest, tracks })), clip };
}

function nextOrder(manifest: ManifestV3): number {
  return Math.max(-1, ...manifest.tracks.map((track) => track.order)) + 1;
}

function ensureDialogTrack(manifest: ManifestV3): { manifest: ManifestV3; track: Track } {
  const existing = manifest.tracks.find((track) => track.kind === 'audio' && track.subtype === 'dialog');
  if (existing) return { manifest, track: existing };
  const track: Track = { trackId: `track_audio_dialog_${randomUUID()}`, kind: 'audio', subtype: 'dialog', name: 'Dialog', order: nextOrder(manifest), locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [] };
  return { manifest: { ...manifest, tracks: [...manifest.tracks, track] }, track };
}

export function detachAudio(manifest: ManifestV3, input: { clipId: string; assetId: string; detachedClipId?: string }): { manifest: ManifestV3; videoClip: Clip; audioClip: Clip; audioTrack: Track } {
  const asset = manifest.assets.find((candidate) => candidate.assetId === input.assetId);
  if (!asset) throw new Error(`Extracted audio asset not found: ${input.assetId}`);
  if (asset.kind !== 'audio') throw new Error(`Detached audio asset must be audio: ${input.assetId}`);
  const { track: sourceTrack, clip } = findClipEntry(manifest, input.clipId);
  if (sourceTrack.kind !== 'video') throw new Error(`Cannot detach audio: source clip ${input.clipId} is not on a video track`);
  const sourceAsset = manifest.assets.find((candidate) => candidate.assetId === clip.assetId);
  if (!sourceAsset) throw new Error(`Source asset not found: ${clip.assetId}`);
  if (sourceAsset.kind !== 'video') throw new Error(`Cannot detach audio from non-video clip: ${input.clipId}`);
  if (clip.audioDetached) throw new Error(`Clip audio already detached: ${input.clipId}`);
  const ensured = ensureDialogTrack(manifest);
  const audioClip: Clip = {
    clipId: input.detachedClipId ?? `clip_audio_${randomUUID()}`,
    assetId: input.assetId,
    sourceStart: clip.sourceStart,
    sourceEnd: clip.sourceEnd,
    timelineStart: clip.timelineStart,
    detachedFrom: clip.clipId
  };
  if (ensured.manifest.tracks.some((track) => track.clips.some((candidate) => candidate.clipId === audioClip.clipId))) throw new Error(`Clip already exists: ${audioClip.clipId}`);
  let videoClip!: Clip;
  let audioTrack!: Track;
  const tracks = ensured.manifest.tracks.map((track) => {
    if (track.clips.some((candidate) => candidate.clipId === clip.clipId)) {
      return { ...track, clips: track.clips.map((candidate) => {
        if (candidate.clipId !== clip.clipId) return candidate;
        videoClip = { ...candidate, audioDetached: true };
        return videoClip;
      }) };
    }
    if (track.trackId === ensured.track.trackId) {
      audioTrack = { ...track, clips: [...track.clips, audioClip] };
      return audioTrack;
    }
    return track;
  });
  return { manifest: validateNext(touch({ ...ensured.manifest, tracks })), videoClip, audioClip, audioTrack };
}

function extractedAssetFor(manifest: ManifestV3, sourceAsset: Asset): Asset | undefined {
  const expectedAssetId = `asset_audio_${sourceAsset.assetId}`;
  const expectedPath = `assets/audio/${sourceAsset.assetId}.wav`;
  return manifest.assets.find((asset) => asset.kind === 'audio' && asset.assetId === expectedAssetId && asset.path === expectedPath);
}

export function extractAudioAssetInWorkspace(workspacePath: string, manifest: ManifestV3, input: { sourceAssetId: string }): { manifest: ManifestV3; asset: Asset } {
  const sourceAsset = manifest.assets.find((asset) => asset.assetId === input.sourceAssetId);
  if (!sourceAsset) throw new Error(`Source asset not found: ${input.sourceAssetId}`);
  if (sourceAsset.kind !== 'video') throw new Error(`Cannot extract audio from non-video asset: ${input.sourceAssetId}`);

  const workspace = resolve(workspacePath);
  const relativePath = `assets/audio/${sourceAsset.assetId}.wav`;
  const outputPath = assertInside(workspace, relativePath);
  const sourcePath = assertInside(workspace, sourceAsset.path);
  if (!existsSync(sourcePath)) throw new Error(`${sourceAsset.path} not found; run etvideo import first`);
  // Scoped to the source asset (issue #4) — the base recording's fix must not silently
  // pan an unrelated video asset's detached audio.
  const sourceChannel = resolveChannelFixForAsset(manifest, sourceAsset.path);
  const existing = extractedAssetFor(manifest, sourceAsset);
  // Reuse requires the fingerprint sidecar to match the CURRENT fix state AND be at
  // least as new as the source (issue #2/#5) — a detach done before the fix was
  // applied (or before a source replace) must not stay stale forever.
  if (existing && channelFixSidecarFresh(outputPath, sourceChannel, sourcePath)) return { manifest, asset: existing };

  mkdirSync(join(workspace, 'assets/audio'), { recursive: true });
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  // Live-probe (not manifest metadata) so a mono/5.1 source can never get a pan referencing
  // a missing/extra channel (issue #7). Only probed when a fix is actually in scope here —
  // extraction with no fix must not require a real, ffprobe-readable source file.
  const channels = sourceChannel ? (probeRecordingMedia(sourcePath).audio?.channels ?? 0) : 0;
  const panArgs = sourceChannel && channels === 2 ? ['-af', channelFixStereoPan(sourceChannel)] : [];
  const result = spawnSync(ffmpeg, ['-y', '-i', sourcePath, '-vn', ...panArgs, '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '2', outputPath], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg audio extraction failed: ${result.stderr || result.error?.message || 'unknown error'}`);
  writeChannelFixSidecar(outputPath, sourceChannel);
  if (existing) {
    // The bytes just re-extracted above track sourceAsset's CURRENT durationSec (e.g. after
    // a source replace) — if that differs from the existing record, the manifest must be
    // updated too, or it permanently misdescribes the derivative now on disk.
    if (existing.durationSec === sourceAsset.durationSec) return { manifest, asset: existing };
    return updateAsset(manifest, { assetId: existing.assetId, patch: { durationSec: sourceAsset.durationSec } });
  }
  const asset: Asset = { assetId: `asset_audio_${sourceAsset.assetId}`, kind: 'audio', path: relativeToWorkspace(workspace, outputPath), durationSec: sourceAsset.durationSec, provenance: 'imported', audio: { sampleRate: 48000, channels: 2, codec: 'pcm_s16le' } };
  return addAsset(manifest, asset);
}

/**
 * `refresh: true` (default false, preserving the pre-existing throw below) lets an
 * ALREADY-detached clip revisit its underlying bytes: extractAudioAssetInWorkspace's
 * freshness check (above) re-extracts assets/audio/<assetId>.wav in place if it's
 * stale relative to the current audioChannelFix state, and this function then just
 * resolves the existing companion audio clip/track instead of throwing (issue #4).
 * No manifest write is needed on that path — only file bytes on disk changed, the
 * clip/track/asset records are untouched (detachAudio never runs twice).
 */
export function detachAudioInWorkspace(workspacePath: string, input: { clipId: string; detachedClipId?: string; refresh?: boolean }): { manifest: ManifestV3; videoClip: Clip; audioClip: Clip; audioTrack: Track; asset: Asset } {
  const manifest = loadManifestV3(workspacePath);
  const { clip } = findClipEntry(manifest, input.clipId);
  const extracted = extractAudioAssetInWorkspace(workspacePath, manifest, { sourceAssetId: clip.assetId });
  if (clip.audioDetached) {
    if (!input.refresh) throw new Error(`Clip audio already detached: ${input.clipId}`);
    const audioClip = extracted.manifest.tracks.flatMap((track) => track.clips).find((candidate) => candidate.detachedFrom === clip.clipId);
    const audioTrack = extracted.manifest.tracks.find((track) => track.clips.some((candidate) => candidate.clipId === audioClip?.clipId));
    if (!audioClip || !audioTrack) throw new Error(`Clip ${input.clipId} is marked detached but its companion audio clip is missing`);
    return { manifest: extracted.manifest, videoClip: clip, audioClip, audioTrack, asset: extracted.asset };
  }
  const detached = detachAudio(extracted.manifest, { clipId: input.clipId, assetId: extracted.asset.assetId, detachedClipId: input.detachedClipId });
  saveManifestV3(workspacePath, detached.manifest, { revision: true });
  return { ...detached, asset: extracted.asset };
}
