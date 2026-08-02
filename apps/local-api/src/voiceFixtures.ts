import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkspace, loadManifestV3, saveManifestV3, upsertVoice, type ManifestV3 } from '@etvideoscript/core';

// Shared fixture builders for the S1b route tests. Kept out of the *.test.ts files so both the
// prepare-voice and the patch-chain suites describe the SAME workspace shape — a divergence
// between them would quietly test two different products.

/** Deterministic 64-char hex, in the canonical form the cleaned-source contract demands. */
export function cacheKey(seed: string): string {
  return seed.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, '0');
}

export function ffmpeg(args: string[]) {
  const result = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr}`);
}

/** A real (tiny) MP4 so extractFullBandReference and ffprobe have something genuine to chew on. */
export function writeSourceVideo(path: string, seconds: number) {
  mkdirSync(join(path, '..'), { recursive: true });
  ffmpeg(['-f', 'lavfi', '-i', `color=c=black:s=64x64:r=5:d=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=150:duration=${seconds}`, '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path]);
}

export function writeTone(path: string, seconds: number, hz = 150) {
  mkdirSync(join(path, '..'), { recursive: true });
  ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}`, '-ar', '24000', '-ac', '1', '-acodec', 'pcm_s16le', path]);
}

/**
 * Continuous word-accurate transcript: 0.4 s words separated by 0.1 s gaps, so every gap is
 * under MAX_INTERNAL_GAP (0.35 s) and selectCleanWindows tiles the run into ~10 s windows.
 */
export function transcriptWords(clipId: string, seconds: number, timing: 'exact' | 'mock' = 'exact') {
  const words: unknown[] = [];
  let index = 0;
  for (let t = 0; t + 0.4 <= seconds; t += 0.5) {
    words.push({
      id: `w${index}`, text: `word${index}`, normalized: `word${index}`,
      start: Number(t.toFixed(3)), end: Number((t + 0.4).toFixed(3)),
      speaker: 'speaker_1', confidence: 0.95, segmentId: 'seg_1', clipId
    });
    index += 1;
  }
  return {
    schemaVersion: 1, source: 'media/extracted-audio.wav',
    provider: { name: 'test', model: 'test', requestId: null, timing },
    language: 'en', durationSec: seconds, words,
    segments: [{ id: 'seg_1', speaker: 'speaker_1', start: 0, end: seconds, text: 'fixture' }]
  };
}

export interface ProjectFixtureOptions {
  seconds?: number;
  /** 'exact' is the only timing the chain accepts; 'mock' drives the typed preflight failure. */
  timing?: 'exact' | 'mock';
  /** Omit the cleanup entirely, or make it stale/absent-artifact, to drive D6 failures. */
  cleanup?: 'fresh' | 'none' | 'disabled' | 'missing-artifact';
  /** Add a SECOND clip resolving to input/source.mp4 → the ⟨F13⟩ multi-eligible case. */
  extraEligibleClip?: boolean;
  /** Add a clip on an unrelated asset — must be IGNORED, not counted as eligible. */
  unrelatedClip?: boolean;
  /** Non-zero clip.sourceStart / timelineStart for the axis tests. */
  sourceStart?: number;
  timelineStart?: number;
  /** Skip the (slow) real MP4 encode when the test never reaches extractFullBandReference. */
  realVideo?: boolean;
}

export interface ProjectFixture {
  workspace: string;
  projectId: string;
  cleanupKey: string;
  clipId: string;
}

