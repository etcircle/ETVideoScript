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
import { getProvider } from './registry';
import type { MediaProvider, ProviderCost, ProviderErrorCode, ProviderErrorEnvelope, ProviderRunEnvelope } from './contract';

export type RunProviderInput<Input> = SettingsPathsInput & {
  kind: ProviderKind;
  input: Input;
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
  if (!id) return undefined;
  return id.includes('.') ? id : `${kind}.${id}`;
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
    const cap = readWorkspaceSettings(input.workspacePath).value.paidCaps[provider.id];
    if (typeof cap === 'number') {
      const spent = providerEstimatedSpend(input.workspacePath, provider.id);
      const estimate = cost.estimated ?? 0;
      if (spent + estimate > cap) {
        return {
          ok: false,
          requestId,
          providerId: provider.id,
          kind: input.kind,
          cost,
          error: {
            code: 'paid_cap_exceeded',
            message: `Paid spend cap reached for ${provider.id}.`,
            problem: `Paid spend cap reached for ${provider.id}.`,
            cause: `Cumulative estimated spend $${spent.toFixed(4)} plus this call's $${estimate.toFixed(4)} would exceed the configured $${cap.toFixed(2)} cap.`,
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
