import { describe, expect, it } from 'vitest';
import { conservativeStsSourceSec, STS_SOURCE_BOUND_FACTOR } from '../generatePatch';
import { stsElevenlabsProvider } from '../providers/tts/elevenlabsSts';

/**
 * The bound and the execution path must not drift apart.
 *
 * Admission prices the STS step against `conservativeStsSourceSec(requested)` and persists the
 * resulting AMOUNT as a grant. Execution prices the real TTS output and is covered only while it
 * stays at or under that amount. These assert the one property that makes the arrangement safe:
 * any output up to the bound prices at or below the grant, and anything beyond it does not — so
 * an overrun falls back to the live cap check instead of spending silently.
 */

const provider = { id: 'tts.elevenlabs-sts', kind: 'tts', name: 'sts', tier: 'paid' } as any;
const price = (sec: number) => stsElevenlabsProvider.estimateCost({ audio: Buffer.alloc(0), voiceId: 'v', sourceDurationSec: sec } as any, provider).estimated!;

describe('conservative STS source bound', () => {
  it('bounds above the requested span', () => {
    expect(STS_SOURCE_BOUND_FACTOR).toBeGreaterThan(1);
    expect(conservativeStsSourceSec(3)).toBeGreaterThan(3);
  });

  it('grants at least what any output up to the bound costs', () => {
    for (const requested of [0.5, 1, 3.7, 12, 60]) {
      const grant = price(conservativeStsSourceSec(requested));
      for (const fraction of [0.1, 0.5, 1, 1.5, STS_SOURCE_BOUND_FACTOR]) {
        expect(price(requested * fraction)).toBeLessThanOrEqual(grant + 1e-9);
      }
    }
  });

  it('does NOT cover an output that runs past the bound — that must fall back to the live check', () => {
    const requested = 10;
    const grant = price(conservativeStsSourceSec(requested));
    expect(price(requested * (STS_SOURCE_BOUND_FACTOR + 0.5))).toBeGreaterThan(grant);
  });

  it('treats a degenerate span as zero rather than negative', () => {
    expect(conservativeStsSourceSec(-5)).toBe(0);
    expect(conservativeStsSourceSec(0)).toBe(0);
  });
});
