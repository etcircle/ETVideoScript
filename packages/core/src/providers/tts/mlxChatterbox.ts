import { randomUUID } from 'node:crypto';
import { registerProvider } from '../registry';
import { ProviderExecutionError } from '../engine';
import { boundedResponseText } from '../httpBody';
import type { HttpMediaProvider } from '../contract';
import type { TtsOutput } from './mock';

export type TtsMlxChatterboxInput = {
  text: string;
  voice: string;
  language: string;
  baseUrl?: string;
  basicAuth?: string;
  timeoutMs?: number;
};

function multipartBody(input: TtsMlxChatterboxInput): { body: Buffer; contentType: string } {
  const boundary = `----etvs-chatterbox-${randomUUID()}`;
  const field = (name: string, value: string) => Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`);
  // Chatterbox (mlx-audio) server on :8791 — voice cloning from a reference clip dropped at
  // ~/models/voices/<voice>.wav on the Mac Mini. `voice` must match ^[a-z0-9][a-z0-9-]{0,63}$
  // and the server 404s if no matching reference clip exists; this adapter passes it through
  // untouched and lets ProviderExecutionError surface that 404 naturally.
  const chunks = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n${input.text}`),
    field('voice', input.voice),
    field('language', input.language),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ];
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export const ttsMlxChatterboxProvider = registerProvider({
  id: 'tts.mlx-chatterbox',
  kind: 'tts',
  tier: 'local',
  mode: 'http',
  displayName: 'MLX Chatterbox',
  estimateCost: () => ({ currency: 'USD', estimated: 0, actual: 0 }),
  actualCost: () => ({ currency: 'USD', estimated: 0, actual: 0 }),
  ledgerInput(input) {
    return { textLength: input.text.length, voice: input.voice, language: input.language, baseUrl: input.baseUrl, hasBasicAuth: Boolean(input.basicAuth) };
  },
  ledgerOutput(output) {
    return { audio: { type: 'Buffer', bytes: output.audio.byteLength }, mimeType: output.mimeType, providerStatus: output.providerStatus };
  },
  async run(input, context) {
    const url = context.provider.baseUrl ?? input.baseUrl ?? 'http://127.0.0.1:8791/v1/tts';
    const { body, contentType } = multipartBody(input);
    const headers: Record<string, string> = { 'content-type': contentType };
    if (input.basicAuth) headers.authorization = input.basicAuth;
    const response = await context.guardedFetch(url, {
      tier: 'local',
      method: 'POST',
      headers,
      body,
      signal: context.signal,
      timeoutMs: input.timeoutMs ?? 5 * 60 * 1000
    } as any);
    if (!response.ok) {
      const errorBody = await boundedResponseText(response);
      throw new ProviderExecutionError(`MLX Chatterbox failed with HTTP ${response.status}: ${errorBody}`, { providerStatus: response.status });
    }
    return { audio: Buffer.from(await response.arrayBuffer()), mimeType: 'audio/wav', providerStatus: response.status };
  }
} satisfies HttpMediaProvider<TtsMlxChatterboxInput, TtsOutput>);
