import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync, copyFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertInside, loadProject, saveProject, sha256File, nowIso } from './filesystem';
import { appendJobStatus, makeJobId } from './jobs';
import { ClipSourceMetadataSchema } from './schemas';
import { extractClipWaveformPeaks, extractWaveformPeaks } from './waveform';
import { loadManifestV3, saveManifestV3 } from './manifest/io';
import { addAsset } from './assets/operations';
import { addClip } from './tracks/operations';

function run(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ['-version'], { encoding: 'utf8' });
  return result.status === 0;
}

export function doctor() {
  return { ffmpeg: commandAvailable('ffmpeg'), ffprobe: commandAvailable('ffprobe'), node: process.version };
}

export function ffprobeDurationSec(filePath: string): number {
  const stdout = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration < 0) throw new Error(`Could not read media duration: ${filePath}`);
  return duration;
}

function fpsFromStream(video: any): number {
  const fpsText = video.avg_frame_rate || video.r_frame_rate || '0/1';
  const [num, den] = String(fpsText).split('/').map(Number);
  return den ? num / den : Number(fpsText) || 0;
}

export type RecordingProbe = {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  video?: { width: number; height: number; fps: number; codec?: string; pixelFormat?: string };
  audio?: { sampleRate?: number; channels?: number; codec?: string };
};

export function probeRecordingMedia(filePath: string): RecordingProbe {
  const stdout = run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
  const data = JSON.parse(stdout);
  const video = data.streams?.find((s: any) => s.codec_type === 'video');
  const audio = data.streams?.find((s: any) => s.codec_type === 'audio');
  const durationSec = Number(data.format?.duration || video?.duration || audio?.duration || 0);
  return {
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    video: video ? { width: Number(video.width || 0), height: Number(video.height || 0), fps: fpsFromStream(video), codec: video.codec_name || undefined, pixelFormat: video.pix_fmt || undefined } : undefined,
    audio: audio ? { sampleRate: audio.sample_rate ? Number(audio.sample_rate) : undefined, channels: audio.channels ? Number(audio.channels) : undefined, codec: audio.codec_name || undefined } : undefined
  };
}

export function ffprobe(filePath: string) {
  const stdout = run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
  const data = JSON.parse(stdout);
  const video = data.streams?.find((s: any) => s.codec_type === 'video') || {};
  const audio = data.streams?.find((s: any) => s.codec_type === 'audio') || {};
  const fpsText = video.avg_frame_rate || video.r_frame_rate || '0/1';
  const [num, den] = String(fpsText).split('/').map(Number);
  const metadata = ClipSourceMetadataSchema.parse({
    clipId: 'clip_001',
    path: 'input/source.mp4',
    originalFilename: basename(filePath),
    sha256: sha256File(filePath),
    durationSec: Number(data.format?.duration || video.duration || 0),
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    fps: den ? num / den : Number(fpsText) || 0,
    audioSampleRate: Number(audio.sample_rate || 0),
    videoCodec: String(video.codec_name || ''),
    audioCodec: String(audio.codec_name || ''),
    pixelFormat: String(video.pix_fmt || '')
  });
  if (!metadata.durationSec || !metadata.width || !metadata.height || !metadata.fps) throw new Error(`Not a usable video file: ${filePath}`);
  return metadata;
}

