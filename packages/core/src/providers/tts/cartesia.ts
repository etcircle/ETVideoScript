import { guardedFetch } from '../../network/guardedFetch';
import { ProviderExecutionError } from '../engine';
import { boundedResponseText } from '../httpBody';
import { registerProvider } from '../registry';
import { CARTESIA_VERSION, cartesiaBaseUrl } from '../cartesia.shared';
import type { HttpMediaProvider } from '../contract';
import type { TtsInput, TtsOutput } from './mock';
import type { VoiceCloneSample } from './elevenlabs';

// Cartesia Sonic TTS (pure clone playback): POST /tts/bytes returns raw WAV bytes.
// Pinned to a DATED model so a base-model change never silently alters the user's
// cloned-voice output (sonic-3-latest would drift); provider.model overrides per record.
export const CARTESIA_TTS_MODELS = ['sonic-3-2026-01-12'] as const;
export const CARTESIA_TTS_DEFAULT_MODEL = 'sonic-3-2026-01-12';
// Cartesia bills TTS at 1 credit/character; credit→USD is plan-dependent
// (~$0.00004/char at the Startup tier's 1.25M credits / $49/mo). INFORMATIONAL estimate
// for cost disclosure only; provider.costPerUnit.amount overrides as $/char.
const CARTESIA_TTS_USD_PER_CHAR = 0.00004;
// WAV output requires an explicit encoding (a bare container request fails). pcm_s16le
// at 44.1k is Sonic's native rate — no resample, universally ffprobe-readable.
const CARTESIA_TTS_SAMPLE_RATE = 44100;

function ttsCost(text: string, providerAmount?: number): number {
  const rate = providerAmount ?? CARTESIA_TTS_USD_PER_CHAR;
  return Number((Math.max(text.length, 1) * rate).toFixed(6));
}

export const ttsCartesiaProvider: HttpMediaProvider<TtsInput, TtsOutput> = registerProvider({
  id: 'tts.cartesia',
  kind: 'tts',
  tier: 'paid',
  mode: 'http',
  displayName: 'Cartesia Sonic',
  availableModels: CARTESIA_TTS_MODELS,
  capabilities: { polling: false, cancel: false, maxDurationSec: 600, outputFormats: ['audio/wav'] },
  estimateCost(input, provider) {
    return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: ttsCost(input.text, provider.costPerUnit?.amount), actual: null };
  },
  actualCost(_output, input, provider) {
    const amount = ttsCost(input.text, provider.costPerUnit?.amount);
    return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: amount, actual: amount };
  },
  async run(input, context) {
    const secret = context.secret;
    if (!secret?.trim()) throw new ProviderExecutionError('Configure a Cartesia API key (secretRef) before running Cartesia TTS.', { code: 'provider_auth_failed' });
    // Pin guard: require a DATED checkpoint id (carries a YYYY-MM-DD) and reject any floating
    // alias — 'sonic-3-latest', bare 'sonic-3', 'sonic-3-preview', etc. A silent base-model change
    // would re-voice the user's clone, so only an explicitly dated checkpoint (default OR a newer
    // dated override) is allowed on the wire.
    const modelId = input.model ?? context.provider.model ?? CARTESIA_TTS_DEFAULT_MODEL;
    if (!/\d{4}-\d{2}-\d{2}/.test(modelId) || /latest/i.test(modelId)) {
      throw new ProviderExecutionError(`Cartesia TTS requires a dated model checkpoint (e.g. ${CARTESIA_TTS_DEFAULT_MODEL}); refusing non-dated/floating model id '${modelId}'.`, { code: 'provider_bad_request' });
    }
    // baseUrl comes from the provider RECORD (admin-configured, exactly like every other paid
    // adapter — xai/scribe/openai). A per-call INPUT can't redirect the Bearer host, and
    // guardedFetch's paid-tier SSRF guard blocks resolution to internal/non-public addresses.
    const response = await context.guardedFetch(`${cartesiaBaseUrl(context.provider.baseUrl)}/tts/bytes`, {
      tier: context.provider.tier,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Cartesia-Version': CARTESIA_VERSION,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model_id: modelId,
        transcript: input.text,
        voice: { mode: 'id', id: input.voice },
        language: input.language,
        output_format: { container: 'wav', sample_rate: CARTESIA_TTS_SAMPLE_RATE, encoding: 'pcm_s16le' }
      }),
      signal: context.signal,
      timeoutMs: 60000
    });
    if (!response.ok) throw new ProviderExecutionError(`Cartesia TTS failed with HTTP ${response.status}: ${await boundedResponseText(response)}`, { providerStatus: response.status });
    const audio = Buffer.from(await response.arrayBuffer());
    // Degraded-payload defense (HTTP 200 != usable artifact): require a real WAV container.
    // An error JSON/HTML body returned with 200 would otherwise be written as a .wav asset and
    // only blow up at render. The duration floor for a valid-but-too-short clip lives downstream
    // (synthesis / voice_patch op validation), per the project's degraded-payload pattern.
    const looksLikeWav = audio.byteLength >= 12 && audio.toString('latin1', 0, 4) === 'RIFF' && audio.toString('latin1', 8, 12) === 'WAVE';
    if (!looksLikeWav) {
      const head = audio.byteLength === 0 ? '(empty body)' : audio.toString('latin1', 0, Math.min(48, audio.byteLength));
      // code (not providerStatus): a degraded 200 body must classify as provider_bad_request, not
      // provider_unavailable — engine.ts only honors `code` when providerStatus is absent.
      throw new ProviderExecutionError(`Cartesia TTS did not return a WAV payload (${audio.byteLength} bytes; head=${JSON.stringify(head)}).`, { code: 'provider_bad_request' });
    }
    return { audio, mimeType: 'audio/wav', providerStatus: response.status };
  }
});

