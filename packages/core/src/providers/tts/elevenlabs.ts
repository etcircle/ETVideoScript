import { guardedFetch } from '../../network/guardedFetch';
import { ProviderExecutionError } from '../engine';
import { boundedResponseText } from '../httpBody';
import { registerProvider } from '../registry';
import type { HttpMediaProvider } from '../contract';
import type { TtsInput, TtsOutput } from './mock';

export const ELEVENLABS_TTS_BASE = 'https://api.elevenlabs.io';
export const ELEVENLABS_TTS_MODELS = ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5'] as const;
export const ELEVENLABS_TTS_DEFAULT_MODEL = 'eleven_multilingual_v2';

// ElevenLabs API-direct pricing per https://elevenlabs.io/pricing/api/ (verified 2026-05-20):
// Multilingual v2/v3 → $0.10 / 1K chars; Flash/Turbo → $0.05 / 1K chars.
// provider.costPerUnit on the provider record still overrides as a flat per-call amount.
const ELEVENLABS_TTS_USD_PER_CHAR_BY_MODEL: Record<string, number> = {
  eleven_multilingual_v2: 0.0001,
  eleven_turbo_v2_5: 0.00005,
  eleven_flash_v2_5: 0.00005
};

function baseUrl(url?: string): string {
  return (url ?? ELEVENLABS_TTS_BASE).replace(/\/+$/, '');
}

function textCost(text: string, model: string | undefined, providerAmount?: number): number {
  if (providerAmount !== undefined) return Number(providerAmount.toFixed(6));
  const rate = ELEVENLABS_TTS_USD_PER_CHAR_BY_MODEL[model ?? ELEVENLABS_TTS_DEFAULT_MODEL] ?? ELEVENLABS_TTS_USD_PER_CHAR_BY_MODEL[ELEVENLABS_TTS_DEFAULT_MODEL]!;
  return Number((Math.max(text.length, 1) * rate).toFixed(6));
}

function pcmToWav(pcm: Buffer): Buffer {
  const sampleRate = 24000;
  const channels = 1;
  const bytesPerSample = 2;
  const buffer = Buffer.alloc(44 + pcm.byteLength);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + pcm.byteLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(pcm.byteLength, 40);
  pcm.copy(buffer, 44);
  return buffer;
}

export const ttsElevenlabsProvider: HttpMediaProvider<TtsInput, TtsOutput> = registerProvider({
  id: 'tts.elevenlabs',
  kind: 'tts',
  tier: 'paid',
  mode: 'http',
  displayName: 'ElevenLabs TTS',
  availableModels: ELEVENLABS_TTS_MODELS,
  capabilities: { polling: false, cancel: false, maxDurationSec: 600, outputFormats: ['audio/wav'] },
  estimateCost(input, provider) {
    const amount = textCost(input.text, input.model, provider.costPerUnit?.amount);
    return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: amount, actual: null };
  },
  actualCost(_output, input, provider) {
    const amount = textCost(input.text, input.model, provider.costPerUnit?.amount);
    return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: amount, actual: amount };
  },
  async run(input, context) {
    if (!context.secret) throw new ProviderExecutionError('Configure a secretRef/API key for ElevenLabs TTS before running this provider.', { code: 'provider_auth_failed' });
    const endpoint = `${baseUrl(context.provider.baseUrl)}/v1/text-to-speech/${encodeURIComponent(input.voice)}?output_format=pcm_24000`;
    const response = await context.guardedFetch(endpoint, {
      tier: context.provider.tier,
      method: 'POST',
      headers: { 'xi-api-key': context.secret, 'Content-Type': 'application/json', Accept: 'audio/basic' },
      body: JSON.stringify({
        text: input.text,
        model_id: input.model ?? ELEVENLABS_TTS_DEFAULT_MODEL,
        ...(input.language ? { language_code: input.language } : {}),
        ...(input.previousText ? { previous_text: input.previousText } : {}),
        ...(input.nextText ? { next_text: input.nextText } : {}),
        voice_settings: { stability: 0.50, similarity_boost: 0.80, style: 0, use_speaker_boost: false }
      }),
      signal: context.signal,
      timeoutMs: 60000
    });
    if (!response.ok) throw new ProviderExecutionError(`ElevenLabs TTS failed with HTTP ${response.status}: ${await boundedResponseText(response)}`, { providerStatus: response.status });
    return { audio: pcmToWav(Buffer.from(await response.arrayBuffer())), mimeType: 'audio/wav', providerStatus: response.status };
  }
});