export async function importSource(workspacePath: string, filePath: string, options: { copy?: boolean; replace?: boolean } = {}) {
  const sourceInput = resolve(filePath);
  if (!existsSync(sourceInput)) throw new Error(`Source file not found: ${filePath}`);
  const workspace = resolve(workspacePath);
  const target = assertInside(workspace, 'input/source.mp4');
  mkdirSync(join(workspace, 'input'), { recursive: true });

  // Validate/probe before touching the stable workspace source.
  const metadata = ffprobe(sourceInput);
  const sourceHash = metadata.sha256;
  const targetExists = existsSync(target);
  const samePath = resolve(sourceInput) === resolve(target);

  if (options.copy === false && !samePath) {
    throw new Error('copy=false is only allowed when the source is already input/source.mp4; external media must be copied to preserve workspace portability');
  }

  if (targetExists && !samePath) {
    const targetHash = sha256File(target);
    if (targetHash !== sourceHash && !options.replace) {
      throw new Error('input/source.mp4 already exists and differs from the requested source; rerun with --yes/replace approval to replace it');
    }
  }

  if (!samePath && options.copy !== false && (!targetExists || options.replace || sha256File(target) !== sourceHash)) {
    const stage = `${target}.import-${process.pid}-${Date.now()}`;
    try {
      copyFileSync(sourceInput, stage);
      // Re-probe the staged file before atomically promoting it.
      ffprobe(stage);
      renameSync(stage, target);
    } catch (err) {
      rmSync(stage, { force: true });
      throw err;
    }
  }

  const finalMetadata = ffprobe(target);
  const project = loadProject(workspace);
  const clipSource = { ...finalMetadata, originalFilename: basename(sourceInput) };
  project.clipSources = [clipSource];
  project.status.imported = true;
  project.updatedAt = nowIso();
  saveProject(project);
  let manifest = loadManifestV3(workspace);
  const assetId = 'asset_video_001';
  const clipId = 'clip_001';
  if (!manifest.assets.some((asset) => asset.assetId === assetId)) {
    manifest = addAsset(manifest, {
      assetId,
      kind: 'video',
      path: 'input/source.mp4',
      durationSec: clipSource.durationSec,
      provenance: 'imported',
      video: { width: clipSource.width, height: clipSource.height, fps: clipSource.fps, codec: clipSource.videoCodec || undefined, pixelFormat: clipSource.pixelFormat || undefined },
      audio: clipSource.audioSampleRate ? { sampleRate: clipSource.audioSampleRate, codec: clipSource.audioCodec || undefined } : undefined
    }).manifest;
  }
  if (!manifest.tracks.some((track) => track.clips.some((clip) => clip.clipId === clipId))) {
    const videoTrack = manifest.tracks.find((track) => track.kind === 'video') ?? manifest.tracks[0];
    if (!videoTrack) throw new Error('Manifest has no video track');
    manifest = addClip(manifest, { trackId: videoTrack.trackId, clip: { clipId, assetId, sourceStart: 0, sourceEnd: clipSource.durationSec, timelineStart: 0 } }).manifest;
  }
  saveManifestV3(workspace, manifest, { revision: false });
  return project;
}

export async function extractAudio(workspacePath: string, options: { format?: 'wav' | 'mp3'; sampleRate?: number; overwrite?: boolean; logJob?: boolean } = {}) {
  const workspace = resolve(workspacePath);
  const source = assertInside(workspace, 'input/source.mp4');
  if (!existsSync(source)) throw new Error('input/source.mp4 not found; run etvideo import first');
  const format = options.format || 'wav';
  const outputRel = `media/extracted-audio.${format}`;
  const output = assertInside(workspace, outputRel);
  if (existsSync(output) && !options.overwrite) {
    if (format === 'wav' && !existsSync(assertInside(workspace, 'media/peaks.json'))) extractWaveformPeaks(workspace);
    return outputRel;
  }
  mkdirSync(join(workspace, 'media'), { recursive: true });
  const codec = format === 'wav' ? ['-acodec', 'pcm_s16le'] : ['-codec:a', 'libmp3lame', '-b:a', '96k'];
  run('ffmpeg', ['-y', '-i', source, '-vn', '-ac', '1', '-ar', String(options.sampleRate || 16000), ...codec, output], workspace);
  const outputs = [outputRel];
  if (format === 'wav') {
    extractWaveformPeaks(workspace);
    outputs.push('media/peaks.json');
  }
  const project = loadProject(workspace);
  project.status.audioExtracted = true;
  project.updatedAt = nowIso();
  saveProject(project);
  if (options.logJob !== false) appendJobStatus(workspace, { jobId: makeJobId('extract-audio'), projectId: project.projectId, type: 'extract-audio', status: 'succeeded', completedAt: nowIso(), outputs });
  return outputRel;
}

