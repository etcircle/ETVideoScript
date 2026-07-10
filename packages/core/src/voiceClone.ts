import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertInside } from './filesystem';
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
import { sliceAudioWindow, trimPausesAndSilence, loudnormClip } from './audioClip';

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
  secret: string;
  baseUrl?: string;
  signal: AbortSignal;
}

export interface CloneCleanClipResult {
  voice: VoiceRecord;
  selection: CleanClipSelection;
  cached: boolean;
  referencePath: string;
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

// ── Cache check ────────────────────────────────────────────────────────────────

function findCachedVoice(
  settingsInput: SettingsPathsInput,
  projectId: string | undefined,
  scope: 'local' | 'project',
  provider: VoiceProvider,
  accountRef: string | undefined,
  range: { clipId: string; start: number; end: number }
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
    const sar = v.sourceAudioRange;
    if (!sar) continue;
    if (sar.clipId !== range.clipId) continue;
    if (Math.abs(sar.start - range.start) < CACHE_EPSILON && Math.abs(sar.end - range.end) < CACHE_EPSILON) {
      return v;
    }
  }
  return null;
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

  // Cache check: look for an existing voice with matching scope/project/range
  const settingsInput: SettingsPathsInput = { homeDir: params.homeDir, workspacePath: params.workspacePath, etvsDir: params.etvsDir };
  const cached = findCachedVoice(settingsInput, params.projectId, selection.scope, provider, accountRef, {
    clipId: selection.clipId,
    start: selection.start,
    end: selection.end
  });
  if (cached) {
    const refRel = `media/${selection.clipId}/reference-48k.wav`;
    return { voice: cached, selection, cached: true, referencePath: refRel };
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
  if (accountRef !== undefined && accountRef.length === 0) throw new Error('cloneCleanClip: accountRef must be non-empty when provided (it is the cache\'s account discriminator; omit it entirely for an account-unscoped clone).');
  if (accountRef !== undefined && accountRef.length > 200) throw new Error(`cloneCleanClip: accountRef exceeds the 200-character limit (got ${accountRef.length}).`);

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
    const cloneResult = await cloneCfg.clone({
      name: voiceName,
      samples: [{ audio, fileName: 'clip.wav', mimeType: 'audio/wav' }],
      secret: params.secret,
      baseUrl: params.baseUrl,
      signal: params.signal
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

    return { voice, selection, cached: false, referencePath: refRel };
  } finally {
    // Clean up temp prep files
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}
