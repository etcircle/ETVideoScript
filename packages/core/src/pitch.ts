// Pure, dependency-free TS YIN pitch tracker (no node:fs / no child_process).
//
// Ported to the exact spec the Slice-1 plan pins (Hermes P2): 16 kHz mono PCM,
// frame 25 ms / hop 10 ms (400 / 160 samples), F0 search 60–320 Hz, CMNDF
// threshold 0.15 with parabolic refinement, a frame is voiced iff the threshold
// is crossed, window register = voiced-median F0, and a voiced-coverage fraction
// (voiced frames / total frames).
//
// Why a TS port and not the python WeSpeaker battery: the plan's non-goals keep
// ONNX/WeSpeaker out of production — the ranker uses F0 + duration only, so a
// small deterministic YIN over Float32Array is all the register signal the
// multi-window selector and (later) the STS ranker need. Kept pure so the
// selector stays testable with synthetic PCM and safe to reason about.
//
// Reference: de Cheveigné & Kawahara, "YIN, a fundamental frequency estimator
// for speech and music" (2002) — steps: (1) difference function, (2) cumulative
// mean normalized difference (CMNDF), (3) absolute threshold, (4) parabolic
// interpolation. We omit step 6 (best local estimate) — it buys little at
// speech rates and the plan does not ask for it.

// ── Locked constants (the plan's YIN spec) ──────────────────────────────────────
export const YIN_SAMPLE_RATE = 16_000;
export const YIN_FRAME_SAMPLES = 400; // 25 ms @ 16 kHz
export const YIN_HOP_SAMPLES = 160; // 10 ms @ 16 kHz
export const YIN_F0_MIN_HZ = 60;
export const YIN_F0_MAX_HZ = 320;
export const YIN_THRESHOLD = 0.15;

export interface FramePitch {
  /** Estimated F0 in Hz, or null when the frame is unvoiced (threshold never crossed). */
  f0Hz: number | null;
  /** True iff the CMNDF threshold was crossed within the F0 search band. */
  voiced: boolean;
}

export interface PitchTrack {
  frames: FramePitch[];
  /** voiced frames / total frames, in [0, 1]. 0 when there are no frames. */
  voicedCoverage: number;
  /** Median F0 over the VOICED frames only, or null when no frame is voiced. */
  voicedMedianF0Hz: number | null;
}

// tau bounds from the F0 search band. Higher F0 ⇒ smaller period ⇒ smaller tau.
// Clamped to [1, frameSamples-1] so the difference/CMNDF loops never index past
// the frame even for pathological sample rates.
function tauBounds(sampleRate: number, frameSamples: number): { tauMin: number; tauMax: number } {
  const tauMin = Math.max(1, Math.floor(sampleRate / YIN_F0_MAX_HZ));
  const tauMax = Math.min(frameSamples - 1, Math.ceil(sampleRate / YIN_F0_MIN_HZ));
  return { tauMin, tauMax };
}

// Step 1+2: difference function d(tau) then cumulative mean normalized difference
// d'(tau). d'(0) := 1 by definition; d'(tau) = d(tau) / ((1/tau) * Σ_{j<=tau} d(j)).
// Only tau in [1, tauMax] is needed downstream, so we compute the running sum up to tauMax.
function cmndf(frame: Float32Array, tauMax: number): Float64Array {
  const cmnd = new Float64Array(tauMax + 1);
  cmnd[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let d = 0;
    // Σ (x[j] - x[j+tau])^2 over the part of the frame that stays in-bounds.
    const limit = frame.length - tau;
    for (let j = 0; j < limit; j++) {
      const delta = frame[j]! - frame[j + tau]!;
      d += delta * delta;
    }
    runningSum += d;
    // runningSum is 0 only for a pure-DC/all-zero frame; guard the divide so a
    // silent frame yields cmnd=1 (never voiced) rather than NaN.
    cmnd[tau] = runningSum > 0 ? (d * tau) / runningSum : 1;
  }
  return cmnd;
}

