import { describe, expect, it } from 'vitest';
import { canonicalProviderId, isAbsentProviderId, ProviderIdError } from '../providers/providerId';
import { assertSpeechProviderSupported } from '../tts';

describe('canonicalProviderId', () => {
  it('prefixes a shorthand with the kind and leaves an already-canonical id alone', () => {
    expect(canonicalProviderId('tts', 'xai')).toBe('tts.xai');
    expect(canonicalProviderId('tts', 'tts.xai')).toBe('tts.xai');
    expect(canonicalProviderId('image-gen', 'mock')).toBe('image-gen.mock');
    // A cross-kind id is returned as-is: rejecting it is the caller's contract, not this
    // function's — it only decides shorthand-vs-canonical.
    expect(canonicalProviderId('tts', 'clone.elevenlabs')).toBe('clone.elevenlabs');
  });

  it('treats an absent provider as "use the configured default", not an error', () => {
    expect(canonicalProviderId('tts', undefined)).toBeUndefined();
    expect(canonicalProviderId('tts', null)).toBeUndefined();
    expect(canonicalProviderId('tts', '')).toBeUndefined();
  });

  it('FAILS CLOSED on an array instead of coercing it into a plausible id', () => {
    // The quirk this replaces: every callsite was an `id.includes('.')` expression, and
    // Array.prototype.includes exists — so a repeated query param or a malformed JSON body
    // survived the check and template-stringified into `tts.xai` (single) or the nonsense
    // `tts.a,b` (multiple). Either way a provider nobody asked for, chosen silently.
    expect(() => canonicalProviderId('tts', ['xai'])).toThrow(ProviderIdError);
    expect(() => canonicalProviderId('tts', ['xai', 'elevenlabs'])).toThrow(/array/);
    expect(() => canonicalProviderId('tts', ['tts.xai'])).toThrow(ProviderIdError);
    // Empty array is still not a string — and is emphatically not "absent".
    expect(() => canonicalProviderId('tts', [])).toThrow(ProviderIdError);
  });

  it('fails closed on the other non-string shapes a malformed body can carry', () => {
    for (const bad of [42, true, { id: 'xai' }] as unknown[]) {
      expect(() => canonicalProviderId('tts', bad)).toThrow(ProviderIdError);
    }
  });

  it('FAILS CLOSED on the falsy non-strings too — they are malformed, not omitted', () => {
    // The trap this closes: callers wrote `provider || 'mock'` / `if (!provider) useDefault()`,
    // so `false` and `0` were read as "nothing was specified" and silently resolved to the
    // configured default provider — which may be a PAID one. Only undefined/null/'' are absent.
    expect(isAbsentProviderId(false)).toBe(false);
    expect(isAbsentProviderId(0)).toBe(false);
    expect(() => canonicalProviderId('tts', false)).toThrow(ProviderIdError);
    expect(() => canonicalProviderId('tts', 0)).toThrow(ProviderIdError);
    expect(() => canonicalProviderId('tts', Number.NaN)).toThrow(ProviderIdError);
    // …and the three that ARE absent stay absent.
    expect([undefined, null, ''].every(isAbsentProviderId)).toBe(true);
  });

  it('builds its error without ever throwing a DIFFERENT error', () => {
    // JSON.stringify throws on a BigInt, on a cycle, and on a throwing toJSON — which would
    // replace the typed ProviderIdError (a 400 the caller catches) with a native TypeError
    // (a 500) for the very same bad request.
    const cyclic: Record<string, unknown> = { kind: 'tts' };
    cyclic.self = cyclic;
    const throwingToJson = { toJSON() { throw new Error('nope'); } };
    const throwingToString = { toString() { throw new Error('nope'); }, toJSON() { throw new Error('nope'); } };
    for (const hostile of [10n, cyclic, throwingToJson, throwingToString, Symbol('xai')] as unknown[]) {
      expect(() => canonicalProviderId('tts', hostile)).toThrow(ProviderIdError);
    }
    // The message stays bounded even for a huge payload.
    expect(() => canonicalProviderId('tts', new Array(500).fill('xai'))).toThrow(ProviderIdError);
    try { canonicalProviderId('tts', new Array(500).fill('xai')); }
    catch (err) { expect((err as Error).message.length).toBeLessThan(200); }
  });

  it('carries a typed code and the received value on the error', () => {
    try {
      canonicalProviderId('tts', ['xai']);
      expect.unreachable('expected a ProviderIdError');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderIdError);
      expect((err as ProviderIdError).code).toBe('invalid_provider_id');
      expect((err as ProviderIdError).received).toEqual(['xai']);
    }
  });
});

describe('assertSpeechProviderSupported (the first gate every voice route goes through)', () => {
  it('accepts shorthand and canonical ids for a registered provider', () => {
    expect(() => assertSpeechProviderSupported('mock')).not.toThrow();
    expect(() => assertSpeechProviderSupported('tts.mock')).not.toThrow();
    expect(() => assertSpeechProviderSupported(undefined)).not.toThrow();
  });

  it('rejects an array provider rather than resolving it to a real adapter', () => {
    // Before: ['mock'] normalized to 'tts.mock', found the adapter and PASSED — a malformed
    // request went on to create an operation and (for a paid provider) spend money.
    expect(() => assertSpeechProviderSupported(['mock'] as unknown as string)).toThrow(ProviderIdError);
  });
});
