/**
 * W5 post-match seam DSP — bakes a natural splice INTO a pure-TTS voice-patch WAV,
 * in place (atomic temp → rename), BEFORE the caller's ffprobe so durationGeneratedSec
 * is truthful. Additive + opt-in: only runs when synthesizeSpeech receives
 * postMatchSeam:true + a seam window.
 *
 * Approach (pure-TTS-in-a-base-muted-slot — NOT infill's ε-margin crossfade):
 *  1. LEVEL match — two-pass MEASURED loudnorm targeting the NEIGHBOR's measured
 *     integrated loudness (never a static −16). If the neighbor is unusable
 *     (near-silent), apply NO gain (do NOT invent a −16 target).
 *  2. ROOM-TONE bed — sampled from the silence ADJACENT to the seam (side-aware),
 *     with a deterministic low-level NOISE fallback (anoisesrc, fixed seed) — never
 *     digital zero, which would read as the dropout we are trying to avoid.
 *  3. Equal-power qsin fade-in/out on the patch's OWN edges (replacing the pipeline's
 *     linear afade, which dips ~6 dB). NO neighbor audio is baked into the asset and
 *     there is NO re-extract — so the patch can never echo the audio it sits beside,
 *     and BOTH edges are feathered.
 *
 * The asset's duration is preserved (loudnorm is linear, the bed is clamped to the
 * patch via amix duration=first, and edge fades don't change length), then measured
 * — never predicted. seamBaked → renderContribution emits crossfadeSec:0 so the
 * pipeline does not double-fade the already-feathered seam.
 *
 * Non-fatal by contract: on ANY ffmpeg/probe failure (or a concurrent overwrite of
 * the patch) it leaves the asset byte-identical and returns { baked: false }, so the
 * caller's ffprobe still sees a truthful un-baked duration and seamBaked is not set.
 * Deterministic: no randomness (noise seed is fixed), no wall-clock dependence.
 * All ffmpeg boundary timestamps via roundSec6; 48 kHz mono pcm_s16le throughout;
 * neighbors come ONLY from the 48k full-band reference, never the 16k STT copy.
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Module-private helpers (intentionally not exported — mirrors audioClip.ts)
// ---------------------------------------------------------------------------

function roundSec6(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`postMatchSeam: invalid timestamp: ${value}`);
  return (Math.round(value * 1_000_000) / 1_000_000).toFixed(6);
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw new Error(`${command} could not be spawned: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} failed (status ${result.status}): ${result.stderr || result.stdout || '(no output)'}`);
  }
}

function probeDuration(absPath: string): number {
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    absPath
  ], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`probeDuration: ffprobe failed on ${absPath}: ${r.stderr ?? r.error?.message ?? ''}`);
  const dur = Number(r.stdout.trim());
  if (!Number.isFinite(dur) || dur <= 0) throw new Error(`probeDuration: could not read duration of ${absPath}`);
  return dur;
}

interface LoudnormStats {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

// loudnorm emits the literal strings "inf"/"-inf" (NOT "Infinity") for pure/near silence;
// Number("-inf") is NaN, so parse those explicitly to ±Infinity. ±Infinity is a VALID
// silent-neighbor reading (the caller then treats the neighbor as unusable and keeps the
// patch level) — only a genuinely-missing field (NaN) is a parse failure.
function parseLoudnormNum(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v).trim().toLowerCase();
  if (s === '-inf' || s === '-infinity') return -Infinity;
  if (s === 'inf' || s === '+inf' || s === 'infinity' || s === '+infinity') return Infinity;
  return Number(s);
}

/** Parse loudnorm JSON from STDERR; ±Infinity allowed (silence), NaN rejected. */
function parseLoudnormJson(stderr: string): LoudnormStats {
  const start = stderr.indexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('parseLoudnormJson: no JSON block in loudnorm output');
  const json = JSON.parse(stderr.slice(start, end + 1));
  const stats: LoudnormStats = {
    input_i: parseLoudnormNum(json.input_i),
    input_tp: parseLoudnormNum(json.input_tp),
    input_lra: parseLoudnormNum(json.input_lra),
    input_thresh: parseLoudnormNum(json.input_thresh),
    target_offset: parseLoudnormNum(json.target_offset)
  };
  for (const [k, v] of Object.entries(stats)) {
    if (Number.isNaN(v)) throw new Error(`parseLoudnormJson: ${k} is not a number (${json[k]})`);
  }
  return stats;
}