export async function extractClipAudio(workspacePath: string, clipId: string, options: { format?: 'wav' | 'mp3'; sampleRate?: number; overwrite?: boolean; logJob?: boolean } = {}) {
  const workspace = resolve(workspacePath);
  const manifest = loadManifestV3(workspace);
  const clip = manifest.tracks.flatMap((track) => track.clips).find((candidate) => candidate.clipId === clipId);
  if (!clip) throw new Error(`Unknown clipId: ${clipId}`);
  const asset = manifest.assets.find((candidate) => candidate.assetId === clip.assetId);
  if (!asset) throw new Error(`Unknown assetId for clip ${clipId}: ${clip.assetId}`);
  const source = assertInside(workspace, asset.path);
  if (!existsSync(source)) throw new Error(`${asset.path} not found; run etvideo import first`);
  const format = options.format || 'wav';
  const outputRel = `media/${clipId}/extracted-audio.${format}`;
  const output = assertInside(workspace, outputRel);
  if (existsSync(output) && !options.overwrite) {
    if (format === 'wav' && !existsSync(assertInside(workspace, `media/${clipId}/peaks.json`))) extractClipWaveformPeaks(workspace, clipId);
    return outputRel;
  }
  mkdirSync(join(workspace, 'media', clipId), { recursive: true });
  const codec = format === 'wav' ? ['-acodec', 'pcm_s16le'] : ['-codec:a', 'libmp3lame', '-b:a', '96k'];
  run('ffmpeg', ['-y', '-i', source, '-vn', '-ac', '1', '-ar', String(options.sampleRate || 16000), ...codec, output], workspace);
  const outputs = [outputRel];
  if (format === 'wav') { extractClipWaveformPeaks(workspace, clipId); outputs.push(`media/${clipId}/peaks.json`); }
  const project = loadProject(workspace);
  project.status.audioExtracted = true;
  project.updatedAt = nowIso();
  saveProject(project);
  if (options.logJob !== false) appendJobStatus(workspace, { jobId: makeJobId('extract-audio'), projectId: project.projectId, type: 'extract-audio', status: 'succeeded', completedAt: nowIso(), outputs });
  return outputRel;
}

// The reference derivative is always full-band 48 kHz mono pcm_s16le. Fixed (not a caller knob):
// a varying rate would let a non-48k file get cached under the canonical name and poison every
// later clone/seam read.
const FULLBAND_REFERENCE_HZ = 48000;
// clipId is interpolated into the derivative path; only a plain slug is allowed so a hand-edited
// manifest clip id (e.g. '../input') can't escape the media/<clipId>/ derivative area.
const REFERENCE_CLIP_ID_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// True iff `path` probes as exactly 48 kHz mono pcm_s16le AND (when an expected duration is given)
// is COMPLETE — its duration is within tolerance of the source's. Used both to validate a freshly
// extracted derivative before promoting it and to reject a partial/corrupt/wrong-format/truncated
// cache hit (a valid-header but truncated file would otherwise pass a format-only check).
function isValidFullBandReference(path: string, expectedDurationSec?: number): boolean {
  // Parse key=value (NOT positional): ffprobe's `default` output orders fields by the stream's
  // internal layout, not the order requested, so a positional read can land codec_name where a
  // number is expected.
  const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels,codec_name', '-of', 'default=noprint_wrappers=1', path], { encoding: 'utf8' });
  if (result.status !== 0) return false;
  const fields = new Map<string, string>();
  for (const line of result.stdout.trim().split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1));
  }
  if (!(Number(fields.get('sample_rate')) === FULLBAND_REFERENCE_HZ && Number(fields.get('channels')) === 1 && fields.get('codec_name') === 'pcm_s16le')) return false;
  if (expectedDurationSec !== undefined) {
    // The derivative is the FULL source audio (untrimmed), so its duration should track the
    // source's. Generous tolerance (catch truncation/corruption, not minor audio/container drift);
    // a false reject just re-extracts (idempotent), never returns a bad artifact.
    let actual: number;
    try { actual = ffprobeDurationSec(path); } catch { return false; }
    if (Math.abs(actual - expectedDurationSec) > Math.max(0.5, expectedDurationSec * 0.1)) return false;
  }
  return true;
}

