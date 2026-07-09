import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertInside } from './filesystem';
import { extractFullBandReference } from './media';

// Each helper writes to a fresh mkdtemp stage then atomically renames onto outAbsPath —
// it NEVER edits its input in place. But if a caller passes out === in, the final rename
// would clobber the input (e.g. the irreplaceable 48k source derivative). Make the
// "never mutates input" contract enforceable, not just documented.
function assertDistinctPaths(inAbsPath: string, outAbsPath: string, fn: string): void {
  if (resolve(inAbsPath) === resolve(outAbsPath)) {
    throw new Error(`${fn}: output path must differ from input path (refusing to overwrite the input: ${inAbsPath})`);
  }
}

// Rounds a timestamp to 6-decimal-place precision for safe ffmpeg boundary use.
// Mirrors roundSec6 in render/pipeline.ts but returns a number (not a string)
// since we use it to build CLI arguments as strings ourselves.
function roundSec6(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Invalid audio timestamp: ${value}`);
  return (Math.round(value * 1_000_000) / 1_000_000).toFixed(6);
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  // spawnSync sets `error` (and leaves status null) when the binary can't be launched
  // (e.g. ENOENT — ffmpeg not on PATH); without this the thrown message would be empty.
  if (result.error) throw new Error(`${command} could not be spawned: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} failed (status ${result.status}${result.signal ? `, signal ${result.signal}` : ''}): ${result.stderr || result.stdout || '(no output)'}`);
}

// Slice [startSec, endSec] out of an existing WAV into a NEW file.
// Uses ffmpeg -ss / -to (input seek) for sample-accurate boundaries.
// startSec/endSec are 6-decimal-rounded before use.
// The output is re-encoded as pcm_s16le (preserves all common sample rates).
// Never modifies the input file — writes to a mkdtemp stage then atomically renames.
export async function sliceAudioWindow(
  inputAbsPath: string,
  startSec: number,
  endSec: number,
  outAbsPath: string
): Promise<void> {
  if (!existsSync(inputAbsPath)) throw new Error(`sliceAudioWindow: input not found: ${inputAbsPath}`);
  assertDistinctPaths(inputAbsPath, outAbsPath, 'sliceAudioWindow');
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) throw new Error(`sliceAudioWindow: start/end must be finite (${startSec}..${endSec})`);
  if (startSec < 0) throw new Error(`sliceAudioWindow: startSec (${startSec}) must be >= 0`);
  if (startSec >= endSec) throw new Error(`sliceAudioWindow: startSec (${startSec}) must be < endSec (${endSec})`);
  const start = roundSec6(startSec);
  const end = roundSec6(endSec);
  mkdirSync(dirname(outAbsPath), { recursive: true });
  const tempDir = mkdtempSync(join(dirname(outAbsPath), '.slice-'));
  const stage = join(tempDir, 'slice.wav');
  try {
    run('ffmpeg', ['-y', '-v', 'error', '-i', inputAbsPath, '-ss', start, '-to', end, '-vn', '-acodec', 'pcm_s16le', stage]);
    renameSync(stage, outAbsPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// Trim leading/trailing silence AND DELETE the overflow of long internal pauses in one pass.
// Uses ffmpeg silenceremove:
//   start_periods=1: trim leading silence
//   stop_periods=-1: multi-region — for every internal+trailing silence, DELETE the portion
//                    beyond stop_duration seconds (it does NOT collapse a pause to a fixed
//                    length — silenceremove has no collapse-to-N primitive; a 2.0s pause with
//                    stop_duration=1.5 keeps ~1.5s and drops the rest; a pause <= stop_duration
//                    is untouched). maxPauseSec IS stop_duration: the max pause LENGTH RETAINED.
// Writes atomically via mkdtemp → rename (never edits inAbsPath in place).
export async function trimPausesAndSilence(
  inAbsPath: string,
  outAbsPath: string,
  opts?: { maxPauseSec?: number; thresholdDb?: number }
): Promise<void> {
  if (!existsSync(inAbsPath)) throw new Error(`trimPausesAndSilence: input not found: ${inAbsPath}`);
  assertDistinctPaths(inAbsPath, outAbsPath, 'trimPausesAndSilence');
  const maxPauseSec = opts?.maxPauseSec ?? 0.5;
  const thresholdDb = opts?.thresholdDb ?? -40;
  const filter = [
    `silenceremove=start_periods=1:start_silence=0:start_threshold=${thresholdDb}dB`,
    `:stop_periods=-1:stop_duration=${maxPauseSec}:stop_threshold=${thresholdDb}dB`
  ].join('');
  mkdirSync(dirname(outAbsPath), { recursive: true });
  const tempDir = mkdtempSync(join(dirname(outAbsPath), '.trim-'));
  const stage = join(tempDir, 'trimmed.wav');
  try {
    run('ffmpeg', ['-y', '-v', 'error', '-i', inAbsPath, '-af', filter, '-acodec', 'pcm_s16le', stage]);
    renameSync(stage, outAbsPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// Single-pass loudnorm for the CLONE-INPUT clip fed to an IVC clone (Cartesia/EL).
// This is NOT the two-pass measured loudnorm match (that's W5/postMatchSeam) — just a
// consistent level for the prepared clone sample.
//
// Target = I=-20 LUFS, TP=-3 dBTP (the clone-input band). ElevenLabs' own IVC guidance
// is a −23..−18 dB RMS window with true peak at −3; loudnorm's I is integrated LUFS
// (loudness, K-weighted) not raw RMS, but for the speech material we feed it the two
// track within ~1 dB, so I=-20 lands squarely inside EL's RMS band while TP=-3 matches
// the true-peak ceiling verbatim. We DROPPED the old broadcast target (I=-16:TP=-1.5:
// LRA=11): -16 LUFS over-drove the clone input relative to EL's guidance, and LRA=11
// invited loudnorm to expand the dynamic range of a short, already-consistent clip.
// The target is exposed as a parameter (default = the clone-input band) so a future
// caller with a different need doesn't have to fork the ffmpeg plumbing — but the ONLY
// caller today is cloneCleanClip's prep chain, so the default IS the clone-input value.
// Writes atomically via mkdtemp → rename.
export async function loudnormClip(
  inAbsPath: string,
  outAbsPath: string,
  opts?: { integratedLufs?: number; truePeakDb?: number }
): Promise<void> {
  if (!existsSync(inAbsPath)) throw new Error(`loudnormClip: input not found: ${inAbsPath}`);
  assertDistinctPaths(inAbsPath, outAbsPath, 'loudnormClip');
  const integratedLufs = opts?.integratedLufs ?? -20;
  const truePeakDb = opts?.truePeakDb ?? -3;
  mkdirSync(dirname(outAbsPath), { recursive: true });
  const tempDir = mkdtempSync(join(dirname(outAbsPath), '.norm-'));
  const stage = join(tempDir, 'normed.wav');
  try {
    run('ffmpeg', ['-y', '-v', 'error', '-i', inAbsPath, '-af', `loudnorm=I=${integratedLufs}:TP=${truePeakDb}`, '-acodec', 'pcm_s16le', stage]);
    renameSync(stage, outAbsPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Extract a time window from the 48k full-band reference on the ASSET axis.
 *
 * Ensures the 48k reference derivative exists (calling extractFullBandReference),
 * then slices [startSec, endSec) to `outAbsPath` at 48000 Hz mono pcm_s16le.
 *
 * CRITICAL: `sliceAudioWindow` preserves the input sample rate; this function
 * always forces -ac 1 -ar 48000 -acodec pcm_s16le so the output is guaranteed
 * to be at 48k regardless of the source rate. Output is written atomically
 * (mkdtemp stage → rename, never in-place). Both paths are validated with
 * assertInside to prevent path traversal.
 *
 * @param workspacePath  Absolute path to the project workspace
 * @param clipId         Clip ID (used to locate the reference derivative)
 * @param startSec       Window start on the asset time axis (must be finite, >= 0)
 * @param endSec         Window end on the asset time axis (must be finite, > startSec)
 * @param outAbsPath     Absolute output path (must be inside workspace)
 */
export async function extractReferenceWindow(
  workspacePath: string,
  clipId: string,
  startSec: number,
  endSec: number,
  outAbsPath: string
): Promise<void> {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    throw new Error(`extractReferenceWindow: start/end must be finite (${startSec}..${endSec})`);
  }
  if (startSec < 0) {
    throw new Error(`extractReferenceWindow: startSec (${startSec}) must be >= 0`);
  }
  if (startSec >= endSec) {
    throw new Error(`extractReferenceWindow: startSec (${startSec}) must be < endSec (${endSec})`);
  }
  const workspace = resolve(workspacePath);
  // Validate outAbsPath is inside the workspace (path-traversal guard) and USE the returned,
  // canonicalized path for every fs op. assertInside resolves absolute paths and rejects any that
  // escape the workspace, so pass outAbsPath straight through — do NOT pre-slice it (a string-prefix
  // slice corrupts a sibling absolute path like `<ws>2/...` into a valid-looking relative path while
  // the writes still land outside the workspace).
  const safeOut = assertInside(workspace, outAbsPath);

  // Ensure the 48k reference derivative exists
  const refRel = await extractFullBandReference(workspace, clipId);
  // assertInside for the reference path as well
  const refAbsPath = assertInside(workspace, refRel);
  // Never let the output collide with the reference itself (would corrupt the shared 48k
  // derivative for every later caller — no-source-mutation spirit). Cheap footgun guard.
  if (resolve(safeOut) === resolve(refAbsPath)) {
    throw new Error('extractReferenceWindow: output path must differ from the 48k reference');
  }

  const start = roundSec6(startSec);
  const end = roundSec6(endSec);
  mkdirSync(dirname(safeOut), { recursive: true });
  const tempDir = mkdtempSync(join(dirname(safeOut), '.refwin-'));
  const stage = join(tempDir, 'window.wav');
  try {
    // Force 48000 Hz mono pcm_s16le regardless of the reference's native rate.
    // Do NOT use sliceAudioWindow here — it preserves the input rate.
    run('ffmpeg', [
      '-y', '-v', 'error',
      '-i', refAbsPath,
      '-ss', start, '-to', end,
      '-vn', '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le',
      stage
    ]);
    renameSync(stage, safeOut);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// Re-export assertInside so audio-clip.test.ts can import it via this module.
export { assertInside };
