import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertInside, stageVerifiedWorkspaceFile } from './filesystem';
import { extractFullBandReference } from './media';
import { loadTranscript } from './transcript';
import { cloneCartesiaVoice, cloneElevenLabsVoice, type VoiceCloneSample } from './providers';
import {
  readVoicesLibrary,
  upsertVoice,
  type VoiceRecord,
  type VoiceProvider,
  type SettingsPathsInput
} from './providerSettings';
import type { TranscriptWords } from './schemas';
import type { ManifestV3 } from './manifest/schema';
import { isStudioCleanupFresh } from './channelFixScope';
import { sliceAudioWindow, trimPausesAndSilence, loudnormClip } from './audioClip';
import { trackPitch, YIN_FRAME_SAMPLES, YIN_SAMPLE_RATE } from './pitch';

// Locale-independent string compare. The selector MUST be deterministic across
// machines/locales (it is an explicit gate criterion), and String.localeCompare
// without an explicit locale uses the host's ICU default collation — which can
// order the same fixture differently on a non-EN host. Code-unit order is stable.
// Exported so transcriptSpan.ts can share the same implementation without drift.
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// True if a candidate window (on its clip) overlaps an exclusion range on the same clip.
// Used to reject any selected window that straddles the edit being replaced — the
// word-level filter alone misses the case where the edit sits in a short inter-word gap.
function windowOverlaps(
  c: { clipId: string; start: number; end: number },
  ex: { clipId: string; start: number; end: number }
): boolean {
  return c.clipId === ex.clipId && c.start < ex.end && c.end > ex.start;
}

// ── Clone-provider dispatch ──────────────────────────────────────────────────────
// Mirrors the CLONE_PROVIDERS table in apps/local-api settingsRoutes.ts so cloneCleanClip
// dispatches by the SAME provider identity the /voices/clone route uses (no divergent
// second dispatch). Both adapters return { voiceId } and accept this exact call shape;
// Cartesia's extra optionals (language/baseUrl/timeoutMs) default inside its adapter, and
// baseUrl is threaded through where the caller supplies one. Typed (no `any`) so a
// signature drift in either adapter is caught at compile time.
//
// maxSamples encodes the provider's clip capability. WIRING ONLY: cloneCleanClip prepares a
// SINGLE window today and submits it as one sample regardless of provider — the multi-window
// scorer that would fill EL's 25-sample budget is future work and deliberately NOT built here.
// EL simply accepts the one prepared window as one sample (well under its 25 cap).
type CloneFn = (input: {
  name: string;
  samples: VoiceCloneSample[];
  secret: string;
  baseUrl?: string;
  signal: AbortSignal;
}) => Promise<{ voiceId: string }>;
const CLONE_PROVIDERS: Record<VoiceProvider, { clone: CloneFn; maxSamples: number }> = {
  elevenlabs: { clone: cloneElevenLabsVoice, maxSamples: 25 },
  cartesia: { clone: cloneCartesiaVoice, maxSamples: 1 }
};
// There is deliberately NO default clone provider in core. `provider` is REQUIRED on
// CloneCleanClipParams: cloneCleanClip was Cartesia-hardwired for its whole life, so a silent
// core-side default (to anything) would make an existing caller skip its legacy Cartesia
// cache records and burn a remote voice slot on the wrong provider without any code change on
// its side. Defaulting is ROUTE policy — the /voices/clone route owns it (settingsRoutes.ts:
// `fields.provider ?? 'elevenlabs'`); every caller of cloneCleanClip must resolve the
// provider the same way and pass it explicitly.

// ── Constants (locked defaults) ────────────────────────────────────────────────
const TARGET_SEC = 10;
const MIN_SEC = 6;
// Exported so transcriptSpan.ts can import and alias as BREATH_GAP_SEC without
// diverging from the constant used here. Never redeclare 0.35 elsewhere.
export const MAX_INTERNAL_GAP = 0.35;
// ── Pause policy: two thresholds, two jobs — this is intentional, not drift ────
// MAX_INTERNAL_GAP (0.35s) governs SELECTION: splitRuns breaks candidate windows at any
// inter-word gap > 0.35s, so an AUTO-SELECTED window can never contain a 0.5–1.5s pause.
// That is deliberate (consistency-over-diversity): continuous-speech windows clone the most
// stable identity, and the tight gap cap is also what keeps enumerateWindows' O(runLen²)
// window budget bounded — do NOT loosen it to "let breaths into" auto-selected windows.
// CLONE_PREP_MAX_PAUSE_SEC (1.5s) governs PREP: trimPausesAndSilence at the clone-prep call
// site retains internal pauses up to 1.5s instead of the primitive's 0.5s default, because
// aggressive pause DELETION teaches the clone a rushed cadence (June evidence — same artifact
// family as infill's cold re-attacks). For auto-selected windows this retention is inert (see
// above: such windows contain no gap > 0.35s). It protects the EXPLICIT referenceRange /
// manual path (which the Phase-1 experiment cells drive) and any future multi-window
// assembly, where windows CAN legitimately contain natural breath pauses.
export const CLONE_PREP_MAX_PAUSE_SEC = 1.5;
const SLACK_SEC = 1.5;
const CACHE_EPSILON = 0.05; // seconds tolerance for range cache matching

// ── Public types ───────────────────────────────────────────────────────────────

export interface CleanClipSelection {
  clipId: string;
  start: number;
  end: number;
  scope: 'local' | 'project';
  reason?: string;
  spanSec: number;
  meanConfidence: number;
  maxInternalGap: number;
}

export interface SelectCleanClipParams {
  words: TranscriptWords;
  scope: 'local' | 'project';
  target?: { clipId: string; start: number; end: number };
  // Internal: a range that no SELECTED window may overlap, even if no word overlaps it
  // (e.g. the edit falls in a short inter-word gap, so the run isn't split and a window
  // could straddle it). Threaded into the project fallback so it keeps excluding the
  // replaced span. Local scope always excludes its own `target`.
  excludeRange?: { clipId: string; start: number; end: number };
  // tuning — locked defaults exposed for tests
  targetSec?: number;
  minSec?: number;
  maxInternalGapSec?: number;
  slackSec?: number;
}

export interface CloneCleanClipParams {
  scope: 'local' | 'project';
  referenceRange?: { clipId: string; start: number; end: number };
  target?: { clipId: string; start: number; end: number };
  name?: string;
  // Clone provider. REQUIRED — core deliberately has no default (see the note above
  // CLONE_PROVIDERS): the caller (route/CLI) owns default resolution, exactly as the
  // /voices/clone route does (`fields.provider ?? 'elevenlabs'`). The `secret`/`baseUrl`
  // supplied must belong to THIS provider — cloneCleanClip does not read secrets; the
  // caller resolves them per provider (same as the route).
  provider: VoiceProvider;
  // Stable NON-SECRET identifier for the credential/account behind `secret` (e.g. the
  // secrets-store key name, optionally suffixed with the endpoint host). NEVER the secret
  // value. Used to scope cache reuse: the same provider under a different account must not
  // cache-hit (the remote voiceId would not exist there). Optional — when omitted, core
  // falls back to the baseUrl host (a non-default endpoint implies a distinct tenant), and
  // with neither the record is account-unscoped (matches like a legacy record).
  accountRef?: string;
  /**
   * Provider credential. REQUIRED unless `cloneExecutor` is supplied — an injected executor
   * (the S1b prepare-voice job's runProvider bridge) resolves the secret itself from the
   * provider record's secretRef, and must never be handed the raw value.
   */
  secret?: string;
  baseUrl?: string;
  signal: AbortSignal;
  /**
   * Injected paid-call executor (S1b ⟨Q5⟩/⟨R4⟩). When present it REPLACES the built-in
   * provider dispatch for the remote clone, so the call can run inside `runProvider`
   * (spend caps, cap reservation, ledger events, structured errors) without cloneCleanClip
   * growing a second, parallel paid path. Everything else — cleaned-source contract, cache
   * identity, per-window prep, record persistence — is unchanged and still enforced here.
   */
  cloneExecutor?: (input: { name: string; samples: VoiceCloneSample[] }) => Promise<{ voiceId: string }>;
  // ── Multi-window mode (S1a) ──
  // When present AND the provider's maxSamples > 1, cloneCleanClip preps EACH window
  // separately (slice → pause retain-cap 1.5s → clone-band loudnorm −20/−3) and uploads them
  // as SEPARATE samples in one clone call. The caller (S1b route) resolves these windows via
  // selectCleanWindows; CORE enforces the cleaned-source contract itself (Hermes S1a review
  // P1): freshness, cacheKey identity, artifact existence, and single-base-clip scoping are
  // all verified here BEFORE any cache read or remote call — the primitive is safe standalone,
  // not "safe if the route behaves". Ignored for a maxSamples===1 provider (Cartesia keeps
  // byte-identical single-window behavior). `referenceRange` and `multiWindow` are mutually
  // exclusive when multi-window mode engages.
  multiWindow?: {
    // Asset-axis windows, canonical ascending-start order (as selectCleanWindows returns them).
    // ALL windows must share one clipId — window timestamps are never reinterpreted against
    // another clip's audio.
    windows: { clipId: string; start: number; end: number }[];
    // 'raw' → prep from the 48k reference; 'cleaned' → prep from the manifest's FRESH cleaned bed.
    sourceClass: 'raw' | 'cleaned';
    // studioCleanup.cacheKey — REQUIRED for 'cleaned' (cache identity pin), forbidden for 'raw'.
    // Core cross-checks it against manifest.studioCleanup.cacheKey; a mismatch is a hard error,
    // not a silent cache-key drift.
    cleanupIdentity?: string;
    // REQUIRED for 'cleaned': the manifest state core verifies the cleaned source against —
    // studioCleanup (status/cacheKey/assetPath), audioChannelFix (freshness fingerprint via
    // isStudioCleanupFresh), and tracks+assets (the windows' clip must belong to the base
    // recording the cleanup describes: asset path input/source.mp4). Pass the project's live
    // ManifestV3 (it is structurally assignable). Ignored for 'raw'.
    manifest?: Pick<ManifestV3, 'studioCleanup' | 'audioChannelFix' | 'tracks' | 'assets'>;
  };
}

