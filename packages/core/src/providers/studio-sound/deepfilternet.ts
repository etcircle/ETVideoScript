import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerProvider } from '../registry';
import { ProviderExecutionError } from '../engine';
import { boundedResponseText } from '../httpBody';
import { transcodeToWav48k } from './shared';
import type { HttpMediaProvider } from '../contract';
import type { StudioSoundInput, StudioSoundOutput } from './ffmpegLocal';

// Minimum byte count for a plausible denoised-audio payload from the DeepFilterNet server.
// Mirrors MIN_ISOLATION_BYTES in shared.ts (HTTP 200 ≠ usable artifact) — kept as a local
// constant rather than exported from shared.ts since it's specific to this adapter's floor.
const MIN_DENOISE_BYTES = 1000;

function multipartBody(inputPath: string): { body: Buffer; contentType: string } {
  const boundary = `----etvs-deepfilternet-${randomUUID()}`;
  const audio = readFileSync(inputPath);
  const chunks = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    audio,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ];
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export type StudioSoundDeepFilterNetInput = StudioSoundInput & {
  baseUrl?: string;
  basicAuth?: string;
  timeoutMs?: number;
};

export const studioSoundDeepFilterNetProvider = registerProvider({
  id: 'studio-sound.deepfilternet',
  kind: 'studio-sound',
  tier: 'local',
  mode: 'http',
  displayName: 'DeepFilterNet',
  estimateCost: () => ({ currency: 'USD', estimated: 0, actual: 0 }),
  actualCost: () => ({ currency: 'USD', estimated: 0, actual: 0 }),
  ledgerOutput(output) {
    return { audio: { type: 'Buffer', bytes: output.audio.byteLength }, mimeType: output.mimeType, providerStatus: output.providerStatus };
  },
  async run(input, context) {
    const url = context.provider.baseUrl ?? input.baseUrl ?? 'http://127.0.0.1:8792/v1/enhance';
    const { body, contentType } = multipartBody(input.inputPath);
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
      throw new ProviderExecutionError(`DeepFilterNet failed with HTTP ${response.status}: ${errorBody}`, { providerStatus: response.status });
    }
    let bytes: Buffer<ArrayBufferLike> = Buffer.from(await response.arrayBuffer());

    // Degraded-payload defense: HTTP 200 ≠ usable artifact (same pattern as the paid
    // studio-sound adapters in shared.ts). Runs without ffprobe so it works in test envs.
    if (bytes.byteLength < MIN_DENOISE_BYTES) {
      throw new ProviderExecutionError(`DeepFilterNet returned implausibly small response (${bytes.byteLength} bytes). The artifact was rejected.`, { providerStatus: response.status });
    }

    bytes = transcodeToWav48k(bytes);
    return { audio: bytes, mimeType: 'audio/wav', providerStatus: response.status };
  }
} satisfies HttpMediaProvider<StudioSoundDeepFilterNetInput, StudioSoundOutput>);
