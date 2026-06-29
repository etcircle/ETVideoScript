import { ProviderExecutionError } from '../engine';
import { boundedResponseText } from '../httpBody';
import { registerProvider } from '../registry';
import type { HttpMediaProvider } from '../contract';
import type { GeneratedMediaOutput, VideoGenInput } from '../generationTypes';
import { generatedMediaLedgerOutput } from '../generationTypes';

const XAI_VIDEO_START_ENDPOINT = 'https://api.x.ai/v1/videos/generations';
const XAI_VIDEO_POLL_BASE = 'https://api.x.ai/v1/videos';
const XAI_VIDEO_MODEL = 'grok-imagine-video';
const POLL_MS = 5000;

const ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);
const RESOLUTIONS = new Set(['720p', '480p']);

function clampDuration(value: number | undefined): number | undefined {
  if (value == null) return undefined;
  return Math.min(15, Math.max(1, Math.round(value)));
}

// xAI Grok Imagine video: $0.050 per second of output, flat across 480p/720p
// (per https://docs.x.ai/developers/models and docs/models/grok-imagine-video, verified 2026-05-20).
// provider.costPerUnit on the provider record overrides this default.
const XAI_VIDEO_USD_PER_SEC = 0.05;

function xaiVideoCost(input: VideoGenInput, providerAmount?: number): number {
  // Cost must mirror what run() actually sends: clamp the duration the same way before
  // pricing, so out-of-range inputs (durationSec=0, durationSec=60) disclose and cap the
  // same number of seconds the provider is billed for. Null durationSec defaults to 8s.
  const clampedSec = clampDuration(input.durationSec) ?? 8;
  return Number((providerAmount ?? (clampedSec * XAI_VIDEO_USD_PER_SEC)).toFixed(6));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderExecutionError('xAI video generation timed out.', { code: 'provider_timeout' }));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new ProviderExecutionError('xAI video generation timed out.', { code: 'provider_timeout' })); }, { once: true });
  });
}

export const videoGenXaiProvider: HttpMediaProvider<VideoGenInput, GeneratedMediaOutput> = registerProvider({
  id: 'video-gen.xai',
  kind: 'video-gen',
  tier: 'paid',
  mode: 'http',
  displayName: 'xAI Video Generation',
  availableModels: [XAI_VIDEO_MODEL],
  capabilities: { polling: true, cancel: false, maxDurationSec: 15, outputFormats: ['video/mp4'] },
  estimateCost(input, provider) { return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: xaiVideoCost(input, provider.costPerUnit?.amount), actual: null }; },
  actualCost(_output, input, provider) { const amount = xaiVideoCost(input, provider.costPerUnit?.amount); return { currency: provider.costPerUnit?.currency ?? 'USD', estimated: amount, actual: amount }; },
  ledgerInput(input) { return { ...input, prompt: input.prompt.slice(0, 500) }; },
  ledgerOutput: generatedMediaLedgerOutput,
  async run(input, context) {
    if (!context.secret) throw new ProviderExecutionError('Configure a secretRef/API key for xAI Video Generation before running this provider.', { code: 'provider_auth_failed' });
    const start = await context.guardedFetch(context.provider.baseUrl ?? XAI_VIDEO_START_ENDPOINT, {
      tier: context.provider.tier,
      method: 'POST',
      headers: { Authorization: `Bearer ${context.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model ?? XAI_VIDEO_MODEL,
        prompt: input.prompt,
        ...(clampDuration(input.durationSec) == null ? {} : { duration: clampDuration(input.durationSec) }),
        aspect_ratio: ASPECT_RATIOS.has(input.aspectRatio ?? '') ? input.aspectRatio : '16:9',
        resolution: RESOLUTIONS.has(input.resolution ?? '') ? input.resolution : '480p'
      }),
      signal: context.signal,
      timeoutMs: 60000
    });
    if (!start.ok) throw new ProviderExecutionError(`xAI video generation start failed with HTTP ${start.status}: ${await boundedResponseText(start)}`, { providerStatus: start.status });
    const started = await start.json() as { request_id?: string };
    if (!started.request_id) throw new ProviderExecutionError('xAI video generation start response did not include request_id.', { providerStatus: start.status });
    const pollBase = context.provider.baseUrl && context.provider.baseUrl !== XAI_VIDEO_START_ENDPOINT ? context.provider.baseUrl.replace(/\/generations\/?$/, '') : XAI_VIDEO_POLL_BASE;
    for (;;) {
      if (context.signal.aborted) throw new ProviderExecutionError('xAI video generation timed out.', { code: 'provider_timeout' });
      const poll = await context.guardedFetch(`${pollBase}/${encodeURIComponent(started.request_id)}`, { tier: context.provider.tier, method: 'GET', headers: { Authorization: `Bearer ${context.secret}` }, signal: context.signal, timeoutMs: 60000 });
      if (!poll.ok) throw new ProviderExecutionError(`xAI video generation poll failed with HTTP ${poll.status}: ${await boundedResponseText(poll)}`, { providerStatus: poll.status });
      const state = await poll.json() as { status?: string; video?: { url?: string; duration?: number }; error?: { code?: string; message?: string }; model?: string };
      if (state.status === 'pending') { await sleep(POLL_MS, context.signal); continue; }
      if (state.status === 'failed' || state.status === 'expired') throw new ProviderExecutionError(state.error?.message ?? `xAI video generation ${state.status}.`, { code: 'provider_unavailable', details: state.error });
      if (state.status !== 'done' || !state.video?.url) throw new ProviderExecutionError(`xAI video generation returned unexpected status: ${state.status ?? 'unknown'}.`, { details: state });
      const media = await context.guardedFetch(state.video.url, { tier: context.provider.tier, method: 'GET', headers: {}, signal: context.signal, timeoutMs: 120000 });
      if (!media.ok) throw new ProviderExecutionError(`xAI video download failed with HTTP ${media.status}: ${await boundedResponseText(media)}`, { providerStatus: media.status });
      return { media: Buffer.from(await media.arrayBuffer()), mimeType: 'video/mp4', durationSec: state.video.duration, providerStatus: media.status };
    }
  }
});
