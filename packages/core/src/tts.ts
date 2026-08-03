import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { assertInside, nowIso } from './filesystem';
import './providers';
import { canonicalProviderId, getProvider, runProvider, type TtsInput, type TtsOutput, type InfillInput, type InfillOutput } from './providers';
import type { TranscriptWords } from './schemas';
import { extractFullBandReference } from './media';
import { extractReferenceWindow } from './audioClip';
import { ensureCartesiaInfillProvider } from './providerSettings';
import { loadManifestV3 } from './manifest/io';
import { postMatchSeam as runPostMatchSeam } from './postMatchSeam';

// Strip leading/trailing silence from the generated TTS clip. ElevenLabs in
// particular returns clips with up to ~200 ms of leading silence (priming
// padding) that, when placed into a voice_patch slot, plays as a gap then a
// late "Hello" — the user hears it as "hello-eyy" instead of "Hello" (real
// regression confirmed against Test-Emo on 2026-05-25). Trim to the actual
// speech boundary so the asset's duration on disk equals the speech duration,
// and downstream `ffprobeDurationSec → durationGeneratedSec → projectTimeMap`
// gets a truthful value. Non-fatal: if ffmpeg is unavailable or fails, we keep
// the untrimmed clip and log to stderr.
function trimSilenceInPlace(absPath: string): void {
  try {
    const tmp = `${absPath}.trim.wav`;
    const result = spawnSync('ffmpeg', [
      '-y',
      '-v', 'error',
      '-i', absPath,
      '-af', 'silenceremove=start_periods=1:start_silence=0:start_threshold=-40dB:stop_periods=1:stop_silence=0.05:stop_threshold=-40dB',
      tmp
    ], { encoding: 'utf8' });
    if (result.status !== 0) {
      try { unlinkSync(tmp); } catch {}
      if (process.env.ETVS_DEBUG_TTS_TRIM) console.error(`[tts.trim] ffmpeg exited ${result.status}: ${result.stderr}`);
      return;
    }
    if (statSync(tmp).size === 0) {
      try { unlinkSync(tmp); } catch {}
      if (process.env.ETVS_DEBUG_TTS_TRIM) console.error(`[tts.trim] trimmed file empty, keeping original`);
      return;
    }
    renameSync(tmp, absPath);
  } catch (err) {
    if (process.env.ETVS_DEBUG_TTS_TRIM) console.error(`[tts.trim] failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export type SpeechProvider = string & {};

export interface SpeechSynthesisInput {
  text: string;
  provider?: SpeechProvider;
  voice?: string;
  // Optional per-call model override. Without this, paid-call cost preview in the UI can
  // mismatch what the adapter actually bills (e.g. user picks eleven_flash_v2_5 at $0.05/1K
  // but the server synthesizes with the adapter default eleven_multilingual_v2 at $0.10/1K).
  model?: string;
  language?: string;
  previousText?: string;
  nextText?: string;
  // When true, skip the leading/trailing-silence trim. Default (false/undefined) keeps the
  // existing trim behavior. The seam-aware Cartesia word/phrase path sets this so the natural
  // breath inside the clip is preserved for the post-match seam pass (W5) instead of clipped.
  keepSilence?: boolean;
  // Regeneration granularity chosen at op-creation; carried through for the seam-aware path and
  // for deterministic re-renders. Inert here (no behavior) beyond being threaded to the adapter.
  granularity?: 'word' | 'phrase' | 'sentence';
  // W5 post-match seam bake. ADDITIVE + OPT-IN: when present (and keepSilence === true),
  // synthesizeSpeech bakes the seam into the asset BEFORE returning, so the caller's
  // ffprobe records the post-bake (truthful) duration. Absent => today's exact behavior.
  postMatchSeam?: boolean;
  // Edit window in CLIP-LOCAL coords (the voice_patch op.target axis — the time map is
  // clip-local, sourceStart:0..duration; see buildBaseTimeline in timeMap/compose.ts). The
  // 48k reference is on the ASSET axis (the whole asset), so this is converted via
  // + clip.sourceStart below. (For single-import clips sourceStart===0, so the two coincide —
  // which is why this distinction is invisible today.) Required when postMatchSeam.
  seam?: { clipId: string; editStartSec: number; editEndSec: number };
  requestId?: string;
  projectId?: string;
  operationId?: string;
  requestType?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  etvsDir?: string;
}

export interface SpeechSynthesisResult {
  asset: string;
  provider: SpeechProvider;
  providerRequestId: string;
  voice: string;
  estimatedCostUsd?: number | null;
  actualCostUsd?: number | null;
  // Currency-agnostic cost passthrough. Cartesia infill bills in CREDITS (not USD), so
  // estimatedCostUsd/actualCostUsd stay null on that path; this carries the honest unit + amount
  // for activity disclosure. Absent on legacy/USD-only callers.
  cost?: { currency: string; estimated: number | null; actual: number | null };
  // W5: true when the seam bake ran successfully and the asset is already post-processed.
  // Absent/false means the asset was NOT baked (default path). Route must NOT set
  // op.seamBaked unless this is true.
  seamBaked?: boolean;
}

/**
 * Shared with the execution + spend-attribution layers (providers/providerId.ts) so a route's
 * ledger id and the engine's resolved id can never diverge — and so a non-string provider (an
 * array from a repeated query param, a number from a malformed body) is a typed bad request
 * here, at the first gate, instead of coercing into a plausible-looking id.
 */
function normalizeProviderId(provider?: string): string | undefined {
  return canonicalProviderId('tts', provider);
}

export function assertSpeechProviderSupported(provider?: string): void {
  const providerId = normalizeProviderId(provider);
  if (!providerId) return;
  const adapter = getProvider<TtsInput, TtsOutput>(providerId);
  if (!adapter || adapter.kind !== 'tts') throw new Error(`Unsupported speech provider: ${String(provider)}`);
}

function displayProvider(providerId: string): SpeechProvider {
  return providerId.startsWith('tts.') ? providerId.slice(4) as SpeechProvider : providerId as SpeechProvider;
}

function nextAssetPath(workspacePath: string, provider: SpeechProvider): { abs: string; rel: string } {
  const stamp = nowIso().replace(/[-:.TZ]/g, '').slice(0, 14);
  const safeProvider = String(provider).replace(/[^a-zA-Z0-9_-]/g, '-');
  const rel = `assets/voice/patch-${stamp}-${safeProvider}-${Math.random().toString(36).slice(2, 8)}.wav`;
  return { abs: assertInside(workspacePath, rel), rel };
}

export async function synthesizeSpeech(workspacePath: string, input: SpeechSynthesisInput): Promise<SpeechSynthesisResult> {
  const workspace = resolve(workspacePath);
  if (typeof input.text !== 'string') throw new Error('Replacement text is required');
  const text = input.text.trim();
  if (!text) throw new Error('Replacement text is required');
  if (text.length > 15000) throw new Error('Replacement text exceeds xAI TTS 15,000 character limit');
  const providerId = normalizeProviderId(input.provider);
  assertSpeechProviderSupported(input.provider);
  const voice = input.voice || 'eve';
  const language = input.language || 'en';
  const envelope = await runProvider<TtsInput, TtsOutput>({
    workspacePath: workspace,
    kind: 'tts',
    providerId,
    requestId: input.requestId,
    requestType: input.requestType ?? 'tts',
    projectId: input.projectId,
    operationId: input.operationId,
    input: { text, voice, language, ...(input.model ? { model: input.model } : {}), ...(input.previousText ? { previousText: input.previousText } : {}), ...(input.nextText ? { nextText: input.nextText } : {}), ...(input.keepSilence ? { keepSilence: true } : {}), ...(input.granularity ? { granularity: input.granularity } : {}) },
    env: input.env,
    homeDir: input.homeDir,
    etvsDir: input.etvsDir
  });
  if (envelope.ok === false) throw new Error(`${envelope.error.problem} ${envelope.error.cause} ${envelope.error.fix}`);
  const provider = displayProvider(envelope.providerId);
  const { abs, rel } = nextAssetPath(workspace, provider);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, envelope.output.audio);
  // Default behavior preserved: trim unless the caller explicitly opts to keep silence.
  if (input.keepSilence !== true) trimSilenceInPlace(abs);
  // W5 seam bake — strictly opt-in and mutually exclusive with the blunt trim. Runs only
  // when keepSilence preserved the breath AND a seam window was supplied. On any failure
  // postMatchSeam leaves `abs` untouched and returns baked:false, so the caller's ffprobe
  // still sees a truthful (un-baked) duration and `seamBaked` is NOT set.
  let seamBaked = false;
  if (input.keepSilence === true && input.postMatchSeam === true && input.seam) {
    try {
      // seam.editStart/EndSec are CLIP-LOCAL (op.target axis). The 48k reference is on the
      // ASSET axis, so convert via + clip.sourceStart. validateLocal / projectTimeMap treat
      // op.target as clip-local (compose.ts buildBaseTimeline sets segment.sourceStart:0), so
      // without this offset the neighbor windows would be mis-sliced for any clip whose
      // sourceStart !== 0. (For single-import clips sourceStart===0 → no-op.)
      const manifest = loadManifestV3(workspace);
      const clip = manifest.tracks.flatMap((t) => t.clips).find((c) => c.clipId === input.seam!.clipId);
      const offset = clip?.sourceStart ?? 0;
      const referenceRel = await extractFullBandReference(workspace, input.seam.clipId);
      const referenceAbsPath = assertInside(workspace, referenceRel);
      const result = await runPostMatchSeam(abs, {
        referenceAbsPath,
        editStartSec: input.seam.editStartSec + offset,
        editEndSec: input.seam.editEndSec + offset,
        ...(input.granularity ? { granularity: input.granularity } : {})
      });
      seamBaked = result.baked;
    } catch {
      // Non-fatal: leave seamBaked false; caller's ffprobe will still see the un-baked asset.
    }
  }
  return {
    asset: relative(workspace, abs).split('\\').join('/'),
    provider,
    providerRequestId: envelope.requestId,
    voice,
    estimatedCostUsd: envelope.cost.currency === 'USD' ? envelope.cost.estimated ?? null : null,
    actualCostUsd: envelope.cost.currency === 'USD' ? envelope.cost.actual ?? null : null,
    ...(seamBaked ? { seamBaked: true } : {})
  };
}

export async function synthesizeReplacementSpeech(workspacePath: string, input: SpeechSynthesisInput): Promise<SpeechSynthesisResult> {
  return synthesizeSpeech(workspacePath, { ...input, requestType: input.requestType ?? 'voice_patch' });
}

// Path B — Cartesia reference-conditioned infill.
export interface InfillSynthesisInput {
  clipId: string;
  // CLIP-LOCAL edit window (the voice_patch op.target axis). Converted to the ASSET axis (where the
  // 48k reference lives) via + clip.sourceStart below — single-import clips have sourceStart===0.
  editStartSec: number;
  editEndSec: number;
  // The text to generate in the gap (favor a breath-snapped PHRASE span — longer transcript gives
  // Cartesia more flexibility, per its infill guidance).
  transcript: string;
  // Identity anchor — a Cartesia IVC voice id. REQUIRED: Cartesia infill mandates voice_id (the
  // reference audio carries acoustics; the clone carries identity). Validated above. Kept optional
  // at the type level only so callers can share one input shape.
  voiceId?: string;
  language?: string;
  model?: string;
  // left/right LOOK-BACK span (sec) searched for neighbour speech. The seam-adjacent silence (breath)
  // is trimmed away, so this is how far to look PAST the breath for real speech, not the final clip
  // length. Default 3.0 (clears a typical ~1.3s breath). A side with no speech in range is dropped.
  leftWindowSec?: number;
  rightWindowSec?: number;
  // Post-asset seam treatment at the splice: 'raw' = none; 'level-qsin' = measured-loudnorm match +
  // qsin edge feather, NO room-tone bed (postMatchSeam mode 'level-feather'); 'full' = today's whole
  // seam (level + room-tone bed + qsin). Default 'level-qsin' — infill should carry the room itself,
  // so the bed risks double-applying it. (qsin-only-no-level is covered analytically by measuring the
  // raw-infill-vs-neighbor level step, not as a separate render cell.)
  seam?: 'raw' | 'level-qsin' | 'full';
  requestId?: string;
  projectId?: string;
  operationId?: string;
  requestType?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  etvsDir?: string;
}

/**
 * Generate replacement speech CONDITIONED on the user's own surrounding audio (left/right 48k
 * reference windows), so it carries energy + room + brightness natively, with an OPTIONAL local-clone
 * voice_id as identity anchor. Sibling to synthesizeReplacementSpeech; NOT yet wired to routes (this
 * is the Layer-1 proof path the A/B harness calls directly). Never trims — the infill output's
 * boundary timing is provider-intended (unlike pure-TTS priming silence). Optional seam bake at the
 * splice per `seam`. Bills in Cartesia CREDITS (see SpeechSynthesisResult.cost).
 */
export async function synthesizeInfillSpeech(workspacePath: string, input: InfillSynthesisInput): Promise<SpeechSynthesisResult> {
  const workspace = resolve(workspacePath);
  const transcript = typeof input.transcript === 'string' ? input.transcript.trim() : '';
  if (!transcript) throw new Error('Infill transcript is required');
  if (transcript.length > 15000) throw new Error('Infill transcript exceeds the 15,000 character limit');
  // Cartesia infill mandates voice_id (the clone is the identity anchor) — fail before slicing/paying.
  if (typeof input.voiceId !== 'string' || input.voiceId.trim().length === 0) {
    throw new Error('Infill requires a voiceId (a cloned voice) — Cartesia mandates voice_id');
  }
  const language = input.language || 'en';
  const seamMode = input.seam ?? 'level-qsin';
  // Validate the edit window BEFORE slicing or any paid call — never spend credits on a nonsensical
  // patch (e.g. editEnd <= editStart would still slice windows and bill).
  if (!Number.isFinite(input.editStartSec) || !Number.isFinite(input.editEndSec)
    || input.editStartSec < 0 || input.editEndSec <= input.editStartSec) {
    throw new Error(`Infill: invalid edit window [${input.editStartSec}, ${input.editEndSec}] (need 0 <= start < end)`);
  }
  for (const w of [input.leftWindowSec, input.rightWindowSec]) {
    if (w !== undefined && (!Number.isFinite(w) || w < 0)) throw new Error('Infill: window lengths must be finite and >= 0');
  }

  // The paid infill provider record must exist (secretRef:'cartesia') or runProvider's synthetic
  // fallback has no secret and Cartesia 401s. Idempotent.
  // (env only overrides provider env-vars, not the providers.json/secrets.json path — which is
  // homeDir/etvsDir-based — so the record + the 'cartesia' secret resolve consistently without it.)
  ensureCartesiaInfillProvider({ homeDir: input.homeDir, etvsDir: input.etvsDir });

  // Resolve clip + sourceStart → ASSET-axis edit bounds (the 48k reference is on the asset axis).
  const manifest = loadManifestV3(workspace);
  const clip = manifest.tracks.flatMap((t) => t.clips).find((c) => c.clipId === input.clipId);
  if (!clip) throw new Error(`Infill: clip ${input.clipId} not found`);
  const offset = clip.sourceStart ?? 0;
  const assetEditStart = input.editStartSec + offset;
  const assetEditEnd = input.editEndSec + offset;

  // Ensure the 48k full-band reference once. The edit boundary is breath-snapped, so the audio
  // IMMEDIATELY adjacent to the seam is often SILENCE — and Cartesia rejects an all-silent reference
  // ("audio is empty or has only silence"). So look back/forward far enough to clear the breath, then
  // trim the seam-adjacent silence so each clip is the neighbour SPEECH "clipped right up to the gap"
  // (Cartesia's own guidance). leftWindowSec/rightWindowSec are the LOOK-BACK span, not the final clip.
  const refRel = await extractFullBandReference(workspace, input.clipId);
  const refAbs = assertInside(workspace, refRel);
  const Lwin = input.leftWindowSec ?? 3.0;
  const Rwin = input.rightWindowSec ?? 3.0;
  const winDir = mkdtempSync(join(workspace, '.infill-'));
  // Trim leading THEN trailing silence (areverse sandwich); internal pauses are preserved.
  const TRIM_BOTH_ENDS = 'silenceremove=start_periods=1:start_silence=0:start_threshold=-40dB,areverse,silenceremove=start_periods=1:start_silence=0:start_threshold=-40dB,areverse';
  // Clamp the look-back to THIS clip's asset range so we never condition the infill on media outside
  // the clip — previously trimmed/deleted speech or a neighbouring clip — near a trimmed boundary
  // (Codex P2). For a single-import clip (sourceStart 0..whole asset) this is a no-op.
  const clipAssetStart = clip.sourceStart ?? 0;
  const clipAssetEnd = (typeof clip.sourceEnd === 'number' && Number.isFinite(clip.sourceEnd)) ? clip.sourceEnd : Infinity;
  const gatherSide = async (side: 'left' | 'right', lookbackSec: number): Promise<string | undefined> => {
    const rawStart = side === 'left' ? Math.max(clipAssetStart, assetEditStart - lookbackSec) : assetEditEnd;
    const rawEnd = side === 'left' ? assetEditStart : Math.min(clipAssetEnd, assetEditEnd + lookbackSec);
    if (rawEnd - rawStart < 0.05) return undefined;
    const raw = join(winDir, `${side}-raw.wav`);
    try { await extractReferenceWindow(workspace, input.clipId, rawStart, rawEnd, raw); } catch { return undefined; }
    const out = join(winDir, `${side}.wav`);
    const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-af', TRIM_BOTH_ENDS, '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le', out], { encoding: 'utf8' });
    if (r.status !== 0) return undefined;
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out], { encoding: 'utf8' });
    const dur = Number((probe.stdout ?? '').trim());
    // < ~0.12s of audio after trimming ⇒ the look-back window was effectively all silence; drop the side.
    if (!Number.isFinite(dur) || dur < 0.12) return undefined;
    return out;
  };
  try {
    const leftAudioPath = await gatherSide('left', Lwin);
    const rightAudioPath = await gatherSide('right', Rwin);
    if (!leftAudioPath && !rightAudioPath) {
      throw new Error('Infill: no non-silent reference speech within the look-back window on either side of the edit');
    }

    const envelope = await runProvider<InfillInput, InfillOutput>({
      workspacePath: workspace,
      kind: 'infill',
      providerId: 'infill.cartesia',
      requestId: input.requestId,
      requestType: input.requestType ?? 'voice_patch_infill',
      projectId: input.projectId,
      operationId: input.operationId,
      input: {
        ...(leftAudioPath ? { leftAudioPath } : {}),
        ...(rightAudioPath ? { rightAudioPath } : {}),
        transcript,
        language,
        ...(input.voiceId ? { voiceId: input.voiceId } : {}),
        ...(input.model ? { model: input.model } : {})
      },
      env: input.env,
      homeDir: input.homeDir,
      etvsDir: input.etvsDir
    });
    if (envelope.ok === false) throw new Error(`${envelope.error.problem} ${envelope.error.cause} ${envelope.error.fix}`);

    const { abs } = nextAssetPath(workspace, 'cartesia-infill');
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, envelope.output.audio);
    // NO trim: infill boundary timing is provider-intended (do NOT run trimSilenceInPlace here).

    let seamBaked = false;
    if (seamMode !== 'raw') {
      try {
        const result = await runPostMatchSeam(abs, {
          referenceAbsPath: refAbs,
          editStartSec: assetEditStart,
          editEndSec: assetEditEnd,
          granularity: 'phrase',
          mode: seamMode === 'full' ? 'full' : 'level-feather'
        });
        seamBaked = result.baked;
      } catch {
        // Non-fatal: leave seamBaked false; the raw infill asset stands.
      }
    }

    return {
      asset: relative(workspace, abs).split('\\').join('/'),
      provider: envelope.providerId as SpeechProvider,
      providerRequestId: envelope.requestId,
      voice: input.voiceId ?? '',
      estimatedCostUsd: envelope.cost.currency === 'USD' ? envelope.cost.estimated ?? null : null,
      actualCostUsd: envelope.cost.currency === 'USD' ? envelope.cost.actual ?? null : null,
      cost: { currency: envelope.cost.currency, estimated: envelope.cost.estimated ?? null, actual: envelope.cost.actual ?? null },
      ...(seamBaked ? { seamBaked: true } : {})
    };
  } finally {
    rmSync(winDir, { recursive: true, force: true });
  }
}

const CONTEXT_WINDOW_SEC = 5;

export function extractSurroundingTranscriptText(
  words: TranscriptWords['words'],
  clipId: string,
  patchStart: number,
  patchEnd: number
): { previousText: string; nextText: string } {
  if (words.length === 0) return { previousText: '', nextText: '' };
  // Include words matching the clip, plus words with no clipId (global/single-clip transcripts).
  const clipWords = words.filter((w) => w.clipId === clipId || w.clipId === '');
  const previousText = clipWords
    .filter((w) => w.end <= patchStart && w.end > patchStart - CONTEXT_WINDOW_SEC)
    .map((w) => w.text)
    .join(' ');
  const nextText = clipWords
    .filter((w) => w.start >= patchEnd && w.start <= patchEnd + CONTEXT_WINDOW_SEC)
    .map((w) => w.text)
    .join(' ');
  return { previousText, nextText };
}