export interface CloneCleanClipResult {
  voice: VoiceRecord;
  selection: CleanClipSelection;
  cached: boolean;
  referencePath: string;
  /** How many samples were uploaded (1 for single-window / Cartesia; N for a multi-window EL clone). */
  sampleCount: number;
}

// ── Internal candidate type ────────────────────────────────────────────────────

interface Candidate {
  clipId: string;
  start: number;
  end: number;
  spanSec: number;
  meanConfidence: number;
  maxInternalGap: number;
  distance: number;
  _firstStart: number;
  _firstId: string;
}

// ── Pure selection algorithm ───────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function splitRuns(words: TranscriptWords['words'], maxGap: number): TranscriptWords['words'][] {
  if (words.length === 0) return [];
  const runs: TranscriptWords['words'][] = [];
  let current: TranscriptWords['words'] = [words[0]!];
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1]!;
    const curr = words[i]!;
    if (curr.start - prev.end > maxGap) {
      runs.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  runs.push(current);
  return runs;
}

function enumerateWindows(
  ws: TranscriptWords['words'],
  clipId: string,
  anchorSec: number | null,
  consts: { targetSec: number; minSec: number; maxInternalGapSec: number; slackSec: number }
): Candidate[] {
  const runs = splitRuns(ws, consts.maxInternalGapSec);
  const out: Candidate[] = [];
  const cap = consts.targetSec + consts.slackSec;
  for (const run of runs) {
    // Enumerate EVERY valid window [i..j] (span within [minSec, cap]), not just the
    // single widest one ending at each j — otherwise a tighter high-confidence window
    // can lose to a wider lower-confidence one that merely starts earlier. For a fixed
    // j, run[i].start rises with i so the span shrinks monotonically: skip while it is
    // over cap (a later start may fit), emit while it is in range, and break once it
    // drops below minSec (all larger i are shorter still). Because i never exceeds j
    // there is no past-the-end deref even on a single overlong artifact word (its sole
    // window is over cap → skipped). O(runLen^2) per run; runs are short speech bursts.
    for (let j = 0; j < run.length; j++) {
      for (let i = 0; i <= j; i++) {
        const spanSec = run[j]!.end - run[i]!.start;
        if (spanSec > cap) continue;
        if (spanSec < consts.minSec) break;
        const slice = run.slice(i, j + 1);
        let maxGapInWindow = 0;
        for (let k = 1; k < slice.length; k++) {
          const gap = slice[k]!.start - slice[k - 1]!.end;
          if (gap > maxGapInWindow) maxGapInWindow = gap;
        }
        const midpoint = (run[i]!.start + run[j]!.end) / 2;
        const distance = anchorSec === null ? 0 : Math.abs(midpoint - anchorSec);
        out.push({
          clipId,
          start: run[i]!.start,
          end: run[j]!.end,
          spanSec,
          meanConfidence: mean(slice.map((w) => w.confidence)),
          maxInternalGap: maxGapInWindow,
          distance,
          _firstStart: run[i]!.start,
          _firstId: run[i]!.id
        });
      }
    }
  }
  return out;
}

function scoreAndPick(candidates: Candidate[], hasDistance: boolean, targetSec: number): Candidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    // 1. distance ASC (only meaningful for local scope)
    if (hasDistance) {
      const d = a.distance - b.distance;
      if (d !== 0) return d;
    }
    // 2. meanConfidence DESC
    const c = b.meanConfidence - a.meanConfidence;
    if (c !== 0) return c;
    // 3. |spanSec - targetSec| ASC — center on the (overridable) target, not the constant
    const s = Math.abs(a.spanSec - targetSec) - Math.abs(b.spanSec - targetSec);
    if (s !== 0) return s;
    // 4. maxInternalGap ASC
    const g = a.maxInternalGap - b.maxInternalGap;
    if (g !== 0) return g;
    // 5. stable tie-break: _firstStart ASC
    const fs = a._firstStart - b._firstStart;
    if (fs !== 0) return fs;
    // 6. _firstId ASC (locale-independent code-unit order — deterministic)
    return cmpStr(a._firstId, b._firstId);
  })[0] ?? null;
}

// PURE, deterministic, no fs/ffmpeg/Date/RNG
export function selectCleanClip(params: SelectCleanClipParams): CleanClipSelection {
  const {
    words,
    scope,
    target,
    excludeRange,
    targetSec = TARGET_SEC,
    minSec = MIN_SEC,
    maxInternalGapSec = MAX_INTERNAL_GAP,
    slackSec = SLACK_SEC
  } = params;
  const consts = { targetSec, minSec, maxInternalGapSec, slackSec };

  if (words.provider.timing !== 'exact') {
    throw new Error(
      'transcript-timing-not-exact: selectCleanClip requires exact word timing; mock and approximate modes produce synthetic gaps that make window selection unsafe.'
    );
  }

  if (scope === 'local') {
    if (!target) throw new Error('selectCleanClip: target is required when scope is "local"');
    const anchorSec = (target.start + target.end) / 2;
    // Filter to the target clip, excluding the edit region itself
    const localWords = words.words
      .filter((w) => w.clipId === target.clipId)
      .filter((w) => !(w.start < target.end && w.end > target.start))
      .sort((a, b) => {
        const d = a.start - b.start;
        return d !== 0 ? d : cmpStr(a.id, b.id);
      });
    // Reject any window that STRADDLES the edit (the word-level filter above misses the
    // case where target falls in a short inter-word gap, leaving both neighbors in one run).
    const candidates = enumerateWindows(localWords, target.clipId, anchorSec, consts)
      .filter((c) => !windowOverlaps(c, target));
    const best = scoreAndPick(candidates, true, targetSec);
    if (best && best.spanSec >= minSec) {
      return {
        clipId: target.clipId,
        start: best.start,
        end: best.end,
        scope: 'local',
        reason: 'local-scope',
        spanSec: best.spanSec,
        meanConfidence: best.meanConfidence,
        maxInternalGap: best.maxInternalGap
      };
    }
    // Local fallback: recurse to project scope. Report the longest clean contiguous
    // local run (NOT best.spanSec — that is 0 whenever no window cleared minSec, which
    // would misreport "0.0s" even when several seconds of clean local speech existed).
    const localRuns = splitRuns(localWords, maxInternalGapSec);
    const longestLocalRun = localRuns.reduce((m, r) => {
      const span = r.length ? r[r.length - 1]!.end - r[0]!.start : 0;
      return span > m ? span : m;
    }, 0);
    // Carry the edit-region exclusion into the fallback: project selection over the FULL
    // transcript could otherwise pick the very words being replaced (a long, high-confidence
    // replacement span) as the clone reference — cloning from the audio we're overwriting.
    // Drop the target-overlapping words on the target clip before falling back.
    const fallbackWords: TranscriptWords = {
      ...words,
      words: words.words.filter((w) => !(w.clipId === target.clipId && w.start < target.end && w.end > target.start))
    };
    const projResult = selectCleanClip({ words: fallbackWords, scope: 'project', excludeRange: target, targetSec, minSec, maxInternalGapSec, slackSec });
    projResult.reason = `project-fallback: insufficient clean contiguous local speech (longest clean local run ${longestLocalRun.toFixed(1)}s < ${minSec}s near edit on clip ${target.clipId})`;
    return projResult;
  }

  // PROJECT scope — group by clipId, iterate in ascending string order (deterministic)
  const byClip = new Map<string, TranscriptWords['words']>();
  for (const w of words.words) {
    const existing = byClip.get(w.clipId) ?? [];
    existing.push(w);
    byClip.set(w.clipId, existing);
  }
  const sortedClipIds = [...byClip.keys()].sort(cmpStr);
  const allCandidates: Candidate[] = [];
  let longestProjectRun = 0;
  for (const clipId of sortedClipIds) {
    const ws = (byClip.get(clipId) ?? []).sort((a, b) => {
      const d = a.start - b.start;
      return d !== 0 ? d : cmpStr(a.id, b.id);
    });
    for (const r of splitRuns(ws, maxInternalGapSec)) {
      const span = r.length ? r[r.length - 1]!.end - r[0]!.start : 0;
      if (span > longestProjectRun) longestProjectRun = span;
    }
    allCandidates.push(...enumerateWindows(ws, clipId, null, consts));
  }
  // In a fallback from local scope, drop any window straddling the replaced span too.
  const eligible = excludeRange ? allCandidates.filter((c) => !windowOverlaps(c, excludeRange)) : allCandidates;
  const best = scoreAndPick(eligible, false, targetSec);
  if (!best || best.spanSec < minSec) {
    // Report the longest clean contiguous RUN (not best.spanSec, which is 0 whenever no
    // window cleared minSec — enumerateWindows only emits in-range windows) so the error is honest.
    throw new Error(
      `no-clean-reference: longest clean contiguous run ${longestProjectRun.toFixed(1)}s < ${minSec}s across project`
    );
  }
  return {
    clipId: best.clipId,
    start: best.start,
    end: best.end,
    scope: 'project',
    spanSec: best.spanSec,
    meanConfidence: best.meanConfidence,
    maxInternalGap: best.maxInternalGap
  };
}

