import { z } from 'zod';
import { nowIso } from '../filesystem';

export const PROVIDER_REGISTRY_SCHEMA_VERSION = 1;

const ProviderRegistryV0Schema = z.object({
  providers: z.array(z.object({
    id: z.string(),
    kind: z.enum(['stt', 'tts', 'studio-sound', 'llm']),
    name: z.string(),
    tier: z.enum(['local', 'paid']),
    baseUrl: z.string().optional(),
    secretRef: z.string().optional(),
    default: z.boolean().optional(),
    enabled: z.boolean().optional(),
    source: z.enum(['manual', 'env-import']).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional()
  })).default([]),
  updatedAt: z.string().optional()
});

function rawVersion(raw: unknown): number {
  if (!raw || typeof raw !== 'object' || !('schemaVersion' in raw)) return 0;
  const value = Number((raw as { schemaVersion?: unknown }).schemaVersion);
  return Number.isInteger(value) ? value : 0;
}

export function migrateProviderRegistryToLatest(raw: unknown): unknown {
  const version = rawVersion(raw);
  if (version > PROVIDER_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported provider registry schemaVersion ${version}; this binary supports ${PROVIDER_REGISTRY_SCHEMA_VERSION}`);
  }
  if (version === PROVIDER_REGISTRY_SCHEMA_VERSION) return raw;
  const now = nowIso();
  const v0 = ProviderRegistryV0Schema.parse(raw);
  return {
    schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION,
    providers: v0.providers.map((provider) => ({
      schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      default: false,
      source: 'manual',
      ...provider,
      createdAt: provider.createdAt ?? now,
      updatedAt: provider.updatedAt ?? now
    })),
    updatedAt: v0.updatedAt ?? now
  };
}
