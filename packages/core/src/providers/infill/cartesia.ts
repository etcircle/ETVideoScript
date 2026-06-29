import { readFileSync } from 'node:fs';
import { ProviderExecutionError } from '../engine';
import { boundedResponseText } from '../httpBody';
import { registerProvider } from '../registry';
import { CARTESIA_VERSION, cartesiaBaseUrl } from '../cartesia.shared';
import type { HttpMediaProvider } from '../contract';
import type { ProviderKind } from '../../providerSettings';

// Cartesia reference-conditioned infill: POST /infill/bytes returns a WAV whose content is
// generated *conditioned on surrounding audio* (left_audio, right_audio) so it carries the
// room, energy, and brightness of the original recording natively. A REQUIRED voice_id anchors
// identity via a clone (Cartesia mandates it — HTTP 400 "missing required field: voice_id" otherwise).
//
// This is an INTERNAL capability of the voice_patch path — NOT a user-selectable task kind.
// It does not appear in settings UI or workspace defaults (UserFacingProviderKindSchema excludes it).
// Cost: ~1 Cartesia credit per character of transcript + 300 fixed per call (header overhead).

// Pinned to a DATED model for the same reason as tts/cartesia.ts: a silent base-model change
// would alter the user's voice identity. A newer dated override is allowed; a floating alias
// ('latest', bare 'sonic-3') is refused before the network call.
export const CARTESIA_INFILL_DEFAULT_MODEL = 'sonic-3-2026-01-12';

// Infill output is 48 k pcm_s16le WAV — matches the reference audio rate so no resampling
// is needed when the caller blends the infill output with the 48k asset-axis reference windows.
const CARTESIA_INFILL_SAMPLE_RATE = 48000;

// Cartesia bills infill at ~1 credit/char + 300 fixed overhead per call.
// Credits, not USD — we report them honestly (see plan D-cost-unit).
const CARTESIA_INFILL_CREDITS_FIXED = 300;

export interface InfillInput {
  leftAudioPath?: string;
  rightAudioPath?: string;
  transcript: string;
  /** REQUIRED by Cartesia infill — a cloned voice id. Enforcement lives at the synthesizeInfillSpeech
   *  entry point; this thin adapter just forwards it (Cartesia's own 400 is the backstop). */
  voiceId?: string;
  language: string;
  model?: string;
}

export interface InfillOutput {
  audio: Buffer;
  mimeType: 'audio/wav';
  durationSec?: number;
  providerStatus?: number;
}

function infillCreditEstimate(transcript: string): number {
  // 1 credit per character of transcript + 300 fixed per call
  return Math.max(transcript.length, 1) + CARTESIA_INFILL_CREDITS_FIXED;
}

