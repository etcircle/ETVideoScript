import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertInside } from './filesystem';
import { ProviderRequest, ProviderRequestSchema } from './schemas';
import { loadManifestV3 } from './manifest/io';
import type { ManifestV3 } from './manifest/schema';
import type { Operation as ManifestOperation } from './operations/registry';

export { ProviderRequestIdSchema } from './schemas';

export type ProviderRequestStatus = ProviderRequest['status'];

export function providerRequestsPath(workspacePath: string): string {
  return assertInside(workspacePath, 'logs/provider-requests.jsonl');
}

export function appendProviderRequestEvent(workspacePath: string, event: ProviderRequest): ProviderRequest {
  const path = providerRequestsPath(workspacePath);
  mkdirSync(dirname(path), { recursive: true });
  const parsed = ProviderRequestSchema.parse(event);
  appendFileSync(path, `${JSON.stringify(parsed)}\n`);
  return parsed;
}

const warnedProviderRequestLogs = new Set<string>();

type ReadProviderRequestsOptions = { throwIfAllInvalid?: boolean };

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
      if (index === lines.length - 1) continue;
      invalidCount += 1;
      firstFailure ||= invalidReason(err);
      continue;
    }
    const parsed = ProviderRequestSchema.safeParse(parsedJson);
    if (parsed.success) events.push(parsed.data);
    else {
      invalidCount += 1;
      firstFailure ||= invalidReason(parsed.error);
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
  for (const event of events) byRequestId.set(event.requestId, [...(byRequestId.get(event.requestId) ?? []), event]);

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

export function latestProviderRequest(workspacePath: string, requestId: string): ProviderRequest | null {
  const events = readProviderRequests(workspacePath).filter((event) => event.requestId === requestId);
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
export function providerEstimatedSpend(workspacePath: string, providerId: string): number {
  const events = readProviderRequests(workspacePath);
  const byRequestId = new Map<string, ProviderRequest[]>();
  for (const event of events) {
    if (event.provider !== providerId) continue;
    const group = byRequestId.get(event.requestId);
    if (group) group.push(event);
    else byRequestId.set(event.requestId, [event]);
  }
  // Any of these signals that a real paid call fired (or was logged as having
  // fired in a legacy single-row generic entry). 'started' is the current
  // engine; 'called' is the legacy status; 'succeeded'/'op_update_failed'
  // imply the call must have fired because the engine wrote them after the
  // provider response.
  const CALL_FIRED_STATUSES = new Set<ProviderRequest['status']>(['started', 'called', 'succeeded', 'op_update_failed']);
  let spent = 0;
  for (const group of byRequestId.values()) {
    if (!group.some((event) => CALL_FIRED_STATUSES.has(event.status))) continue;
    const terminalEvents = group.filter((event) => TERMINAL_STATUSES.has(event.status));
    if (terminalEvents.length > 0) {
      const terminal = latestEvent(terminalEvents);
      if (terminal.status === 'failed' || terminal.status === 'rejected') continue;
    }
    spent += latestNonNullCost(group, 'estimated') ?? 0;
  }
  return roundMoney(spent);
}
