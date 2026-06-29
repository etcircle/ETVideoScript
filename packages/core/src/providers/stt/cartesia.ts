import { readFileSync, statSync } from 'node:fs';
import { ProviderExecutionError } from '../engine';
import { boundedResponseText } from '../httpBody';
import { registerProvider } from '../registry';
import { CARTESIA_VERSION, cartesiaBaseUrl } from '../cartesia.shared';
import type { HttpMediaProvider } from '../contract';

// Cartesia Ink-Whisper STT: POST /stt (multipart) → { text, duration, language,
// words: [{ word, start, end }] }. That shape is ALREADY what parseTimedWhisperResponse
// accepts (it reads `word.word ?? word.text` and defaults per-word confidence to 0.8),
// so the only adaptation needed is surfacing the model id.
export const CARTESIA_STT_MODELS = ['ink-whisper'] as const;
export const CARTESIA_STT_DEFAULT_MODEL = 'ink-whisper';
// Ink-Whisper STT is credit-based; ~$0.003/min is an INFORMATIONAL estimate for cost
// disclosure. provider.costPerUnit.amount overrides as a $/minute rate.
export const CARTESIA_STT_USD_PER_MINUTE = 0.003;
// Conservative cap. Refuse a giant upload at the boundary instead of silently sending it.
export const CARTESIA_STT_MAX_FILE_BYTES = 500 * 1024 * 1024;

export type SttCartesiaInput = {
  audioPath: string;
  audioRel: string;
  durationSec: number;
  model?: string;
  language?: string;
};

export type SttCartesiaOutput = {
  rawJson: string;
  originalJson: string;
  responseBytes: number;
  durationSec: number;
  providerStatus: number;
  timing: 'provider-json';
};

function minuteCost(durationSec: number, providerAmount?: number): number {
  const rate = providerAmount ?? CARTESIA_STT_USD_PER_MINUTE;
  return Number(((Math.max(durationSec, 0) / 60) * rate).toFixed(6));
}

export const sttCartesiaProvider = registerProvider({
  id: 'stt.cartesia',
  kind: 'stt',
  tier: 'paid',
  mode: 'http',
  displayName: 'Cartesia Ink-Whisper',
  availableModels: CARTESIA_STT_MODELS,
  capabilities: { polling: false, cancel: false, maxDurationSec: 60 * 60, outputFormats: ['application/json'] },
  estimateCost(input, provider) {
    return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: minuteCost(input.durationSec, provider.costPerUnit?.amount), actual: null };
  },
  actualCost(_output, input, provider) {
    const amount = minuteCost(input.durationSec, provider.costPerUnit?.amount);
    return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: amount, actual: amount };
  },
  ledgerInput(input) {
    return { audioRel: input.audioRel, durationSec: input.durationSec, model: input.model };
  },
  ledgerOutput(output) {
    try {
      const parsed = JSON.parse(output.rawJson);
      const words = Array.isArray(parsed.words) ? parsed.words : [];
      return { wordCount: words.length, segmentCount: 0, durationSec: output.durationSec, timing: words.length > 0 ? 'exact' : 'none', responseBytes: output.responseBytes, providerStatus: output.providerStatus };
    } catch {
      return { wordCount: 0, segmentCount: 0, durationSec: output.durationSec, timing: 'unparseable', responseBytes: output.responseBytes, providerStatus: output.providerStatus };
    }
  },
  async run(input, context) {
    if (!context.secret?.trim()) throw new ProviderExecutionError('Configure a Cartesia API key (secretRef) before running Ink-Whisper STT.', { code: 'provider_auth_failed' });
    const size = statSync(input.audioPath).size;
    if (size > CARTESIA_STT_MAX_FILE_BYTES) {
      throw new ProviderExecutionError(`Audio file ${input.audioRel} is ${(size / 1024 / 1024).toFixed(1)} MB; Cartesia STT upload cap is ${CARTESIA_STT_MAX_FILE_BYTES / 1024 / 1024} MB. Split the clip or raise the cap.`, { code: 'provider_bad_request' });
    }
    const fileBuffer = readFileSync(input.audioPath);
    // globalThis FormData/Blob ONLY — mixing in undici's FormData silently drops multipart
    // fields (a real ElevenLabs 422 we already hit). Registry baseUrl is the sole auth destination.
    const form = new FormData();
    form.append('file', new Blob([fileBuffer as unknown as BlobPart], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', input.model ?? context.provider.model ?? CARTESIA_STT_DEFAULT_MODEL);
    form.append('language', input.language ?? 'en');
    form.append('timestamp_granularities[]', 'word');
    const response = await context.guardedFetch(`${cartesiaBaseUrl(context.provider.baseUrl)}/stt`, {
      tier: context.provider.tier,
      method: 'POST',
      headers: { Authorization: `Bearer ${context.secret}`, 'Cartesia-Version': CARTESIA_VERSION, Accept: 'application/json' },
      body: form,
      signal: context.signal,
      timeoutMs: 10 * 60 * 1000
    } as any);
    if (!response.ok) throw new ProviderExecutionError(`Cartesia Ink-Whisper failed with HTTP ${response.status}: ${await boundedResponseText(response)}`, { providerStatus: response.status });
    const originalJson = await response.text();
    if (!originalJson.trim()) throw new ProviderExecutionError('Cartesia Ink-Whisper returned an empty response.', { providerStatus: response.status });
    let parsed: any;
    try { parsed = JSON.parse(originalJson); } catch { throw new ProviderExecutionError(`Cartesia Ink-Whisper returned malformed JSON: ${originalJson.slice(0, 200)}`, { providerStatus: response.status }); }
    // Degraded-200 guard: a top-level `error` string means the provider failed despite HTTP 200
    // (it may even ship a junk words[] alongside, so don't gate on words.length). Reject
    // unconditionally — don't let it ledger as success and only blow up later in the parser.
    // code = provider_bad_request so the engine classifies it accurately (a 200 status would
    // otherwise map to provider_unavailable). A genuinely silent clip carries no `error` and is
    // handled downstream: empty words[] → parseTimedWhisperResponse returns null → transcribe throws.
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
      throw new ProviderExecutionError(`Cartesia Ink-Whisper returned an error payload: ${parsed.error}`, { code: 'provider_bad_request' });
    }
    // Surface model/language so the transcript's provider.model reads 'ink-whisper' instead
    // of the parser's 'configured-whisper' fallback. Words/start/end/text are passed through
    // unchanged — the parser already understands Cartesia's native word shape.
    if (!parsed.model) parsed.model = input.model ?? context.provider.model ?? CARTESIA_STT_DEFAULT_MODEL;
    if (!parsed.language) parsed.language = input.language ?? 'en';
    const adaptedJson = JSON.stringify(parsed);
    return { rawJson: adaptedJson, originalJson, responseBytes: Buffer.byteLength(originalJson), durationSec: input.durationSec, providerStatus: response.status, timing: 'provider-json' };
  }
} satisfies HttpMediaProvider<SttCartesiaInput, SttCartesiaOutput>);
