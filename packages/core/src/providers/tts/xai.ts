import { registerProvider } from '../registry';
import { ProviderExecutionError } from '../engine';
import type { HttpMediaProvider } from '../contract';
import type { TtsInput, TtsOutput } from './mock';

// xAI Grok TTS: $15.00 per 1,000,000 characters (per https://docs.x.ai/developers/models, verified 2026-05-20).
// provider.costPerUnit on the provider record overrides this default; cost flows through ProviderRunEnvelope/ledger.
const XAI_TTS_USD_PER_CHAR = 0.000015;

function textCost(text: string): number {
  return Number((Math.max(text.length, 1) * XAI_TTS_USD_PER_CHAR).toFixed(6));
}

export const ttsXaiProvider: HttpMediaProvider<TtsInput, TtsOutput> = registerProvider({
  id: 'tts.xai',
  kind: 'tts',
  tier: 'paid',
  mode: 'http',
  displayName: 'xAI TTS',
  capabilities: { polling: false, cancel: false, maxDurationSec: 600, outputFormats: ['audio/wav'] },
  estimateCost(input, provider) {
    const amount = provider.costPerUnit?.amount ?? textCost(input.text);
    return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: amount, actual: null };
  },
  actualCost(_output, input, provider) {
    const amount = provider.costPerUnit?.amount ?? textCost(input.text);
    return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: amount, actual: amount };
  },
  async run(input, context) {
    const secret = context.secret;
    if (!secret) throw new ProviderExecutionError('Configure a secretRef/API key for xAI TTS before running this provider.', { code: 'provider_auth_failed' });
    const endpoint = context.provider.baseUrl ?? 'https://api.x.ai/v1/tts';
    const response = await context.guardedFetch(endpoint, {
      tier: context.provider.tier,
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: input.text,
        voice_id: input.voice,
        language: input.language,
        output_format: { codec: 'wav', sample_rate: 24000 }
      }),
      signal: context.signal,
      timeoutMs: 60000
    });
    if (!response.ok) throw new ProviderExecutionError(`xAI TTS failed: ${response.status} ${await response.text()}`, { providerStatus: response.status });
    return { audio: Buffer.from(await response.arrayBuffer()), mimeType: 'audio/wav', providerStatus: response.status };
  }
});
