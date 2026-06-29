import { ProviderExecutionError } from '../engine';
import { boundedResponseText } from '../httpBody';
import { registerProvider } from '../registry';
import type { HttpMediaProvider } from '../contract';
import type { GeneratedMediaOutput, ImageGenInput } from '../generationTypes';
import { generatedMediaLedgerOutput } from '../generationTypes';

const XAI_IMAGE_ENDPOINT = 'https://api.x.ai/v1/images/generations';
// xAI's current image models per https://docs.x.ai/developers/models (verified 2026-05-20).
// grok-2-image / grok-2-image-1212 are no longer listed.
const XAI_IMAGE_MODEL = 'grok-imagine-image';
// Per-model published rates. provider.costPerUnit overrides this map entirely.
// Unknown model strings fall back to the standard rate so cost is still disclosed.
const XAI_IMAGE_USD_PER_IMAGE: Record<string, number> = {
  'grok-imagine-image': 0.02,
  'grok-imagine-image-quality': 0.05
};
const XAI_IMAGE_USD_PER_IMAGE_DEFAULT = XAI_IMAGE_USD_PER_IMAGE[XAI_IMAGE_MODEL]!;

function count(input: ImageGenInput): number {
  const value = Math.floor(input.count ?? 1);
  return Math.min(10, Math.max(1, value));
}

function pricePerImage(model: string | undefined): number {
  return XAI_IMAGE_USD_PER_IMAGE[model ?? XAI_IMAGE_MODEL] ?? XAI_IMAGE_USD_PER_IMAGE_DEFAULT;
}

export const imageGenXaiProvider: HttpMediaProvider<ImageGenInput, GeneratedMediaOutput> = registerProvider({
  id: 'image-gen.xai',
  kind: 'image-gen',
  tier: 'paid',
  mode: 'http',
  displayName: 'xAI Image Generation',
  availableModels: Object.keys(XAI_IMAGE_USD_PER_IMAGE),
  capabilities: { polling: false, cancel: false, outputFormats: ['image/jpeg'] },
  estimateCost(input, provider) {
    const amount = (provider.costPerUnit?.amount ?? pricePerImage(input.model)) * count(input);
    return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: Number(amount.toFixed(6)), actual: null };
  },
  actualCost(_output, input, provider) {
    const amount = (provider.costPerUnit?.amount ?? pricePerImage(input.model)) * count(input);
    return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: Number(amount.toFixed(6)), actual: Number(amount.toFixed(6)) };
  },
  ledgerInput(input) { return { ...input, prompt: input.prompt.slice(0, 500) }; },
  ledgerOutput: generatedMediaLedgerOutput,
  async run(input, context) {
    if (!context.secret) throw new ProviderExecutionError('Configure a secretRef/API key for xAI Image Generation before running this provider.', { code: 'provider_auth_failed' });
    const response = await context.guardedFetch(context.provider.baseUrl ?? XAI_IMAGE_ENDPOINT, {
      tier: context.provider.tier,
      method: 'POST',
      headers: { Authorization: `Bearer ${context.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: input.model ?? XAI_IMAGE_MODEL, prompt: input.prompt, n: count(input), response_format: 'b64_json' }),
      signal: context.signal,
      timeoutMs: 120000
    });
    if (!response.ok) throw new ProviderExecutionError(`xAI image generation failed with HTTP ${response.status}: ${await boundedResponseText(response)}`, { providerStatus: response.status });
    const json = await response.json() as { data?: Array<{ b64_json?: string }> };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new ProviderExecutionError('xAI image generation response did not include data[0].b64_json.', { providerStatus: response.status });
    return { media: Buffer.from(b64, 'base64'), mimeType: 'image/jpeg', providerStatus: response.status };
  }
});