// Full-band 48 kHz reference derivative of a clip's SOURCE audio — the SOLE source for voice
// cloning samples and seam/post-match DSP. Deliberately distinct from extractClipAudio's 16 kHz
// copy (media/<clipId>/extracted-audio.wav), which is for transcription ONLY:
//   - never feed the 16 kHz STT copy to synthesis/clone/seam conditioning (narrowband timbre),
//   - never mutate the user's source media.
// Writes a dedicated path (media/<clipId>/reference-48k.wav). The derivative is the FULL source
// audio (no trim), so its time axis equals the source time axis — callers convert clip/timeline
// coords to source coords. Robustness (codex+hermes W2 review): write to a temp file then probe
// and atomically rename, so ffmpeg can't write THROUGH a symlink onto the source/STT file and a
// partial/interrupted extraction can never be cached.
export async function extractFullBandReference(
  workspacePath: string,
  clipId: string,
  options: { overwrite?: boolean } = {}
): Promise<string> {
  const workspace = resolve(workspacePath);
  if (!REFERENCE_CLIP_ID_SLUG.test(clipId)) throw new Error(`Unsafe clipId for reference derivative: ${JSON.stringify(clipId)}`);
  const manifest = loadManifestV3(workspace);
  const clip = manifest.tracks.flatMap((track) => track.clips).find((candidate) => candidate.clipId === clipId);
  if (!clip) throw new Error(`Unknown clipId: ${clipId}`);
  const asset = manifest.assets.find((candidate) => candidate.assetId === clip.assetId);
  if (!asset) throw new Error(`Unknown assetId for clip ${clipId}: ${clip.assetId}`);
  const source = assertInside(workspace, asset.path);
  if (!existsSync(source)) throw new Error(`${asset.path} not found; run etvideo import first`);
  const outputRel = `media/${clipId}/reference-48k.wav`;
  const output = assertInside(workspace, outputRel);
  // Lexical hard-rule guards: never resolve onto the source or the 16 kHz STT/peaks copy.
  if (resolve(output) === resolve(source)) throw new Error('reference derivative path must differ from the source media');
  if (resolve(output) === resolve(assertInside(workspace, `media/${clipId}/extracted-audio.wav`))) {
    throw new Error('reference derivative must not overwrite the 16 kHz STT/peaks audio');
  }
  const sourceDurationSec = ffprobeDurationSec(source);
  // Cache reuse only a REAL file (a symlink could redirect the overwrite below onto the source),
  // fresh relative to the source (clip repoint / source replace re-extracts), that still probes as
  // a COMPLETE 48k mono derivative (rejects a valid-header-but-truncated cache).
  //
  // NOTE (accepted, codex W2 P3): freshness is mtime + duration + format, NOT a stored source hash.
  // The real source-replacement path is importSource, which atomically promotes a new file and so
  // bumps mtime (caught here). A hand-crafted swap of same-duration audio with a backdated mtime
  // would reuse a stale derivative, but that's outside this local-first, single-user threat model;
  // `overwrite: true` is always available. A source-hash sidecar isn't worth the machinery here.
  if (existsSync(output) && !options.overwrite && !lstatSync(output).isSymbolicLink()
      && statSync(output).mtimeMs >= statSync(source).mtimeMs && isValidFullBandReference(output, sourceDurationSec)) {
    return outputRel;
  }
  mkdirSync(join(workspace, 'media', clipId), { recursive: true });
  // Private temp DIR (mkdtemp → unguessable name, 0700) on the SAME filesystem as `output`: the
  // staged file can't be pre-planted as a symlink (closes the staged-path write-through race), and
  // the final rename stays atomic + same-fs. Probe before promote → a partial/corrupt extraction is
  // never cached; rename REPLACES any symlink at `output` rather than writing through it.
  const tempDir = mkdtempSync(join(workspace, 'media', clipId, '.ref-'));
  const stage = join(tempDir, 'reference-48k.wav');
  try {
    run('ffmpeg', ['-y', '-i', source, '-vn', '-ac', '1', '-ar', String(FULLBAND_REFERENCE_HZ), '-acodec', 'pcm_s16le', stage], workspace);
    if (!isValidFullBandReference(stage, sourceDurationSec)) throw new Error('reference derivative failed validation (expected complete 48 kHz mono pcm_s16le)');
    renameSync(stage, output);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  return outputRel;
}

export async function extractAllClipAudio(workspacePath: string, options: { format?: 'wav' | 'mp3'; sampleRate?: number; overwrite?: boolean; logJob?: boolean } = {}) {
  const workspace = resolve(workspacePath);
  const manifest = loadManifestV3(workspace);
  const clips = manifest.tracks.flatMap((track) => track.clips);
  const outputs: string[] = [];
  for (const clip of clips) outputs.push(await extractClipAudio(workspace, clip.clipId, options));
  return outputs;
}

export function readTextIfExists(path: string) { return existsSync(path) ? readFileSync(path, 'utf8') : null; }
