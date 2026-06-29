import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerProvider } from '../registry';
import { ProviderExecutionError } from '../engine';
import { boundedResponseText } from '../httpBody';
import type { HttpMediaProvider } from '../contract';

export type SttHomelabWhisperInput = {
  audioPath: string;
  audioRel: string;
  durationSec: number;
  baseUrl?: string;
  basicAuth?: string;
  timeoutMs?: number;
};

export type SttHomelabWhisperOutput = {
  rawJson: string;
  responseBytes: number;
  durationSec: number;
  providerStatus: number;
  timing: 'provider-json';
};

function multipartBody(input: SttHomelabWhisperInput): { body: Buffer; contentType: string } {
  const boundary = `----etvs-whisper-${randomUUID()}`;
  const field = (name: string, value: string) => Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`);
  const audio = readFileSync(input.audioPath);
  // OpenAI-compatible multipart shape — targets the a self-hosted WhisperX server on :8789
  // (transformers Whisper-large-v3-turbo + wav2vec2 forced alignment, ~30ms word-boundary
  // accuracy on EN). The legacy whisper.cpp /inference on :8788 had ~1–3s drift on leading
  // silence and a process-global VAD state bleed; both fixed by switching engines, not by
  // mutating the user's audio. response_format=verbose_json + timestamp_granularities[]=word
  // are required so parseTimedWhisperResponse can extract segments[].words[]; without word
  // timings, the parser returns null and the env flags ETVS_ALLOW_APPROXIMATE_TRANSCRIPT /
  // ETVIDEO_ALLOW_APPROXIMATE_TRANSCRIPT / ALLOW_APPROXIMATE_TRANSCRIPT trigger an
  // evenly-spaced fallback that visibly drifts against playback for long segments.
  const chunks = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    audio,
    field('model', 'whisper-1'),
    field('language', 'en'),
    field('response_format', 'verbose_json'),
    field('timestamp_granularities[]', 'word'),
    field('temperature', '0.0'),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ];
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export const sttHomelabWhisperProvider = registerProvider({
  id: 'stt.homelab-whisper',
  kind: 'stt',
  tier: 'local',
  mode: 'http',
  displayName: 'Homelab Whisper',
  estimateCost: () => ({ currency: 'USD', estimated: 0, actual: 0 }),
  actualCost: () => ({ currency: 'USD', estimated: 0, actual: 0 }),
  ledgerInput(input) {
    return {
      audioRel: input.audioRel,
      durationSec: input.durationSec,
      baseUrl: input.baseUrl,
      hasBasicAuth: Boolean(input.basicAuth)
    };
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
    const url = context.provider.baseUrl ?? input.baseUrl ?? 'http://127.0.0.1:8789/v1/audio/transcriptions';
    const { body, contentType } = multipartBody(input);
    const headers: Record<string, string> = { 'content-type': contentType };
    if (input.basicAuth) headers.authorization = input.basicAuth;
    const response = await context.guardedFetch(url, {
      tier: 'local',
      method: 'POST',
      headers,
      body,
      signal: context.signal,
      timeoutMs: input.timeoutMs ?? 10 * 60 * 1000
    } as any);
    if (!response.ok) {
      const errorBody = await boundedResponseText(response);
      throw new ProviderExecutionError(`Homelab Whisper failed with HTTP ${response.status}: ${errorBody}`, { providerStatus: response.status });
    }
    const rawJson = await response.text();
    if (!rawJson.trim()) throw new ProviderExecutionError('Homelab Whisper returned an empty transcript.', { providerStatus: response.status });
    return { rawJson, responseBytes: Buffer.byteLength(rawJson), durationSec: input.durationSec, providerStatus: response.status, timing: 'provider-json' };
  }
} satisfies HttpMediaProvider<SttHomelabWhisperInput, SttHomelabWhisperOutput>);
