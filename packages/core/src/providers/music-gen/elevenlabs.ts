import { ProviderExecutionError } from '../engine';
import { boundedResponseText } from '../httpBody';
import { registerProvider } from '../registry';
import type { HttpMediaProvider } from '../contract';
import type { GeneratedMediaOutput, MusicGenInput } from '../generationTypes';
import { generatedMediaLedgerOutput } from '../generationTypes';

const ELEVENLABS_MUSIC_ENDPOINT = 'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128';
const ELEVENLABS_MUSIC_MODEL = 'music_v1';

function clampDurationMs(input: MusicGenInput): number {
  return Math.min(600000, Math.max(3000, Math.round(input.durationMs ?? 30000)));
}

function placeholderCost(input: MusicGenInput, providerAmount?: number): number {
  // Placeholder until ElevenLabs publishes a stable music-generation unit price; provider.costPerUnit overrides it.
  return Number((providerAmount ?? ((clampDurationMs(input) / 1000) * 0.002)).toFixed(6));
}

export const musicGenElevenlabsProvider: HttpMediaProvider<MusicGenInput, GeneratedMediaOutput> = registerProvider({
  id: 'music-gen.elevenlabs',
  kind: 'music-gen',
  tier: 'paid',
  mode: 'http',
  displayName: 'ElevenLabs Music Generation',
  availableModels: [ELEVENLABS_MUSIC_MODEL],
  capabilities: { polling: false, cancel: false, maxDurationSec: 600, outputFormats: ['audio/mpeg'] },
  estimateCost(input, provider) { return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: placeholderCost(input, provider.costPerUnit?.amount), actual: null }; },
  actualCost(_output, input, provider) { const amount = placeholderCost(input, provider.costPerUnit?.amount); return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: amount, actual: amount }; },
  ledgerInput(input) { return { ...input, prompt: input.prompt.slice(0, 500) }; },
  ledgerOutput: generatedMediaLedgerOutput,
  async run(input, context) {
    if (!context.secret) throw new ProviderExecutionError('Configure a secretRef/API key for ElevenLabs Music before running this provider.', { code: 'provider_auth_failed' });
    const response = await context.guardedFetch(context.provider.baseUrl ?? ELEVENLABS_MUSIC_ENDPOINT, {
      tier: context.provider.tier,
      method: 'POST',
      headers: { 'xi-api-key': context.secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: input.prompt, music_length_ms: clampDurationMs(input), model_id: input.model ?? ELEVENLABS_MUSIC_MODEL }),
      signal: context.signal,
      timeoutMs: 180000
    });
    if (!response.ok) throw new ProviderExecutionError(`ElevenLabs music generation failed with HTTP ${response.status}: ${await boundedResponseText(response)}`, { providerStatus: response.status });
    return { media: Buffer.from(await response.arrayBuffer()), mimeType: 'audio/mpeg', providerStatus: response.status };
  }
});