// Off-ledger Cartesia IVC (Instant Voice Clone) function.
// This is NOT a registered provider and NEVER touches runProvider / appendProviderRequestEvent
// because IVC creation is a free platform operation (not billed per character like TTS).
// Uses guardedFetch directly with tier:'paid' for the SSRF guard (api.cartesia.ai is public).
// Wire contract: POST /voices/clone with a multipart body containing `clip`, `name`, `language`.
// Field set is version-correct for Cartesia-Version: 2026-03-01 — do NOT add `mode` or `enhance`
// (those are legacy 2024-11-13 knobs that don't exist on the pinned schema and will 4xx).
export async function cloneCartesiaVoice(input: {
  name: string;
  description?: string;
  language?: string;
  samples: VoiceCloneSample[];
  secret: string;
  baseUrl?: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<{ voiceId: string }> {
  const secret = input.secret?.trim();
  if (!secret) throw new ProviderExecutionError('Configure a Cartesia API key (secretRef) before cloning a voice.', { code: 'provider_auth_failed' });
  if (input.samples.length === 0) throw new ProviderExecutionError('At least one voice sample is required.', { code: 'provider_bad_request' });
  // Cartesia IVC is single-clip. Reject (don't silently drop) extra samples so a caller
  // can't believe N recordings trained the voice when only the first was sent — the
  // enroll route reports sampleCount from the request, which would otherwise mislead.
  if (input.samples.length > 1) throw new ProviderExecutionError(`Cartesia instant voice cloning accepts a single clip; received ${input.samples.length} samples. Send one ~10s clip, or use a multi-sample provider.`, { code: 'provider_bad_request' });
  const sample = input.samples[0]!;
  const form = new FormData();
  // Preserve the uploaded clip's real filename so its extension matches sample.mimeType.
  // The clone/enroll routes accept any audio/* (e.g. a browser audio/webm recording), so
  // hard-coding .wav would mislabel the multipart part and the provider may reject/misread it.
  form.append('clip', new Blob([sample.audio as unknown as BlobPart], { type: sample.mimeType }), sample.fileName || 'clip.wav');
  form.append('name', input.name);
  form.append('language', input.language ?? 'en');
  if (input.description !== undefined) form.append('description', input.description);
  // Do NOT manually set Content-Type — let FormData set the boundary automatically.
  const response = await guardedFetch(`${cartesiaBaseUrl(input.baseUrl)}/voices/clone`, {
    tier: 'paid',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Cartesia-Version': CARTESIA_VERSION,
      Accept: 'application/json'
    },
    body: form,
    signal: input.signal,
    timeoutMs: input.timeoutMs ?? 5 * 60 * 1000
  });
  if (!response.ok) throw new ProviderExecutionError(`Cartesia voice clone failed with HTTP ${response.status}: ${await boundedResponseText(response)}`, { providerStatus: response.status });
  // Bounded success read (1 MiB): large enough for any legitimate clone body (id plus an
  // echoed description or voice embedding, which the 2 KiB error-cap would wrongly truncate
  // into a JSON.parse failure), yet capped so a degraded/malicious 200 can't allocate freely.
  const body = await boundedResponseText(response, 1024 * 1024);
  let json: { id?: string; error?: string };
  try { json = JSON.parse(body); }
  catch { throw new ProviderExecutionError(`Cartesia voice clone returned malformed JSON: ${body.slice(0, 200)}`, { code: 'provider_bad_request', providerStatus: response.status }); }
  if (typeof json.error === 'string' && json.error.trim()) throw new ProviderExecutionError(`Cartesia voice clone returned an error payload: ${json.error}`, { code: 'provider_bad_request' });
  // Degraded-payload guard: a 200 with a missing, non-string, or whitespace-only id is
  // not a usable clone handle — reject rather than persist a voice that can never synthesize.
  if (typeof json.id !== 'string' || json.id.trim().length === 0) throw new ProviderExecutionError('Cartesia voice clone response is missing a usable id', { code: 'provider_bad_request' });
  return { voiceId: json.id.trim() };
}
