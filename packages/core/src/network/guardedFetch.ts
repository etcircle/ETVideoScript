import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { SettingsError, type ProviderTier } from '../providerSettings';
import { PaidCallBlockedError, resolvePaidTransport } from './paidCallGate';

export type GuardedFetchOptions = Omit<RequestInit, 'redirect'> & {
  tier: ProviderTier;
  timeoutMs?: number;
  maxRedirects?: number;
};

function normalizeIp(address: string): string {
  const unbracketed = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const lower = unbracketed.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice(7);
    if (tail.includes('.')) return tail;
    const parts = tail.split(':').map((part) => parseInt(part || '0', 16));
    if (parts.length === 2 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)) {
      return `${parts[0]! >> 8}.${parts[0]! & 0xff}.${parts[1]! >> 8}.${parts[1]! & 0xff}`;
    }
  }
  return lower;
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!) >>> 0;
}

function ipv4InCidr(address: string, base: string, bits: number): boolean {
  const value = ipv4ToInt(address);
  const baseValue = ipv4ToInt(base);
  if (value == null || baseValue == null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function expandIpv6(address: string): number[] | null {
  const zoneFree = address.split('%')[0]!.toLowerCase();
  if (zoneFree.includes('.')) return null;
  const [headRaw, tailRaw] = zoneFree.split('::');
  if (zoneFree.split('::').length > 2) return null;
  const head = headRaw ? headRaw.split(':') : [];
  const tail = tailRaw ? tailRaw.split(':') : [];
  if (head.some((part) => part.length > 4 || !/^[0-9a-f]+$/.test(part)) || tail.some((part) => part.length > 4 || !/^[0-9a-f]+$/.test(part))) return null;
  const missing = zoneFree.includes('::') ? 8 - head.length - tail.length : 0;
  const parts = zoneFree.includes('::') ? [...head, ...Array(Math.max(0, missing)).fill('0'), ...tail] : head;
  if (parts.length !== 8) return null;
  return parts.map((part) => parseInt(part || '0', 16));
}

function ipv6InCidr(address: string, base: string, bits: number): boolean {
  const value = expandIpv6(address);
  const baseValue = expandIpv6(base);
  if (value == null || baseValue == null) return false;
  let remaining = bits;
  for (let i = 0; i < 8; i += 1) {
    if (remaining <= 0) return true;
    const chunkBits = Math.min(16, remaining);
    const mask = chunkBits === 16 ? 0xffff : (0xffff << (16 - chunkBits)) & 0xffff;
    if ((value[i]! & mask) !== (baseValue[i]! & mask)) return false;
    remaining -= chunkBits;
  }
  return true;
}

export function isPublicGlobalUnicastIp(address: string): boolean {
  const normalized = normalizeIp(address);
  if (isIP(normalized) === 4) {
    const blocked: Array<[string, number]> = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
      ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
      ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
    ];
    return !blocked.some(([base, bits]) => ipv4InCidr(normalized, base, bits));
  }
  if (isIP(normalized) === 6) return ipv6InCidr(normalized, '2000::', 3) && !ipv6InCidr(normalized, '2001:db8::', 32);
  return false;
}

function assertDialAddressAllowed(address: string, tier: ProviderTier) {
  if (tier === 'paid' && !isPublicGlobalUnicastIp(address)) throw new SettingsError('ssrf_blocked', 'Paid provider baseUrl resolved to a non-public address.');
}

function assertUrlShapeAllowed(url: URL, tier: ProviderTier) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new SettingsError('invalid_base_url', 'Provider baseUrl must be http or https.');
  if (tier === 'paid' && url.hostname.toLowerCase().endsWith('.local')) throw new SettingsError('ssrf_blocked', 'Paid provider baseUrl must not resolve to local network hosts.');
  const hostnameIp = normalizeIp(url.hostname);
  if (isIP(hostnameIp)) assertDialAddressAllowed(hostnameIp, tier);
}

function makeGuardedAgent(tier: ProviderTier) {
  return new Agent({
    connect: {
      lookup(hostname: string, options: unknown, callback: any) {
        (dnsLookup as any)(hostname, options, (err: any, address: unknown, family: unknown) => {
          if (err) return callback(err);
          try {
            const addresses = Array.isArray(address) ? address : [{ address, family }];
            for (const entry of addresses as Array<{ address: unknown }>) assertDialAddressAllowed(String(entry.address), tier);
            if (Array.isArray(address)) return callback(null, addresses);
            return callback(null, address, family);
          } catch (blocked) {
            return callback(blocked);
          }
        });
      }
    }
  });
}