// ── Multi-window selection (S1a) ─────────────────────────────────────────────────
// selectCleanWindows fills a maxSamples>1 provider's sample budget with several ~10s
// clean windows from ONE eligible clip, register-consistent with the whole-recording
// target. It is PURE (no fs/ffmpeg): the caller supplies the eligible clip's 16k mono
// PCM on the asset axis, and register/voicing come from the TS YIN port (pitch.ts).
// selectCleanClip stays the single-window primitive; this is its multi-sample sibling.

const WINDOW_SEC = 10; // ~10s target window (the plan's cadence)
const MIN_USABLE_AGG_SEC = 30; // must reach ≥30s of usable material or fail honestly
const MAX_TOTAL_SEC = 90; // cap total uploaded material at ≈90s
const MIN_VOICED_COVERAGE = 0.4; // usability floor: ≥40% voiced frames
const MIN_MEAN_CONFIDENCE = 0.6; // cleanliness pass floor (mean word confidence)
const REGISTER_BAND_FRAC = 0.03; // ±3% register band; out-of-band DEMOTES (not excludes)

// Typed error so the caller can distinguish "not enough usable clean audio for the
// multi-window path" from a programming error and fall back to the legacy single-window
// path (recording that fallback in the cache record). Named per the plan's "error naming
// the shortfall" requirement.
export class InsufficientCleanWindowsError extends Error {
  readonly code = 'insufficient-clean-windows';
  readonly usableSec: number;
  readonly requiredSec: number;
  constructor(usableSec: number, requiredSec: number, detail: string) {
    super(`insufficient-clean-windows: only ${usableSec.toFixed(1)}s of usable clean material (need >= ${requiredSec.toFixed(1)}s) — ${detail}`);
    this.name = 'InsufficientCleanWindowsError';
    this.usableSec = usableSec;
    this.requiredSec = requiredSec;
  }
}

// studioCleanup.cacheKey is produced exclusively as a sha256 hex digest of the source audio
// (studioCleanupRoutes.computeSourceHash). Anything else is hand-edited/corrupt and must never
// reach path construction.
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// Typed error for every violation of the cleaned-source contract in cloneCleanClip's
// multi-window mode (stale/absent/misdescribed cleanup, cacheKey mismatch, wrong clip).
// Distinct from InsufficientCleanWindowsError: that one means "the audio doesn't have enough
// clean material" (caller may fall back to single-window); this one means "the cleaned bed you
// asked to clone from is not trustworthy right now" (caller must re-run cleanup, fall back to
// raw EXPLICITLY, or surface the state to the user — never silently proceed).
export class CleanedSourceUnavailableError extends Error {
  readonly code = 'cleaned-source-unavailable';
  constructor(detail: string) {
    super(`cleaned-source-unavailable: ${detail}`);
    this.name = 'CleanedSourceUnavailableError';
  }
}

export interface CleanWindow {
  clipId: string;
  start: number;
  end: number;
  spanSec: number;
  meanConfidence: number;
  maxInternalGap: number;
  /** voiced-frame fraction over this window's PCM (YIN). */
  voicedCoverage: number;
  /** voiced-median F0 (register) over this window, or null when no frame is voiced. */
  registerHz: number | null;
  /** |registerHz - target| / target, or null when either register is unavailable. */
  registerDeltaFrac: number | null;
  /** true iff within the ±REGISTER_BAND_FRAC band of the target register. */
  inBand: boolean;
  /** true iff ≥MIN_VOICED_COVERAGE voiced AND cleanliness pass — only usable windows upload. */
  usable: boolean;
}

export interface SelectCleanWindowsParams {
  words: TranscriptWords;
  /** The single ELIGIBLE clip (cleaned-source scoping restricts this to the base clip). */
  clipId: string;
  /** 16k mono PCM (Float32 [-1,1]) of the eligible clip on the ASSET axis (t=0 at sample 0). */
  pcm16k: Float32Array;
  sampleRate?: number;
  /**
   * Whole-recording target register (voiced-median F0 over transcript-covered speech frames
   * of the SAME source class). When omitted, computed here from `pcm16k` over the union of
   * transcript-covered spans (never silence/music). Pass null to skip register scoring
   * entirely (every window treated in-band) — used only when the recording has no voiced
   * material to anchor on.
   */
  targetRegisterHz?: number | null;
  // tuning — locked defaults exposed for tests
  windowSec?: number;
  minUsableAggregateSec?: number;
  maxTotalSec?: number;
  minVoicedCoverage?: number;
  minMeanConfidence?: number;
  registerBandFrac?: number;
  maxInternalGapSec?: number;
}

export interface SelectCleanWindowsResult {
  /** Usable windows in canonical ascending-start order, capped at ≈maxTotalSec aggregate. */
  windows: CleanWindow[];
  /** Sum of the returned windows' spans. */
  totalSec: number;
  /** The target register used for scoring (echoed for provenance/tests). */
  targetRegisterHz: number | null;
}

// Slice the eligible clip's 16k PCM for [startSec, endSec) on the asset axis. Bounds are
// clamped into the buffer so a window ending past the decoded PCM tail still yields the
// frames it has (the transcript can legitimately outrun the exact sample count by a hair).
function pcmWindow(pcm: Float32Array, sampleRate: number, startSec: number, endSec: number): Float32Array {
  const from = Math.max(0, Math.floor(startSec * sampleRate));
  const to = Math.min(pcm.length, Math.ceil(endSec * sampleRate));
  return from < to ? pcm.subarray(from, to) : new Float32Array(0);
}

// Whole-recording target register: voiced-median F0 over the union of transcript-covered
// WORD spans (speech frames of this source class), NOT the whole buffer and NOT run spans —
// a run span (first-word→last-word) would include the ≤maxInternalGap inter-word gaps, and
// voiced non-speech in those gaps (music bed, hum, a second speaker's bleed) would pollute
// the median. Per-word slicing keeps only frames the transcript actually attributes to
// speech. Overlapping/adjacent word spans are merged first so no sample is double-counted
// (double-counting would bias the median toward whatever repeats). We concatenate the merged
// spans' PCM and run one YIN pass over the result; frame boundaries at the concat seams add
// a little noise per seam (a frame can straddle two words), which is acceptable for a MEDIAN
// over thousands of frames — it cannot drag the register the way in-gap voiced content can.
function computeTargetRegister(
  words: TranscriptWords['words'],
  clipId: string,
  pcm: Float32Array,
  sampleRate: number
): number | null {
  const clipWords = words.filter((w) => w.clipId === clipId).sort((a, b) => a.start - b.start || cmpStr(a.id, b.id));
  // Merge overlapping/adjacent word spans (STT words can overlap slightly at boundaries).
  const merged: { start: number; end: number }[] = [];
  for (const w of clipWords) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      if (w.end > last.end) last.end = w.end;
    } else {
      merged.push({ start: w.start, end: w.end });
    }
  }
  const chunks: Float32Array[] = [];
  for (const span of merged) {
    chunks.push(pcmWindow(pcm, sampleRate, span.start, span.end));
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  if (total < YIN_FRAME_SAMPLES) return null;
  const covered = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { covered.set(c, off); off += c.length; }
  return trackPitch(covered, sampleRate).voicedMedianF0Hz;
}