/** MEASURE pass: loudnorm print_format=json, parse from STDERR. */
function measureLoudness(absPath: string): LoudnormStats {
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats',
    '-i', absPath,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
    '-f', 'null', '-'
  ], { encoding: 'utf8' });
  if (result.error) throw new Error(`measureLoudness: ffmpeg could not be spawned: ${result.error.message}`);
  return parseLoudnormJson(result.stderr ?? '');
}

interface SilenceRegion {
  startSec: number;
  endSec: number;
}

/**
 * Detect silence on `neighborAbsPath` and return the region NEAREST the seam.
 * The seam sits at the END of a LEFT-window slice and the START of a RIGHT-window
 * slice, so side-awareness matters: left → largest endSec, right → smallest startSec.
 * Closes an unterminated trailing silence at `neighborDurationSec` (ffmpeg may only
 * emit silence_start at EOF). Deterministic tie-breaks. null when none qualifies.
 */
function findAdjacentSilence(
  neighborAbsPath: string,
  minLenSec: number,
  side: 'left' | 'right',
  neighborDurationSec: number,
  thresholdDb = -40
): SilenceRegion | null {
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats',
    '-i', neighborAbsPath,
    '-af', `silencedetect=noise=${thresholdDb}dB:d=${minLenSec.toFixed(3)}`,
    '-f', 'null', '-'
  ], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;

  const regions: SilenceRegion[] = [];
  let pendingStart: number | null = null;
  for (const line of (result.stderr ?? '').split('\n')) {
    const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
    const endMatch = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (startMatch) pendingStart = Number(startMatch[1]);
    if (endMatch && pendingStart !== null) {
      const endSec = Number(endMatch[1]);
      const dur = endSec - pendingStart;
      if (Number.isFinite(dur) && dur >= minLenSec) regions.push({ startSec: pendingStart, endSec });
      pendingStart = null;
    }
  }
  // Close a trailing silence that ran to EOF (no silence_end emitted).
  if (pendingStart !== null && Number.isFinite(neighborDurationSec)) {
    const dur = neighborDurationSec - pendingStart;
    if (Number.isFinite(dur) && dur >= minLenSec) regions.push({ startSec: pendingStart, endSec: neighborDurationSec });
  }
  if (regions.length === 0) return null;

  if (side === 'left') {
    // Seam at window end → nearest = largest endSec (tie: largest startSec).
    regions.sort((a, b) => (b.endSec - a.endSec) || (b.startSec - a.startSec));
  } else {
    // Seam at window start → nearest = smallest startSec (tie: smallest endSec).
    regions.sort((a, b) => (a.startSec - b.startSec) || (a.endSec - b.endSec));
  }
  return regions[0]!;
}