export async function makeProject(root: string, projectId: string, options: ProjectFixtureOptions = {}): Promise<ProjectFixture> {
  const seconds = options.seconds ?? 60;
  const workspace = join(root, projectId);
  await createWorkspace({ workspacePath: workspace, projectId, title: projectId });

  if (options.realVideo) writeSourceVideo(join(workspace, 'input/source.mp4'), seconds);
  else { mkdirSync(join(workspace, 'input'), { recursive: true }); writeFileSync(join(workspace, 'input/source.mp4'), Buffer.from('placeholder')); }

  const key = cacheKey('abc123def456');
  const manifest = loadManifestV3(workspace);
  // The asset must span the clip's SOURCE range, which for a trimmed clip starts past 0.
  const assetDurationSec = (options.sourceStart ?? 0) + seconds;
  manifest.assets = [{ assetId: 'asset_video_001', kind: 'video', path: 'input/source.mp4', durationSec: assetDurationSec, provenance: 'imported', video: { width: 64, height: 64, fps: 5 } } as never];
  const clips: unknown[] = [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: options.sourceStart ?? 0, sourceEnd: (options.sourceStart ?? 0) + seconds, timelineStart: options.timelineStart ?? 0 }];
  if (options.extraEligibleClip) clips.push({ clipId: 'clip_002', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 5, timelineStart: seconds + 1 });
  if (options.unrelatedClip) {
    manifest.assets.push({ assetId: 'asset_broll_001', kind: 'video', path: 'assets/broll/extra.mp4', durationSec: 3, provenance: 'imported', video: { width: 64, height: 64, fps: 5 } } as never);
    clips.push({ clipId: 'clip_broll', assetId: 'asset_broll_001', sourceStart: 0, sourceEnd: 3, timelineStart: seconds + 10 });
  }
  manifest.tracks[0]!.clips = clips as never;

  const cleanupMode = options.cleanup ?? 'fresh';
  if (cleanupMode !== 'none') {
    manifest.studioCleanup = {
      status: cleanupMode === 'disabled' ? 'disabled' : 'approved',
      assetPath: `assets/studio-clean/${key}.wav`,
      cacheKey: key,
      provider: 'studio-sound.elevenlabs-isolation',
      createdAt: new Date().toISOString(),
      costUsd: 0
    } as never;
  }
  saveManifestV3(workspace, manifest, { revision: false });

  if (cleanupMode === 'fresh' || cleanupMode === 'disabled') {
    writeTone(join(workspace, `assets/studio-clean/${key}.wav`), seconds, 150);
  }
  mkdirSync(join(workspace, 'transcript'), { recursive: true });
  writeFileSync(join(workspace, 'transcript/words.json'), JSON.stringify(transcriptWords('clip_001', seconds, options.timing ?? 'exact'), null, 2));

  return { workspace, projectId, cleanupKey: key, clipId: 'clip_001' };
}

/** Pre-seed the prepared clone so patch-route tests don't have to run a (slow) clone job. */
export function seedPreparedVoice(settingsHome: string, projectId: string, cleanupKey: string, options: { accountRef?: string; voiceId?: string } = {}) {
  return upsertVoice({
    homeDir: settingsHome,
    voice: {
      id: 'voice-seeded1',
      name: 'Prepared clone',
      provider: 'elevenlabs',
      voiceId: options.voiceId ?? 'el-voice-abc',
      accountRef: options.accountRef ?? 'elevenlabs',
      originProjectId: projectId,
      cloneScope: 'project',
      sourceAudioRange: { clipId: 'clip_001', start: 0, end: 60 },
      sourceClass: 'cleaned',
      cleanupIdentity: cleanupKey,
      windows: [{ clipId: 'clip_001', start: 0, end: 10 }],
      provenance: { method: 'ivc', createdBy: 'clone-route' }
    } as never
  });
}

/** 16 kHz mono voiced PCM the pure selector can score without ffmpeg in the loop. */
export function syntheticVoicedPcm(seconds: number, hz = 150): Float32Array {
  const rate = 16000;
  const pcm = new Float32Array(Math.floor(seconds * rate));
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.4 * Math.sin((2 * Math.PI * hz * i) / rate);
  return pcm;
}

export function manifestOf(workspace: string): ManifestV3 {
  return loadManifestV3(workspace);
}