// Wrap the common body-consumer methods so that an AbortError fired during the
// body phase (because timeoutMs elapsed after headers were received but before
// the caller drained the body) surfaces with the same SettingsError shape the
// header-phase abort uses. Without this, the raw AbortError leaks out of the
// caller's `await response.json()` etc. and the engine misclassifies it as a
// generic provider_unavailable with a raw "fetch aborted" message instead of
// the cleaner "Provider call timed out." path.
function wrapResponseAbort(response: Response, signal: AbortSignal): Response {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); }
    catch (err: any) {
      const aborted = signal.aborted || err?.name === 'AbortError' || err?.cause?.name === 'AbortError';
      if (aborted) throw new SettingsError('provider_unreachable', 'Provider call timed out.');
      throw err;
    }
  };
  // For direct stream reads (response.body.getReader() in boundedResponseText
  // and any future stream consumers): wrap the body so an AbortError during
  // reader.read() surfaces as the same SettingsError as the body-consumer
  // methods. Proxy the body itself so getReader() returns a reader whose
  // .read() wraps the abort — this avoids constructing a new ReadableStream
  // (which would schedule pull() in a microtask and lock the original even
  // when the caller only meant to probe response.body).
  let cachedWrappedBody: ReadableStream<Uint8Array> | null = null;
  const mapReadError = (err: unknown): Error => {
    const aborted = signal.aborted || (err as { name?: string })?.name === 'AbortError' || (err as { cause?: { name?: string } })?.cause?.name === 'AbortError';
    return aborted ? new SettingsError('provider_unreachable', 'Provider call timed out.') : (err as Error);
  };
  const wrapReader = (original: ReadableStreamDefaultReader<Uint8Array>): ReadableStreamDefaultReader<Uint8Array> => {
    return new Proxy(original, {
      get(target, prop) {
        if (prop === 'read') return async () => {
          try { return await target.read(); }
          catch (err) { throw mapReadError(err); }
        };
        const value = (target as unknown as Record<PropertyKey, unknown>)[prop];
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
    });
  };
  const wrapBody = (original: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
    if (cachedWrappedBody) return cachedWrappedBody;
    cachedWrappedBody = new Proxy(original, {
      get(target, prop) {
        if (prop === 'getReader') return ((...args: unknown[]) => {
          const reader = (target.getReader as (...args: unknown[]) => ReadableStreamDefaultReader<Uint8Array>).apply(target, args);
          return wrapReader(reader);
        }) as unknown as typeof target.getReader;
        const value = (target as unknown as Record<PropertyKey, unknown>)[prop];
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
    });
    return cachedWrappedBody;
  };
  // Note: undici's Response uses private fields (#state) accessed via getters,
  // so Reflect.get(target, prop, receiver) breaks because `this` ends up bound
  // to the proxy. Read directly off `target` and bind functions to it instead.
  return new Proxy(response, {
    get(target, prop) {
      if (prop === 'json') return () => wrap(() => target.json());
      if (prop === 'text') return () => wrap(() => target.text());
      if (prop === 'arrayBuffer') return () => wrap(() => target.arrayBuffer());
      if (prop === 'blob') return () => wrap(() => target.blob());
      if (prop === 'formData') return () => wrap(() => target.formData());
      if (prop === 'bytes' && typeof (target as { bytes?: () => Promise<unknown> }).bytes === 'function') {
        return () => wrap(() => (target as { bytes: () => Promise<unknown> }).bytes());
      }
      if (prop === 'body') return target.body ? wrapBody(target.body) : target.body;
      const value = (target as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  });
}

function mergeSignals(parent: AbortSignal | undefined, timeoutSignal: AbortSignal): AbortSignal {
  if (!parent) return timeoutSignal;
  if (parent.aborted) return parent;
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener('abort', abort, { once: true });
  timeoutSignal.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

export async function guardedFetch(input: string | URL, options: GuardedFetchOptions): Promise<Response> {
  // S1b D8: single fail-closed boundary for PAID calls. Every paid provider call (TTS,
  // speech-to-speech, voice clone, Studio Sound isolation) funnels through here, so resolving
  // the transport here gates all of them. Under VITEST this THROWS unless a test explicitly
  // installed a transport — there is no env bypass.
  const transport = options.tier === 'paid' ? resolvePaidTransport(String(input)) : null;
  let current: URL;
  try { current = new URL(String(input)); }
  catch { throw new SettingsError('invalid_base_url', 'Provider baseUrl is invalid.'); }
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxRedirects = options.maxRedirects ?? 4;
  const controller = new AbortController();
  // The timer stays armed across both header and body phases. If the caller's
  // body read (response.text/json/arrayBuffer) stalls, this will fire and abort
  // the underlying body stream via controller.signal, so callers actually get
  // the per-call timeoutMs they asked for. unref() so a benign late fire (after
  // the response has already been consumed) doesn't keep the event loop alive.
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  (timeout as { unref?: () => void }).unref?.();
  const agent = makeGuardedAgent(options.tier);
  const { tier, timeoutMs: _timeoutMs, maxRedirects: _maxRedirects, signal, ...init } = options;
  try {
    for (let hop = 0; hop < maxRedirects; hop += 1) {
      assertUrlShapeAllowed(current, tier);
      let response: Response;
      try {
        // Use globalThis.fetch instead of importing fetch from undici. Per the
        // undici docs ("Keep fetch and FormData together"), the fetch impl and
        // the FormData impl must come from the same source — mixing npm undici's
        // fetch with globalThis FormData (or vice versa) silently drops form
        // fields, reproduced live as ElevenLabs returning HTTP 422 "name
        // missing" on a correct multipart body. globalThis.fetch and
        // globalThis.FormData come from the same bundled implementation in any
        // Node version that supports fetch, so they stay consistent.
        // Node's built-in fetch still accepts undici's Agent as the dispatcher
        // (a documented public API), so the SSRF DNS guard below remains
        // effective. Tests can still mock globalThis.fetch directly.
        // Paid calls use the gate-resolved transport (production: the platform fetch; under
        // VITEST: the explicitly installed test transport). Local-tier calls are not money and
        // keep using the platform fetch directly.
        const fetchImpl = transport ?? globalThis.fetch.bind(globalThis);
        response = await (fetchImpl as any)(current, { ...init, redirect: 'manual', signal: mergeSignals(signal ?? undefined, controller.signal), dispatcher: agent }) as unknown as Response;
      } catch (err: any) {
        // The paid-call gate must surface AS ITSELF: laundering it into
        // 'provider_unreachable' would read as a flaky network in test output and hide the
        // fact that a paid path was reached without an installed transport.
        if (err instanceof PaidCallBlockedError) throw err;
        if (err instanceof SettingsError) throw err;
        if (err?.cause instanceof SettingsError) throw err.cause;
        if (err?.name === 'AbortError' || controller.signal.aborted) throw new SettingsError('provider_unreachable', 'Provider call timed out.');
        if (/certificate|tls|ssl/i.test(String(err?.message || err))) throw new SettingsError('tls_failed', 'Provider TLS handshake failed.');
        throw new SettingsError('provider_unreachable', 'Provider could not be reached.');
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new SettingsError('provider_unreachable', 'Provider redirect was missing a Location header.');
        const next = new URL(location, current);
        if (next.protocol !== current.protocol || next.hostname !== current.hostname || next.port !== current.port) {
          assertUrlShapeAllowed(next, tier);
          if (tier === 'paid') throw new SettingsError('ssrf_blocked', 'Paid provider redirects must stay on the same host and public tier.');
        }
        current = next;
        continue;
      }
      // Fire-and-forget agent.close(). Awaiting it here deadlocks: undici's close()
      // waits for in-flight requests to drain, but the caller hasn't consumed the
      // response body yet (we haven't returned the response to them). The agent is
      // internally referenced by the in-flight request; once the body is consumed
      // (or the timeout aborts it), close() resolves naturally.
      void agent.close();
      return wrapResponseAbort(response, controller.signal);
    }
    throw new SettingsError('ssrf_blocked', 'Provider redirected too many times.');
  } catch (err) {
    clearTimeout(timeout);
    void agent.close();
    throw err;
  }
}
