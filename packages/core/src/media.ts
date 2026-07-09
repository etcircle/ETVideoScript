import { existsSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertInside, loadProject, saveProject, sha256File, nowIso, writeDerivativeStaged } from './filesystem';
import { appendJobStatus, makeJobId } from './jobs';
import { ClipSourceMetadataSchema } from './schemas';
import { extractClipWaveformPeaks, extractWaveformPeaks } from './waveform';
import { loadManifestV3, saveManifestV3 } from './manifest/io';
import { addAsset, updateAsset } from './assets/operations';
import { addClip } from './tracks/operations';
import { run, probeRecordingMedia, type RecordingProbe } from './ffprobe';
import { channelFixMonoPan, resolveChannelFixForAsset } from './channelFixScope';
import { channelFixSidecarFresh, writeChannelFixSidecar } from './channelFixSidecar';

// Re-exported for back-compat: callers previously imported these from media.ts.
export { probeRecordingMedia, type RecordingProbe };

export function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ['-version'], { encoding: 'utf8' });
  return result.status === 0;
}

export function doctor() {
  return { ffmpeg: commandAvailable('ffmpeg'), ffprobe: commandAvailable('ffprobe'), node: process.version };
}

/**
 * ffprobe RAN and produced output, but the duration in it was not a usable number
 * (e.g. `duration=N/A` for a zero-sample WAV container). Distinct from process-level
 * failures (ffprobe binary missing, file unreadable), which run() surfaces as plain
 * Errors — ffprobeDurationSecOrZero maps ONLY this class to 0.
 */
export class MediaDurationUnreadableError extends Error {
  constructor(filePath: string) {
    super(`Could not read media duration: ${filePath}`);
    this.name = 'MediaDurationUnreadableError';
  }
}

export function ffprobeDurationSec(filePath: string): number {
  const stdout = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration < 0) throw new MediaDurationUnreadableError(filePath);
  return duration;
}

/**
 * Like ffprobeDurationSec, but returns 0 when the probe RAN and the duration was
 * unreadable. For freshly-synthesized TTS assets: a payload that was pure silence
 * gets silence-trimmed (tts.ts trimSilenceInPlace) down to a zero-sample WAV whose
 * container ffprobe reports as duration=N/A. That is a DEGRADED PAYLOAD, not an
 * internal error — callers route the 0 through their existing sub-100 ms floor so
 * the op is rejected cleanly (same defense as the ~50 ms ElevenLabs near-silence
 * case) instead of surfacing a raw 500 from the probe. Process/filesystem failures
 * (missing ffprobe binary, missing file, permissions) still propagate — mapping
 * them to 0 would misreport real local infra breakage as "provider returned 0 ms".
 */