export interface VoiceCloneSample { audio: Buffer; fileName: string; mimeType: string; }

export async function cloneElevenLabsVoice(input: {
  name: string;
  description?: string;
  samples: VoiceCloneSample[];
  secret: string;
  baseUrl?: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<{ voiceId: string }> {
  if (!input.secret) throw new ProviderExecutionError('Configure a secretRef/API key for ElevenLabs TTS before cloning a voice.', { code: 'provider_auth_failed' });
  if (input.samples.length === 0) throw new ProviderExecutionError('At least one voice sample is required.', { code: 'provider_auth_failed' });
  if (input.samples.length > 25) throw new ProviderExecutionError('ElevenLabs IVC accepts at most 25 samples per clone request.', { code: 'provider_auth_failed' });
  const form = new FormData();
  form.append('name', input.name);
  if (input.description !== undefined) form.append('description', input.description);
  for (const s of input.samples) {
    form.append('files', new Blob([s.audio as unknown as BlobPart], { type: s.mimeType }), s.fileName);
  }
  const response = await guardedFetch(`${baseUrl(input.baseUrl)}/v1/voices/add`, {
    tier: 'paid',
    method: 'POST',
    headers: { 'xi-api-key': input.secret, Accept: 'application/json' },
    body: form,
    signal: input.signal,
    timeoutMs: input.timeoutMs ?? 5 * 60 * 1000
  });
  if (!response.ok) throw new ProviderExecutionError(`ElevenLabs voice clone failed with HTTP ${response.status}: ${await boundedResponseText(response)}`, { providerStatus: response.status });
  // ElevenLabs occasionally fronts errors as 200 with an HTML interstitial (CDN, maintenance). Parse defensively
  // so callers (Lane E's API route) get a ProviderExecutionError, not a raw SyntaxError out of response.json().
  const body = await boundedResponseText(response);
  let json: { voice_id?: string; requires_verification?: boolean };
  try { json = JSON.parse(body); }
  catch { throw new ProviderExecutionError(`ElevenLabs voice clone returned malformed JSON: ${body.slice(0, 200)}`, { providerStatus: response.status }); }
  if (!json.voice_id) throw new ProviderExecutionError('ElevenLabs voice clone response is missing voice_id', { providerStatus: response.status });
  return { voiceId: json.voice_id };
}

export async function speechToSpeechElevenlabs(input: {
  audio: Buffer;
  voiceId: string;
  model?: string;
  secret: string;
  baseUrl?: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<{ audio: Buffer; mimeType: 'audio/wav' }> {
  if (!input.secret) throw new ProviderExecutionError('Configure a secretRef/API key for ElevenLabs TTS before using speech-to-speech.', { code: 'provider_auth_failed' });
  const form = new FormData();
  form.append('audio', new Blob([input.audio as unknown as BlobPart], { type: 'audio/webm' }), 'recording.webm');
  if (input.model) form.append('model_id', input.model);
  form.append('remove_background_noise', 'false');
  const response = await guardedFetch(`${baseUrl(input.baseUrl)}/v1/speech-to-speech/${encodeURIComponent(input.voiceId)}?output_format=pcm_24000`, {
    tier: 'paid',
    method: 'POST',
    headers: { 'xi-api-key': input.secret, Accept: 'audio/basic' },
    body: form,
    signal: input.signal,
    timeoutMs: input.timeoutMs ?? 2 * 60 * 1000
  });
  if (!response.ok) throw new ProviderExecutionError(`ElevenLabs speech-to-speech failed with HTTP ${response.status}: ${await boundedResponseText(response)}`, { providerStatus: response.status });
  return { audio: pcmToWav(Buffer.from(await response.arrayBuffer())), mimeType: 'audio/wav' };
}
