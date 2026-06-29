import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ProviderExecutionError } from '../engine';
import { boundedResponseText } from '../httpBody';
import type { HttpMediaProvider, HttpProviderRunContext, ProviderCost } from '../contract';
import type { StudioSoundInput, StudioSoundOutput } from './ffmpegLocal';

export function mockWav(): Buffer {
  return Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x40\x1f\x00\x00\x80\x3e\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00', 'binary');
}

export function estimateStudioSoundCost(provider: 'adobe-enhance' | 'elevenlabs-isolation', durationSec: number): ProviderCost {
  const minutes = Math.max(durationSec, 0) / 60;
  const perMinute = provider === 'adobe-enhance' ? 0.08 : 0.10;
  const estimated = Number((minutes * perMinute).toFixed(4));
  return { currency: 'USD', estimated, actual: estimated };
}

/**
 * Probe the duration of an audio buffer in seconds. Returns 0 if ffprobe is
 * unavailable or the buffer is too small to decode. Used for degraded-payload
 * defense (HTTP 200 ≠ usable artifact).
 *
 * The buffer is written to a temp file under `tempDir` so ffprobe can read it;
 * callers pass the provider's `context.tempDir` which is already cleaned up
 * after `run()` returns.
 *
 * NOTE: exported for testing. The provider's run() uses the size-based floor
 * (below) as its primary gate because ffprobe is not always available in test
 * environments and mock responses are intentionally undersized.
 */
export function probeAudioBufferDurationSec(bytes: Buffer, tempDir?: string): number {
  const probeFile = join(tempDir ?? tmpdir(), `_probe_${Date.now()}.bin`);
  try {
    writeFileSync(probeFile, bytes);
    const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', probeFile], { encoding: 'utf8' });
    const duration = Number((result.stdout ?? '').trim());
    return Number.isFinite(duration) && duration >= 0 ? duration : 0;
  } catch {
    return 0;
  }
}

/**
 * Transcode any audio to 48 kHz mono pcm_s16le WAV. Used when the EL
 * Voice Isolator returns an mp3 (or any non-WAV) response — we always store
 * WAV on disk so the rest of the pipeline can open it without needing a
 * decoder. Returns the input bytes unchanged when they are already a WAV
 * (magic bytes "RIFF…WAVE").
 */
export function transcodeToWav48k(bytes: Buffer<ArrayBufferLike>, tempDir?: string): Buffer<ArrayBufferLike> {
  // Fast-path: already a RIFF/WAV container — trust the EL Isolator wrote
  // a well-formed WAV (it typically does when it returns audio/wav).
  if (bytes.byteLength >= 12 && bytes.subarray(0, 4).toString('binary') === 'RIFF' && bytes.subarray(8, 12).toString('binary') === 'WAVE') {
    return bytes;
  }
  const dir = tempDir ?? tmpdir();
  const inFile = join(dir, `_transcode_in_${Date.now()}.bin`);
  const outFile = join(dir, `_transcode_out_${Date.now()}.wav`);
  writeFileSync(inFile, bytes);
  const result = spawnSync('ffmpeg', ['-y', '-i', inFile, '-ar', '48000', '-ac', '1', '-acodec', 'pcm_s16le', outFile], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new ProviderExecutionError(`Transcode to WAV failed (ffmpeg exit ${result.status ?? 'null'}): ${(result.stderr ?? '').slice(0, 400)}`);
  }
  return readFileSync(outFile);
}

// Minimum byte count for a plausible audio payload from the EL Voice Isolator.
// 100ms of 48kHz mono 16-bit PCM = 9600 bytes; WAV header adds 44 bytes.
// Anything below ~1000 bytes is clearly a stub or empty error response.
// This is the primary gate in the provider's run() because ffprobe is not
// always available in CI / test environments. The route-level defense
// (studioCleanupRoutes.ts) applies a proper duration floor on the saved file.
const MIN_ISOLATION_BYTES = 1000;