export function ffprobeDurationSecOrZero(filePath: string): number {
  try { return ffprobeDurationSec(filePath); }
  catch (err) {
    if (err instanceof MediaDurationUnreadableError) return 0;
    throw err;
  }
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
  // audioChannels rides alongside the schema-validated metadata (not part of
  // ClipSourceMetadataSchema) so callers that need the channel count can read it
  // off this same probe instead of spawning a second, redundant ffprobe process.
  return { ...metadata, audioChannels: audio.channels ? Number(audio.channels) : undefined };
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

  const willCopy = !samePath && options.copy !== false && (!targetExists || options.replace || sha256File(target) !== sourceHash);

  // VALIDATE THEN PROMOTE (issue #1): stage the new bytes (if copying) WITHOUT promoting
  // them onto input/source.mp4 yet, build the prospective manifest mutation entirely in
  // memory against the STAGED bytes, and only rename/save once that mutation has been
  // proven valid. A shorter replacement that would leave an existing clip's sourceEnd
  // past the new asset's durationSec must be rejected BEFORE input/source.mp4 or
  // project.json are touched — never a split-brain workspace with new bytes but a stale
  // (or now-invalid) manifest silently left in place.
  let stage: string | undefined;
  try {
    if (willCopy) {
      stage = `${target}.import-${process.pid}-${Date.now()}`;
      copyFileSync(sourceInput, stage);
    }
    // Probe the bytes that will actually land at target — this also re-validates the
    // staged file is readable before it's ever promoted (previously a separate `ffprobe(stage)`
    // call whose result was discarded).
    const probeSource = stage ?? target;
    const finalMetadata = ffprobe(probeSource);
    const project = loadProject(workspace);
    // Captured BEFORE clipSources is overwritten below: the hash importSource recorded the
    // last time it ran against this workspace, i.e. what audioChannelFix (if any) was
    // analyzed against. Covers both a copied-in replace and an in-place edit at samePath —
    // either way, a changed hash means the previous fix/metadata describe stale bytes.
    // Compared against finalMetadata.sha256 (the STAGED/final bytes), not the earlier
    // sourceHash probe of the caller-supplied path (issue #12) — closes the window where
    // the external file changes between the initial probe (line 66) and the copy above.
    const previousSourceHash = project.clipSources[0]?.sha256;
    const clipSource = { ...finalMetadata, originalFilename: basename(sourceInput) };
    const contentReplaced = previousSourceHash !== undefined && previousSourceHash !== finalMetadata.sha256;
    const audioMetadata = clipSource.audioSampleRate ? { sampleRate: clipSource.audioSampleRate, channels: finalMetadata.audioChannels, codec: clipSource.audioCodec || undefined } : undefined;

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
        audio: audioMetadata
      }).manifest;
    } else if (contentReplaced) {
      // Replacing the recording with different bytes: refresh the asset's probed metadata
      // (incl. channel count) so it describes the NEW media, not whatever was probed when
      // the asset record was first created — buildRenderPlan's channel-count guard and any
      // future fix depend on this staying accurate. updateAsset validates the resulting
      // manifest internally and THROWS here (before any promotion below) if the new,
      // shorter duration would leave an existing clip's sourceEnd past it.
      manifest = updateAsset(manifest, {
        assetId,
        patch: {
          durationSec: clipSource.durationSec,
          video: { width: clipSource.width, height: clipSource.height, fps: clipSource.fps, codec: clipSource.videoCodec || undefined, pixelFormat: clipSource.pixelFormat || undefined },
          audio: audioMetadata
        }
      }).manifest;
    }
    if (!manifest.tracks.some((track) => track.clips.some((clip) => clip.clipId === clipId))) {
      const videoTrack = manifest.tracks.find((track) => track.kind === 'video') ?? manifest.tracks[0];
      if (!videoTrack) throw new Error('Manifest has no video track');
      manifest = addClip(manifest, { trackId: videoTrack.trackId, clip: { clipId, assetId, sourceStart: 0, sourceEnd: clipSource.durationSec, timelineStart: 0 } }).manifest;
    }
    // A real content replacement invalidates any approved channel fix — it was computed
    // against the OLD bytes. Disable (never delete) so the record + its history survive;
    // the user re-runs `ets fix-channels` for a fresh recommendation on the new recording.
    // Auto-detection never overwrites a disabled record by design, so this doesn't
    // auto-re-detect — an explicit re-run is required, which is the correct, reversible
    // behavior (see applyChannelFix).
    if (contentReplaced && manifest.audioChannelFix?.status === 'approved') {
      manifest = { ...manifest, audioChannelFix: { ...manifest.audioChannelFix, status: 'disabled', appliedAt: nowIso() } };
    }

    // Every prospective mutation above has been validated (addAsset/updateAsset/addClip
    // each validate internally) — only NOW promote: rename the staged bytes into place,
    // then persist project.json and the manifest. Nothing above this point touched
    // workspace state, so a throw anywhere above leaves input/source.mp4, project.json,
    // and edits/manifest.json byte-for-byte unchanged — a retry throws identically.
    if (stage) renameSync(stage, target);
    project.clipSources = [clipSource];
    project.status.imported = true;
    project.updatedAt = nowIso();
    saveProject(project);
    saveManifestV3(workspace, manifest);
    return project;
  } catch (err) {
    if (stage) rmSync(stage, { force: true });
    throw err;
  }
}

// Approved audioChannelFix → live channel of the base recording; undefined otherwise.
// Tolerates a missing/invalid manifest: extraction must keep working in degraded
// workspaces, and the fix simply doesn't apply there.
function manifestSourceChannel(workspace: string): 'left' | 'right' | undefined {
  try {
    return resolveChannelFixForAsset(loadManifestV3(workspace), 'input/source.mp4');
  } catch {
    return undefined;
  }
}

// Mono-downmix args for extraction. Default `-ac 1` AVERAGES all channels, so a
// dead channel dilutes speech by ~6 dB; with an approved channel fix we take ONLY
// the live channel. Falls back to -ac 1 when the file is not exactly 2-channel
// stereo — a pan referencing a channel a mono file lacks would fail the whole
// ffmpeg run, and a 5.1/7.1 source would drop center-channel dialogue by
// selecting only c0/c1.
function monoDownmixArgs(sourceChannel: 'left' | 'right' | undefined, sourcePath: string): string[] {
  if (!sourceChannel) return ['-ac', '1'];
  const channels = probeRecordingMedia(sourcePath).audio?.channels ?? 0;
  if (channels !== 2) return ['-ac', '1'];
  return ['-af', channelFixMonoPan(sourceChannel)];
}