// Step 3: absolute threshold. Pick the SMALLEST tau (>= tauMin) at which d'(tau)
// dips below the threshold AND is a local minimum (walk down the dip); this avoids
// latching onto the descending shoulder of the first dip. Returns -1 when the
// threshold is never crossed in-band (⇒ unvoiced).
function absoluteThreshold(cmnd: Float64Array, tauMin: number, tauMax: number, threshold: number): number {
  let tau = tauMin;
  while (tau <= tauMax) {
    if (cmnd[tau]! < threshold) {
      // Walk down to the local minimum of this dip.
      while (tau + 1 <= tauMax && cmnd[tau + 1]! < cmnd[tau]!) tau++;
      return tau;
    }
    tau++;
  }
  return -1;
}

// Step 4: parabolic interpolation around the chosen tau against its two neighbors,
// refining the period to sub-sample precision. Falls back to the integer tau at the
// array edges where a neighbor is unavailable.
function parabolicRefine(cmnd: Float64Array, tau: number, tauMax: number): number {
  if (tau <= 0 || tau >= tauMax) return tau;
  const s0 = cmnd[tau - 1]!;
  const s1 = cmnd[tau]!;
  const s2 = cmnd[tau + 1]!;
  const denom = 2 * (2 * s1 - s2 - s0);
  if (denom === 0) return tau;
  return tau + (s2 - s0) / denom;
}

/**
 * Estimate F0 for a SINGLE frame of mono PCM (Float32, [-1, 1] nominal).
 * `frame.length` should be YIN_FRAME_SAMPLES for the spec cadence, but any
 * length ≥ tauMax+1 works. Returns { f0Hz, voiced }.
 */
export function estimateFrameF0(frame: Float32Array, sampleRate = YIN_SAMPLE_RATE): FramePitch {
  const { tauMin, tauMax } = tauBounds(sampleRate, frame.length);
  if (tauMax < tauMin) return { f0Hz: null, voiced: false };
  const cmnd = cmndf(frame, tauMax);
  const tau = absoluteThreshold(cmnd, tauMin, tauMax, YIN_THRESHOLD);
  if (tau < 0) return { f0Hz: null, voiced: false };
  const refined = parabolicRefine(cmnd, tau, tauMax);
  const f0 = sampleRate / refined;
  // A refined tau can drift just outside the band; keep the frame voiced (the
  // threshold WAS crossed — the plan's voicing rule) but clamp the reported F0
  // into the search band so downstream register math stays well-defined.
  const clamped = Math.min(YIN_F0_MAX_HZ, Math.max(YIN_F0_MIN_HZ, f0));
  return { f0Hz: clamped, voiced: true };
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Track pitch across a mono PCM buffer at frame 25 ms / hop 10 ms and reduce to a
 * register (voiced-median F0) + voiced-coverage fraction.
 *
 * Deterministic and allocation-bounded: one pass of ⌊(N - frame)/hop⌋+1 frames.
 * `pcm` is Float32 in nominal [-1, 1]; callers converting from Int16 should divide
 * by 32768 (see `int16ToFloat32`). A buffer shorter than one frame yields an empty
 * track (coverage 0, register null) rather than throwing — the selector treats that
 * as an unusable window, which is the honest outcome.
 */
export function trackPitch(pcm: Float32Array, sampleRate = YIN_SAMPLE_RATE): PitchTrack {
  const frames: FramePitch[] = [];
  const voicedF0: number[] = [];
  if (pcm.length >= YIN_FRAME_SAMPLES) {
    for (let start = 0; start + YIN_FRAME_SAMPLES <= pcm.length; start += YIN_HOP_SAMPLES) {
      const frame = pcm.subarray(start, start + YIN_FRAME_SAMPLES);
      const fp = estimateFrameF0(frame, sampleRate);
      frames.push(fp);
      if (fp.voiced && fp.f0Hz !== null) voicedF0.push(fp.f0Hz);
    }
  }
  const voicedCoverage = frames.length === 0 ? 0 : voicedF0.length / frames.length;
  const voicedMedianF0Hz = voicedF0.length === 0 ? null : median([...voicedF0].sort((a, b) => a - b));
  return { frames, voicedCoverage, voicedMedianF0Hz };
}

/** Convert Int16 PCM to Float32 in [-1, 1] (divide by 32768). */
export function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
  return out;
}