/**
 * Enumerate ~windowSec windows over the eligible clip, score each by cleanliness +
 * register-closeness, and return the usable set (≥minVoicedCoverage voiced AND a cleanliness
 * pass) in canonical ascending-start order, capped at ≈maxTotalSec. Throws
 * InsufficientCleanWindowsError when the usable aggregate falls short of minUsableAggregateSec.
 *
 * PURE and deterministic (YIN + transcript only; no fs/ffmpeg/Date/RNG). Windows are cut at
 * run boundaries (gaps > maxInternalGapSec) so an auto-selected window never straddles a long
 * pause — the same consistency-over-diversity policy selectCleanClip uses; natural breaths up
 * to CLONE_PREP_MAX_PAUSE_SEC are retained at PREP time, not selection.
 */
export function selectCleanWindows(params: SelectCleanWindowsParams): SelectCleanWindowsResult {
  const {
    words,
    clipId,
    pcm16k,
    sampleRate = YIN_SAMPLE_RATE,
    windowSec = WINDOW_SEC,
    minUsableAggregateSec = MIN_USABLE_AGG_SEC,
    maxTotalSec = MAX_TOTAL_SEC,
    minVoicedCoverage = MIN_VOICED_COVERAGE,
    minMeanConfidence = MIN_MEAN_CONFIDENCE,
    registerBandFrac = REGISTER_BAND_FRAC,
    maxInternalGapSec = MAX_INTERNAL_GAP
  } = params;

  if (words.provider.timing !== 'exact') {
    throw new Error(
      'transcript-timing-not-exact: selectCleanWindows requires exact word timing; mock and approximate modes produce synthetic gaps that make window selection unsafe.'
    );
  }
  // Tuning sanity: a cap below the aggregate floor is unsatisfiable by construction — the
  // chosen set could never reach minUsableAggregateSec. Fail loudly as a caller bug instead
  // of always throwing InsufficientCleanWindowsError (which reads as "your audio is bad").
  if (maxTotalSec < minUsableAggregateSec) {
    throw new Error(`selectCleanWindows: maxTotalSec (${maxTotalSec}) must be >= minUsableAggregateSec (${minUsableAggregateSec}) — the cap would make the aggregate floor unreachable.`);
  }

  const targetRegisterHz = params.targetRegisterHz !== undefined
    ? params.targetRegisterHz
    : computeTargetRegister(words.words, clipId, pcm16k, sampleRate);

  const clipWords = words.words
    .filter((w) => w.clipId === clipId)
    .sort((a, b) => a.start - b.start || cmpStr(a.id, b.id));
  const runs = splitRuns(clipWords, maxInternalGapSec);

  // Tile each run into consecutive non-overlapping ~windowSec windows. Greedy from the run
  // start: accumulate words until the span would exceed windowSec, close the window, start
  // the next at the following word. Windows never straddle a run boundary (no long pause
  // inside). A trailing sub-windowSec remainder still becomes a window — the usability floor,
  // not a hard length cut, decides whether it is uploaded.
  const raw: CleanWindow[] = [];
  for (const run of runs) {
    let i = 0;
    while (i < run.length) {
      let j = i;
      while (j + 1 < run.length && run[j + 1]!.end - run[i]!.start <= windowSec) j++;
      const slice = run.slice(i, j + 1);
      const start = slice[0]!.start;
      const end = slice[slice.length - 1]!.end;
      let maxGap = 0;
      for (let k = 1; k < slice.length; k++) {
        const gap = slice[k]!.start - slice[k - 1]!.end;
        if (gap > maxGap) maxGap = gap;
      }
      const track = trackPitch(pcmWindow(pcm16k, sampleRate, start, end), sampleRate);
      const registerHz = track.voicedMedianF0Hz;
      const registerDeltaFrac = targetRegisterHz && registerHz !== null
        ? Math.abs(registerHz - targetRegisterHz) / targetRegisterHz
        : null;
      // In-band when there's no target to compare against (null delta ⇒ treat as in-band so
      // register scoring is inert), or when within ±registerBandFrac.
      const inBand = registerDeltaFrac === null || registerDeltaFrac <= registerBandFrac;
      const meanConfidence = mean(slice.map((w) => w.confidence));
      const usable = track.voicedCoverage >= minVoicedCoverage && meanConfidence >= minMeanConfidence;
      raw.push({
        clipId, start, end, spanSec: end - start,
        meanConfidence, maxInternalGap: maxGap,
        voicedCoverage: track.voicedCoverage, registerHz, registerDeltaFrac, inBand, usable
      });
      i = j + 1;
    }
  }

  // Only usable windows are ever uploaded. Silence/low-confidence windows are never used to
  // pad toward the duration target (the plan: "silence is never uploaded to fill duration").
  const usableWindows = raw.filter((w) => w.usable);
  const usableAgg = usableWindows.reduce((s, w) => s + w.spanSec, 0);
  if (usableAgg < minUsableAggregateSec) {
    throw new InsufficientCleanWindowsError(
      usableAgg, minUsableAggregateSec,
      `${usableWindows.length} usable window(s) on clip ${clipId} (of ${raw.length} enumerated); need continuous clean speech ≥${minVoicedCoverage * 100}% voiced and ≥${minMeanConfidence} mean confidence`
    );
  }

  // Rank (best first) BEFORE the cap so the ≈maxTotalSec budget keeps the strongest windows:
  //   1. in-band before out-of-band (±3% band DEMOTES, does not exclude)
  //   2. higher voiced coverage
  //   3. closer register (smaller delta; null delta sorts last among equals)
  //   4. earlier start (stable, deterministic)
  const ranked = [...usableWindows].sort((a, b) => {
    if (a.inBand !== b.inBand) return a.inBand ? -1 : 1;
    const cov = b.voicedCoverage - a.voicedCoverage;
    if (cov !== 0) return cov;
    const da = a.registerDeltaFrac ?? Number.POSITIVE_INFINITY;
    const db = b.registerDeltaFrac ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    if (a.start !== b.start) return a.start - b.start;
    return cmpStr(a.clipId, b.clipId);
  });

  // Take from the ranked list until adding the next window would exceed the ≈maxTotalSec cap.
  // A window longer than the whole cap (unusual) is still taken alone so we never return empty
  // when usable material exists.
  const chosen: CleanWindow[] = [];
  let total = 0;
  for (const w of ranked) {
    if (chosen.length > 0 && total + w.spanSec > maxTotalSec) continue;
    chosen.push(w);
    total += w.spanSec;
    if (total >= maxTotalSec) break;
  }

  // Post-pack floor guard: greedy packing under an adversarial cap/window tuning can select
  // less than the aggregate floor even though the pre-pack usable set met it (e.g. two 19.9s
  // windows, floor 30, cap 30 — no subset satisfies both, and a rank-order unlucky greedy can
  // also under-pack when one does). The invariant is "returned set >= floor, or typed error";
  // with the locked defaults (~10s windows, floor 30, cap 90) this never fires.
  if (total < minUsableAggregateSec) {
    throw new InsufficientCleanWindowsError(
      total, minUsableAggregateSec,
      `greedy cap packing chose ${chosen.length} window(s) under the ${maxTotalSec}s cap from ${usableWindows.length} usable — no floor-satisfying subset was packed`
    );
  }

  // Canonical OUTPUT ordering: ascending start (ranking governed selection, not order).
  chosen.sort((a, b) => a.start - b.start || cmpStr(a.clipId, b.clipId));
  return { windows: chosen, totalSec: chosen.reduce((s, w) => s + w.spanSec, 0), targetRegisterHz };
}

// ── Cache check ────────────────────────────────────────────────────────────────

// A cache request is one of two structurally-distinct CLASSES, matched symmetrically (the
// same philosophy as accountRef tag classes): a LEGACY single-window request identifies its
// clone by sourceAudioRange only; a MULTI-WINDOW request identifies it by sourceClass +
// ordered windows (+ cleanupIdentity when cleaned). A legacy record never satisfies a
// multi-window request and vice versa — even if the ranges happen to coincide — because the
// prepared audio (single raw window vs. several cleaned windows uploaded as separate samples)
// is a different clone entirely.
interface MultiWindowIdentity {
  sourceClass: 'raw' | 'cleaned';
  /** Present only for sourceClass:'cleaned' (studioCleanup.cacheKey). */
  cleanupIdentity?: string;
  /** Canonical ascending-start order; compared position-by-position within CACHE_EPSILON. */
  windows: { clipId: string; start: number; end: number }[];
}