export async function extractAudio(workspacePath: string, options: { format?: 'wav' | 'mp3'; sampleRate?: number; overwrite?: boolean; logJob?: boolean } = {}) {
  const workspace = resolve(workspacePath);
  const source = assertInside(workspace, 'input/source.mp4');
  if (!existsSync(source)) throw new Error('input/source.mp4 not found; run etvideo import first');
  const format = options.format || 'wav';
  const outputRel = `media/extracted-audio.${format}`;
  const output = assertInside(workspace, outputRel);
  const sourceChannel = manifestSourceChannel(workspace);
  // Cache reuse requires the fingerprint sidecar to match the CURRENT fix state, not just
  // file existence — otherwise a fix applied/changed/disabled after the last extraction
  // silently keeps serving audio mixed for the old (or absent) state (issue #1). It also
  // requires the derivative to be at least as new as the source (issue #2) — otherwise a
  // source replace (importSource) keeps serving audio extracted from the OLD recording.
  if (!options.overwrite && channelFixSidecarFresh(output, sourceChannel, source)) {
    if (format === 'wav' && !existsSync(assertInside(workspace, 'media/peaks.json'))) extractWaveformPeaks(workspace);
    return outputRel;
  }
  mkdirSync(join(workspace, 'media'), { recursive: true });
  const codec = format === 'wav' ? ['-acodec', 'pcm_s16le'] : ['-codec:a', 'libmp3lame', '-b:a', '96k'];
  // Staged write (not ffmpeg -y at the destination): a pre-planted symlink at `output` must be
  // REPLACED, never written through — this regeneration runs automatically off sidecar staleness.
  writeDerivativeStaged(output, (stage) => run('ffmpeg', ['-y', '-i', source, '-vn', ...monoDownmixArgs(sourceChannel, source), '-ar', String(options.sampleRate || 16000), ...codec, stage], workspace));
  writeChannelFixSidecar(output, sourceChannel);
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
  // Scoped to THIS clip's asset (issue #4) — the base recording's fix must not silently
  // pan an unrelated imported clip/b-roll asset.
  const sourceChannel = resolveChannelFixForAsset(manifest, asset.path);
  if (!options.overwrite && channelFixSidecarFresh(output, sourceChannel, source)) {
    if (format === 'wav' && !existsSync(assertInside(workspace, `media/${clipId}/peaks.json`))) extractClipWaveformPeaks(workspace, clipId);
    return outputRel;
  }
  mkdirSync(join(workspace, 'media', clipId), { recursive: true });
  const codec = format === 'wav' ? ['-acodec', 'pcm_s16le'] : ['-codec:a', 'libmp3lame', '-b:a', '96k'];
  // Staged write — same symlink defense as extractAudio above.
  writeDerivativeStaged(output, (stage) => run('ffmpeg', ['-y', '-i', source, '-vn', ...monoDownmixArgs(sourceChannel, source), '-ar', String(options.sampleRate || 16000), ...codec, stage], workspace));
  writeChannelFixSidecar(output, sourceChannel);
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
  // Scoped to THIS clip's asset (issue #4) — the base recording's fix must not silently
  // pan an unrelated imported clip/b-roll asset used as a voice-clone reference.
  const sourceChannel = resolveChannelFixForAsset(manifest, asset.path);
  // Cache reuse only a REAL file (a symlink could redirect the overwrite below onto the source),
  // fresh relative to the source (clip repoint / source replace re-extracts), that still probes as
  // a COMPLETE 48k mono derivative (rejects a valid-header-but-truncated cache).
  //
  // NOTE (accepted, codex W2 P3): freshness is mtime + duration + format, NOT a stored source hash.
  // The real source-replacement path is importSource, which atomically promotes a new file and so
  // bumps mtime (caught here). A hand-crafted swap of same-duration audio with a backdated mtime
  // would reuse a stale derivative, but that's outside this local-first, single-user threat model;
  // `overwrite: true` is always available. A source-hash sidecar isn't worth the machinery here.
  //
  // audioChannelFix is also a freshness dimension: the derivative's channel mix (mono-downmix vs.
  // live-channel-only) depends on it, so an apply/re-apply/disable after extraction must invalidate
  // the cache even though the source file itself hasn't changed. Keyed by a value fingerprint
  // (issue #5), not appliedAt/mtime ordering — immune to a restored older revision or a
  // hand-edited sourceChannel whose appliedAt wasn't bumped to match. The symlink/mtime/fingerprint
  // checks above live in channelFixSidecarFresh (shared with extractAudio/extractClipAudio/
  // extractAudioAssetInWorkspace) — isValidFullBandReference below adds the format/duration check
  // that's unique to this derivative.
  if (!options.overwrite && channelFixSidecarFresh(output, sourceChannel, source) && isValidFullBandReference(output, sourceDurationSec)) {
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
    run('ffmpeg', ['-y', '-i', source, '-vn', ...monoDownmixArgs(sourceChannel, source), '-ar', String(FULLBAND_REFERENCE_HZ), '-acodec', 'pcm_s16le', stage], workspace);
    if (!isValidFullBandReference(stage, sourceDurationSec)) throw new Error('reference derivative failed validation (expected complete 48 kHz mono pcm_s16le)');
    renameSync(stage, output);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  writeChannelFixSidecar(output, sourceChannel);
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
