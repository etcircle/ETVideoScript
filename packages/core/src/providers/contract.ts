import type { ProviderKind, ProviderRecord, ProviderTier } from '../providerSettings';
import type { guardedFetch } from '../network/guardedFetch';

export type ProviderCost = {
  // 'USD' for standard providers; 'CREDITS' for Cartesia infill (which bills in credits, not USD).
  // The spend-cap in engine.ts is USD-only and skips non-USD currencies; ledger records
  // the currency honestly rather than fabricating a USD equivalent.
  currency: 'USD' | 'CREDITS' | string;
  estimated?: number | null;
  actual?: number | null;
};

export type ProviderCapabilities = {
  polling?: boolean;
  cancel?: boolean;
  maxDurationSec?: number;
  outputFormats?: string[];
};

export type ProviderRunEnvelope<Output> = {
  ok: true;
  requestId: string;
  providerId: string;
  kind: ProviderKind;
  output: Output;
  cost: ProviderCost;
} | {
  ok: false;
  requestId: string;
  providerId: string;
  kind: ProviderKind;
  error: ProviderErrorEnvelope;
  cost: ProviderCost;
};

export type ProviderErrorCode =
  | 'provider_auth_failed'
  | 'ssrf_blocked'
  | 'provider_timeout'
  | 'provider_bad_request'
  | 'provider_unavailable'
  | 'model_missing'
  | 'provider_not_found'
  | 'provider_disabled'
  | 'paid_cap_exceeded'
  | 'invalid_settings';

export type ProviderErrorEnvelope = {
  code: ProviderErrorCode;
  message: string;
  problem: string;
  cause: string;
  fix: string;
  providerId?: string;
  statusCode?: number;
  requestId?: string;
  details?: unknown;
};

export type ProviderRunBaseContext = {
  provider: ProviderRecord;
  requestId: string;
  signal: AbortSignal;
};

export type HttpProviderRunContext = ProviderRunBaseContext & {
  guardedFetch: typeof guardedFetch;
  secret: string | undefined;
};

export type LocalProviderRunContext = ProviderRunBaseContext & {
  spawn: typeof import('node:child_process').spawn;
  workspacePath: string;
  tempDir: string;
};

export type MediaProviderBase<Input, Output> = {
  id: string;
  kind: ProviderKind;
  tier: ProviderTier;
  displayName: string;
  capabilities?: ProviderCapabilities;
  availableModels?: readonly string[];
  estimateCost(input: Input, provider: ProviderRecord): ProviderCost;
  actualCost?(output: Output, input: Input, provider: ProviderRecord): ProviderCost;
  ledgerInput?(input: Input): unknown;
  ledgerOutput?(output: Output, input: Input): unknown;
};

export type HttpMediaProvider<Input, Output> = MediaProviderBase<Input, Output> & {
  mode: 'http';
  run(input: Input, context: HttpProviderRunContext): Promise<Output>;
  healthCheck?(context: HttpProviderRunContext): Promise<void>;
};

export type LocalMediaProvider<Input, Output> = MediaProviderBase<Input, Output> & {
  mode: 'local';
  run(input: Input, context: LocalProviderRunContext): Promise<Output>;
  healthCheck?(context: LocalProviderRunContext): Promise<void>;
};

export type MediaProvider<Input = unknown, Output = unknown> = HttpMediaProvider<Input, Output> | LocalMediaProvider<Input, Output>;
