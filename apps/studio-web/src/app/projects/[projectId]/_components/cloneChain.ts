import { ApiError } from '../../../../lib/api';

/**
 * Clone-chain decision logic, kept out of the React component so the money-relevant parts are
 * testable without rendering.
 *
 * NOTE ON COST: nothing here prices the chain. The estimate and the cap verdict come from
 * `GET .../voice-patches/estimate`, which runs the same adapter estimate and the same cap
 * admission arithmetic the real call will run. A client-side mirror of that arithmetic was
 * wrong in three ways at once — it missed `costPerUnit` overrides, summed ledger rows that do
 * not count toward a cap, and added figures across currencies.
 */

export const CLONE_CHAIN_CALLS = 2;

/** Typed 409s whose remedy is "prepare (or re-prepare) your voice" — D3. */
export const CLONE_PREPARE_CODES = new Set(['clone-not-ready', 'clone-stale', 'clone-unknown-outcome']);

/**
 * Typed failures where a paid step's outcome is unknown or its artifact is untrustworthy. These
 * are NEVER auto-retried and never replayed under the same requestId — only a fresh user action
 * (a new requestId) may bill again.
 */
export const CLONE_FRESH_ACTION_CODES = new Set(['paid-step-unknown-outcome', 'step-artifact-corrupt']);

/**
 * Conflicts that mean the world moved under the generation. The route's Phase-1 RESUME preflight
 * returns these too — without a terminal and without echoing providerRequestId — and it requires
 * a NEW generation, so they must also discard the id (see CLONE_SPENT_CODES). Retrying the same
 * id would 409 forever against the same stale precondition.
 */
export const CLONE_CONFLICT_CODES = new Set(['operation-conflict', 'snapshot-conflict', 'range-conflict', 'request-id-conflict']);

/**
 * Failures the operator has to resolve before anything can proceed.
 *
 * `ledger-corruption` means a CONFLICTING root terminal already exists for this requestId, and
 * `commit-marker-conflict` can coexist with an identical one — so "no terminal was written" is
 * not true of either, and neither is fixed by pressing Confirm again. The id is still retained
 * (a fresh one would re-execute paid work), but the honest instruction is to go look at the
 * project's provider ledger.
 */
export const CLONE_OPERATOR_BLOCKED_CODES = new Set(['ledger-corruption', 'commit-marker-conflict']);

/**
 * The server's pre-payment sequence admission refused this generation: the spend cap would not
 * admit both paid calls. NOTHING was created and nothing was billed, so the id is spent (a
 * retry is a new action) — and the remedy is the cap, not a resume and not a re-prepare.
 */
export const CLONE_CAP_REFUSED_CODES = new Set(['cap-would-refuse-sequence']);

/**
 * Failures that PROVE the requestId is spent — the server reached a decision under it, so any
 * further attempt is a new user action and needs a new id.
 *
 * Two groups: intake/resolution errors that never reached execution (`field-not-allowed`,
 * `invalid-*`, `clip-not-eligible`, `validation-failed`, the `clone-*` family), and the
 * precondition conflicts above, which the route's resume path answers with a bare code and no
 * echo but which still demand a fresh generation.
 */
const CLONE_SPENT_CODES = new Set([
  'field-not-allowed', 'invalid-request-id', 'invalid-text', 'invalid-granularity', 'invalid-range', 'invalid-mode',
  'clip-not-eligible', 'validation-failed',
  'clone-not-ready', 'clone-stale', 'clone-unknown-outcome',
  ...CLONE_CONFLICT_CODES,
  ...CLONE_CAP_REFUSED_CODES
]);

/**
 * Does this failure PROVE the requestId is spent?
 *
 * The dangerous case is an ambiguous one — a reverse proxy answering 502/504 after the backend
 * already accepted the POST. Minting a new id there is a second bill for work that may have
 * completed. So the default is RETAIN, and the id is released only on positive evidence: a code
 * in CLONE_SPENT_CODES, a body echoing this requestId (the route writes it into every terminal
 * it produces), or a 400 (intake never reached execution).
 *
 * The operator-blocked codes are the one case that overrides an echo: they do carry
 * providerRequestId, but the retry is not the user's to make.
 */
export function requestIdIsSpent(error: ApiError, requestId: string): boolean {
  if (error.errorCode && CLONE_OPERATOR_BLOCKED_CODES.has(error.errorCode)) return false;
  if (error.errorCode && CLONE_SPENT_CODES.has(error.errorCode)) return true;
  const echoed = (error.body as { providerRequestId?: unknown } | undefined)?.providerRequestId;
  if (typeof echoed === 'string' && echoed === requestId) return true;
  return error.status === 400;
}

/** How the UI should describe a failed generation, and what it should offer. */
export type CloneChainRemedy = 'prepare-voice' | 'new-generation' | 'operator' | 'cap' | 'retry-replays' | 'none';

export function cloneChainRemedy(error: { errorCode?: string; retryReplays?: boolean }): CloneChainRemedy {
  if (error.errorCode && CLONE_PREPARE_CODES.has(error.errorCode)) return 'prepare-voice';
  // Its own class: neither "start a new generation" (nothing changed about the request — a
  // resubmission is refused identically) nor "resume" (nothing was billed to resume).
  if (error.errorCode && CLONE_CAP_REFUSED_CODES.has(error.errorCode)) return 'cap';
  // Checked BEFORE the conflict set: commit-marker-conflict is in both, and the operator
  // instruction is the correct one — "start a new generation" would just re-hit the bad ledger.
  if (error.errorCode && CLONE_OPERATOR_BLOCKED_CODES.has(error.errorCode)) return 'operator';
  if (error.errorCode && (CLONE_FRESH_ACTION_CODES.has(error.errorCode) || CLONE_CONFLICT_CODES.has(error.errorCode))) return 'new-generation';
  return error.retryReplays ? 'retry-replays' : 'none';
}

/**
 * The complete intent a requestId belongs to. Coordinates alone are not an identity: the same
 * start/end on a different clip (or in a different project) is a different request that the
 * server hashes differently, and reusing the id there is a guaranteed `request-id-conflict`.
 */
export function cloneChainIntentKey(input: { projectId: string; clipId: string; start: number; end: number; text: string }): string {
  return JSON.stringify([input.projectId, input.clipId, input.start, input.end, input.text]);
}
