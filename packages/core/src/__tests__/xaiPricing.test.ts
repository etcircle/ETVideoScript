import { describe, expect, it } from 'vitest';
import { getProvider } from '../providers';
import type { ProviderRecord } from '../providerSettings';

// P4-2: xAI cost estimates must match the published xAI rates so the cap totals
// and the GenerationDialog disclosure are honest.
// Source: https://docs.x.ai/developers/models (verified 2026-05-20)
//   - tts.xai           — $15.00 / 1,000,000 characters
//   - video-gen.xai     — $0.050 / second (flat across 480p and 720p)
//   - image-gen.xai     — $0.02 / image (grok-imagine-image; quality variant $0.05)

function record(id: string, kind: ProviderRecord['kind'], costPerUnit?: ProviderRecord['costPerUnit']): ProviderRecord {
  const now = new Date().toISOString();
  return { schemaVersion: 1, id, kind, name: id.split('.')[1]!, tier: 'paid', enabled: true, default: false, createdAt: now, updatedAt: now, ...(costPerUnit ? { costPerUnit } : {}) };
}

describe('xAI cost estimates match published pricing (P4-2)', () => {
  it('tts.xai estimates $15 per 1M characters', () => {
    const adapter = getProvider('tts.xai')!;
    const provider = record('tts.xai', 'tts');
    // 1,000,000 characters → $15.00
    expect(adapter.estimateCost({ text: 'a'.repeat(1_000_000), voice: 'eve', language: 'en' } as any, provider).estimated).toBe(15);
    // 1,000 characters → $0.015
    expect(adapter.estimateCost({ text: 'a'.repeat(1000), voice: 'eve', language: 'en' } as any, provider).estimated).toBe(0.015);
    // 1 character → $0.000015
    expect(adapter.estimateCost({ text: 'a', voice: 'eve', language: 'en' } as any, provider).estimated).toBe(0.000015);
    // empty text floors to 1 character to avoid zero-disclosure
    expect(adapter.estimateCost({ text: '', voice: 'eve', language: 'en' } as any, provider).estimated).toBe(0.000015);
  });

  it('video-gen.xai estimates $0.05 per second of output', () => {
    const adapter = getProvider('video-gen.xai')!;
    const provider = record('video-gen.xai', 'video-gen');
    // explicit durationSec → that × $0.05
    expect(adapter.estimateCost({ prompt: 'x', durationSec: 1 } as any, provider).estimated).toBe(0.05);
    expect(adapter.estimateCost({ prompt: 'x', durationSec: 4 } as any, provider).estimated).toBe(0.2);
    expect(adapter.estimateCost({ prompt: 'x', durationSec: 15 } as any, provider).estimated).toBe(0.75);
    // omitted durationSec defaults to 8s (matches the GenerationDialog default disclosure)
    expect(adapter.estimateCost({ prompt: 'x' } as any, provider).estimated).toBe(0.4);
  });

  it('video-gen.xai clamps durationSec to the 1..15s provider range before pricing', () => {
    // run() clamps the duration sent to xAI to 1..15s; the cost estimate must mirror that
    // so the spend cap and disclosure match what the provider is actually billed for.
    const adapter = getProvider('video-gen.xai')!;
    const provider = record('video-gen.xai', 'video-gen');
    // 0 → clamps to 1s → $0.05 (not $0)
    expect(adapter.estimateCost({ prompt: 'x', durationSec: 0 } as any, provider).estimated).toBe(0.05);
    // negative → clamps to 1s
    expect(adapter.estimateCost({ prompt: 'x', durationSec: -5 } as any, provider).estimated).toBe(0.05);
    // 60 → clamps to 15s → $0.75 (not $3.00)
    expect(adapter.estimateCost({ prompt: 'x', durationSec: 60 } as any, provider).estimated).toBe(0.75);
    // 7.6 → rounds to 8 → $0.40
    expect(adapter.estimateCost({ prompt: 'x', durationSec: 7.6 } as any, provider).estimated).toBe(0.4);
  });

  it('image-gen.xai estimates $0.02 per image (grok-imagine-image standard)', () => {
    const adapter = getProvider('image-gen.xai')!;
    const provider = record('image-gen.xai', 'image-gen');
    expect(adapter.estimateCost({ prompt: 'x', count: 1 } as any, provider).estimated).toBe(0.02);
    expect(adapter.estimateCost({ prompt: 'x', count: 4 } as any, provider).estimated).toBe(0.08);
    // count omitted defaults to 1 image
    expect(adapter.estimateCost({ prompt: 'x' } as any, provider).estimated).toBe(0.02);
    // explicit standard model picks the standard price
    expect(adapter.estimateCost({ prompt: 'x', model: 'grok-imagine-image', count: 2 } as any, provider).estimated).toBe(0.04);
  });

  it('image-gen.xai estimates $0.05 per image when caller selects the quality variant', () => {
    // grok-imagine-image-quality is xAI's higher-quality variant ($0.05/image vs $0.02/image
    // for grok-imagine-image). The adapter sends input.model through to xAI, so the cost
    // estimate and ledger must follow the per-model rate, not the default.
    const adapter = getProvider('image-gen.xai')!;
    const provider = record('image-gen.xai', 'image-gen');
    expect(adapter.estimateCost({ prompt: 'x', model: 'grok-imagine-image-quality', count: 1 } as any, provider).estimated).toBe(0.05);
    expect(adapter.estimateCost({ prompt: 'x', model: 'grok-imagine-image-quality', count: 3 } as any, provider).estimated).toBe(0.15);
    const actual = adapter.actualCost!({ media: Buffer.alloc(0), mimeType: 'image/jpeg' } as any, { prompt: 'x', model: 'grok-imagine-image-quality', count: 2 } as any, provider);
    expect(actual).toMatchObject({ estimated: 0.1, actual: 0.1 });
  });

  it('image-gen.xai falls back to the standard rate for unknown model strings', () => {
    // Unknown / future model strings still need cost disclosure — fail-loud silently means
    // under-counting the spend cap. Pin to the standard rate so the disclosure is at least
    // non-zero and the cap counts something.
    const adapter = getProvider('image-gen.xai')!;
    const provider = record('image-gen.xai', 'image-gen');
    expect(adapter.estimateCost({ prompt: 'x', model: 'grok-imagine-image-pro-2027', count: 1 } as any, provider).estimated).toBe(0.02);
  });

  it('provider.costPerUnit override beats the adapter default for all three xAI adapters', () => {
    // Operator-set override (e.g., a private deal / future price change applied via Settings)
    // must not be silently ignored — required behaviour for the per-provider spend cap to stay correct.
    const tts = getProvider('tts.xai')!;
    const ttsProvider = record('tts.xai', 'tts', { currency: 'USD', unit: 'request', amount: 0.5 });
    expect(tts.estimateCost({ text: 'whatever', voice: 'eve', language: 'en' } as any, ttsProvider).estimated).toBe(0.5);

    const video = getProvider('video-gen.xai')!;
    const videoProvider = record('video-gen.xai', 'video-gen', { currency: 'USD', unit: 'request', amount: 1.25 });
    expect(video.estimateCost({ prompt: 'x', durationSec: 10 } as any, videoProvider).estimated).toBe(1.25);

    const image = getProvider('image-gen.xai')!;
    const imageProvider = record('image-gen.xai', 'image-gen', { currency: 'USD', unit: 'image', amount: 0.5 });
    // image override is per-image; count of 3 → $1.50
    expect(image.estimateCost({ prompt: 'x', count: 3 } as any, imageProvider).estimated).toBe(1.5);
  });

  it('actualCost matches estimateCost (same formula) and reports the actual field', () => {
    const tts = getProvider('tts.xai')!;
    expect(tts.actualCost).toBeDefined();
    const ttsActual = tts.actualCost!({ audio: Buffer.alloc(0), mimeType: 'audio/wav' } as any, { text: 'a'.repeat(2000), voice: 'eve', language: 'en' } as any, record('tts.xai', 'tts'));
    expect(ttsActual).toMatchObject({ estimated: 0.03, actual: 0.03 });

    const video = getProvider('video-gen.xai')!;
    expect(video.actualCost).toBeDefined();
    const videoActual = video.actualCost!({ media: Buffer.alloc(0), mimeType: 'video/mp4' } as any, { prompt: 'x', durationSec: 2 } as any, record('video-gen.xai', 'video-gen'));
    expect(videoActual).toMatchObject({ estimated: 0.1, actual: 0.1 });

    const image = getProvider('image-gen.xai')!;
    expect(image.actualCost).toBeDefined();
    const imageActual = image.actualCost!({ media: Buffer.alloc(0), mimeType: 'image/jpeg' } as any, { prompt: 'x', count: 2 } as any, record('image-gen.xai', 'image-gen'));
    expect(imageActual).toMatchObject({ estimated: 0.04, actual: 0.04 });
  });
});
