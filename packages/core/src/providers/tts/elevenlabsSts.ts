import { registerProvider } from '../registry';
import { speechToSpeechElevenlabs, type ElevenLabsVoiceSettings } from './elevenlabs';
import type { HttpMediaProvider } from '../contract';

// ── tts.elevenlabs-sts (S1b D7) ─────────────────────────────────────────────────
// ElevenLabs speech-to-speech as its own provider record, so the STS half of the clone chain is
// accounted INDEPENDENTLY of the TTS half: separate provider id ⇒ separate spend cap, separate
// ledger rows, separate structured errors. Both steps of one patch therefore show up as two
// honest paid calls rather than one blended row.
//
// It is a 'tts'-kind adapter because that is what it produces (speech); the distinct id is what
// carries the accounting separation.

export interface StsInput {
  audio: Buffer;
  voiceId: string;
  model?: string;
  voiceSettings?: ElevenLabsVoiceSettings;
  sourceMimeType?: string;
  sourceFileName?: string;
  /**
   * Duration of the source audio. EL bills speech-to-speech by SOURCE LENGTH, so this is the
   * real billing unit — without it the estimate is null and a configured spend cap has nothing
   * to count (the engine then fails the call closed rather than billing past the ceiling).
   */
  sourceDurationSec?: number;
}

export interface StsOutput {
  audio: Buffer;
  mimeType: 'audio/wav';
  providerStatus?: number;
}

export const ELEVENLABS_STS_DEFAULT_MODEL = 'eleven_multilingual_sts_v2';

/**
 * ElevenLabs bills speech-to-speech at ~1000 credits per minute of SOURCE audio, which at the
 * multilingual API-direct rate ($0.10 / 1K credits, verified 2026-05-20 alongside the TTS
 * table) is $0.10 per minute. Estimating in that unit — rather than reporting null — is what
 * lets a configured spend cap actually bound these calls.
 *
 * `provider.costPerUnit.amount` still overrides as a flat per-call amount. When neither a
 * source duration nor an override is available the estimate is null and the engine fails the
 * call closed if a cap exists, instead of counting an unknown cost as zero.
 */
const ELEVENLABS_STS_USD_PER_MINUTE = 0.10;

function stsCost(input: Pick<StsInput, 'sourceDurationSec'>, provider: { costPerUnit?: { currency?: string; amount: number } }) {
  const currency = provider.costPerUnit?.currency ?? 'USD';
  if (provider.costPerUnit?.amount !== undefined) return { currency, estimated: Number(provider.costPerUnit.amount.toFixed(6)), actual: null };
  const seconds = input.sourceDurationSec;
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return { currency, estimated: null, actual: null };
  return { currency, estimated: Number(((seconds / 60) * ELEVENLABS_STS_USD_PER_MINUTE).toFixed(6)), actual: null };
}

export const stsElevenlabsProvider: HttpMediaProvider<StsInput, StsOutput> = registerProvider({
  id: 'tts.elevenlabs-sts',
  kind: 'tts',
  tier: 'paid',
  mode: 'http',
  displayName: 'ElevenLabs Speech-to-Speech',
  availableModels: [ELEVENLABS_STS_DEFAULT_MODEL] as const,
  capabilities: { polling: false, cancel: false, outputFormats: ['audio/wav'] },
  estimateCost(input, provider) { return stsCost(input, provider); },
  actualCost(_output, input, provider) {
    const cost = stsCost(input, provider);
    return { ...cost, actual: cost.estimated };
  },
  // Never let the source audio bytes into the append-only ledger.
  ledgerInput(input) {
    return { voiceId: input.voiceId, model: input.model, sourceBytes: input.audio.byteLength, sourceDurationSec: input.sourceDurationSec, voiceSettings: input.voiceSettings };
  },
  ledgerOutput(output) {
    return { mimeType: output.mimeType, bytes: output.audio.byteLength, providerStatus: output.providerStatus };
  },
  async run(input, context) {
    const result = await speechToSpeechElevenlabs({
      audio: input.audio,
      voiceId: input.voiceId,
      model: input.model ?? ELEVENLABS_STS_DEFAULT_MODEL,
      secret: context.secret ?? '',
      ...(context.provider.baseUrl ? { baseUrl: context.provider.baseUrl } : {}),
      signal: context.signal,
      ...(input.voiceSettings ? { voiceSettings: input.voiceSettings } : {}),
      ...(input.sourceMimeType ? { sourceMimeType: input.sourceMimeType } : {}),
      ...(input.sourceFileName ? { sourceFileName: input.sourceFileName } : {}),
      fetchImpl: context.guardedFetch
    });
    return { audio: result.audio, mimeType: result.mimeType };
  }
});
