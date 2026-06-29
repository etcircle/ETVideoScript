import { readFileSync, statSync } from 'node:fs';
import { ProviderExecutionError } from '../engine';
import { boundedResponseText } from '../httpBody';
import { registerProvider } from '../registry';
import type { HttpMediaProvider } from '../contract';

export const ELEVENLABS_SCRIBE_BASE = 'https://api.elevenlabs.io';
export const ELEVENLABS_SCRIBE_MODELS = ['scribe_v2', 'scribe_v1'] as const;
export const ELEVENLABS_SCRIBE_DEFAULT_MODEL = 'scribe_v2';
// Official ElevenLabs API pricing: $0.22/hour for Scribe v1/v2 (verified 2026-05-23,
// https://elevenlabs.io/pricing/api). provider.costPerUnit?.amount overrides as a
// per-minute rate (multiplied by durationSec/60 — not a flat per-call override).
export const ELEVENLABS_SCRIBE_USD_PER_MINUTE = 0.003667;
// Conservative cap. Scribe documents 3 GB max but we don't want to silently upload
// a giant file from a workspace; refuse at the boundary instead.
export const ELEVENLABS_SCRIBE_MAX_FILE_BYTES = 500 * 1024 * 1024;

export type SttElevenlabsScribeInput = {
  audioPath: string;
  audioRel: string;
  durationSec: number;
  baseUrl?: string;
  model?: string;
};

export type SttElevenlabsScribeOutput = {
  rawJson: string;
  originalJson: string;
  responseBytes: number;
  durationSec: number;
  providerStatus: number;
  timing: 'provider-json';
};

function minuteCost(durationSec: number, providerAmount?: number): number {
  const rate = providerAmount ?? ELEVENLABS_SCRIBE_USD_PER_MINUTE;
  return Number(((Math.max(durationSec, 0) / 60) * rate).toFixed(6));
}

const EVENT_TAG_RE = /\s*\[[^\]]+\]\s*/g;

export const sttElevenlabsScribeProvider = registerProvider({
  id: 'stt.elevenlabs',
  kind: 'stt',
  tier: 'paid',
  mode: 'http',
  displayName: 'ElevenLabs Scribe',
  availableModels: ELEVENLABS_SCRIBE_MODELS,
  capabilities: { polling: false, cancel: false, maxDurationSec: 60 * 60, outputFormats: ['application/json'] },
  estimateCost(input, provider) {
    return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: minuteCost(input.durationSec, provider.costPerUnit?.amount), actual: null };
  },
  actualCost(_output, input, provider) {
    const amount = minuteCost(input.durationSec, provider.costPerUnit?.amount);
    return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: amount, actual: amount };
  },
  ledgerInput(input) {
    return { audioRel: input.audioRel, durationSec: input.durationSec, baseUrl: input.baseUrl, model: input.model };
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
    if (!context.secret?.trim()) {
      throw new ProviderExecutionError('Configure an ElevenLabs API key (secretRef) before running Scribe.', { code: 'provider_auth_failed' });
    }
    const size = statSync(input.audioPath).size;
    if (size > ELEVENLABS_SCRIBE_MAX_FILE_BYTES) {
      throw new ProviderExecutionError(`Audio file ${input.audioRel} is ${(size / 1024 / 1024).toFixed(1)} MB; Scribe upload cap is ${ELEVENLABS_SCRIBE_MAX_FILE_BYTES / 1024 / 1024} MB. Split the clip or raise the cap.`, { code: 'provider_bad_request' });
    }
    const fileBuffer = readFileSync(input.audioPath);
    const url = `${(context.provider.baseUrl ?? ELEVENLABS_SCRIBE_BASE).replace(/\/+$/, '')}/v1/speech-to-text`;
    const form = new FormData();
    form.append('file', new Blob([fileBuffer as unknown as BlobPart], { type: 'audio/wav' }), 'audio.wav');
    form.append('model_id', input.model ?? context.provider.model ?? ELEVENLABS_SCRIBE_DEFAULT_MODEL);
    form.append('timestamps_granularity', 'word');
    form.append('tag_audio_events', 'false');
    form.append('diarize', 'false');
    const response = await context.guardedFetch(url, {
      tier: context.provider.tier,
      method: 'POST',
      headers: { 'xi-api-key': context.secret, Accept: 'application/json' },
      body: form,
      signal: context.signal,
      timeoutMs: 10 * 60 * 1000
    } as any);
    if (!response.ok) {
      throw new ProviderExecutionError(`ElevenLabs Scribe failed with HTTP ${response.status}: ${await boundedResponseText(response)}`, { providerStatus: response.status });
    }
    const originalJson = await response.text();
    if (!originalJson.trim()) {
      throw new ProviderExecutionError('ElevenLabs Scribe returned an empty response.', { providerStatus: response.status });
    }
    let parsed: any;
    try {
      parsed = JSON.parse(originalJson);
    } catch {
      throw new ProviderExecutionError(`ElevenLabs Scribe returned malformed JSON: ${originalJson.slice(0, 200)}`, { providerStatus: response.status });
    }
    // Filter non-word tokens and map logprob → probability so parseTimedWhisperResponse
    // (transcript.ts:101+ and :134) sees real per-word confidence rather than its 0.8 fallback.
    if (Array.isArray(parsed.words)) {
      parsed.words = parsed.words
        .filter((w: any) => w?.type === 'word')
        .map((w: any) => {
          const lp = Number(w.logprob);
          const probability = Number.isFinite(lp) ? Math.min(1, Math.max(0, Math.exp(lp))) : 0.8;
          return { text: w.text, start: w.start, end: w.end, probability };
        });
    }
    // Strip [audio_event] markers from top-level text too — filtering words[] alone leaves
    // `[laughter]` in the synthesized segment text the parser would otherwise propagate.
    if (typeof parsed.text === 'string') {
      parsed.text = parsed.text.replace(EVENT_TAG_RE, ' ').replace(/\s+/g, ' ').trim();
    }
    // Scribe doesn't return a `model` field; surface the request's model so the transcript's
    // provider.model reads `scribe_v2` instead of the parser's `configured-whisper` fallback.
    parsed.model = input.model ?? context.provider.model ?? ELEVENLABS_SCRIBE_DEFAULT_MODEL;
    // Scribe returns `language_code` (ISO-639-3, e.g. 'eng'); parser reads `language`
    // (ISO-639-1). Map common 3-letter codes; fall through unchanged if no mapping exists.
    if (typeof parsed.language_code === 'string' && !parsed.language) {
      const map: Record<string, string> = { eng: 'en', spa: 'es', fra: 'fr', deu: 'de', ita: 'it', por: 'pt', nld: 'nl', rus: 'ru', jpn: 'ja', kor: 'ko', zho: 'zh', cmn: 'zh', ara: 'ar', hin: 'hi', tur: 'tr', pol: 'pl', ukr: 'uk' };
      parsed.language = map[parsed.language_code] ?? parsed.language_code;
    }
    const adaptedJson = JSON.stringify(parsed);
    return {
      rawJson: adaptedJson,
      originalJson,
      responseBytes: Buffer.byteLength(originalJson),
      durationSec: input.durationSec,
      providerStatus: response.status,
      timing: 'provider-json'
    };
  }
} satisfies HttpMediaProvider<SttElevenlabsScribeInput, SttElevenlabsScribeOutput>);