export const infillCartesiaProvider: HttpMediaProvider<InfillInput, InfillOutput> = registerProvider({
  id: 'infill.cartesia',
  kind: 'infill' as ProviderKind,
  tier: 'paid',
  mode: 'http',
  displayName: 'Cartesia Reference Infill',
  availableModels: [CARTESIA_INFILL_DEFAULT_MODEL] as const,
  capabilities: { polling: false, cancel: false, maxDurationSec: 600, outputFormats: ['audio/wav'] },

  estimateCost(input, _provider) {
    // Cartesia bills credits, not USD. Report currency:'CREDITS' honestly rather than
    // fabricating a USD number (the engine's cap check skips non-USD; see P1-2 in the plan).
    return { currency: 'CREDITS', estimated: infillCreditEstimate(input.transcript), actual: null };
  },

  actualCost(output, input, _provider) {
    const credits = infillCreditEstimate(input.transcript);
    return { currency: 'CREDITS', estimated: credits, actual: credits };
  },

  ledgerInput(input) {
    // NEVER log absolute file paths — they can contain workspace-level PII (project names,
    // directory structure). Record only the metadata needed to audit the request.
    return {
      transcriptLength: input.transcript.length,
      hasVoiceId: typeof input.voiceId === 'string' && input.voiceId.trim().length > 0,
      hasLeft: typeof input.leftAudioPath === 'string' && input.leftAudioPath.length > 0,
      hasRight: typeof input.rightAudioPath === 'string' && input.rightAudioPath.length > 0,
      language: input.language,
      model: input.model ?? CARTESIA_INFILL_DEFAULT_MODEL
    };
  },

  ledgerOutput(output) {
    const rec: Record<string, unknown> = {
      audioBytes: output.audio.byteLength,
      mimeType: output.mimeType,
      providerStatus: output.providerStatus
    };
    if (output.durationSec !== undefined) rec.durationSec = output.durationSec;
    return rec;
  },

  async run(input, context) {
    // --- Auth guard (mirrors tts/cartesia.ts) ---
    const secret = context.secret;
    if (!secret?.trim()) {
      throw new ProviderExecutionError(
        'Configure a Cartesia API key (secretRef) before running Cartesia infill.',
        { code: 'provider_auth_failed' }
      );
    }

    // --- At-least-one-audio guard (before any network call) ---
    // The infill endpoint requires ≥1 reference window; rejecting here prevents a confusing
    // provider 422 with no local context.
    const hasLeft = typeof input.leftAudioPath === 'string' && input.leftAudioPath.trim().length > 0;
    const hasRight = typeof input.rightAudioPath === 'string' && input.rightAudioPath.trim().length > 0;
    if (!hasLeft && !hasRight) {
      throw new ProviderExecutionError(
        'Cartesia infill requires at least one reference audio window (leftAudioPath or rightAudioPath); neither was provided.',
        { code: 'provider_bad_request' }
      );
    }

    // --- Dated-model guard (verbatim from tts/cartesia.ts) ---
    // Pin guard: require a DATED checkpoint id (carries a YYYY-MM-DD) and reject any floating
    // alias — 'sonic-3-latest', bare 'sonic-3', 'sonic-3-preview', etc. A silent base-model
    // change would re-voice the user's clone, so only an explicitly dated checkpoint is allowed.
    const modelId = input.model ?? context.provider.model ?? CARTESIA_INFILL_DEFAULT_MODEL;
    if (!/\d{4}-\d{2}-\d{2}/.test(modelId) || /latest/i.test(modelId)) {
      throw new ProviderExecutionError(
        `Cartesia infill requires a dated model checkpoint (e.g. ${CARTESIA_INFILL_DEFAULT_MODEL}); refusing non-dated/floating model id '${modelId}'.`,
        { code: 'provider_bad_request' }
      );
    }

    // --- Build multipart form (globalThis FormData/Blob ONLY) ---
    // Using globalThis.FormData (not undici's FormData) is mandatory: mixing in undici's FormData
    // silently drops multipart fields — a real 422 we hit with ElevenLabs. The 3-arg append
    // (field, blob, filename) is required for binary parts so the filename is present in the
    // Content-Disposition header. NEVER set Content-Type manually — let FormData set the boundary.
    const form = new globalThis.FormData();

    if (hasLeft) {
      const buf = readFileSync(input.leftAudioPath!);
      const blob = new globalThis.Blob([buf as unknown as BlobPart], { type: 'audio/wav' });
      form.append('left_audio', blob, 'left.wav');
    }

    if (hasRight) {
      const buf = readFileSync(input.rightAudioPath!);
      const blob = new globalThis.Blob([buf as unknown as BlobPart], { type: 'audio/wav' });
      form.append('right_audio', blob, 'right.wav');
    }

    form.append('transcript', input.transcript);
    form.append('model_id', modelId);
    form.append('language', input.language);

    // voice_id: Cartesia infill REQUIRES it, but enforcement lives at the synthesizeInfillSpeech
    // entry point (this adapter stays a thin wire). Append when present; a direct adapter call
    // without it gets Cartesia's own clear 400 "missing required field: voice_id".
    if (typeof input.voiceId === 'string' && input.voiceId.trim().length > 0) {
      form.append('voice_id', input.voiceId.trim());
    }

    // Nested output_format fields as flat form keys (Cartesia's bracket-notation field names).
    // 48k mono pcm_s16le to match the reference audio rate — no resampling at blend time.
    form.append('output_format[container]', 'wav');
    form.append('output_format[sample_rate]', String(CARTESIA_INFILL_SAMPLE_RATE));
    form.append('output_format[encoding]', 'pcm_s16le');

    // --- Network call ---
    // baseUrl comes from the provider RECORD (admin-configured). A per-call INPUT can't redirect
    // the Bearer host, and guardedFetch's paid-tier SSRF guard blocks non-public addresses.
    // Timeout is generous (120s): infill conditioning on two audio windows can be slower than TTS.
    const response = await context.guardedFetch(
      `${cartesiaBaseUrl(context.provider.baseUrl)}/infill/bytes`,
      {
        tier: context.provider.tier,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Cartesia-Version': CARTESIA_VERSION
          // NO manual Content-Type — FormData sets the boundary
        },
        body: form,
        signal: context.signal,
        timeoutMs: 120000
      }
    );

    if (!response.ok) {
      throw new ProviderExecutionError(
        `Cartesia infill failed with HTTP ${response.status}: ${await boundedResponseText(response)}`,
        { providerStatus: response.status }
      );
    }

    const audio = Buffer.from(await response.arrayBuffer());

    // --- Degraded-payload defense (verbatim from tts/cartesia.ts) ---
    // HTTP 200 ≠ usable artifact. A JSON error body returned with status 200 would otherwise
    // be written as a .wav asset and only blow up at render time. Require a real WAV container.
    // code = provider_bad_request (not provider_unavailable) because the engine only honors
    // `code` when providerStatus is absent; a degraded 200 body is a bad-request from us, not
    // a provider outage.
    const looksLikeWav =
      audio.byteLength >= 12 &&
      audio.toString('latin1', 0, 4) === 'RIFF' &&
      audio.toString('latin1', 8, 12) === 'WAVE';

    if (!looksLikeWav) {
      const head =
        audio.byteLength === 0
          ? '(empty body)'
          : audio.toString('latin1', 0, Math.min(48, audio.byteLength));
      throw new ProviderExecutionError(
        `Cartesia infill did not return a WAV payload (${audio.byteLength} bytes; head=${JSON.stringify(head)}).`,
        { code: 'provider_bad_request' }
      );
    }

    // durationSec is deliberately omitted — the caller ffprobes the written asset for a
    // truthful duration (WAV header math is unreliable for variable-rate or truncated files).
    return { audio, mimeType: 'audio/wav', providerStatus: response.status };
  }
});