// True iff a record's stored windows match the request's windows exactly: same count, same
// clipId per position, and start/end within CACHE_EPSILON. Order matters, but both sides are
// produced/stored in canonical ascending-start order so a positional compare is exact.
function windowsMatch(
  recWindows: { clipId: string; start: number; end: number }[] | undefined,
  reqWindows: { clipId: string; start: number; end: number }[]
): boolean {
  if (!recWindows || recWindows.length !== reqWindows.length) return false;
  for (let i = 0; i < reqWindows.length; i++) {
    const a = recWindows[i]!;
    const b = reqWindows[i]!;
    if (a.clipId !== b.clipId) return false;
    if (Math.abs(a.start - b.start) >= CACHE_EPSILON || Math.abs(a.end - b.end) >= CACHE_EPSILON) return false;
  }
  return true;
}

function findCachedVoice(
  settingsInput: SettingsPathsInput,
  projectId: string | undefined,
  scope: 'local' | 'project',
  provider: VoiceProvider,
  accountRef: string | undefined,
  range: { clipId: string; start: number; end: number },
  // Present ⇒ MULTI-WINDOW request class; absent ⇒ LEGACY single-window request class.
  multiWindow?: MultiWindowIdentity
): VoiceRecord | null {
  // Cache reuse is strictly project-scoped. The voices library is GLOBAL, so without a
  // project identity a common range (e.g. clip_001 / 0..10) could match a clone made
  // from an UNRELATED workspace and reuse the wrong speaker. No projectId → never reuse;
  // make a fresh clone instead (correctness over a saved round-trip).
  if (!projectId) return null;
  const library = readVoicesLibrary(settingsInput).value;
  for (const v of library.voices) {
    // Per-provider match: an EL clone must never be reused for a Cartesia request (or vice
    // versa) — the voiceId is provider-namespaced and the speaker identity differs. Legacy
    // records carry provider: 'cartesia' (upsertVoice always set it), so a Cartesia request
    // still cache-hits them here — backward-compatible, no migration needed.
    if (v.provider !== provider) continue;
    // Per-account match — SYMMETRIC by tag class. A voiceId only exists in the account that
    // created it, so:
    //   • tagged request  → matches ONLY records with the IDENTICAL accountRef (an untagged
    //     legacy record could have been created under ANY account; reusing it from a tagged
    //     request would 404 in the requester's account — or worse, resolve to a different
    //     user's voice on a shared endpoint);
    //   • untagged request → matches ONLY untagged records (preserves legacy single-account
    //     behavior among legacy records; disabling untagged↔untagged would silently re-clone
    //     and burn a voice slot for the common single-account setup).
    // Never match across tag classes in either direction. Residual known limit: two accounts
    // BOTH making untagged requests are indistinguishable — callers that switch accounts must
    // tag their requests (the future route caller always will). Strict !== implements exactly
    // class-then-value equality: undefined===undefined for the untagged class, string
    // equality within the tagged class.
    if (v.accountRef !== accountRef) continue;
    if (v.cloneScope !== scope) continue;
    if (v.originProjectId !== projectId) continue;

    // Class-symmetric matching on the multi-window identity. A record is NEW-shaped iff it
    // carries ANY of sourceClass/cleanupIdentity/windows (a hand-edited or partially-written
    // record with only some of the trio is still not legacy — treating it as legacy would let
    // a legacy request reuse a clone whose prepared audio it knows nothing about); legacy =
    // none of the three. A request is multi-window iff `multiWindow` is present. Never match
    // across classes — a legacy record and a multi-window request describe different prepared
    // audio even when their ranges coincide.
    const recIsNewShaped = v.sourceClass !== undefined || v.cleanupIdentity !== undefined || v.windows !== undefined;
    const reqIsMultiWindow = !!multiWindow;
    if (recIsNewShaped !== reqIsMultiWindow) continue;

    if (reqIsMultiWindow) {
      // MULTI-WINDOW class: sourceClass + cleanupIdentity + ordered windows must ALL match.
      // sourceClass distinguishes a raw multi-window clone from a cleaned one; cleanupIdentity
      // (present only for cleaned) pins the exact cleaned bed so a re-cleaned recording misses.
      const mw = multiWindow!;
      if (v.sourceClass !== mw.sourceClass) continue;
      // cleanupIdentity is undefined for raw and defined for cleaned on BOTH sides; strict ===
      // gives class-then-value equality (undefined===undefined for raw, string eq for cleaned).
      if (v.cleanupIdentity !== mw.cleanupIdentity) continue;
      if (!windowsMatch(v.windows, mw.windows)) continue;
      return v;
    }

    // LEGACY single-window class: sourceAudioRange only (unchanged semantics). Reaching here
    // means the record carries NONE of sourceClass/cleanupIdentity/windows (any partial
    // new-shape was skipped by the class check above).
    const sar = v.sourceAudioRange;
    if (!sar) continue;
    if (sar.clipId !== range.clipId) continue;
    if (Math.abs(sar.start - range.start) < CACHE_EPSILON && Math.abs(sar.end - range.end) < CACHE_EPSILON) {
      return v;
    }
  }
  return null;
}

/**
 * The project's cleaned multi-window clone for ONE cleanup generation, ignoring the exact
 * window set (S1b item 6). `/voice/status` must answer "is a voice ready for this recording as
 * it stands right now?" without decoding audio to re-derive windows, so it matches on the
 * identity that actually invalidates a clone: provider + account + project + cleaned source
 * class + cleanup generation. `cloneCleanClip`'s own cache check stays window-exact — this is a
 * strictly coarser READ used for state display, never to skip a paid call.
 */
export function findProjectCleanedClone(
  settingsInput: SettingsPathsInput,
  query: { projectId: string; provider: VoiceProvider; accountRef?: string; cleanupIdentity?: string }
): VoiceRecord | null {
  if (!query.projectId) return null;
  const library = readVoicesLibrary(settingsInput).value;
  for (const v of library.voices) {
    if (v.provider !== query.provider) continue;
    // Same class-symmetric account matching as findCachedVoice: a tagged request never
    // matches an untagged record and vice versa.
    if (v.accountRef !== query.accountRef) continue;
    if (v.originProjectId !== query.projectId) continue;
    if (v.sourceClass !== 'cleaned') continue;
    // OMITTING cleanupIdentity asks the generation-agnostic question — "does this project have
    // ANY cleaned clone?" — which is what distinguishes 'stale' (re-prepare) from 'none'
    // (prepare). Supplying it asks the generation-exact question the patch route needs.
    if (query.cleanupIdentity !== undefined && v.cleanupIdentity !== query.cleanupIdentity) continue;
    return v;
  }
  return null;
}

// ── Remote clone dispatch ──────────────────────────────────────────────────────
// One place decides HOW the paid clone call is made: the caller's injected executor when
// present (S1b: runProvider, so the call is capped/ledgered), otherwise the built-in
// per-provider adapter with the caller's own credential. Both single-window and multi-window
// prep funnel through here so the two paths can never diverge on this.
async function runClone(
  params: CloneCleanClipParams,
  cloneCfg: { clone: CloneFn },
  request: { name: string; samples: VoiceCloneSample[] }
): Promise<{ voiceId: string }> {
  if (params.cloneExecutor) return params.cloneExecutor(request);
  return cloneCfg.clone({
    name: request.name,
    samples: request.samples,
    secret: params.secret!,
    baseUrl: params.baseUrl,
    signal: params.signal
  });
}

// ── Orchestrator ───────────────────────────────────────────────────────────────

