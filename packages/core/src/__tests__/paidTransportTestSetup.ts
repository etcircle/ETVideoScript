import { afterEach, beforeEach } from 'vitest';
import { paidTransportFromGlobalFetch, setPaidTransportForTests, type PaidFetch } from '../network/paidCallGate';

/**
 * Declares that this test file drives PAID provider adapters with its own stubs.
 *
 * The central gate (network/paidCallGate.ts) fails every paid call closed under VITEST unless a
 * transport was explicitly installed — no env bypass, no "a replaced global fetch counts".
 * Calling this at the top of a suite is that explicit installation, and it is deliberately
 * visible in the file: "this file exercises paid code paths".
 *
 * The installed transport still refuses when `globalThis.fetch` is the pristine built-in, so an
 * individual test in the file that forgets its own stub is blocked rather than billed.
 */
export function usePaidTransportStubbingGlobalFetch(): void {
  beforeEach(() => { setPaidTransportForTests(paidTransportFromGlobalFetch()); });
  afterEach(() => { setPaidTransportForTests(null); });
}

/** Install an explicit transport for one suite (e.g. the real dialer for SSRF-guard tests). */
export function usePaidTransport(transport: () => PaidFetch): void {
  beforeEach(() => { setPaidTransportForTests(transport()); });
  afterEach(() => { setPaidTransportForTests(null); });
}
