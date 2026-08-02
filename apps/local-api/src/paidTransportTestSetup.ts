import { afterEach, beforeEach } from 'vitest';
import { paidTransportFromGlobalFetch, setPaidTransportForTests } from '@etvideoscript/core';

/**
 * Declares that this route-test file drives PAID provider adapters with its own fetch stubs.
 * See packages/core/src/__tests__/paidTransportTestSetup.ts for the rationale — the central
 * gate fails paid calls closed under VITEST unless a transport is explicitly installed, and
 * this call is that installation, kept visible at the top of the suite.
 */
export function usePaidTransportStubbingGlobalFetch(): void {
  beforeEach(() => { setPaidTransportForTests(paidTransportFromGlobalFetch()); });
  afterEach(() => { setPaidTransportForTests(null); });
}
