// ── Central fail-closed gate for PAID provider network calls (S1b D8/⟨Q5⟩) ───────
//
// One choke point. EVERY paid provider call in this codebase reaches the network through
// guardedFetch with `tier: 'paid'` — TTS, speech-to-speech, the EL voice clone, and Studio
// Sound's Voice Isolator — so gating the transport there covers all of them.
//
// The rule under VITEST: a paid call may only proceed through a transport the test EXPLICITLY
// installed. There is deliberately NO environment-variable bypass and no "a replaced global
// fetch counts as consent" heuristic: an env var is invisible at the callsite and can be set
// process-wide by an unrelated test, and an accidentally-restored global fetch would silently
// become a real, billed request. Absent an explicit installation the call fails CLOSED.
//
// Tests that drive paid adapters declare that intent once per file:
//
//     beforeEach(() => setPaidTransportForTests(paidTransportFromGlobalFetch()));
//     afterEach(() => setPaidTransportForTests(null));
//
// `paidTransportFromGlobalFetch` still refuses when the global fetch is the pristine built-in,
// so a test in such a file that forgets its own stub is blocked rather than billed.
//
// No imports: this module is loaded from guardedFetch, which the provider engine imports, so
// anything imported here would close an import cycle.

export type PaidFetch = (input: string | URL, init?: unknown) => Promise<Response>;

const PRISTINE_FETCH: unknown = (globalThis as { fetch?: unknown }).fetch;

let injectedTransport: PaidFetch | null = null;

export class PaidCallBlockedError extends Error {
  readonly code = 'paid_call_blocked';
  constructor(context: string) {
    super(`paid-call-blocked: ${context} attempted a real paid provider network call under VITEST with no explicitly installed test transport. Install one with setPaidTransportForTests(...) in the test that means to exercise this path.`);
    this.name = 'PaidCallBlockedError';
  }
}

/**
 * TEST-ONLY. Install (or clear, with `null`) the transport paid calls use under VITEST.
 * Ignored outside VITEST so a stray call in production can never redirect real traffic.
 */
export function setPaidTransportForTests(transport: PaidFetch | null): void {
  injectedTransport = transport;
}

/**
 * A transport that forwards to whatever `globalThis.fetch` currently is, but REFUSES when that
 * is still the pristine built-in. Lets a suite keep stubbing the global (the established
 * pattern in this repo) while preserving the fail-closed property for any test in that file
 * that forgets its stub.
 */
export function paidTransportFromGlobalFetch(): PaidFetch {
  return async (input, init) => {
    const current = (globalThis as { fetch?: unknown }).fetch;
    if (current === PRISTINE_FETCH) throw new PaidCallBlockedError(String(input));
    return (current as PaidFetch)(input, init);
  };
}

/**
 * A transport that deliberately forwards to the REAL dialer. The only legitimate use is a test
 * of the network layer itself (the SSRF guard), where the request must actually enter the
 * dialer to be rejected by it — and where every address under test is non-routable. Explicit
 * and per-suite, unlike a process-wide env bypass.
 */
export function realDialerTransportForNetworkTests(): PaidFetch {
  return async (input, init) => (PRISTINE_FETCH as PaidFetch)(input, init as never);
}

/**
 * Resolve the transport a paid call should use. THE gate: under VITEST an explicit test
 * transport is mandatory; in production the platform fetch is returned unchanged.
 */
export function resolvePaidTransport(context: string): PaidFetch {
  if (!process.env.VITEST) return (globalThis as { fetch: PaidFetch }).fetch.bind(globalThis) as PaidFetch;
  if (injectedTransport) return injectedTransport;
  throw new PaidCallBlockedError(context);
}