export function paidStudioSoundProvider(input: { id: 'studio-sound.adobe-enhance' | 'studio-sound.elevenlabs-isolation'; displayName: string; endpoint: string; name: 'adobe-enhance' | 'elevenlabs-isolation' }): HttpMediaProvider<StudioSoundInput, StudioSoundOutput> {
  return {
    id: input.id,
    kind: 'studio-sound',
    tier: 'paid',
    mode: 'http',
    displayName: input.displayName,
    estimateCost(runInput) { return estimateStudioSoundCost(input.name, runInput.durationSec); },
    actualCost(_output, runInput) { return estimateStudioSoundCost(input.name, runInput.durationSec); },
    ledgerOutput(output) { return { audio: { type: 'Buffer', bytes: output.audio.byteLength }, mimeType: output.mimeType, providerStatus: output.providerStatus }; },
    async run(runInput, context: HttpProviderRunContext) {
      if (runInput.envTestMode) return { audio: mockWav(), mimeType: 'audio/wav', providerStatus: 200 };
      const credential = context.secret ?? runInput.credential;
      if (!credential) throw new ProviderExecutionError(`Configure credentials first for ${input.displayName}`, { code: 'provider_auth_failed' });

      // ElevenLabs /v1/audio-isolation requires multipart/form-data with an
      // `audio` field and `xi-api-key` header. The old implementation sent
      // application/octet-stream + Bearer — that format is wrong for this
      // endpoint (every other EL adapter in this repo uses xi-api-key).
      //
      // Adobe Enhance uses its own auth scheme; for now we keep the same
      // multipart shape and rely on the credential being a Bearer token for
      // Adobe. The conditional below isolates EL-specific auth.
      let fetchBody: BodyInit;
      let fetchHeaders: Record<string, string>;

      if (input.name === 'elevenlabs-isolation') {
        const form = new FormData();
        form.append('audio', new Blob([readFileSync(runInput.inputPath) as unknown as BlobPart], { type: 'audio/wav' }), 'source.wav');
        fetchBody = form;
        // FormData sets its own Content-Type with boundary; do NOT set it manually.
        fetchHeaders = { 'xi-api-key': credential };
      } else {
        // Adobe Enhance and any future providers: keep the octet-stream approach
        // until their real shape is confirmed.
        fetchBody = readFileSync(runInput.inputPath);
        fetchHeaders = { authorization: `Bearer ${credential}`, 'content-type': 'application/octet-stream' };
      }

      const response = await context.guardedFetch(context.provider.baseUrl ?? input.endpoint, {
        tier: 'paid',
        method: 'POST',
        headers: fetchHeaders,
        body: fetchBody,
        signal: context.signal,
        timeoutMs: 10 * 60 * 1000
      } as any);
      if (!response.ok) {
        const errorBody = await boundedResponseText(response);
        throw new ProviderExecutionError(`${input.displayName} failed with HTTP ${response.status}: ${errorBody}`, { providerStatus: response.status });
      }

      let bytes: Buffer<ArrayBufferLike> = Buffer.from(await response.arrayBuffer());

      // Degraded-payload defense: HTTP 200 ≠ usable artifact.
      // Primary gate: byte-count floor. A response below ~1000 bytes cannot
      // contain even 100ms of compressed audio for a whole-recording isolation.
      // This runs without ffprobe so it works in test environments.
      if (bytes.byteLength < MIN_ISOLATION_BYTES) {
        throw new ProviderExecutionError(`${input.displayName} returned implausibly small response (${bytes.byteLength} bytes). The artifact was rejected.`, { providerStatus: response.status });
      }

      // EL returns the isolated audio. Transcode to WAV if the response is mp3
      // (EL /v1/audio-isolation can return audio/mpeg; the endpoint doesn't
      // always honor Accept: audio/wav). transcodeToWav48k fast-paths for RIFF.
      bytes = transcodeToWav48k(bytes);

      return { audio: bytes, mimeType: 'audio/wav', providerStatus: response.status };
    }
  };
}
