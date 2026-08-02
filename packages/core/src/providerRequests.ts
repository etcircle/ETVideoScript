import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { assertInside } from './filesystem';
import { isVoicePatchStepRecord, parseProviderRequestRow, ProviderRequest, ProviderRequestSchema, type VoicePatchStepRecord } from './schemas';
import { loadManifestV3 } from './manifest/io';
import type { ManifestV3 } from './manifest/schema';
import type { Operation as ManifestOperation } from './operations/registry';

export { ProviderRequestIdSchema } from './schemas';

export type ProviderRequestStatus = ProviderRequest['status'];

export function providerRequestsPath(workspacePath: string): string {
  return assertInside(workspacePath, 'logs/provider-requests.jsonl');
}

/**
 * Append one ledger event, DURABLY.
 *
 * This log is the paid-idempotency record: a 'started' row written before a paid call is the
 * only thing that stops a retry from re-billing it. `appendFileSync` alone leaves that row in
 * the page cache, so a crash seconds later loses exactly the record whose absence permits a
 * second charge. fsync on the file (and best-effort on the directory) closes that window.
 */
export function appendProviderRequestEvent(workspacePath: string, event: ProviderRequest): ProviderRequest {
  const path = providerRequestsPath(workspacePath);
  mkdirSync(dirname(path), { recursive: true });
  // WRITES GO THROUGH THE SAME DISPATCHER AS READS. Parsing with an ordered union here would let
  // a row that spans two record families be appended (and silently stripped by whichever member
  // matched first), leaving a permanently mis-classified line in an append-only log. Validating
  // by exhaustive classification instead means a row that cannot be classified cleanly never
  // reaches the file. `migrateLegacy` is off: this process only ever writes current shapes.
  const parsed = parseProviderRequestRow(event, { migrateLegacy: false });
  if (!parsed.ok) throw new Error(`refusing to append an unclassifiable provider-request row: ${parsed.reason}`);
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, `${JSON.stringify(parsed.value)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    const dirFd = openSync(dirname(path), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* directory fsync is unsupported on some filesystems; the file fsync already landed */ }
  return parsed.value;
}

/**
 * Derived, schema-valid, bounded storage key for one paid step of a voice-patch chain
 * (S1b ⟨R1⟩). ProviderRequestIdSchema forbids colons and caps length at 128, so the natural
 * `${parentRequestId}:${step}` is not expressible — hash instead. 44 chars total.
 *
 * The hash is ONLY the key: `parentRequestId` and `step` are persisted as explicit fields on
 * the record, so nothing ever needs to reverse it.
 */
export function voicePatchStepRecordId(parentRequestId: string, step: 'tts' | 'sts'): string {
  return `vps-${createHash('sha256').update(`${parentRequestId}/${step}`).digest('hex').slice(0, 40)}`;
}

/**
 * The ACCOUNTING requestId for one paid step — the id the provider engine writes its cost rows
 * under. Deliberately distinct from the step RECORD id (⟨Q4⟩): the ledger's cost view and the
 * route's idempotency terminal are different concerns, and conflating their ids would make an
 * engine `succeeded` row look like proof that the route verified the artifact. It is not.
 */
export function voicePatchAccountingRequestId(parentRequestId: string, step: 'tts' | 'sts'): string {
  return `vpa-${createHash('sha256').update(`${parentRequestId}/${step}/accounting`).digest('hex').slice(0, 40)}`;
}

/** Every step record for one parent request, oldest first. STRICT: this gates paid calls. */
export function voicePatchStepRecords(workspacePath: string, parentRequestId: string): VoicePatchStepRecord[] {
  return readProviderRequests(workspacePath, { strict: true })
    .filter(isVoicePatchStepRecord)
    .filter((record) => record.parentRequestId === parentRequestId);
}

/**
 * The durable state of one step: its terminal if it has one, otherwise the 'started' marker,
 * otherwise null. A marker with NO terminal is the unknown-outcome case — the caller must NOT
 * re-bill it (a fresh user action with a new requestId is the only way to pay again).
 */
export function voicePatchStepState(workspacePath: string, parentRequestId: string, step: 'tts' | 'sts'): { terminal: VoicePatchStepRecord | null; started: boolean } {
  const records = voicePatchStepRecords(workspacePath, parentRequestId).filter((record) => record.step === step);
  const terminal = records.filter((record) => record.status !== 'started').at(-1) ?? null;
  return { terminal, started: records.some((record) => record.status === 'started') };
}

export function appendVoicePatchStepRecord(workspacePath: string, record: VoicePatchStepRecord): VoicePatchStepRecord {
  return appendProviderRequestEvent(workspacePath, record) as VoicePatchStepRecord;
}

const warnedProviderRequestLogs = new Set<string>();

/**
 * Raised by the STRICT reader when the ledger cannot be read in full. Callers that gate paid
 * calls on this log must treat it as fatal: a skipped line is a record that no longer says
 * "this was already billed".
 */
export class ProviderLedgerCorruptError extends Error {
  readonly code = 'provider-ledger-corrupt';
  constructor(path: string, detail: string) {
    super(`provider-ledger-corrupt: ${path} could not be read in full (${detail}). Refusing to proceed on a partial paid-call ledger — a missing record would permit a second charge.`);
    this.name = 'ProviderLedgerCorruptError';
  }
}

/**
 * `strict` makes malformed content FAIL CLOSED instead of being skipped, INCLUDING a truncated
 * final line (which the lenient reader tolerates as a normal interrupted-append artifact).
 *
 * Scoping, deliberately: strictness is opt-in per caller rather than the default, because this
 * log is shared with the legacy agent-WS sticky records and older workspaces are known to
 * contain lines that predate current schemas. Flipping the default would make those workspaces
 * unreadable — including for the read-only cost summary, which has no business refusing to
 * render. The paid-idempotency consumers (the S1b step-record readers, the execution snapshot,
 * the resolved range, and the clone-chain body-hash lookup) all pass `strict: true`; every
 * legacy reader keeps the lenient semantics it has always had.
 */
type ReadProviderRequestsOptions = { throwIfAllInvalid?: boolean; strict?: boolean };

function invalidReason(error: unknown): string {
  if (error && typeof error === 'object' && 'issues' in error) {
    const first = (error as { issues?: Array<{ path?: Array<string | number>; message?: string }> }).issues?.[0];
    if (first) return `${first.path?.join('.') || 'line'}: ${first.message || 'invalid provider request'}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function readProviderRequests(workspacePath: string, options: ReadProviderRequestsOptions = {}): ProviderRequest[] {
  const path = providerRequestsPath(workspacePath);
  if (!existsSync(path)) return [];
  const events: ProviderRequest[] = [];
  let invalidCount = 0;
  let firstFailure = '';
  const lines = readFileSync(path, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch (err) {
      // A truncated FINAL line is the ordinary interrupted-append artifact and is tolerated by
      // the lenient reader — but a paid-idempotency consumer cannot tolerate it, because the
      // record it is missing may be the 'started' marker that stops a re-charge.
      if (options.strict) throw new ProviderLedgerCorruptError(path, `line ${index + 1} is not valid JSON`);
      if (index === lines.length - 1) continue;
      invalidCount += 1;
      firstFailure ||= invalidReason(err);
      continue;
    }
    // ONE dispatcher for both modes (parseProviderRequestRow): a row is routed by its own
    // discriminators, so no schema can rescue a row that declared itself something else. Strict
    // mode additionally MIGRATES pre-schema history — the point of strictness is that no row is
    // silently skipped on a paid gate, not that old workspaces stop working.
    const parsed = parseProviderRequestRow(parsedJson, { migrateLegacy: options.strict === true });
    if (parsed.ok) events.push(parsed.value);
    else {
      if (options.strict) throw new ProviderLedgerCorruptError(path, `line ${index + 1}: ${parsed.reason}`);
      invalidCount += 1;
      firstFailure ||= parsed.reason;
    }
  }
  if (invalidCount > 0 && !warnedProviderRequestLogs.has(path)) {
    warnedProviderRequestLogs.add(path);
    console.warn(`Skipped ${invalidCount} invalid provider request log line${invalidCount === 1 ? '' : 's'} in ${path}; first failure: ${firstFailure}`);
  }
  if (options.throwIfAllInvalid && invalidCount > 0 && events.length === 0) {
    throw new Error(`Invalid provider request log: skipped ${invalidCount} invalid line${invalidCount === 1 ? '' : 's'}; first failure: ${firstFailure}`);
  }
  return events;
}

export type ProviderRequestCostSummaryRow = {
  requestId: string;
  provider: string;
  requestType: string;
  status: Exclude<ProviderRequestStatus, 'op_update_failed'>;
  currency: string;
  estimatedCost: number | null;
  actualCost: number | null;
  costDiverged: boolean;
  duration: { generatedSec?: number; requestedSec?: number; unit: 'seconds' } | null;
  timestamp: string;
  sourceAction: string;
  providerStatus: number | null;
  whyCostUnknown: string | null;
};

export type ProviderRequestProviderTotal = {
  provider: string;
  currency: string;
  estimatedTotal: number;
  actualTotal: number;
  count: number;
};

export type ProviderRequestCostSummary = {
  rows: ProviderRequestCostSummaryRow[];
  totalsByProvider: ProviderRequestProviderTotal[];
};

export type ProviderRequestSummaryContext = { manifest?: ManifestV3; operations?: ManifestOperation[] };

const COST_EPSILON = 0.000001;

type GenericProviderRequest = ProviderRequest & { type: string; cost: { currency: string; estimated?: number | null; actual?: number | null }; providerStatus?: number };

function isGenericProviderRequest(event: ProviderRequest): event is GenericProviderRequest {
  return 'type' in event;
}

function normalizeStatus(status: ProviderRequestStatus): ProviderRequestCostSummaryRow['status'] {
  return status === 'op_update_failed' ? 'failed' : status;
}

function legacyRequestType(event: ProviderRequest): string {
  if (isGenericProviderRequest(event)) return event.type;
  if (event.operationId) return event.operationId.replace(/_\d+$/, '') || event.operationId;
  return 'legacy';
}

function durationView(event: ProviderRequest): ProviderRequestCostSummaryRow['duration'] {
  // Step records are filtered out upstream (summarizeProviderRequests) and carry their duration
  // on `artifact`, not these legacy fields.
  if (isVoicePatchStepRecord(event)) return null;
  const generatedSec = event.durationGeneratedSec;
  const requestedSec = event.durationRequestedSec;
  if (generatedSec == null && requestedSec == null) return null;
  return {
    ...(generatedSec == null ? {} : { generatedSec }),
    ...(requestedSec == null ? {} : { requestedSec }),
    unit: 'seconds'
  };
}

function voicePatchDurationFromOperation(event: ProviderRequest, operations: ManifestOperation[] = []): ProviderRequestCostSummaryRow['duration'] {
  const operation = operations.find((op) => op.type === 'voice_patch' && op.providerRequestId === event.requestId);
  if (!operation || operation.type !== 'voice_patch') return null;
  const generatedSec = operation.durationGeneratedSec;
  const requestedSec = operation.durationRequestedSec;
  if (generatedSec == null && requestedSec == null) return null;
  return {
    ...(generatedSec == null ? {} : { generatedSec }),
    ...(requestedSec == null ? {} : { requestedSec }),
    unit: 'seconds'
  };
}

function unknownCostReason(event: ProviderRequest, estimated: number | null, actual: number | null): string | null {
  if (!isGenericProviderRequest(event)) return 'legacy/no-cost-record';
  if (estimated == null && actual == null) return 'cost-missing';
  if (estimated == null) return 'estimated-cost-missing';
  if (actual == null) return 'actual-cost-missing';
  return null;
}

function roundMoney(value: number): number {
  return Number(value.toFixed(6));
}

const TERMINAL_STATUSES = new Set<ProviderRequestStatus>(['succeeded', 'failed', 'rejected', 'op_update_failed']);

function eventTimestamp(event: ProviderRequest): string {
  return event.completedAt || event.createdAt;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestEvent(events: ProviderRequest[]): ProviderRequest {
  return [...events].sort((a, b) => timestampMs(eventTimestamp(a)) - timestampMs(eventTimestamp(b))).at(-1)!;
}

function latestTerminalOrLatestEvent(events: ProviderRequest[]): ProviderRequest {
  const terminal = events.filter((event) => TERMINAL_STATUSES.has(event.status));
  return latestEvent(terminal.length ? terminal : events);
}

function latestNonNullCost(events: ProviderRequest[], field: 'estimated' | 'actual'): number | null {
  const latest = [...events]
    .filter(isGenericProviderRequest)
    .filter((event) => event.cost[field] != null)
    .sort((a, b) => timestampMs(eventTimestamp(a)) - timestampMs(eventTimestamp(b)))
    .at(-1);
  return latest?.cost[field] ?? null;
}

function latestCurrency(events: ProviderRequest[], fallbackEvent: ProviderRequest): string {
  const latest = [...events]
    .filter(isGenericProviderRequest)
    .filter((event) => event.cost.currency)
    .sort((a, b) => timestampMs(eventTimestamp(a)) - timestampMs(eventTimestamp(b)))
    .at(-1);
  return latest?.cost.currency ?? (isGenericProviderRequest(fallbackEvent) ? fallbackEvent.cost.currency : 'USD');
}

export function summarizeProviderRequests(events: ProviderRequest[], context: ProviderRequestSummaryContext = {}): ProviderRequestCostSummary {
  const operations = context.operations ?? context.manifest?.operations ?? [];
  const byRequestId = new Map<string, ProviderRequest[]>();
  // Voice-patch STEP records are idempotency terminals, not cost rows (S1b ⟨Q4⟩): the paid
  // call they describe is billed under its own engine requestId, which is already in this
  // ledger. Including them would double-count every clone-chain patch in the cost table.
  for (const event of events) {
    if (isVoicePatchStepRecord(event)) continue;
    byRequestId.set(event.requestId, [...(byRequestId.get(event.requestId) ?? []), event]);
  }

  const rows = Array.from(byRequestId.values()).map((group) => {
    const latest = latestEvent(group);
    const statusEvent = latestTerminalOrLatestEvent(group);
    const generic = isGenericProviderRequest(latest);
    const estimatedCost = latestNonNullCost(group, 'estimated');
    const actualCost = latestNonNullCost(group, 'actual');
    const row: ProviderRequestCostSummaryRow = {
      requestId: latest.requestId,
      provider: latest.provider,
      requestType: legacyRequestType(latest),
      status: normalizeStatus(statusEvent.status),
      currency: latestCurrency(group, latest),
      estimatedCost,
      actualCost,
      costDiverged: estimatedCost != null && actualCost != null && Math.abs(actualCost - estimatedCost) > COST_EPSILON,
      duration: durationView(latest) ?? voicePatchDurationFromOperation(latest, operations),
      timestamp: eventTimestamp(latest),
      sourceAction: latest.operationId || (generic ? latest.type : legacyRequestType(latest)),
      providerStatus: generic ? latest.providerStatus ?? null : null,
      whyCostUnknown: unknownCostReason(latest, estimatedCost, actualCost)
    };
    return row;
  }).sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp));

  const totals = new Map<string, ProviderRequestProviderTotal>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.currency}`;
    const total = totals.get(key) ?? { provider: row.provider, currency: row.currency, estimatedTotal: 0, actualTotal: 0, count: 0 };
    total.estimatedTotal = roundMoney(total.estimatedTotal + (row.estimatedCost ?? 0));
    total.actualTotal = roundMoney(total.actualTotal + (row.actualCost ?? 0));
    total.count += 1;
    totals.set(key, total);
  }
  return { rows, totalsByProvider: Array.from(totals.values()).sort((a, b) => a.provider.localeCompare(b.provider) || a.currency.localeCompare(b.currency)) };
}

export function summarizeProviderRequestsForWorkspace(workspacePath: string): ProviderRequestCostSummary {
  let manifest: ManifestV3 | undefined;
  try { manifest = loadManifestV3(workspacePath); } catch {}
  return summarizeProviderRequests(readProviderRequests(workspacePath), { manifest });
}

export function latestProviderRequest(workspacePath: string, requestId: string, options: ReadProviderRequestsOptions = {}): ProviderRequest | null {
  const events = readProviderRequests(workspacePath, options).filter((event) => event.requestId === requestId);
  return events.at(-1) || null;
}

// Cumulative estimated USD spend for one provider id, from the per-workspace
// ledger — the basis for the paid spend cap. A request counts toward spend
// once it has fired a real paid call (the engine wrote a 'started' event) and
// has NOT terminated in a provider-call failure (status 'failed' is the
// engine's "provider call did not complete") or pre-call rejection. This is
// the rule the cap needs:
//
//  - 'approved' but no 'started': call has not fired; not yet committed.
//  - 'started' (still in flight): the call is committed; cap MUST reserve its
//    estimate so a sibling concurrent paid call can't also pass the cap check
//    and double-spend (especially relevant after P4-1c, which lets two
//    different-requestId paid calls run in parallel).
//  - 'succeeded': call billed; counted.
//  - 'op_update_failed' after 'succeeded': provider call billed, post-hoc op
//    attach failed; still counted.
//  - 'failed': provider call did not complete; not counted.
//  - 'rejected' (pre-call): user declined before any call fired; not counted.
//
// Summary rows alone can't distinguish 'succeeded → op_update_failed' from
// 'failed' (latestTerminalOrLatestEvent collapses both to 'failed' for the
// row), so this walks the raw event stream.
export function providerEstimatedSpend(workspacePath: string, providerId: string | string[]): number {
  // A cap can cover a GROUP of provider ids (a user-facing provider plus the hidden ones that
  // bill the same account), so spend is summed over whichever ids the caller is enforcing.
  const providerIds = new Set(Array.isArray(providerId) ? providerId : [providerId]);
  // STRICT: this total is the admission decision for a paid call. A skipped row undercounts the
  // cap and lets spending past the ceiling the user set, so an unreadable ledger must refuse the
  // call rather than quietly report a smaller number.
  const events = readProviderRequests(workspacePath, { strict: true });

  // Any of these signals that a real paid call fired (or was logged as having
  // fired in a legacy single-row generic entry). 'started' is the current
  // engine; 'called' is the legacy status; 'succeeded'/'op_update_failed'
  // imply the call must have fired because the engine wrote them after the
  // provider response.
  const CALL_FIRED_STATUSES = new Set<ProviderRequest['status']>(['started', 'called', 'succeeded', 'op_update_failed']);

  // FAIL CLOSED on money this cap cannot account for — for EVERY record family, not just
  // migrated history. The two holes are the same shape in each family:
  //   • UNATTRIBUTED: a fired row whose provider is blank or 'unknown' belongs to no group, so
  //     every group silently counts it as zero. It may well be ours.
  //   • UNPRICED: a fired row FOR the capped group with no estimate anywhere also counts as
  //     zero, and a schema-valid Legacy row has no cost field at all.
  // Refusing is the only honest answer: there is spending in the ledger the ceiling cannot see.
  // (Never-fired rows are not spending, so they contribute 0 and never block.)
  const unattributed = (event: ProviderRequest) => {
    const name = (event.provider ?? '').trim();
    return name === '' || name === 'unknown';
  };
  const nonStepByRequestId = new Map<string, ProviderRequest[]>();
  for (const event of events) {
    // Step records carry no cost (the engine's accounting row does) — skip them so a
    // clone-chain patch is never counted twice against the spend cap.
    if (isVoicePatchStepRecord(event)) continue;
    const existing = nonStepByRequestId.get(event.requestId);
    if (existing) existing.push(event);
    else nonStepByRequestId.set(event.requestId, [event]);
  }
  // The row family a lifecycle row belongs to, for consistency checking within one requestId.
  const familyOf = (event: ProviderRequest) => ('textHash' in event ? 'legacy' : 'generic');
  const rowEstimate = (event: ProviderRequest) => (event as { cost?: { estimated?: number | null } }).cost?.estimated ?? null;

  let spent = 0;
  for (const group of nonStepByRequestId.values()) {
    // FIRED rows are the ones that record real spending, and they are also the rows that carry
    // the cost. Everything below is decided from THEM — not from the first lifecycle row (whose
    // provider may be a pre-execution shorthand) and not from the latest row (which can be a
    // later, cheaper or unpriced entry that launders an earlier charge).
    const fired = group.filter((event) => CALL_FIRED_STATUSES.has(event.status));
    if (fired.length === 0) continue; // never fired ⇒ contributes 0 and never blocks

    // A single requestId describing calls to different providers, or spanning record families,
    // cannot be reconciled into one spend figure — whichever row we believed would silently
    // discard the other.
    const firedProviders = new Set(fired.map((event) => event.provider));
    if (firedProviders.size > 1) {
      throw new ProviderLedgerCorruptError(
        providerRequestsPath(workspacePath),
        `requestId ${fired[0]!.requestId} records paid calls attributed to more than one provider (${[...firedProviders].join(', ')}) — its spend cannot be attributed to a single cap`
      );
    }
    const firedFamilies = new Set(fired.map(familyOf));
    if (firedFamilies.size > 1) {
      throw new ProviderLedgerCorruptError(
        providerRequestsPath(workspacePath),
        `requestId ${fired[0]!.requestId} mixes ${[...firedFamilies].join(' and ')} rows for the same paid call — its lifecycle cannot be reconciled`
      );
    }
    const groupProvider = fired[0]!.provider;

    // Attribution is checked for EVERY fired group, whether or not it looks like ours: an
    // unattributed row belongs to no group, so without this it is counted as zero by all of them.
    if (unattributed(fired[0]!)) {
      throw new ProviderLedgerCorruptError(
        providerRequestsPath(workspacePath),
        `requestId ${fired[0]!.requestId} records a paid call with no provider attribution — it belongs to no spend group, so a cap cannot account for it`
      );
    }
    if (!providerIds.has(groupProvider)) continue;

    // EVERY fired row must be priced, not merely one of them: a fired legacy row with no cost at
    // all, followed by a priced row under the same requestId, previously collapsed to the priced
    // one and the unpriced charge vanished.
    const unpriced = fired.find((event) => rowEstimate(event) === null);
    if (unpriced) {
      throw new ProviderLedgerCorruptError(
        providerRequestsPath(workspacePath),
        `requestId ${unpriced.requestId} records a paid call to ${groupProvider} with no cost estimate — it cannot be counted against the cap`
      );
    }

    // MONOTONIC SUCCEEDED SPEND. Once a call has succeeded for cost X, no later row may reduce
    // this group's contribution below X: a subsequent 'failed' row means a LATER attempt failed,
    // not that the completed one was refunded, and a later cheaper row does not undo the charge.
    const succeededFloor = fired
      .filter((event) => event.status === 'succeeded' || event.status === 'op_update_failed')
      .reduce<number | null>((max, event) => {
        const estimate = rowEstimate(event);
        return estimate === null ? max : Math.max(max ?? 0, estimate);
      }, null);

    if (succeededFloor !== null) {
      spent += Math.max(succeededFloor, latestNonNullCost(group, 'estimated') ?? 0);
      continue;
    }
    // No success on record: an in-flight call still reserves its estimate, but a terminal
    // failure or a pre-call rejection did not spend anything.
    //
    // ORDER MATTERS, and "is there a failure anywhere?" is the wrong question: a retry writes
    // started → failed → started, so the historical failure is not the group's outcome — the
    // newer 'started' is a call in flight whose estimate must still be reserved, or two
    // concurrent retries could each pass the cap. Compare the LATEST fired row against the
    // LATEST failure by timestamp, breaking ties on ledger position (the group preserves file
    // order, and same-millisecond rows are common).
    const latestIndexWhere = (predicate: (event: ProviderRequest) => boolean): number | null => {
      let best: number | null = null;
      for (let index = 0; index < group.length; index++) {
        if (!predicate(group[index]!)) continue;
        if (best === null) { best = index; continue; }
        const candidate = timestampMs(eventTimestamp(group[index]!));
        const incumbent = timestampMs(eventTimestamp(group[best]!));
        if (candidate > incumbent || (candidate === incumbent && index > best)) best = index;
      }
      return best;
    };
    const latestFiredIndex = latestIndexWhere((event) => CALL_FIRED_STATUSES.has(event.status));
    const latestFailureIndex = latestIndexWhere((event) => event.status === 'failed' || event.status === 'rejected');
    if (latestFailureIndex !== null && latestFiredIndex !== null) {
      const failureAt = timestampMs(eventTimestamp(group[latestFailureIndex]!));
      const firedAt = timestampMs(eventTimestamp(group[latestFiredIndex]!));
      const failureIsNewer = failureAt > firedAt || (failureAt === firedAt && latestFailureIndex > latestFiredIndex);
      if (failureIsNewer) continue;
    }
    // Reserve the LATEST fired row's estimate — that is the attempt currently outstanding.
    spent += (latestFiredIndex !== null ? rowEstimate(group[latestFiredIndex]!) : null) ?? latestNonNullCost(group, 'estimated') ?? 0;
  }
  return roundMoney(spent);
}
