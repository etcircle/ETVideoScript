import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { appendProviderRequestEvent, providerEstimatedSpend } from '../providerRequests';
import { nowIso } from '../filesystem';
import {
  readSecrets,
  readWorkspaceSettings,
  redactSecrets,
  resolveProviderForKind,
  SettingsError,
  settingsErrorEnvelope,
  type ProviderKind,
  type ProviderRecord,
  type SettingsPathsInput
} from '../providerSettings';
import { guardedFetch } from '../network/guardedFetch';
import { canonicalProviderId } from './providerId';
import { getProvider } from './registry';
import type { MediaProvider, ProviderCost, ProviderErrorCode, ProviderErrorEnvelope, ProviderRunEnvelope } from './contract';

export type RunProviderInput<Input> = SettingsPathsInput & {
  kind: ProviderKind;
  input: Input;
  /**
   * A cap admission already granted to this call.
   *
   * A multi-call operation is admitted as a SEQUENCE before its first paid step (the clone
   * chain's ordered preflight). Without a grant, the second step is re-checked against a live
   * cap that the FIRST step has meanwhile consumed — so an operation the user was told was
   * affordable gets billed for its first half and refused on its second.
   *
   * The grant is a WINDOW, not a bypass, and it is deliberately not just `estimate <= granted`.
   * Two chains in the same project overlap in Phase 2 (the project mutex covers Phase 1 only),
   * and each would otherwise wave its own step through while the other's spend piled up — the
   * cap bypassed twice over. So honoring also requires that the live spend plus this call still
   * fits inside the window the admission actually observed: `spent + estimate <=
   * capSpentAtAdmission + chainTotal`. A second chain sees a larger `spent`, falls outside the
   * window, and is refused by the ordinary live check.
   *
   * `currency` and `providerId` pin the grant to the call it was issued for: an amount in one
   * currency is not an amount in another, and a grant for the TTS step is not a licence for the
   * speech-to-speech one. Everything else about the cap — the ledger preflight, the
   * unknown-estimate refusal — is unchanged.
   */
  admission?: {
    grantedEstimate: number;
    /** Ledger spend the admission observed. Null ⇒ the grant is not honored at all. */
    capSpentAtAdmission: number | null;
    /** Total the whole admitted operation was granted, across its steps. */
    chainTotal: number;
    currency: string;
    providerId: string;
  };
  workspacePath: string;
  providerId?: string;
  projectId?: string;
  operationId?: string;
  requestType?: string;
  requestId?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
};

function normalizeProviderId(kind: ProviderKind, id?: string): string | undefined {
  return canonicalProviderId(kind, id);
}

