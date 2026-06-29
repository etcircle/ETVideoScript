import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ProviderExecutionError } from '../engine';
import { boundedResponseText } from '../httpBody';
import { registerProvider } from '../registry';
import type { HttpMediaProvider } from '../contract';
import type { SttHomelabWhisperOutput } from './homelabWhisper';

export const OPENAI_WHISPER_BASE = 'https://api.openai.com';
export const OPENAI_WHISPER_MODELS = ['whisper-1'] as const;
export const OPENAI_WHISPER_DEFAULT_MODEL = 'whisper-1';

export type SttOpenaiWhisperInput = {
  audioPath: string;
  audioRel: string;
  durationSec: number;
  model?: string;
  timeoutMs?: number;
};

function baseUrl(url?: string): string {
  return (url ?? OPENAI_WHISPER_BASE).replace(/\/+$/, '');
}

function sttCost(input: SttOpenaiWhisperInput, providerAmount?: number): number {
  if (providerAmount !== undefined) return Number(providerAmount.toFixed(6));
  return Number(((Math.max(input.durationSec, 0) / 60) * 0.006).toFixed(6));
}

function multipartBody(input: SttOpenaiWhisperInput): { body: Buffer; contentType: string } {
  const boundary = `----etvs-openai-whisper-${randomUUID()}`;
  const field = (name: string, value: string) => Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`);
  const audio = readFileSync(input.audioPath);
  const chunks = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    audio,
    field('model', input.model ?? OPENAI_WHISPER_DEFAULT_MODEL),
    field('response_format', 'verbose_json'),
    field('timestamp_granularities[]', 'word'),
    field('temperature', '0.0'),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ];
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export const sttOpenaiWhisperProvider = registerProvider({
  id: 'stt.openai-whisper',
  kind: 'stt',
  tier: 'paid',
  mode: 'http',
  displayName: 'OpenAI Whisper',
  availableModels: OPENAI_WHISPER_MODELS,
  estimateCost(input, provider) {
    return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: sttCost(input, provider.costPerUnit?.amount), actual: null };
  },
  actualCost(_output, input, provider) {
    const amount = sttCost(input, provider.costPerUnit?.amount);
    return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: amount, actual: amount };
  },
  ledgerInput(input) {
    return { audioRel: input.audioRel, durationSec: input.durationSec, model: input.model ?? OPENAI_WHISPER_DEFAULT_MODEL };
  },
  ledgerOutput(output) {
    try {
      const parsed = JSON.parse(output.rawJson);
      const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
      const wordCount = segments.reduce((sum: number, segment: any) => sum + (Array.isArray(segment?.words) ? segment.words.length : 0), 0);
      return { wordCount, segmentCount: segments.length, durationSec: output.durationSec, timing: wordCount > 0 ? 'exact' : 'none', responseBytes: output.responseBytes, providerStatus: output.providerStatus };
    } catch {
      return { wordCount: 0, segmentCount: 0, durationSec: output.durationSec, timing: 'unparseable', responseBytes: output.responseBytes, providerStatus: output.providerStatus };
    }
  },
  async run(input, context) {
    if (!context.secret?.trim()) throw new ProviderExecutionError('Configure a secretRef/API key for OpenAI Whisper before running this provider.', { code: 'provider_auth_failed' });
    const { body, contentType } = multipartBody(input);
    // Provider registry baseUrl is the only source of truth — refuse to let a per-call input
    // override the Bearer-token destination (codex review P2: prevents agents from redirecting
    // a paid auth header to a hostile host via the in-process input shape).
    const response = await context.guardedFetch(`${baseUrl(context.provider.baseUrl)}/v1/audio/transcriptions`, {
      tier: context.provider.tier,
      method: 'POST',
      headers: { authorization: `Bearer ${context.secret}`, 'content-type': contentType },
      body,
      signal: context.signal,
      timeoutMs: input.timeoutMs ?? 10 * 60 * 1000
    } as any);
    if (!response.ok) throw new ProviderExecutionError(`OpenAI Whisper failed with HTTP ${response.status}: ${await boundedResponseText(response)}`, { providerStatus: response.status });
    const rawJson = await response.text();
    if (!rawJson.trim()) throw new ProviderExecutionError('OpenAI Whisper returned an empty transcript.', { providerStatus: response.status });
    return { rawJson, responseBytes: Buffer.byteLength(rawJson), durationSec: input.durationSec, providerStatus: response.status, timing: 'provider-json' };
  }
} satisfies HttpMediaProvider<SttOpenaiWhisperInput, SttHomelabWhisperOutput>);