/** Slice [startSec, endSec) → outAbsPath. 48 kHz mono pcm_s16le, atomic temp→rename. */
function sliceWav(inputAbsPath: string, startSec: number, endSec: number, outAbsPath: string): void {
  if (startSec >= endSec) throw new Error(`sliceWav: startSec (${startSec}) must be < endSec (${endSec})`);
  mkdirSync(dirname(outAbsPath), { recursive: true });
  const tempDir = mkdtempSync(join(dirname(outAbsPath), '.slice-'));
  const stage = join(tempDir, 'slice.wav');
  try {
    run('ffmpeg', [
      '-y', '-hide_banner', '-v', 'error',
      '-i', inputAbsPath,
      '-ss', roundSec6(startSec), '-to', roundSec6(endSec),
      '-vn', '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le',
      stage
    ]);
    renameSync(stage, outAbsPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface PostMatchSeamOptions {
  /** Absolute path to the 48k full-band reference (media/<clipId>/reference-48k.wav). */
  referenceAbsPath: string;
  /** Edit window in the reference's ASSET time axis. (The tts.ts bridge converts the
   *  clip-local op.target via + clip.sourceStart before calling this.) */
  editStartSec: number;
  editEndSec: number;
  /** Granularity tunes neighbor-window + feather length. Defaults to 'phrase'. */
  granularity?: 'word' | 'phrase' | 'sentence';
  /**
   * Seam processing mode. Defaults to 'full'.
   *
   * 'full'          — level-match + room-tone bed (adjacent silence seed or synthetic
   *                   brown-noise fallback) + qsin edge feather. Today's default.
   * 'level-feather' — level-match + qsin edge feather ONLY. The room-tone bed is
   *                   skipped entirely (no adjacent-silence seed, no synthetic noise).
   *                   Use when the patch already carries room tone natively (e.g.
   *                   Cartesia reference-conditioned infill) to avoid double-applying
   *                   the room. The level-match step still runs so the loudness meets
   *                   the neighbor target.
   */
  mode?: 'full' | 'level-feather';
}

export interface SeamReport {
  /**
   * Absolute loudness step between the neighbor and the post-bake patch on the
   * left side (dB). `null` when the post-bake measurement failed or was
   * unavailable — distinguishable from a real 0 (perfect match).
   */
  leftLevelStepDb: number | null;
  /**
   * Same as leftLevelStepDb for the right side. Currently both sides share the
   * same measured value; typed individually for future asymmetric measurement.
   */
  rightLevelStepDb: number | null;
  /**
   * 'adjacent' when a real adjacent-silence seed was used for the room-tone bed;
   * 'synthetic' when the deterministic brown-noise fallback was used;
   * 'none' when the room-tone bed was skipped entirely (mode: 'level-feather').
   */
  roomToneSource: 'adjacent' | 'synthetic' | 'none';
  durationBeforeSec: number;
  durationAfterSec: number;
}

export interface PostMatchSeamResult {
  /** True when the bake (level + room-tone bed + qsin edge fades) was applied. */
  baked: boolean;
  /** Post-bake duration (ffprobed AFTER the bake). undefined when baked === false. */
  durationSec?: number;
  /** Deterministic seam report for logging/diagnostics. */
  report?: SeamReport;
}

// Granularity → (neighbor window W seconds, qsin edge-fade duration seconds).
const GRANULARITY_PARAMS: Record<string, { windowSec: number; qsinD: number }> = {
  word:     { windowSec: 0.30, qsinD: 0.010 },
  phrase:   { windowSec: 0.60, qsinD: 0.025 },
  sentence: { windowSec: 1.00, qsinD: 0.030 }
};

// A neighbor whose measured integrated loudness is at/below this is treated as silence
// (no usable level target). −70 LUFS is far below any real speech; pure digital silence
// reads as -inf / −120.
const NEIGHBOR_SILENCE_FLOOR_LUFS = -70;

// The neighbor LEVEL target is measured over a WIDER window than the room-tone/crossfade
// window. loudnorm's EBU R128 integrated-loudness measurement has a ~400 ms gate: a window
// shorter than that returns input_i = -inf, which reads as a silent neighbor and SILENTLY
// disables the level match (the word-granularity room-tone window is only 0.30 s). A ~2.5 s
// window clears the gate, and loudnorm's own relative gate excludes the in-window breaths so
// the target reflects neighbor SPEECH, not speech+silence. Decoupled from GRANULARITY_PARAMS
// because room-tone seeding wants a TIGHT adjacent window while level wants a STABLE one.
const LEVEL_MEASURE_WINDOW_SEC = 2.5;

export async function postMatchSeam(
  patchAbsPath: string,
  options: PostMatchSeamOptions
): Promise<PostMatchSeamResult> {
  const { referenceAbsPath, editStartSec, editEndSec, granularity } = options;
  const mode = options.mode ?? 'full';

  try {
    if (!existsSync(patchAbsPath) || !existsSync(referenceAbsPath)) return { baked: false };

    const gran = (granularity && GRANULARITY_PARAMS[granularity]) ? granularity : 'phrase';
    const { windowSec: W, qsinD } = GRANULARITY_PARAMS[gran]!;

    let refDuration: number;
    let patchDurationBefore: number;
    try {
      refDuration = probeDuration(referenceAbsPath);
      patchDurationBefore = probeDuration(patchAbsPath);
    } catch {
      return { baked: false };
    }

    // Concurrency guard: snapshot identity now; re-check immediately before the rename.
    let beforeStat: ReturnType<typeof statSync>;
    try { beforeStat = statSync(patchAbsPath); } catch { return { baked: false }; }

    const tempDir = mkdtempSync(join(dirname(patchAbsPath), '.seam-'));
    try {
      // ── Slice neighbors from the 48k reference (asset axis) ──────────────────
      const leftStart = Math.max(0, editStartSec - W);
      const leftEnd = editStartSec;
      const rightStart = editEndSec;
      const rightEnd = Math.min(refDuration, editEndSec + W);
      const hasLeft = leftStart < leftEnd - 1e-6;
      const hasRight = rightStart < rightEnd - 1e-6;
      if (!hasLeft && !hasRight) return { baked: false };

      const leftPath = join(tempDir, 'left.wav');
      const rightPath = join(tempDir, 'right.wav');
      try {
        if (hasLeft) sliceWav(referenceAbsPath, leftStart, leftEnd, leftPath);
        if (hasRight) sliceWav(referenceAbsPath, rightStart, rightEnd, rightPath);
      } catch {
        return { baked: false };
      }

      // ── 1. LEVEL match (two-pass measured loudnorm to the neighbor SPEECH) ────
      // Slice WIDER level-measurement windows (see LEVEL_MEASURE_WINDOW_SEC): the short
      // room-tone windows above can be below loudnorm's ~400 ms integrated-loudness gate,
      // which returns -inf and silently disables the match. Each side prefers its wide
      // level slice and falls back to the short room-tone slice if the wide one is absent.
      const lvlLeftStart = Math.max(0, editStartSec - LEVEL_MEASURE_WINDOW_SEC);
      const lvlRightEnd = Math.min(refDuration, editEndSec + LEVEL_MEASURE_WINDOW_SEC);
      let hasLvlLeft = lvlLeftStart < editStartSec - 1e-6;
      let hasLvlRight = editEndSec < lvlRightEnd - 1e-6;
      const lvlLeftPath = join(tempDir, 'lvlL.wav');
      const lvlRightPath = join(tempDir, 'lvlR.wav');
      // Slice each side INDEPENDENTLY: a wide slice can fail (ffmpeg decode error / truncation in
      // the extended 2.5 s span) even when the tight room-tone slice above succeeded. A failure
      // here must fall back to the SHORT window for THAT side — not skip the neighbor entirely —
      // so re-derive each flag from what actually landed on disk. (A single shared try/catch would
      // let a left-slice throw also suppress an otherwise-fine right slice.)
      if (hasLvlLeft) { try { sliceWav(referenceAbsPath, lvlLeftStart, editStartSec, lvlLeftPath); } catch { /* fall back below */ } }
      if (hasLvlRight) { try { sliceWav(referenceAbsPath, editEndSec, lvlRightEnd, lvlRightPath); } catch { /* fall back below */ } }
      hasLvlLeft = hasLvlLeft && existsSync(lvlLeftPath);
      hasLvlRight = hasLvlRight && existsSync(lvlRightPath);
      // Pick a USABLE neighbor for the level target — prefer left, fall back to right;
      // a silent left neighbor must not stop us from matching a voiced right neighbor.
      let neighborStats: LoudnormStats | null = null;
      let neighborUsable = false;
      for (const p of [
        hasLvlLeft ? lvlLeftPath : (hasLeft ? leftPath : null),
        hasLvlRight ? lvlRightPath : (hasRight ? rightPath : null)
      ]) {
        if (!p) continue;
        let s: LoudnormStats;
        try { s = measureLoudness(p); } catch { continue; }
        if (!neighborStats) neighborStats = s; // remember a reading for the report even if silent
        if (Number.isFinite(s.input_i) && s.input_i > NEIGHBOR_SILENCE_FLOOR_LUFS) {
          neighborStats = s;
          neighborUsable = true;
          break;
        }
      }
      if (!neighborStats) return { baked: false }; // neither neighbor could even be measured

      const leveledPath = join(tempDir, 'leveled.wav');
      if (neighborUsable) {
        let patchStats: LoudnormStats;
        try { patchStats = measureLoudness(patchAbsPath); } catch { return { baked: false }; }
        try {
          run('ffmpeg', [
            '-y', '-hide_banner', '-i', patchAbsPath,
            '-af', [
              `loudnorm=I=${neighborStats.input_i.toFixed(2)}`,
              'TP=-1.5', 'LRA=11',
              `measured_I=${patchStats.input_i.toFixed(2)}`,
              `measured_TP=${patchStats.input_tp.toFixed(2)}`,
              `measured_LRA=${patchStats.input_lra.toFixed(2)}`,
              `measured_thresh=${patchStats.input_thresh.toFixed(2)}`,
              `offset=${patchStats.target_offset.toFixed(2)}`,
              'linear=true', 'print_format=summary'
            ].join(':'),
            '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le', leveledPath
          ]);
        } catch {
          return { baked: false };
        }
      } else {
        // Near-silent neighbor: no usable target. Keep the patch level as-is (do NOT
        // invent a −16 target that would blast speech into a quiet seam) but still bed+feather.
        try {
          run('ffmpeg', ['-y', '-hide_banner', '-i', patchAbsPath, '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le', leveledPath]);
        } catch {
          return { baked: false };
        }
      }

      let leveledDuration: number;
      try { leveledDuration = probeDuration(leveledPath); } catch { return { baked: false }; }

      // ── 2. ROOM-TONE bed (side-aware adjacent silence; real-noise fallback) ──
      // Skipped entirely in 'level-feather' mode — the patch is expected to carry room
      // tone natively (e.g. Cartesia infill), so we avoid double-applying the room.
      let roomToneSource: 'adjacent' | 'synthetic' | 'none';
      let beddedPath: string;

      if (mode === 'level-feather') {
        // level-feather: skip bed — go leveled patch → qsin fades → done
        roomToneSource = 'none';
        beddedPath = leveledPath;
      } else {
        // full: build room-tone bed and mix under the leveled patch
        const bedLen = leveledDuration + 0.05; // amix duration=first clamps to the patch
        const bedMinLenSec = 0.20;
        const bedPath = join(tempDir, 'bed.wav');
        roomToneSource = 'synthetic';

        // Prefer silence adjacent to the seam: try the left window's tail, then the right window's head.
        let seed: { absStart: number; absEnd: number } | null = null;
        if (hasLeft) {
          let leftDur = 0;
          try { leftDur = probeDuration(leftPath); } catch { leftDur = leftEnd - leftStart; }
          const r = findAdjacentSilence(leftPath, bedMinLenSec, 'left', leftDur);
          if (r) seed = { absStart: leftStart + r.startSec, absEnd: leftStart + r.endSec };
        }
        if (!seed && hasRight) {
          let rightDur = 0;
          try { rightDur = probeDuration(rightPath); } catch { rightDur = rightEnd - rightStart; }
          const r = findAdjacentSilence(rightPath, bedMinLenSec, 'right', rightDur);
          if (r) seed = { absStart: rightStart + r.startSec, absEnd: rightStart + r.endSec };
        }

        if (seed) {
          const seedEnd = Math.min(refDuration, seed.absEnd);
          const seedStart = Math.min(seed.absStart, seedEnd - 0.01);
          if (seedStart >= 0 && seedStart < seedEnd) {
            const roomSeedPath = join(tempDir, 'roomseed.wav');
            try {
              sliceWav(referenceAbsPath, seedStart, seedEnd, roomSeedPath);
              run('ffmpeg', [
                '-y', '-hide_banner',
                '-stream_loop', '-1', '-i', roomSeedPath,
                '-t', roundSec6(bedLen),
                '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le', bedPath
              ]);
              roomToneSource = 'adjacent';
            } catch {
              roomToneSource = 'synthetic';
            }
          }
        }

        if (roomToneSource === 'synthetic') {
          // Deterministic low-level NOISE floor (~−50 dBFS brown noise, fixed seed) — a real
          // bed, NOT digital zero. Brown noise is low-frequency and reads as room ambience.
          try {
            run('ffmpeg', [
              '-y', '-hide_banner',
              '-f', 'lavfi', '-i', `anoisesrc=c=brown:r=48000:a=0.003:seed=0:d=${roundSec6(bedLen)}`,
              '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le', bedPath
            ]);
          } catch {
            return { baked: false };
          }
        }

        // Mix the bed UNDER the leveled patch (clamp to patch length, no auto-normalize).
        const mixedPath = join(tempDir, 'bedded.wav');
        try {
          run('ffmpeg', [
            '-y', '-hide_banner',
            '-i', leveledPath, '-i', bedPath,
            '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]',
            '-map', '[a]', '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le', mixedPath
          ]);
        } catch {
          return { baked: false };
        }
        beddedPath = mixedPath;
      }

      // ── 3. Equal-power qsin fade on the patch's OWN edges (no neighbor audio) ─
      const fade = Math.min(qsinD, leveledDuration / 2 - 1e-3);
      const finalPath = join(tempDir, 'final.wav');
      if (fade > 0.001) {
        try {
          run('ffmpeg', [
            '-y', '-hide_banner', '-i', beddedPath,
            '-af', `afade=t=in:st=0:d=${roundSec6(fade)}:curve=qsin,afade=t=out:st=${roundSec6(leveledDuration - fade)}:d=${roundSec6(fade)}:curve=qsin`,
            '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le', finalPath
          ]);
        } catch {
          return { baked: false };
        }
      } else {
        // Patch too short to feather BOTH edges. Do NOT claim a baked seam — seamBaked would
        // disable the pipeline's fade and leave an unfeathered edge (a click). Degrade to
        // un-baked; the 100ms degraded-payload floor makes this unreachable for valid assets.
        return { baked: false };
      }

      let durationAfter: number;
      try { durationAfter = probeDuration(finalPath); } catch { return { baked: false }; }
      if (durationAfter <= 0) return { baked: false };

      // Report (post-bake loudness vs the neighbor target).
      // `null` means the post-bake measurement failed or was unavailable — distinguishable
      // from a real 0 (perfect match). This closes the ambiguity where 0 meant BOTH
      // "perfect match" and "measurement failed".
      let postBakeStats: LoudnormStats | null = null;
      try { postBakeStats = measureLoudness(finalPath); } catch { /* report stays null */ }
      const levelStep: number | null = (neighborUsable && postBakeStats && Number.isFinite(postBakeStats.input_i))
        ? Math.abs(neighborStats.input_i - postBakeStats.input_i)
        : null;
      const report: SeamReport = {
        leftLevelStepDb: levelStep,
        rightLevelStepDb: levelStep,
        roomToneSource,
        durationBeforeSec: patchDurationBefore,
        durationAfterSec: durationAfter
      };

      // Concurrency re-check: if another writer touched the patch while we worked, bail
      // (do NOT clobber their version with our now-stale bake).
      let afterStat: ReturnType<typeof statSync>;
      try { afterStat = statSync(patchAbsPath); } catch { return { baked: false }; }
      // A concurrent writer that rename-replaced the file changes the inode; a same-size,
      // same-mtime overwrite still changes ctime. Check all four to avoid clobbering it.
      if (afterStat.size !== beforeStat.size || afterStat.mtimeMs !== beforeStat.mtimeMs
        || afterStat.ino !== beforeStat.ino || afterStat.ctimeMs !== beforeStat.ctimeMs) return { baked: false };

      renameSync(finalPath, patchAbsPath);
      return { baked: true, durationSec: durationAfter, report };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {
    return { baked: false };
  }
}