function syntheticProvider(kind: ProviderKind, id: string, adapter: MediaProvider<any, any>): ProviderRecord {
  const name = id.slice(`${kind}.`.length);
  return {
    schemaVersion: 1,
    id,
    kind,
    name,
    tier: adapter.tier,
    enabled: true,
    default: false,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function estimateFallback(): ProviderCost {
  return { currency: 'USD', estimated: null, actual: null };
}

/**
 * Hidden provider id → the user-facing provider whose spend cap it falls under. These ids are
 * internal (never shown in the Settings cap UI) but bill the SAME account, so a cap the user set
 * on the visible provider has to bound them too.
 */
const CAP_INHERITS_FROM: Record<string, string> = {
  'clone.elevenlabs': 'tts.elevenlabs',
  'tts.elevenlabs-sts': 'tts.elevenlabs'
};

export function resolveProviderSecret(provider: ProviderRecord, input: SettingsPathsInput & { env?: Record<string, string | undefined> } = {}): string | undefined {
  if (provider.secretRef) return readSecrets(input).secrets[provider.secretRef];
  return undefined;
}

function classifyStatus(status?: number): Pick<ProviderErrorEnvelope, 'code' | 'problem' | 'cause' | 'fix'> {
  if (status === 401 || status === 403) return { code: 'provider_auth_failed', problem: 'Provider authentication failed.', cause: `The provider returned HTTP ${status}.`, fix: 'Check the configured secretRef/API key and provider account access.' };
  if (status === 400 || status === 422) return { code: 'provider_bad_request', problem: 'Provider rejected the request.', cause: `The provider returned HTTP ${status}.`, fix: 'Check the model, voice, language, input size, and provider payload.' };
  if (status === 404) return { code: 'model_missing', problem: 'Provider endpoint or model was not found.', cause: 'The provider returned HTTP 404.', fix: 'Check the configured base URL, endpoint, model, or voice id.' };
  if (status === 408 || status === 504) return { code: 'provider_timeout', problem: 'Provider request timed out.', cause: `The provider returned HTTP ${status}.`, fix: 'Retry later or use a local provider for this run.' };
  return { code: 'provider_unavailable', problem: 'Provider is unavailable.', cause: status ? `The provider returned HTTP ${status}.` : 'The provider call failed before a usable response was returned.', fix: 'Retry later, verify the provider base URL, or switch providers.' };
}

export class ProviderExecutionError extends Error {
  providerStatus?: number;
  code?: ProviderErrorCode;
  details?: unknown;
  constructor(message: string, input: { providerStatus?: number; code?: ProviderErrorCode; details?: unknown } = {}) {
    super(message);
    this.name = 'ProviderExecutionError';
    this.providerStatus = input.providerStatus;
    this.code = input.code;
    this.details = input.details;
  }
}

export class ProviderEnvelopeError extends Error {
  envelope: ProviderErrorEnvelope;
  code: ProviderErrorCode;
  providerId?: string;
  statusCode?: number;
  requestId?: string;
  constructor(envelope: ProviderErrorEnvelope) {
    super(`${envelope.problem} ${envelope.cause} ${envelope.fix}`);
    this.name = 'ProviderEnvelopeError';
    this.envelope = envelope;
    this.code = envelope.code;
    this.providerId = envelope.providerId;
    this.statusCode = envelope.statusCode;
    this.requestId = envelope.requestId;
  }
}

function boundedLedgerOutput(value: unknown, maxBytes = 8192): unknown {
  const redacted = redactSecrets(value);
  let json: string;
  try { json = JSON.stringify(redacted); }
  catch { return { omitted: true, reason: 'unserializable_provider_output' }; }
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return redacted;
  const kind = Array.isArray(redacted) ? 'array' : redacted && typeof redacted === 'object' ? 'object' : typeof redacted;
  return { omitted: true, kind, approxBytes: Buffer.byteLength(json, 'utf8') };
}

export function providerErrorEnvelope(error: unknown, context: { providerId?: string; requestId?: string } = {}): ProviderErrorEnvelope {
  if (error instanceof SettingsError) {
    const env = settingsErrorEnvelope(error).error;
    const mapped: Record<string, Pick<ProviderErrorEnvelope, 'code' | 'problem' | 'cause' | 'fix'>> = {
      ssrf_blocked: {
        code: 'ssrf_blocked',
        problem: 'Provider URL was blocked by the SSRF guard.',
        cause: 'A paid provider resolved or redirected to a local/non-public address.',
        fix: 'Set a public base URL or use a local-tier provider.'
      },
      model_missing: {
        code: 'model_missing',
        problem: 'Provider model or endpoint was not found.',
        cause: env.message,
        fix: 'Check the configured model, voice, endpoint, or base URL.'
      },
      provider_not_found: {
        code: 'provider_not_found',
        problem: 'Provider adapter or settings record was not found.',
        cause: env.message,
        fix: 'Choose an installed provider or add the provider settings record.'
      },
      provider_disabled: {
        code: 'provider_disabled',
        problem: 'Provider is disabled.',
        cause: env.message,
        fix: 'Enable the provider in Settings, or select another provider.'
      },
      auth_failed: {
        code: 'provider_auth_failed',
        problem: 'Provider authentication failed.',
        cause: env.message,
        fix: 'Check the configured secretRef/API key and provider account access.'
      },
      provider_unreachable: {
        code: 'provider_unavailable',
        problem: 'Provider could not be reached.',
        cause: env.message,
        fix: 'Check network connectivity, provider status, and the configured base URL.'
      },
      tls_failed: {
        code: 'provider_unavailable',
        problem: 'Provider TLS handshake failed.',
        cause: env.message,
        fix: 'Check the provider certificate, HTTPS endpoint, or local trust store.'
      },
      invalid_base_url: {
        code: 'provider_bad_request',
        problem: 'Provider base URL is invalid.',
        cause: env.message,
        fix: 'Configure a valid http(s) provider base URL.'
      }
    };
    const classified = mapped[error.code] ?? { code: 'invalid_settings' as const, problem: env.message, cause: env.message, fix: 'Fix provider settings and retry.' };
    return {
      ...classified,
      message: env.message,
      providerId: context.providerId,
      requestId: context.requestId,
      details: env.details
    };
  }
  const providerStatus = error instanceof ProviderExecutionError ? error.providerStatus : undefined;
  const classified = error instanceof ProviderExecutionError && error.code && !providerStatus
    ? { code: error.code, problem: error.message, cause: error.message, fix: 'Fix provider settings and retry.' }
    : classifyStatus(providerStatus);
  const message = String(redactSecrets(error instanceof Error ? error.message : String(error)));
  return {
    ...classified,
    message,
    providerId: context.providerId,
    requestId: context.requestId,
    ...(providerStatus == null ? {} : { statusCode: providerStatus }),
    ...(error instanceof ProviderExecutionError && error.details !== undefined ? { details: redactSecrets(error.details) } : {})
  };
}

/** True when the call would breach at least one ceiling absent any grant. */
function breachedWithoutGrant(checks: ReadonlyArray<{ limit: number; spent: number }>, estimate: number): boolean {
  return checks.some((check) => check.spent + estimate > check.limit);
}

/** The ids a cap on `providerId` actually covers: its root plus every id inheriting that root. */
export function capGroupFor(providerId: string): string[] {
  const capRoot = CAP_INHERITS_FROM[providerId] ?? providerId;
  return [capRoot, ...Object.keys(CAP_INHERITS_FROM).filter((id) => CAP_INHERITS_FROM[id] === capRoot)];
}

export interface ProviderCallEstimate {
  providerId: string;
  tier: ProviderRecord['tier'];
  cost: ProviderCost;
  /** True when the cap admission check would refuse THIS call, given everything before it. */
  wouldRefuse: boolean;
  refusal?: EstimateRefusal;
  /** Only for 'cap-exceeded'. */
  refusalScope?: CapRefusalScope;
}

export type EstimateRefusal = 'cap-exceeded' | 'unknown-estimate' | 'ledger-unreadable' | 'provider-not-found' | 'provider-disabled';

/**
 * For a 'cap-exceeded' refusal: does this step breach the ceiling ON ITS OWN, or only once the
 * earlier steps of the batch are counted? The remedies differ — 'step-alone' means this single
 * call is unaffordable, 'sequence-only' means the calls are individually fine but cannot both
 * run — and telling the user the wrong one sends them to the wrong fix.
 */
export type CapRefusalScope = 'step-alone' | 'sequence-only';

export interface ProviderBatchEstimate {
  steps: ProviderCallEstimate[];
  cap: {
    /** The tightest ceiling in play across the batch, or null when nothing is capped. */
    limit: number | null;
    /** Ledger spend already counted against it, or null when the ledger refuses to total. */
    spent: number | null;
    group: string[];
  };
  /** True when running this batch IN ORDER would be refused at some step. */
  wouldRefuse: boolean;
  refusal?: EstimateRefusal;
  refusalScope?: CapRefusalScope;
  /** Index of the first step that would be refused. */
  refusedAtStep?: number;
}

/**
 * The admission arithmetic `runProvider` performs, for an ORDERED BATCH of prospective calls —
 * without running anything, writing anything, or reserving anything.
 *
 * ORDERED matters. The clone chain is two paid calls under ONE shared ceiling, and checking them
 * independently answers the wrong question: with $0.055 left, a $0.01 TTS and a $0.05 STS each
 * fit, but running them in sequence bills the first and then refuses the second — the user is
 * charged for half a generation the UI promised was affordable. So each step's check carries the
 * prospective spend of every step before it.
 *
 * Exists so a UI can disclose what a prospective operation costs and whether the cap admits it,
 * instead of mirroring the pricing table and the cap-inheritance graph client-side. A mirror
 * cannot see `costPerUnit` overrides (which both ElevenLabs adapters treat as a flat per-call
 * amount), cannot know which ledger rows count toward a cap, and cannot reproduce the
 * fail-closed refusals below.
 *
 * READ-ONLY: settings are read without persisting a schema migration, so asking the question
 * never edits the answer.
 */
export function estimateProviderCalls(params: SettingsPathsInput & {
  calls: ReadonlyArray<{ kind: ProviderKind; providerId: string; input: unknown }>;
  workspacePath?: string;
  env?: Record<string, string | undefined>;
}): ProviderBatchEstimate {
  const steps: ProviderCallEstimate[] = [];
  // Prospective spend from earlier steps in THIS batch, per provider id. Added on top of the
  // ledger total so a later step is judged against the world its predecessors will have created.
  const prospectiveById = new Map<string, number>();
  let capLimit: number | null = null;
  let capSpent: number | null = null;
  let capGroup: string[] = [];
  let batchRefusal: EstimateRefusal | undefined;
  let batchRefusalScope: CapRefusalScope | undefined;
  let refusedAtStep: number | undefined;

  const noteRefusal = (index: number, refusal: EstimateRefusal, scope?: CapRefusalScope) => {
    if (batchRefusal === undefined) { batchRefusal = refusal; batchRefusalScope = scope; refusedAtStep = index; }
  };

  for (const [index, call] of params.calls.entries()) {
    const normalizedProviderId = normalizeProviderId(call.kind, call.providerId);
    // persistMigration:false — an estimate must not rewrite providers.json.
    const resolved = resolveProviderForKind({ ...params, flagProviderId: normalizedProviderId, kind: call.kind, env: params.env, persistMigration: false });
    const fallbackId = normalizedProviderId ?? `${call.kind}.mock`;
    const adapter = getProvider<unknown, unknown>(resolved?.id ?? fallbackId);
    if (!adapter) {
      steps.push({ providerId: resolved?.id ?? fallbackId, tier: 'paid', cost: estimateFallback(), wouldRefuse: true, refusal: 'provider-not-found' });
      noteRefusal(index, 'provider-not-found');
      continue;
    }
    if (resolved?.enabled === false) {
      // runProvider refuses a disabled provider before it does anything else, so reporting this
      // one as admissible would promise a call that cannot run — and the remedy is not the cap.
      steps.push({ providerId: resolved.id, tier: resolved.tier, cost: estimateFallback(), wouldRefuse: true, refusal: 'provider-disabled' });
      noteRefusal(index, 'provider-disabled');
      continue;
    }
    const provider = resolved ?? syntheticProvider(call.kind, fallbackId, adapter);
    const cost = adapter.estimateCost(call.input, provider);
    const group = capGroupFor(provider.id);
    if (capGroup.length === 0) capGroup = group;

    const addProspective = () => {
      if (cost.estimated != null) prospectiveById.set(provider.id, (prospectiveById.get(provider.id) ?? 0) + cost.estimated);
    };

    // Cap enforcement is paid-tier and USD only, exactly as in runProvider: a non-USD estimate
    // is never compared against a USD ceiling.
    if (provider.tier !== 'paid' || !params.workspacePath || cost.currency !== 'USD') {
      steps.push({ providerId: provider.id, tier: provider.tier, cost, wouldRefuse: false });
      addProspective();
      continue;
    }
    const paidCaps = readWorkspaceSettings(params.workspacePath).value.paidCaps;
    const capRoot = CAP_INHERITS_FROM[provider.id] ?? provider.id;
    const ownCap = paidCaps[provider.id];
    const groupCap = paidCaps[capRoot];
    const limit = ownCap ?? groupCap;
    if (typeof limit !== 'number') {
      steps.push({ providerId: provider.id, tier: provider.tier, cost, wouldRefuse: false });
      addProspective();
      continue;
    }

    // UNCONDITIONAL GROUP PREFLIGHT, matching runProvider: whenever ANY cap applies it totals the
    // whole group first and refuses if that total cannot be computed. Scanning only the capped
    // id here would let the estimator admit a call that execution then refuses on a ledger it
    // could not read.
    let ledgerGroupSpend: number;
    try {
      ledgerGroupSpend = providerEstimatedSpend(params.workspacePath, group);
    } catch {
      capLimit = capLimit == null ? limit : Math.min(capLimit, limit);
      capSpent = null;
      steps.push({ providerId: provider.id, tier: provider.tier, cost, wouldRefuse: true, refusal: 'ledger-unreadable' });
      noteRefusal(index, 'ledger-unreadable');
      continue;
    }

    const prospectiveIn = (ids: readonly string[]) => ids.reduce((sum, id) => sum + (prospectiveById.get(id) ?? 0), 0);
    // `ledger` is what has ALREADY been billed (what the user is shown); `spent` adds this
    // batch's earlier steps and is what the admission check compares. Keeping them apart is why
    // the reported "spent" does not silently include money nobody has been charged yet.
    const checks: Array<{ limit: number; ledger: number; spent: number }> = [];
    if (typeof groupCap === 'number') checks.push({ limit: groupCap, ledger: ledgerGroupSpend, spent: ledgerGroupSpend + prospectiveIn(group) });
    if (typeof ownCap === 'number' && provider.id !== capRoot) {
      const ownLedger = providerEstimatedSpend(params.workspacePath, provider.id);
      checks.push({ limit: ownCap, ledger: ownLedger, spent: ownLedger + prospectiveIn([provider.id]) });
    }
    if (checks.length === 0) {
      const ownLedger = providerEstimatedSpend(params.workspacePath, provider.id);
      checks.push({ limit, ledger: ownLedger, spent: ownLedger + prospectiveIn([provider.id]) });
    }

    // Report the tightest ceiling the batch is up against.
    const binding = checks.reduce((tightest, check) => (check.limit - check.spent < tightest.limit - tightest.spent ? check : tightest));
    if (capLimit == null || binding.limit - binding.spent < capLimit - (capSpent ?? 0)) { capLimit = binding.limit; capSpent = binding.ledger; }

    // FAIL CLOSED on an unknown estimate under a cap — the same rule the engine applies.
    if (cost.estimated == null) {
      steps.push({ providerId: provider.id, tier: provider.tier, cost, wouldRefuse: true, refusal: 'unknown-estimate' });
      noteRefusal(index, 'unknown-estimate');
      continue;
    }
    const estimated = cost.estimated;
    const wouldRefuse = checks.some((check) => check.spent + estimated > check.limit);
    // Alone-vs-sequence: compare against the LEDGER total (what is already billed) instead of
    // ledger+prospective. Breaching that means this call is unaffordable by itself; breaching
    // only the prospective figure means the batch, not the call, is what does not fit.
    const scope: CapRefusalScope | undefined = wouldRefuse
      ? (checks.some((check) => check.ledger + estimated > check.limit) ? 'step-alone' : 'sequence-only')
      : undefined;
    steps.push({ providerId: provider.id, tier: provider.tier, cost, wouldRefuse, ...(wouldRefuse ? { refusal: 'cap-exceeded' as const, refusalScope: scope } : {}) });
    if (wouldRefuse) noteRefusal(index, 'cap-exceeded', scope);
    addProspective();
  }

  return {
    steps,
    cap: { limit: capLimit, spent: capSpent, group: capGroup },
    wouldRefuse: batchRefusal !== undefined,
    ...(batchRefusal !== undefined ? { refusal: batchRefusal, refusedAtStep, ...(batchRefusalScope ? { refusalScope: batchRefusalScope } : {}) } : {})
  };
}

/** Single-call convenience over {@link estimateProviderCalls}. */
export function estimateProviderCall<Input>(params: SettingsPathsInput & {
  kind: ProviderKind;
  providerId: string;
  input: Input;
  workspacePath?: string;
  env?: Record<string, string | undefined>;
}): ProviderBatchEstimate {
  const { kind, providerId, input, ...rest } = params;
  return estimateProviderCalls({ ...rest, calls: [{ kind, providerId, input }] });
}

export async function runProvider<Input, Output>(input: RunProviderInput<Input>): Promise<ProviderRunEnvelope<Output>> {
  const normalizedProviderId = normalizeProviderId(input.kind, input.providerId);
  const resolved = resolveProviderForKind({ ...input, flagProviderId: normalizedProviderId, kind: input.kind, env: input.env });
  if (resolved?.enabled === false) {
    const requestId = input.requestId ?? `provider_${randomUUID().replace(/-/g, '_')}`;
    const err = new SettingsError('provider_disabled', `Provider is disabled: ${resolved.id}`);
    return { ok: false, requestId, providerId: resolved.id, kind: input.kind, error: providerErrorEnvelope(err, { providerId: resolved.id, requestId }), cost: estimateFallback() };
  }
  const fallbackId = normalizedProviderId ?? `${input.kind}.mock`;
  const adapter = getProvider<Input, Output>(resolved?.id ?? fallbackId);
  if (!adapter) {
    const requestId = input.requestId ?? `provider_${randomUUID().replace(/-/g, '_')}`;
    const err = new SettingsError('provider_not_found', `Provider adapter not found: ${resolved?.id ?? fallbackId}`);
    return { ok: false, requestId, providerId: resolved?.id ?? fallbackId, kind: input.kind, error: providerErrorEnvelope(err, { providerId: resolved?.id ?? fallbackId, requestId }), cost: estimateFallback() };
  }
  const provider = resolved ?? syntheticProvider(input.kind, fallbackId, adapter);
  const requestId = input.requestId ?? `provider_${randomUUID().replace(/-/g, '_')}`;
  const createdAt = nowIso();
  const cost = adapter.estimateCost(input.input, provider);
  const type = input.requestType ?? input.kind;

  // Paid spend cap — WorkspaceSettings.paidCaps holds an optional USD ceiling
  // per provider id. If this call's estimate would push the provider's
  // cumulative estimated spend over the cap, block it here: before any provider
  // call, before any ledger write. Failed/rejected past calls do not count
  // (see providerEstimatedSpend). Local-tier providers are never capped.
  //
  // Currency-aware: cap enforcement only applies when cost.currency === 'USD'.
  // Non-USD currencies (e.g. 'CREDITS' for Cartesia infill) are not compared to
  // a USD ceiling — doing so would fabricate a nonsensical comparison. The ledger
  // still records the cost honestly; the user can review credit usage there.
  if (provider.tier === 'paid' && input.workspacePath && cost.currency === 'USD') {
    const paidCaps = readWorkspaceSettings(input.workspacePath).value.paidCaps;
    // HIDDEN providers inherit the cap of the user-facing provider they share an account with.
    // `clone.elevenlabs` and `tts.elevenlabs-sts` are internal ids the user never sees, so they
    // never appear in the Settings cap UI — without inheritance a cap on `tts.elevenlabs` would
    // silently fail to bound the very calls the clone chain makes most of.
    // A cap covers a GROUP, not a single id. The group is the user-facing provider plus every
    // hidden provider that inherits its cap — they all bill the same account, so totalling only
    // the current id would let TTS, speech-to-speech and clone EACH spend the whole ceiling.
    const capRoot = CAP_INHERITS_FROM[provider.id] ?? provider.id;
    const capGroup = [capRoot, ...Object.keys(CAP_INHERITS_FROM).filter((id) => CAP_INHERITS_FROM[id] === capRoot)];
    const ownCap = paidCaps[provider.id];
    const groupCap = paidCaps[capRoot];
    const cap = ownCap ?? groupCap;
    if (typeof cap === 'number') {
      // The spend total can REFUSE to be computed (an unreadable ledger, or historical rows that
      // record a paid call this cap cannot price or attribute). That is a refusal to admit the
      // call, not an internal error — surface it as the cap error the caller already handles,
      // with a message that says what needs attention.
      try { providerEstimatedSpend(input.workspacePath, capGroup); }
      catch (err) {
        return {
          ok: false, requestId, providerId: provider.id, kind: input.kind, cost,
          error: {
            code: 'paid_cap_exceeded',
            message: `Cannot enforce the spend cap for ${provider.id}: the provider ledger needs attention.`,
            problem: `Cannot enforce the spend cap for ${provider.id}.`,
            cause: err instanceof Error ? err.message : String(err),
            fix: 'Repair or archive logs/provider-requests.jsonl in this workspace, or remove the spend cap for this provider.',
            providerId: provider.id,
            requestId
          }
        };
      }
      // Spend is aggregated across the group whenever the cap being enforced is the GROUP's.
      // An explicit per-provider cap is additionally checked against that provider alone below,
      // so configuring both a group ceiling and a tighter per-provider one behaves as written.
      const spent = providerEstimatedSpend(input.workspacePath, typeof groupCap === 'number' ? capGroup : provider.id);
      // FAIL CLOSED on an unknown estimate: treating null as 0 lets an unbounded number of
      // uncosted calls slip past a configured ceiling, which is exactly what the ceiling exists
      // to stop. A provider that cannot estimate must either be given a costPerUnit or be run
      // without a cap — never billed silently against one.
      if (cost.estimated == null) {
        return {
          ok: false, requestId, providerId: provider.id, kind: input.kind, cost,
          error: {
            code: 'paid_cap_exceeded',
            message: `Cannot enforce the spend cap for ${provider.id}: this call's cost is unknown.`,
            problem: `Cannot enforce the spend cap for ${provider.id}.`,
            cause: `A $${cap.toFixed(2)} cap is configured, but this provider cannot estimate the call's cost, so it cannot be counted against the cap.`,
            fix: `Set a costPerUnit amount for ${provider.id} in Settings so calls can be costed, or remove the spend cap for it.`,
            providerId: provider.id,
            requestId
          }
        };
      }
      const estimate = cost.estimated;
      // Both ceilings apply when both are configured: the group total, and (if the user set one
      // for this exact id) that provider's own.
      const checks: Array<{ limit: number; spent: number; scope: string }> = [];
      if (typeof groupCap === 'number') checks.push({ limit: groupCap, spent: providerEstimatedSpend(input.workspacePath, capGroup), scope: capGroup.length > 1 ? `${capRoot} (with ${capGroup.length - 1} linked provider(s))` : capRoot });
      if (typeof ownCap === 'number' && provider.id !== capRoot) checks.push({ limit: ownCap, spent: providerEstimatedSpend(input.workspacePath, provider.id), scope: provider.id });
      if (checks.length === 0) checks.push({ limit: cap, spent, scope: provider.id });
      // Honored only for a breach: an unreadable ledger or an unpriceable call above already
      // refused this call before reaching here.
      const grant = input.admission;
      const admissionWindow = grant && grant.capSpentAtAdmission != null && Number.isFinite(grant.capSpentAtAdmission) && Number.isFinite(grant.chainTotal)
        ? grant.capSpentAtAdmission + grant.chainTotal
        : null;
      const coveredByGrant = !!grant
        && Number.isFinite(grant.grantedEstimate)
        && estimate <= grant.grantedEstimate
        && grant.currency === cost.currency
        && grant.providerId === provider.id
        && admissionWindow != null
        // ONE CEILING ONLY. `capSpentAtAdmission` is a baseline measured in ONE scope — whichever
        // ceiling the admission found binding — and the grant carries no record of which. With a
        // single check the scopes agree by construction. With two (a group cap AND an explicit
        // cap on this exact id) they may not, and comparing a group-scoped baseline against an
        // own-scoped ledger — or the reverse — either deadens the grant silently or bounds it
        // against the wrong number. Refusing to honor is the fail-closed answer: the call falls
        // back to the live check, which is correct, just less forgiving.
        && checks.length === 1
        // The ceiling must still fit inside the observed window — this is what stops a second
        // concurrent chain in the same project from riding its own grant past a cap the first
        // one has meanwhile consumed.
        && checks.every((check) => check.spent + estimate <= admissionWindow);
      // A grant that was offered and NOT honored is worth seeing: it means a chain is about to
      // be refused mid-flight, which is the stranding grants exist to prevent.
      //
      // Note also that ANY unrelated spend in this workspace between admission and this call
      // narrows the window and can deaden the grant — restoring the stranding for that chain.
      // Accepted: the alternative is reserving spend, which a single-user local-first app does
      // not justify.
      // Narrowed to the cases worth seeing: a grant addressed to THIS call that the window or
      // the scope rule declined. A grant meant for another step or another currency is not a
      // near-miss, it is simply not this call's grant.
      if (grant && !coveredByGrant && grant.providerId === provider.id && grant.currency === cost.currency && breachedWithoutGrant(checks, estimate)) {
        // eslint-disable-next-line no-console
        console.warn(`[provider] admission grant not honored for ${provider.id} (request ${requestId}): estimate ${estimate}, granted ${grant.grantedEstimate}, window ${admissionWindow ?? 'none'}, ceilings ${checks.length}`);
      }
      const breached = coveredByGrant ? undefined : checks.find((check) => check.spent + estimate > check.limit);
      if (breached) {
        return {
          ok: false,
          requestId,
          providerId: provider.id,
          kind: input.kind,
          cost,
          error: {
            code: 'paid_cap_exceeded',
            message: `Paid spend cap reached for ${breached.scope}.`,
            problem: `Paid spend cap reached for ${breached.scope}.`,
            cause: `Cumulative estimated spend $${breached.spent.toFixed(4)} plus this call's $${estimate.toFixed(4)} would exceed the configured $${breached.limit.toFixed(2)} cap.`,
            fix: 'Raise the spend cap for this provider in Settings, or switch to a local provider.',
            providerId: provider.id,
            requestId
          }
        };
      }
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 60000);
  const append = (status: 'started' | 'succeeded' | 'failed', extra: Record<string, unknown> = {}) => {
    appendProviderRequestEvent(input.workspacePath, {
      requestId,
      type,
      projectId: input.projectId ?? '',
      provider: provider.id,
      operationId: input.operationId ?? '',
      status,
      input: boundedLedgerOutput(adapter.ledgerInput ? adapter.ledgerInput(input.input) : input.input) as Record<string, unknown>,
      cost: { currency: cost.currency, estimated: cost.estimated ?? null, actual: status === 'succeeded' ? cost.actual ?? null : cost.actual ?? undefined },
      createdAt,
      ...(status === 'started' ? {} : { completedAt: nowIso() }),
      ...extra
    } as any);
  };
  append('started');
  try {
    const secret = resolveProviderSecret(provider, input);
    const tempDir = mkdtempSync(join(tmpdir(), 'etvs-provider-'));
    try {
      const output = adapter.mode === 'http'
        ? await adapter.run(input.input, { provider, requestId, signal: controller.signal, guardedFetch, secret })
        : await adapter.run(input.input, { provider, requestId, signal: controller.signal, spawn, workspacePath: input.workspacePath, tempDir });
      const actualCost = adapter.actualCost?.(output, input.input, provider) ?? cost;
      const providerStatus = adapter.mode === 'http' && output && typeof output === 'object' && 'providerStatus' in output && typeof (output as { providerStatus?: unknown }).providerStatus === 'number'
        ? (output as { providerStatus: number }).providerStatus
        : undefined;
      append('succeeded', { output: boundedLedgerOutput(adapter.ledgerOutput ? adapter.ledgerOutput(output, input.input) : output) as Record<string, unknown>, cost: { currency: actualCost.currency, estimated: cost.estimated ?? null, actual: actualCost.actual ?? actualCost.estimated ?? null }, ...(providerStatus == null ? {} : { providerStatus }) });
      return { ok: true, requestId, providerId: provider.id, kind: input.kind, output, cost: { currency: actualCost.currency, estimated: cost.estimated ?? null, actual: actualCost.actual ?? actualCost.estimated ?? null } };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    const envelope = providerErrorEnvelope(controller.signal.aborted ? new ProviderExecutionError('Provider request timed out.', { code: 'provider_timeout' }) : err, { providerId: provider.id, requestId });
    append('failed', { error: envelope.message, providerStatus: envelope.statusCode });
    return { ok: false, requestId, providerId: provider.id, kind: input.kind, error: envelope, cost };
  } finally {
    clearTimeout(timeout);
  }
}