export async function cloneCleanClip(
  workspacePath: string,
  params: CloneCleanClipParams & SettingsPathsInput & { projectId?: string }
): Promise<CloneCleanClipResult> {
  const workspace = resolve(workspacePath);

  // Provider is REQUIRED (no core default — see CLONE_PROVIDERS note). The runtime guard
  // still matters despite the type: params commonly arrive from parsed JSON bodies where a
  // bad string would otherwise dispatch to `undefined.clone`.
  const provider: VoiceProvider = params.provider;
  const cloneCfg = CLONE_PROVIDERS[provider];
  if (!cloneCfg) throw new Error(`cloneCleanClip: unsupported clone provider "${provider}". Pass 'elevenlabs' or 'cartesia' explicitly — core has no default.`);
  // Fail before any extraction/remote work: without an injected executor the built-in dispatch
  // needs a credential, and a missing one would otherwise surface as a provider 401 AFTER the
  // full multi-window prep chain has run.
  if (!params.cloneExecutor && !params.secret) throw new Error('cloneCleanClip: secret is required unless cloneExecutor is supplied.');
  // Account discriminator for cache scoping. Prefer the caller's explicit non-secret
  // identifier; fall back to the baseUrl host (a non-default endpoint implies a distinct
  // tenant). NEVER derived from the secret value. Undefined ⇒ account-unscoped record
  // (legacy-equivalent matching semantics in findCachedVoice).
  // Trim here so cache matching and the persisted record see one canonical form. An
  // explicitly-provided-but-blank accountRef is a caller bug and is rejected in the
  // preflight below — it does NOT silently fall back to the baseUrl derivation.
  let accountRef: string | undefined = params.accountRef?.trim();
  if (params.accountRef === undefined && params.baseUrl) {
    try { accountRef = new URL(params.baseUrl).host; } catch { /* malformed baseUrl fails later in the adapter with a clearer error */ }
  }

  const settingsInput: SettingsPathsInput = { homeDir: params.homeDir, workspacePath: params.workspacePath, etvsDir: params.etvsDir };
  const accountPreflight = () => {
    // Shared accountRef preflight — same rationale as the single-window path: reject an invalid
    // accountRef BEFORE any remote clone so it never consumes a voice slot and then strands.
    if (accountRef !== undefined && accountRef.length === 0) throw new Error('cloneCleanClip: accountRef must be non-empty when provided (it is the cache\'s account discriminator; omit it entirely for an account-unscoped clone).');
    if (accountRef !== undefined && accountRef.length > 200) throw new Error(`cloneCleanClip: accountRef exceeds the 200-character limit (got ${accountRef.length}).`);
  };

  // Multi-window mode is engaged only when the provider actually supports >1 sample AND the
  // caller supplied windows. A maxSamples===1 provider (Cartesia) IGNORES multiWindow and keeps
  // byte-identical single-window behavior — but a bad request (asking Cartesia for multi-window)
  // would silently degrade, so the caller is expected to only pass multiWindow to a capable
  // provider; we fall back to single-window rather than error to stay permissive.
  if (params.multiWindow && cloneCfg.maxSamples > 1) {
    // referenceRange and multiWindow are mutually-exclusive prep paths — but only when
    // multi-window mode actually engages. A maxSamples===1 provider ignores multiWindow and
    // uses referenceRange (below), so the conflict only matters here.
    if (params.referenceRange) {
      throw new Error('cloneCleanClip: referenceRange and multiWindow are mutually exclusive for a multi-sample provider — pass one prep path.');
    }
    accountPreflight();
    return cloneMultiWindow(workspace, params, { provider, cloneCfg, accountRef, settingsInput, multiWindow: params.multiWindow });
  }

  // Determine the selection
  let selection: CleanClipSelection;
  if (params.referenceRange) {
    // Explicit override — skip selection, but still validate: the override bypasses the
    // selector's guarantees, so a bad range would otherwise flow straight into ffmpeg.
    const r = params.referenceRange;
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) throw new Error('cloneCleanClip: referenceRange start/end must be finite numbers.');
    if (r.start < 0 || r.end <= r.start) throw new Error(`cloneCleanClip: referenceRange must satisfy 0 <= start < end (got ${r.start}..${r.end}).`);
    // Even an explicit override must not clone from the span being replaced.
    if (params.target && r.clipId === params.target.clipId && r.start < params.target.end && r.end > params.target.start) {
      throw new Error('cloneCleanClip: referenceRange overlaps the edit target — it would clone from the audio being replaced.');
    }
    selection = {
      clipId: r.clipId,
      start: r.start,
      end: r.end,
      scope: params.scope,
      spanSec: r.end - r.start,
      meanConfidence: 1,
      maxInternalGap: 0
    };
  } else {
    const transcript = loadTranscript(workspace);
    if (!transcript) throw new Error('cloneCleanClip: transcript not found. Run transcribe first.');
    selection = selectCleanClip({
      words: transcript,
      scope: params.scope,
      target: params.scope === 'local' ? params.target : undefined,
      // A project-scope clone for a replacement must still avoid the span being
      // overwritten — pass the target as excludeRange so project-wide selection can't
      // train from the audio it is about to replace.
      excludeRange: params.scope === 'project' ? params.target : undefined
    });
  }

  // Cache check: look for an existing voice with matching scope/project/range (LEGACY class —
  // no multiWindow arg, so it matches only legacy-shaped records, never a multi-window one).
  const cached = findCachedVoice(settingsInput, params.projectId, selection.scope, provider, accountRef, {
    clipId: selection.clipId,
    start: selection.start,
    end: selection.end
  });
  if (cached) {
    const refRel = `media/${selection.clipId}/reference-48k.wav`;
    return { voice: cached, selection, cached: true, referencePath: refRel, sampleCount: 1 };
  }

  // Validate the length-constrained voice-record fields BEFORE any extraction or the
  // (remote, free-but-real) clone, so a too-long name/clipId/projectId fails fast instead
  // of orphaning a created Cartesia voice that upsertVoice would then refuse to persist.
  // Mirrors the clone route's pre-flight check; limits match VoiceRecordSchema.
  const voiceName = params.name ?? `clone-${selection.clipId}-${Math.round(selection.start)}-${Math.round(selection.end)}`;
  if (voiceName.length < 1 || voiceName.length > 200) throw new Error(`cloneCleanClip: voice name must be 1–200 characters (got ${voiceName.length}).`);
  if (selection.clipId.length > 128) throw new Error(`cloneCleanClip: clipId "${selection.clipId}" exceeds the 128-character sourceAudioRange limit.`);
  if (params.projectId !== undefined && params.projectId.length > 200) throw new Error('cloneCleanClip: projectId exceeds the 200-character originProjectId limit.');
  // accountRef preflight — same rationale as the fields above: VoiceRecordSchema requires
  // 1..200 chars when present, and upsertVoice only runs AFTER the remote clone succeeds. An
  // invalid accountRef must fail HERE, not consume a provider voice slot and then strand the
  // clone with no local cache record.
  accountPreflight();

  // Extract 48k full-band reference (never the 16k STT copy)
  const refRel = await extractFullBandReference(workspace, selection.clipId);
  const refAbs = assertInside(workspace, refRel);

  // Hardened guard: the clone source must never be input/source.mp4 or the 16k STT audio
  const sttPath = assertInside(workspace, `media/${selection.clipId}/extracted-audio.wav`);
  if (refAbs === sttPath) throw new Error('cloneCleanClip: reference path must not be the 16k STT audio');

  // Coordinate model (CORRECTED W5 — the earlier "all source-axis" note here was WRONG):
  //   • extractClipAudio (16k STT) and extractFullBandReference (this 48k reference) both ffmpeg
  //     the WHOLE asset (no -ss/-to), so transcript word.start/end and the reference time axis are
  //     ASSET coords (0..assetDuration).
  //   • BUT the time map is CLIP-LOCAL: buildBaseTimeline (timeMap/compose.ts) sets segment
  //     sourceStart:0..duration, so a voice_patch op.target — validated and rippled against it — is
  //     clip-local, NOT asset-axis. These coincide ONLY when clip.sourceStart === 0 (single-import,
  //     the only case in use today).
  // selectCleanClip is driven by WORD times (asset axis) and slices the asset-axis reference, so the
  // SELECTION is correct on any clip — no offset needed here. (The local-scope `target` exclusion
  // compares the clip-local op.target against asset-axis words, so it is exact only for
  // sourceStart===0; for a trimmed clip it would be offset by sourceStart — a known limitation
  // tracked for when multi-clip/trimmed projects land, invisible today. W5's tts.ts seam bridge,
  // which DOES start from op.target, applies the + clip.sourceStart conversion explicitly.)

  // Slice the selected window out of the 48k reference into a PER-CALL temp dir.
  // mkdtemp (not a fixed .clone-prep name) so two concurrent clone requests for the
  // same clip cannot collide on staged filenames or delete each other's dir in finally.
  const clipMediaDir = assertInside(workspace, `media/${selection.clipId}`);
  mkdirSync(clipMediaDir, { recursive: true });
  const tempDir = mkdtempSync(join(clipMediaDir, '.clone-prep-'));
  const slicedPath = join(tempDir, 'slice.wav');
  const trimmedPath = join(tempDir, 'trimmed.wav');
  const normedPath = join(tempDir, 'normed.wav');

  try {
    await sliceAudioWindow(refAbs, selection.start, selection.end, slicedPath);
    // Gentle pause handling for CLONE INPUT — see the pause-policy block at
    // CLONE_PREP_MAX_PAUSE_SEC / MAX_INTERNAL_GAP for why prep retention (1.5s) and
    // selection gap (0.35s) differ on purpose. trimPausesAndSilence DELETES the overflow of
    // any internal pause beyond maxPauseSec (it does not collapse — see its doc); the
    // primitive's 0.5s default would shave natural breaths and teach a rushed cadence.
    await trimPausesAndSilence(slicedPath, trimmedPath, { maxPauseSec: CLONE_PREP_MAX_PAUSE_SEC });
    // Clone-input level target: I=-20 LUFS, TP=-3 dBTP. ElevenLabs' IVC guidance is a
    // −23..−18 dB RMS window with true peak at −3; loudnorm's I is integrated LUFS (K-weighted
    // loudness), not raw RMS, but for speech the two track within ~1 dB, so I=-20 lands inside
    // EL's RMS band and TP=-3 matches the ceiling verbatim. Passed EXPLICITLY: loudnormClip's
    // own default stays the broadcast target (I=-16/TP=-1.5) because it is publicly exported
    // from core — external consumers must not silently drop 4 LU.
    await loudnormClip(trimmedPath, normedPath, { integratedLufs: -20, truePeakDb: -3 });

    // Read prepared audio as buffer (voiceName was computed + validated above, pre-clone)
    const audio = readFileSync(normedPath);

    // Provider-dispatched clone. WIRING ONLY: exactly one prepared window is submitted as a
    // single sample for EVERY provider — behavior is identical to the old Cartesia-hardwired
    // path (which also sent one sample). EL accepts the one sample (well under its 25 cap);
    // filling EL's multi-sample budget is future work (the multi-window scorer), not this wave.
    const cloneResult = await runClone(params, cloneCfg, {
      name: voiceName,
      samples: [{ audio, fileName: 'clip.wav', mimeType: 'audio/wav' }]
    });

    // The provider handle must fit VoiceRecordSchema (voiceId max 128) or upsertVoice throws
    // AFTER the remote clone exists. Both adapters guarantee a non-empty trimmed string; guard
    // the length too for a clear error rather than a schema stack trace.
    if (cloneResult.voiceId.length > 128) throw new Error(`cloneCleanClip: ${provider} returned a voice id longer than 128 chars; the remote clone was created but cannot be persisted locally.`);
    const voiceId = `voice-${randomBytes(4).toString('hex')}`;
    const voice = upsertVoice({
      ...settingsInput,
      voice: {
        id: voiceId,
        name: voiceName,
        provider,
        voiceId: cloneResult.voiceId,
        // Account-tag new records only when we HAVE a discriminator — writing a synthetic
        // one for the default account would stop legacy-style (unscoped) requests matching.
        ...(accountRef !== undefined ? { accountRef } : {}),
        ...(params.projectId ? { originProjectId: params.projectId } : {}),
        cloneScope: selection.scope,
        sourceAudioRange: { clipId: selection.clipId, start: selection.start, end: selection.end },
        provenance: { method: 'ivc', createdBy: 'clone-route' }
      }
    });

    return { voice, selection, cached: false, referencePath: refRel, sampleCount: 1 };
  } finally {
    // Clean up temp prep files
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Multi-window prep + upload (S1a) ─────────────────────────────────────────────
// Preps EACH resolved window separately (slice → pause retain-cap 1.5s → clone-band loudnorm
// −20/−3) and uploads them as SEPARATE samples in ONE clone call. Records the multi-window
// cache identity (sourceClass + cleanupIdentity + canonical ordered windows). Only reached when
// the provider's maxSamples > 1 (EL); Cartesia never gets here (single-window path above).
async function cloneMultiWindow(
  workspace: string,
  params: CloneCleanClipParams & SettingsPathsInput & { projectId?: string },
  ctx: {
    provider: VoiceProvider;
    cloneCfg: { clone: CloneFn; maxSamples: number };
    accountRef: string | undefined;
    settingsInput: SettingsPathsInput;
    multiWindow: NonNullable<CloneCleanClipParams['multiWindow']>;
  }
): Promise<CloneCleanClipResult> {
  const { provider, cloneCfg, accountRef, settingsInput, multiWindow } = ctx;
  const { windows, sourceClass, cleanupIdentity, manifest } = multiWindow;

  // Validate the request shape up front (before any cache read / extraction / remote call).
  if (windows.length === 0) throw new Error('cloneCleanClip: multiWindow.windows must be non-empty.');
  if (windows.length > cloneCfg.maxSamples) throw new Error(`cloneCleanClip: ${windows.length} windows exceeds provider ${provider}'s ${cloneCfg.maxSamples}-sample budget.`);
  for (const w of windows) {
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) throw new Error('cloneCleanClip: multiWindow window start/end must be finite numbers.');
    if (w.start < 0 || w.end <= w.start) throw new Error(`cloneCleanClip: multiWindow window must satisfy 0 <= start < end (got ${w.start}..${w.end}).`);
    if (w.clipId.length > 128) throw new Error(`cloneCleanClip: window clipId "${w.clipId}" exceeds the 128-character limit.`);
  }
  // ONE clip per request (Hermes S1a P1): every window's timestamps are asset-axis coordinates
  // of windows[0]'s clip. A mixed set would slice clip A's timestamps out of clip B's audio —
  // timestamp reinterpretation across clips is never allowed.
  for (const w of windows) {
    if (w.clipId !== windows[0]!.clipId) {
      throw new Error(`cloneCleanClip: all multiWindow windows must be on ONE clip (got "${w.clipId}" alongside "${windows[0]!.clipId}") — window timestamps are never reinterpreted against another clip's audio.`);
    }
  }
  // Windows must already be in canonical ascending-start order (as selectCleanWindows returns
  // them) — the cache identity compares positionally, so an out-of-order request would never
  // cache-hit its own record. Enforce it rather than silently re-sort (a re-sort would mask a
  // caller bug and desync the record from what the caller believes it stored).
  for (let i = 1; i < windows.length; i++) {
    if (windows[i]!.start < windows[i - 1]!.start) throw new Error('cloneCleanClip: multiWindow.windows must be in ascending-start order.');
  }
  // sourceClass ↔ cleanup coupling: 'raw' must not carry cleaned-only fields (a cleanupIdentity
  // on a raw record would corrupt the cache identity).
  if (sourceClass === 'raw') {
    if (cleanupIdentity) throw new Error('cloneCleanClip: multiWindow.cleanupIdentity must be omitted when sourceClass is "raw".');
  }

  // ── Cleaned-source contract, enforced by CORE (Hermes S1a P1) ────────────────────────────
  // The primitive must be safe standalone: a caller-supplied cleanupIdentity or artifact path
  // is never trusted. Verify the manifest's cleanup state HERE, before the cache lookup — a
  // stale/absent cleanup must not even return a cache hit (the hit would launder a clone whose
  // bed no longer reflects the recording's current state). Every violation is a typed
  // CleanedSourceUnavailableError; raw sourceClass is unaffected by this block.
  let cleanedAssetRel: string | undefined;
  if (sourceClass === 'cleaned') {
    if (!cleanupIdentity) throw new CleanedSourceUnavailableError('multiWindow.cleanupIdentity is required when sourceClass is "cleaned".');
    if (!manifest) throw new CleanedSourceUnavailableError('multiWindow.manifest is required when sourceClass is "cleaned" — core verifies cleanup freshness itself.');
    // Canonical-format gate BEFORE any path construction or cache identity use.
    // StudioCleanupSchema deliberately keeps cacheKey loose (tightening the parse schema would
    // refuse to LOAD older or hand-edited manifests wholesale), so every boundary that builds
    // a path from the key must enforce the sha256-hex form itself: a traversal payload like
    // "../../media/clip_001/evil" survives the assetPath equality check below (both sides
    // interpolate the same string) and assertInside (it stays inside the workspace), and would
    // otherwise launder an arbitrary workspace WAV — or a cache hit keyed to it.
    if (!SHA256_HEX_RE.test(cleanupIdentity)) {
      throw new CleanedSourceUnavailableError(`cleanupIdentity "${cleanupIdentity}" is not a canonical sha256 hex key.`);
    }
    const cleanup = manifest.studioCleanup;
    // (a) approved + (b) fresh — the SAME rule render uses (shared helper, not a re-derivation).
    if (!cleanup || cleanup.status !== 'approved') {
      throw new CleanedSourceUnavailableError(`studioCleanup is ${cleanup ? `status "${cleanup.status}"` : 'absent'} — an approved cleanup is required to clone from the cleaned source.`);
    }
    if (!SHA256_HEX_RE.test(cleanup.cacheKey)) {
      throw new CleanedSourceUnavailableError(`studioCleanup.cacheKey "${cleanup.cacheKey}" is not a canonical sha256 hex key — refusing to build a path from it.`);
    }
    if (!isStudioCleanupFresh(manifest)) {
      throw new CleanedSourceUnavailableError('studioCleanup is STALE (its audioChannelFixFingerprint no longer matches the current channel-fix state) — re-run studio cleanup or clone from raw explicitly.');
    }
    // (c) the request's cache identity must BE the manifest's cleanup identity. A mismatch means
    // the caller resolved windows against one cleanup generation and is cloning under another.
    if (cleanupIdentity !== cleanup.cacheKey) {
      throw new CleanedSourceUnavailableError(`cleanupIdentity "${cleanupIdentity}" does not match the manifest's studioCleanup.cacheKey "${cleanup.cacheKey}" — the windows were selected against a different cleanup generation.`);
    }
    // (d) the artifact path must be the immutable content-addressed location for THIS cacheKey
    // and must exist on disk. A hand-edited assetPath pointing elsewhere is not trusted.
    const expectedRel = `assets/studio-clean/${cleanup.cacheKey}.wav`;
    if (cleanup.assetPath !== expectedRel) {
      throw new CleanedSourceUnavailableError(`studioCleanup.assetPath "${cleanup.assetPath}" is not the expected content-addressed path "${expectedRel}".`);
    }
    let cleanedAbs: string;
    try {
      cleanedAbs = assertInside(workspace, expectedRel);
    } catch (err) {
      // assertInside failures inside the cleaned contract are cleaned-contract violations too —
      // callers branch on CleanedSourceUnavailableError.code, never on generic path errors.
      throw new CleanedSourceUnavailableError(`cleaned artifact path rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!existsSync(cleanedAbs)) {
      throw new CleanedSourceUnavailableError(`cleaned artifact missing at ${expectedRel} — regenerate studio cleanup or clone from raw explicitly.`);
    }
    // The windows' clip must belong to the base recording the cleanup describes: studioCleanup
    // covers ONLY input/source.mp4's audio (same literal-path rule as render's scope guard).
    const clipId = windows[0]!.clipId;
    const clip = (manifest.tracks ?? [])
      .filter((t) => t.kind === 'video')
      .flatMap((t) => t.clips ?? [])
      .find((c) => c.clipId === clipId);
    if (!clip) {
      throw new CleanedSourceUnavailableError(`clip "${clipId}" not found on any video track — cleaned windows must target the base recording's clip.`);
    }
    const asset = (manifest.assets ?? []).find((a) => a.assetId === clip.assetId);
    if (!asset || asset.path !== 'input/source.mp4') {
      throw new CleanedSourceUnavailableError(`clip "${clipId}" resolves to asset path "${asset?.path ?? '(unknown)'}" — studioCleanup describes only input/source.mp4, so cleaned windows must be on that recording's clip.`);
    }
    cleanedAssetRel = expectedRel;
  }

  // The scope is 'project' for a multi-window clone (it trains from the whole recording's
  // eligible clip, not a local edit anchor). selection is reported as the spanning range across
  // the chosen windows for provenance/UX (referencePath still points at the base clip's 48k ref).
  const scope = params.scope;
  const spanClipId = windows[0]!.clipId;
  const spanStart = Math.min(...windows.map((w) => w.start));
  const spanEnd = Math.max(...windows.map((w) => w.end));
  const selection: CleanClipSelection = {
    clipId: spanClipId, start: spanStart, end: spanEnd, scope,
    spanSec: spanEnd - spanStart, meanConfidence: 1, maxInternalGap: 0,
    reason: `multi-window:${sourceClass}:${windows.length}`
  };

  // Cache check — MULTI-WINDOW class. Passes the multiWindow identity so it matches only
  // multi-window records of the same sourceClass/cleanupIdentity/windows, never a legacy record.
  const cached = findCachedVoice(settingsInput, params.projectId, scope, provider, accountRef, {
    clipId: spanClipId, start: spanStart, end: spanEnd
  }, { sourceClass, cleanupIdentity, windows });
  if (cached) {
    const refRel = `media/${spanClipId}/reference-48k.wav`;
    return { voice: cached, selection, cached: true, referencePath: refRel, sampleCount: windows.length };
  }

  // Field-length preflight (mirrors the single-window path) before any extraction / remote call.
  const voiceName = params.name ?? `clone-${sourceClass}-${spanClipId}-${Math.round(spanStart)}-${Math.round(spanEnd)}`;
  if (voiceName.length < 1 || voiceName.length > 200) throw new Error(`cloneCleanClip: voice name must be 1–200 characters (got ${voiceName.length}).`);
  if (params.projectId !== undefined && params.projectId.length > 200) throw new Error('cloneCleanClip: projectId exceeds the 200-character originProjectId limit.');

  // Resolve the base audio each window is sliced from. 'raw' → the 48k reference derivative of
  // the base clip; 'cleaned' → the CORE-VERIFIED fresh cleaned WAV (contract block above: fresh,
  // cacheKey-matched, content-addressed path, exists). Both are sliced on the ASSET axis — the
  // cleaned bed is length-preserving (EL Isolator returns a same-duration file), so window
  // timestamps map 1:1.
  let baseAudioAbs: string;
  let stagedCleaned: { path: string; dispose: () => void } | null = null;
  const refRel = await extractFullBandReference(workspace, spanClipId);
  if (sourceClass === 'cleaned') {
    // SYMLINK SAFETY: the contract block above validated the path lexically, but ffmpeg would
    // re-open it by NAME — a symlink swapped in at the leaf or at any ancestor between the two
    // would upload arbitrary local audio to a paid provider. Read it once through the
    // no-follow/fstat path and slice from the staged private copy instead.
    stagedCleaned = stageVerifiedWorkspaceFile(workspace, cleanedAssetRel!, { fileName: 'cleaned-source.wav' });
    baseAudioAbs = stagedCleaned.path;
  } else {
    baseAudioAbs = assertInside(workspace, refRel);
    // Hardened guard: never clone from the 16k STT copy (same as single-window path).
    const sttPath = assertInside(workspace, `media/${spanClipId}/extracted-audio.wav`);
    if (baseAudioAbs === sttPath) throw new Error('cloneCleanClip: reference path must not be the 16k STT audio');
  }

  const clipMediaDir = assertInside(workspace, `media/${spanClipId}`);
  mkdirSync(clipMediaDir, { recursive: true });
  const tempDir = mkdtempSync(join(clipMediaDir, '.clone-prep-multi-'));
  try {
    const samples: VoiceCloneSample[] = [];
    for (let idx = 0; idx < windows.length; idx++) {
      const w = windows[idx]!;
      const slicedPath = join(tempDir, `slice-${idx}.wav`);
      const trimmedPath = join(tempDir, `trimmed-${idx}.wav`);
      const normedPath = join(tempDir, `normed-${idx}.wav`);
      // Same prep chain as single-window, PER window: slice → pause retain-cap 1.5s → clone-band
      // loudnorm (−20 LUFS / −3 dBTP). Each window becomes one separate sample.
      await sliceAudioWindow(baseAudioAbs, w.start, w.end, slicedPath);
      await trimPausesAndSilence(slicedPath, trimmedPath, { maxPauseSec: CLONE_PREP_MAX_PAUSE_SEC });
      await loudnormClip(trimmedPath, normedPath, { integratedLufs: -20, truePeakDb: -3 });
      samples.push({ audio: readFileSync(normedPath), fileName: `clip-${idx}.wav`, mimeType: 'audio/wav' });
    }

    // ONE clone call with N samples (EL's IVC accepts multiple sample files in a single add).
    const cloneResult = await runClone(params, cloneCfg, { name: voiceName, samples });

    if (cloneResult.voiceId.length > 128) throw new Error(`cloneCleanClip: ${provider} returned a voice id longer than 128 chars; the remote clone was created but cannot be persisted locally.`);
    const voiceId = `voice-${randomBytes(4).toString('hex')}`;
    const voice = upsertVoice({
      ...settingsInput,
      voice: {
        id: voiceId,
        name: voiceName,
        provider,
        voiceId: cloneResult.voiceId,
        ...(accountRef !== undefined ? { accountRef } : {}),
        ...(params.projectId ? { originProjectId: params.projectId } : {}),
        cloneScope: scope,
        // sourceAudioRange kept for back-compat/UX (the spanning range); the multi-window cache
        // identity lives in the new fields below.
        sourceAudioRange: { clipId: spanClipId, start: spanStart, end: spanEnd },
        sourceClass,
        ...(cleanupIdentity ? { cleanupIdentity } : {}),
        windows,
        provenance: { method: 'ivc', createdBy: 'clone-route' }
      }
    });

    return { voice, selection, cached: false, referencePath: refRel, sampleCount: windows.length };
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    stagedCleaned?.dispose();
  }
}
