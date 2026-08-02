import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { atomicWriteJson, nowIso } from './filesystem';
import { migrateProviderRegistryToLatest, PROVIDER_REGISTRY_SCHEMA_VERSION } from './migrations/provider-registry';
import { VoiceReferenceSchema } from './voiceReference';

export const SETTINGS_ERROR_CODES = [
  'provider_unreachable',
  'auth_failed',
  'model_missing',
  'tls_failed',
  'invalid_base_url',
  'ssrf_blocked',
  'provider_disabled',
  'settings_stale'
] as const;

export type SettingsErrorCode = typeof SETTINGS_ERROR_CODES[number] | 'provider_not_found' | 'voice_not_found' | 'invalid_settings' | 'paid_default_requires_ack';

export class SettingsError extends Error {
  code: SettingsErrorCode;
  details?: unknown;
  constructor(code: SettingsErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
    this.details = details;
  }
}

// NOTE: 'infill' is an internal capability of voice_patch (reference-conditioned
// speech generation). It is NOT a user-selectable task kind and must not appear
// in settings UI or workspace defaults. The 7 user-facing provider kinds are:
//   stt, tts, studio-sound, llm, image-gen, video-gen, music-gen
// 'infill' is added here solely so the provider registry and runProvider can
// handle infill.cartesia records with proper cost-cap and ledger tracking.
// (Layer 2 TODO: also reject kind==='infill' in the user-facing settings ROUTES
// so the public API matches this "hidden kind" contract — see Hermes impl-review.)
// 'clone' is the same species of hidden kind as 'infill' (S1b ⟨Q5⟩): voice cloning is an
// internal capability of the voice_patch chain, not a user-selectable task. It exists as a
// provider kind ONLY so the EL clone call runs inside runProvider — spend caps, cap
// reservation, ledger events, structured provider errors — instead of a bespoke second
// choke point. It must never appear in settings UI or workspace defaults.
export const ProviderKindSchema = z.enum(['stt', 'tts', 'studio-sound', 'llm', 'image-gen', 'video-gen', 'music-gen', 'infill', 'clone']);
export const ProviderTierSchema = z.enum(['local', 'paid']);
export const ProviderIdSchema = z.string().regex(/^(stt|tts|studio-sound|llm|image-gen|video-gen|music-gen|infill|clone)\.[a-z0-9][a-z0-9-]*$/, 'provider id must be <kind>.<name>');
export const ProviderSourceSchema = z.enum(['manual', 'env-import']).default('manual');

export const CostPerUnitSchema = z.object({
  currency: z.string().min(3).max(8).default('USD'),
  unit: z.string().min(1),
  amount: z.number().nonnegative()
});

export const ProviderRecordSchema = z.object({
  schemaVersion: z.literal(PROVIDER_REGISTRY_SCHEMA_VERSION).default(PROVIDER_REGISTRY_SCHEMA_VERSION),
  id: ProviderIdSchema,
  kind: ProviderKindSchema,
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'name must be a stable slug'),
  tier: ProviderTierSchema,
  baseUrl: z.string().url().optional(),
  secretRef: z.string().min(1).optional(),
  model: z.string().min(1).max(128).optional(),
  default: z.boolean().default(false),
  enabled: z.boolean().default(true),
  costPerUnit: CostPerUnitSchema.optional(),
  source: ProviderSourceSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
}).superRefine((record, ctx) => {
  if (record.id !== `${record.kind}.${record.name}`) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['id'], message: 'provider id must equal <kind>.<name>' });
  }
});

export const ProviderRegistryFileSchema = z.object({
  schemaVersion: z.literal(PROVIDER_REGISTRY_SCHEMA_VERSION),
  providers: z.array(ProviderRecordSchema),
  updatedAt: z.string().min(1)
});

// VoiceReferenceSchema is imported from ./voiceReference (a dependency-free module) so both
// providerSettings and operations/voice-patch can pull it without creating an import cycle.
// Re-export here so consumers that imported it from this barrel keep working.
export { VoiceReferenceSchema };

// Per-task options that don't fit the "one provider id per task" `defaults` shape. v1 only has
// TTS default voice; future entries (default language, music style, etc.) slot in here next to
// the existing tts block. `.default({})` so old workspace settings files parse unchanged —
// no schemaVersion bump. The output type makes taskOptions and taskOptions.tts always present
// (empty objects when omitted in storage), so callers don't need null-checks.
export const TaskOptionsSchema = z.object({
  tts: z.object({
    defaultVoice: VoiceReferenceSchema.optional()
  }).default({}),
  fillerWords: z.array(z.string()).optional()
}).default({});

// User-facing task kinds shown in the settings UI — the 7 selectable defaults.
// 'infill' is intentionally excluded: it is an internal capability of voice_patch,
// not a user-selectable task kind. Do not add 'infill' here.
export const UserFacingProviderKindSchema = z.enum(['stt', 'tts', 'studio-sound', 'llm', 'image-gen', 'video-gen', 'music-gen']);
export type UserFacingProviderKind = z.infer<typeof UserFacingProviderKindSchema>;

export const WorkspaceSettingsFileSchema = z.object({
  schemaVersion: z.literal(1),
  // defaults only accepts user-facing task kinds; 'infill' is internal capability of voice_patch, not a user-selectable task kind
  defaults: z.record(UserFacingProviderKindSchema, ProviderIdSchema).default({}),
  paidCaps: z.record(z.string(), z.number().nonnegative()).default({}),
  taskOptions: TaskOptionsSchema,
  updatedAt: z.string().min(1)
});

export const SecretsFileSchema = z.object({
  schemaVersion: z.literal(1),
  secrets: z.record(z.string().min(1), z.string()),
  updatedAt: z.string().min(1)
});

// Voices library — global file ~/.etvs/voices.json. Each entry is a cloned voice the user can
// reuse across projects. Cloning providers: ElevenLabs (legacy) and Cartesia (current default
// direction — instant clones from ~10s of clean project audio). xAI stock voices are not
// "cloned" and don't belong here. Voice metadata (names, origin project ids, sample paths,
// provider voice handles) is personal/biometric-adjacent — file is chmod 600 to match secrets.
export const VoiceProviderSchema = z.enum(['elevenlabs', 'cartesia']);
// sampleAssetPath references a file inside a project workspace (the project that originally
// cloned the voice). Reject absolute paths and traversal segments at parse time so a
// hand-edited voices.json can't trick a future re-clone path into reading arbitrary files.
const safeRelativePath = z.string().min(1).max(500).refine(
  (p) => !p.startsWith('/') && !p.startsWith('\\') && !/^[A-Za-z]:[\\/]/.test(p) && !p.split(/[\\/]+/).includes('..'),
  'must be a project-relative path with no absolute prefix and no `..` segments'
);
export const VoiceRecordSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'voice id must be a stable slug').min(1).max(64),
  name: z.string().min(1).max(200),
  provider: VoiceProviderSchema,
  voiceId: z.string().min(1).max(128),
  sampleAssetPath: safeRelativePath.optional(),
  originProjectId: z.string().min(1).max(200).optional(),
  // W4 additions — all optional, keeps back-compat (existing voices.json parses unchanged).
  cloneScope: z.enum(['local', 'project']).optional(),
  // Stable NON-SECRET identifier of the provider account/credential that created this clone
  // (secrets-store key name and/or endpoint host — NEVER a secret value; this file is
  // chmod 600 but still must not hold key material). Cache reuse in cloneCleanClip is
  // SYMMETRIC by tag class: a tagged record matches only requests with the IDENTICAL
  // accountRef, and an untagged (legacy) record matches only untagged requests — never
  // across classes in either direction (see findCachedVoice in voiceClone.ts).
  // Optional ⇒ existing voices.json parses unchanged.
  accountRef: z.string().min(1).max(200).optional(),
  sourceAudioRange: z.object({
    clipId: z.string().min(1).max(128),
    start: z.number().nonnegative(),
    end: z.number().nonnegative()
  }).refine((r) => r.end > r.start, 'sourceAudioRange.end must be greater than start').optional(),
  // S1a multi-window clone additions — ALL optional so legacy voices.json parses unchanged.
  // Cache matching in cloneCleanClip is CLASS-SYMMETRIC on these, exactly like accountRef:
  // a legacy record (no sourceClass/windows) matches ONLY legacy-shaped requests, and a
  // cleaned/multi-window request NEVER matches a legacy record (and vice versa). See
  // findCachedVoice in voiceClone.ts.
  //
  // Which base audio the clone samples came from: 'raw' = the 48k reference derivative,
  // 'cleaned' = the fresh EL-Isolator studioCleanup bed. Absent ⇒ legacy (raw-equivalent).
  sourceClass: z.enum(['raw', 'cleaned']).optional(),
  // Cleanup identity = studioCleanup.cacheKey (the source-audio hash) at clone time. Present
  // ONLY for sourceClass:'cleaned' — it pins the clone to the exact cleaned bed so a
  // re-cleaned recording (new cacheKey) misses and re-clones. Never set for raw clones.
  cleanupIdentity: z.string().min(1).max(200).optional(),
  // The exact asset-axis windows uploaded as samples, in canonical ascending-start order.
  // A multi-window clone records ALL of them; a legacy single-window clone omits this field
  // (its lone range lives in sourceAudioRange, kept for back-compat). A change to the window
  // SET is a cache miss.
  windows: z.array(z.object({
    clipId: z.string().min(1).max(128),
    start: z.number().nonnegative(),
    end: z.number().nonnegative()
  }).refine((w) => w.end > w.start, 'window.end must be greater than start')).min(1).optional(),
  provenance: z.object({
    method: z.enum(['ivc', 'upload', 'enroll', 'project-range']).optional(),
    createdBy: z.enum(['clone-route', 'enroll-route', 'manual']).optional(),
    sourceAssetPath: safeRelativePath.optional()
  }).strip().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});
export const VoicesFileSchema = z.object({
  schemaVersion: z.literal(1),
  voices: z.array(VoiceRecordSchema),
  updatedAt: z.string().min(1)
}).superRefine((file, ctx) => {
  // Hand-edited voices.json can introduce duplicates that upsertVoice would never produce.
  // Surface both kinds: same library slug (UI delete ambiguity), and the same upstream voice
  // registered twice (likely user error and confuses the picker). The upstream-voice handle
  // is (provider, accountRef, voiceId): provider-local voice IDs are only unique WITHIN one
  // account, so the same voiceId under two DIFFERENT accounts is two legitimately distinct
  // voices — rejecting the second would fail persistence AFTER a paid remote clone succeeded
  // (stranded clone). Untagged records (accountRef absent → null in the tuple) are their own
  // account class, consistent with cloneCleanClip's symmetric tag-class cache matching, and
  // legacy voices.json files (no accountRef anywhere) validate exactly as before.
  // The dedupe KEY is a JSON-encoded tuple, NOT a ':'-joined string: accountRef and voiceId
  // may themselves contain ':', so naive joining is ambiguous — (accountRef 'acct:a',
  // voiceId 'b') and (accountRef 'acct', voiceId 'a:b') would both serialize to
  // 'provider:acct:a:b' and the legitimate second tuple would be rejected AFTER its paid
  // clone. JSON.stringify escapes delimiters inside the fields, making the encoding
  // injective; the error message stays human-readable by naming the fields separately.
  const seenIds = new Set<string>();
  const seenHandles = new Map<string, string>();
  file.voices.forEach((voice, index) => {
    if (seenIds.has(voice.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['voices', index, 'id'], message: `duplicate voice id: ${voice.id}` });
    }
    seenIds.add(voice.id);
    const handle = JSON.stringify([voice.provider, voice.accountRef ?? null, voice.voiceId]);
    const priorId = seenHandles.get(handle);
    if (priorId) {
      const accountLabel = voice.accountRef === undefined ? 'no account' : `account "${voice.accountRef}"`;
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['voices', index, 'voiceId'], message: `voice ${voice.voiceId} on ${voice.provider} (${accountLabel}) is already registered as ${priorId}` });
    }
    seenHandles.set(handle, voice.id);
  });
});

export type ProviderKind = z.infer<typeof ProviderKindSchema>;
export type ProviderTier = z.infer<typeof ProviderTierSchema>;
export type ProviderRecord = z.infer<typeof ProviderRecordSchema>;
export type ProviderRegistryFile = z.infer<typeof ProviderRegistryFileSchema>;
export type WorkspaceSettingsFile = z.infer<typeof WorkspaceSettingsFileSchema>;
export type SecretsFile = z.infer<typeof SecretsFileSchema>;
export type VoiceProvider = z.infer<typeof VoiceProviderSchema>;
export type VoiceRecord = z.infer<typeof VoiceRecordSchema>;
export type VoicesFile = z.infer<typeof VoicesFileSchema>;
export type TaskOptions = z.infer<typeof TaskOptionsSchema>;

export type SettingsSnapshot<T> = {
  path: string;
  value: T;
  updatedAt: string | null;
  mtimeMs: number | null;
  hash: string | null;
};

export type SettingsPathsInput = { homeDir?: string; workspacePath?: string; etvsDir?: string };

export function etvsHomeDir(input: SettingsPathsInput = {}): string {
  return resolve(input.etvsDir ?? join(input.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? '.', '.etvs'));
}

export function providerRegistryPath(input: SettingsPathsInput = {}): string {
  return join(etvsHomeDir(input), 'providers.json');
}

export function secretsPath(input: SettingsPathsInput = {}): string {
  return join(etvsHomeDir(input), 'secrets.json');
}

export function voicesLibraryPath(input: SettingsPathsInput = {}): string {
  return join(etvsHomeDir(input), 'voices.json');
}

export function workspaceSettingsPath(workspacePath: string): string {
  return join(resolve(workspacePath), '.etvs', 'settings.json');
}

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readSnapshotBytes(path: string): Omit<SettingsSnapshot<unknown>, 'value' | 'updatedAt'> & { bytes: Buffer | null } {
  if (!existsSync(path)) return { path, mtimeMs: null, hash: null, bytes: null };
  const bytes = readFileSync(path);
  const stat = statSync(path);
  return { path, mtimeMs: stat.mtimeMs, hash: sha256Bytes(bytes), bytes };
}

function parseSettingsJson(path: string, bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (err) {
    throw new SettingsError('invalid_settings', `Malformed settings JSON at ${path}. Fix the file by hand or restore from backup; ETVideoScript will not reset it silently.`, { cause: err instanceof Error ? err.message : String(err) });
  }
}

export function emptyProviderRegistry(now = nowIso()): ProviderRegistryFile {
  return { schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION, providers: [], updatedAt: now };
}

export function emptyWorkspaceSettings(now = nowIso()): WorkspaceSettingsFile {
  return { schemaVersion: 1, defaults: {}, paidCaps: {}, taskOptions: { tts: {} }, updatedAt: now };
}

export function emptyVoicesFile(now = nowIso()): VoicesFile {
  return { schemaVersion: 1, voices: [], updatedAt: now };
}

export function readWorkspaceSettings(workspacePath: string): SettingsSnapshot<WorkspaceSettingsFile> {
  const path = workspaceSettingsPath(workspacePath);
  const snap = readSnapshotBytes(path);
  if (!snap.bytes) return { path, value: emptyWorkspaceSettings(), updatedAt: null, mtimeMs: null, hash: null };
  const raw = parseSettingsJson(path, snap.bytes);
  const parsed = WorkspaceSettingsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SettingsError('invalid_settings', `Invalid workspace settings at ${path}. Fix the file by hand or restore from backup; ETVideoScript will not reset it silently.`, parsed.error.flatten());
  }
  return { path, value: parsed.data, updatedAt: parsed.data.updatedAt, mtimeMs: snap.mtimeMs, hash: snap.hash };
}

export type SettingsWriteExpectation = Pick<SettingsSnapshot<unknown>, 'mtimeMs' | 'hash'>;

export function writeWorkspaceSettings(workspacePath: string, value: WorkspaceSettingsFile, expected?: SettingsWriteExpectation): SettingsSnapshot<WorkspaceSettingsFile> {
  const path = workspaceSettingsPath(workspacePath);
  const current = readSnapshotBytes(path);
  if (expected && (current.mtimeMs !== expected.mtimeMs || current.hash !== expected.hash)) {
    throw new SettingsError('settings_stale', 'Workspace settings changed since they were read; reload and retry.', { expected: { mtimeMs: expected.mtimeMs, hash: expected.hash }, current: { mtimeMs: current.mtimeMs, hash: current.hash } });
  }
  const parsed = WorkspaceSettingsFileSchema.parse({ ...value, updatedAt: value.updatedAt || nowIso() });
  atomicWriteJson(path, parsed);
  const written = readSnapshotBytes(path);
  return { path, value: parsed, updatedAt: parsed.updatedAt, mtimeMs: written.mtimeMs, hash: written.hash };
}

/**
 * `persistMigration: false` migrates an older registry IN MEMORY only.
 *
 * A read taken purely to answer a question — "what would this call cost?" — must not rewrite the
 * user's settings as a side effect. The returned value is identical either way; only the
 * on-disk file is left alone.
 */
export function readProviderRegistry(input: SettingsPathsInput & { persistMigration?: boolean } = {}): SettingsSnapshot<ProviderRegistryFile> {
  const path = providerRegistryPath(input);
  const snap = readSnapshotBytes(path);
  if (!snap.bytes) return { path, value: emptyProviderRegistry(), updatedAt: null, mtimeMs: null, hash: null };
  const raw = parseSettingsJson(path, snap.bytes);
  const beforeVersion = raw && typeof raw === 'object' && 'schemaVersion' in raw ? Number((raw as { schemaVersion?: unknown }).schemaVersion) : 0;
  const migrated = migrateProviderRegistryToLatest(raw);
  const parsedMigrated = ProviderRegistryFileSchema.safeParse(migrated);
  if (!parsedMigrated.success) {
    throw new SettingsError('invalid_settings', `Invalid provider registry at ${path}. Fix the file by hand or restore from backup; ETVideoScript will not reset it silently.`, parsedMigrated.error.flatten());
  }
  if (beforeVersion !== PROVIDER_REGISTRY_SCHEMA_VERSION) {
    if (input.persistMigration === false) return { path, value: parsedMigrated.data, updatedAt: parsedMigrated.data.updatedAt, mtimeMs: snap.mtimeMs, hash: snap.hash };
    const backup = `${path}.v${beforeVersion}.bak`;
    if (!existsSync(backup)) copyFileSync(path, backup);
    atomicWriteJson(path, parsedMigrated.data);
    const reread = readSnapshotBytes(path);
    return { path, value: parsedMigrated.data, updatedAt: parsedMigrated.data.updatedAt, mtimeMs: reread.mtimeMs, hash: reread.hash };
  }
  return { path, value: parsedMigrated.data, updatedAt: parsedMigrated.data.updatedAt, mtimeMs: snap.mtimeMs, hash: snap.hash };
}

export function writeProviderRegistry(value: ProviderRegistryFile, expected?: SettingsWriteExpectation, input: SettingsPathsInput = {}): SettingsSnapshot<ProviderRegistryFile> {
  const path = providerRegistryPath(input);
  const current = readSnapshotBytes(path);
  // Settings writes use optimistic CAS: callers read mtime+content hash, then
  // write only if both still match. The mtime catches normal edits; the hash
  // catches same-timestamp hand edits. A mismatch means another writer won, so
  // we fail loud with settings_stale instead of silently stomping user changes.
  // This narrows but does not eliminate the residual cross-process window where
  // two independent writers both pass compare before either rename completes;
  // fully closing that would require lock files, intentionally out of scope per
  // the settings no-lock-files decision.
  if (expected && (current.mtimeMs !== expected.mtimeMs || current.hash !== expected.hash)) {
    throw new SettingsError('settings_stale', 'Provider settings changed since they were read; reload and retry.', { expected: { mtimeMs: expected.mtimeMs, hash: expected.hash }, current: { mtimeMs: current.mtimeMs, hash: current.hash } });
  }
  const parsed = ProviderRegistryFileSchema.parse({ ...value, updatedAt: value.updatedAt || nowIso() });
  atomicWriteJson(path, parsed);
  const written = readSnapshotBytes(path);
  return { path, value: parsed, updatedAt: parsed.updatedAt, mtimeMs: written.mtimeMs, hash: written.hash };
}

export function upsertProvider(input: SettingsPathsInput & { provider: Omit<Partial<ProviderRecord>, 'schemaVersion' | 'createdAt' | 'updatedAt'> & Pick<ProviderRecord, 'id' | 'kind' | 'name' | 'tier'> }): ProviderRecord {
  const snapshot = readProviderRegistry(input);
  const now = nowIso();
  const existing = snapshot.value.providers.find((provider) => provider.id === input.provider.id);
  const provider = ProviderRecordSchema.parse({
    schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION,
    enabled: true,
    default: false,
    source: 'manual',
    ...existing,
    ...input.provider,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  });
  const providers = snapshot.value.providers.filter((candidate) => candidate.id !== provider.id);
  if (provider.default) {
    for (const candidate of providers) if (candidate.kind === provider.kind) candidate.default = false;
  }
  providers.push(provider);
  providers.sort((a, b) => a.id.localeCompare(b.id));
  writeProviderRegistry({ ...snapshot.value, providers, updatedAt: now }, snapshot, input);
  return provider;
}

export function removeProvider(input: SettingsPathsInput & { id: string }): ProviderRecord {
  const snapshot = readProviderRegistry(input);
  const provider = snapshot.value.providers.find((candidate) => candidate.id === input.id);
  if (!provider) throw new SettingsError('provider_not_found', `Provider not found: ${input.id}`);
  writeProviderRegistry({ ...snapshot.value, providers: snapshot.value.providers.filter((candidate) => candidate.id !== input.id), updatedAt: nowIso() }, snapshot, input);
  return provider;
}

export function setDefaultProvider(input: SettingsPathsInput & { kind: ProviderKind; id: string; acknowledgePaid?: boolean }): ProviderRecord {
  const snapshot = readProviderRegistry(input);
  const provider = snapshot.value.providers.find((candidate) => candidate.id === input.id && candidate.kind === input.kind);
  if (!provider) throw new SettingsError('provider_not_found', `Provider not found for ${input.kind}: ${input.id}`);
  if (!provider.enabled) throw new SettingsError('provider_disabled', `Provider is disabled: ${input.id}`);
  if (provider.tier === 'paid' && !input.acknowledgePaid) throw new SettingsError('paid_default_requires_ack', `Setting paid provider ${input.id} as default requires --yes acknowledgement.`);
  const now = nowIso();
  const providers = snapshot.value.providers.map((candidate) => ProviderRecordSchema.parse({ ...candidate, default: candidate.kind === input.kind ? candidate.id === provider.id : candidate.default, updatedAt: candidate.id === provider.id ? now : candidate.updatedAt }));
  writeProviderRegistry({ ...snapshot.value, providers, updatedAt: now }, snapshot, input);
  return providers.find((candidate) => candidate.id === provider.id)!;
}

export function readSecrets(input: SettingsPathsInput = {}): SecretsFile {
  const path = secretsPath(input);
  if (!existsSync(path)) return { schemaVersion: 1, secrets: {}, updatedAt: nowIso() };
  const parsed = SecretsFileSchema.safeParse(parseSettingsJson(path, readFileSync(path)));
  if (!parsed.success) throw new SettingsError('invalid_settings', `Invalid secrets file at ${path}.`, parsed.error.flatten());
  return parsed.data;
}

export function setProviderSecret(input: SettingsPathsInput & { secretRef: string; value: string }): SecretsFile {
  const path = secretsPath(input);
  const current = readSecrets(input);
  const next = SecretsFileSchema.parse({ schemaVersion: 1, secrets: { ...current.secrets, [input.secretRef]: input.value }, updatedAt: nowIso() });
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteJson(path, next, 0o600);
  chmodSync(path, 0o600);
  return next;
}

export function deleteProviderSecret(input: SettingsPathsInput & { secretRef: string }): SecretsFile {
  const path = secretsPath(input);
  const current = readSecrets(input);
  const { [input.secretRef]: _removed, ...secrets } = current.secrets;
  const next = SecretsFileSchema.parse({ schemaVersion: 1, secrets, updatedAt: nowIso() });
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteJson(path, next, 0o600);
  chmodSync(path, 0o600);
  return next;
}

export function readVoicesLibrary(input: SettingsPathsInput = {}): SettingsSnapshot<VoicesFile> {
  const path = voicesLibraryPath(input);
  const snap = readSnapshotBytes(path);
  if (!snap.bytes) return { path, value: emptyVoicesFile(), updatedAt: null, mtimeMs: null, hash: null };
  const raw = parseSettingsJson(path, snap.bytes);
  const parsed = VoicesFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SettingsError('invalid_settings', `Invalid voices library at ${path}. Fix the file by hand or restore from backup; ETVideoScript will not reset it silently.`, parsed.error.flatten());
  }
  return { path, value: parsed.data, updatedAt: parsed.data.updatedAt, mtimeMs: snap.mtimeMs, hash: snap.hash };
}

export function writeVoicesLibrary(value: VoicesFile, expected?: SettingsWriteExpectation, input: SettingsPathsInput = {}): SettingsSnapshot<VoicesFile> {
  const path = voicesLibraryPath(input);
  const current = readSnapshotBytes(path);
  // Same optimistic CAS pattern as the registry — mtime + content hash. Voices library writes
  // are rarer (clone + delete), so a stale-write here typically means a parallel CLI/UI session,
  // worth surfacing rather than stomping.
  if (expected && (current.mtimeMs !== expected.mtimeMs || current.hash !== expected.hash)) {
    throw new SettingsError('settings_stale', 'Voices library changed since it was read; reload and retry.', { expected: { mtimeMs: expected.mtimeMs, hash: expected.hash }, current: { mtimeMs: current.mtimeMs, hash: current.hash } });
  }
  const parsed = VoicesFileSchema.parse({ ...value, updatedAt: value.updatedAt || nowIso() });
  mkdirSync(dirname(path), { recursive: true });
  // Voice metadata is biometric-adjacent (names, sample paths, provider voice handles); chmod
  // 600 to match secrets.json posture even though no actual API keys live here.
  atomicWriteJson(path, parsed, 0o600);
  chmodSync(path, 0o600);
  const written = readSnapshotBytes(path);
  return { path, value: parsed, updatedAt: parsed.updatedAt, mtimeMs: written.mtimeMs, hash: written.hash };
}

export function upsertVoice(input: SettingsPathsInput & {
  voice: Omit<Partial<VoiceRecord>, 'schemaVersion' | 'createdAt' | 'updatedAt'> & Pick<VoiceRecord, 'id' | 'name' | 'provider' | 'voiceId'>
}): VoiceRecord {
  const snapshot = readVoicesLibrary(input);
  const now = nowIso();
  const existing = snapshot.value.voices.find((voice) => voice.id === input.voice.id);
  const voice = VoiceRecordSchema.parse({
    schemaVersion: 1,
    ...existing,
    ...input.voice,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  });
  const voices = snapshot.value.voices.filter((candidate) => candidate.id !== voice.id);
  voices.push(voice);
  voices.sort((a, b) => a.id.localeCompare(b.id));
  writeVoicesLibrary({ ...snapshot.value, voices, updatedAt: now }, snapshot, input);
  return voice;
}

export function removeVoice(input: SettingsPathsInput & { id: string }): VoiceRecord {
  const snapshot = readVoicesLibrary(input);
  const voice = snapshot.value.voices.find((candidate) => candidate.id === input.id);
  if (!voice) throw new SettingsError('voice_not_found', `Voice not found: ${input.id}`);
  writeVoicesLibrary({ ...snapshot.value, voices: snapshot.value.voices.filter((candidate) => candidate.id !== input.id), updatedAt: nowIso() }, snapshot, input);
  return voice;
}

const WHISPER_BASE_URL_ENV_KEYS = [
  'ETVS_WHISPER_BASE_URL',
  'WHISPER_BASE_URL',
  'ETVS_WHISPER_URL',
  'ETVS_WHISPER_LAN_URL',
  'ETVIDEO_WHISPER_BASE_URL',
  'ETVIDEO_WHISPER_URL',
  'ETVIDEO_WHISPER_LAN_URL',
  'WHISPER_URL',
  'WHISPER_LAN_URL'
] as const;

export function resolveWhisperBaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  for (const key of WHISPER_BASE_URL_ENV_KEYS) {
    const value = env[key];
    if (value) return value;
  }
  return undefined;
}

export function resolveWhisperBasicAuth(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.ETVS_WHISPER_BASIC_AUTH ?? env.WHISPER_BASIC_AUTH ?? env.ETVIDEO_WHISPER_BASIC_AUTH;
}

export function importLegacyEnvProviders(input: SettingsPathsInput & { env?: Record<string, string | undefined> } = {}): ProviderRecord[] {
  const env = input.env ?? process.env;
  const imported: ProviderRecord[] = [];
  const whisperUrl = resolveWhisperBaseUrl(env);
  if (whisperUrl) {
    imported.push(upsertProvider({ ...input, provider: { id: 'stt.homelab-whisper', kind: 'stt', name: 'homelab-whisper', tier: 'local', baseUrl: whisperUrl, enabled: true, default: true, source: 'env-import' } }));
  }
  const studio = env.ETVS_STUDIO_SOUND_PROVIDER;
  if (studio) {
    const name = studio.replace(/^studio-sound\./, '').replace(/_/g, '-');
    imported.push(upsertProvider({ ...input, provider: { id: `studio-sound.${name}`, kind: 'studio-sound', name, tier: name === 'ffmpeg-local' ? 'local' : 'paid', enabled: true, default: true, source: 'env-import' } }));
  }
  return imported;
}

/**
 * Idempotently upsert the `infill.cartesia` provider record so that
 * `runProvider({ kind:'infill', providerId:'infill.cartesia' })` can resolve
 * a `secretRef` and avoid Cartesia 401s (the synthetic-provider fallback in
 * engine.ts has no secretRef). If a `tts.cartesia` record already exists and
 * has a `baseUrl`, that URL is reused; otherwise no baseUrl is set.
 *
 * This function is NOT called at module load — call it explicitly from the
 * harness (Layer 1 A/B) and at startup/migration (Layer 2). The record is
 * NOT set as the default for the 'infill' kind; it is not surfaced in the
 * settings UI.
 */
export function ensureCartesiaInfillProvider(input: SettingsPathsInput = {}): ProviderRecord {
  const registry = readProviderRegistry(input).value;
  const ttsCar = registry.providers.find((p) => p.id === 'tts.cartesia');
  const existingInfill = registry.providers.find((p) => p.id === 'infill.cartesia');
  const baseUrl = existingInfill?.baseUrl ?? ttsCar?.baseUrl;
  // Inherit the Cartesia key reference so infill auths with the SAME key the user already configured
  // for tts.cartesia (which may be a non-default secretRef): prefer an existing infill record's ref,
  // then tts.cartesia's, then the conventional 'cartesia'. Hardcoding 'cartesia' would break a valid
  // custom-secretRef setup (Codex impl-review P2).
  const secretRef = existingInfill?.secretRef ?? ttsCar?.secretRef ?? 'cartesia';
  const model = 'sonic-3-2026-01-12';
  // True idempotency: synthesizeInfillSpeech calls this on EVERY infill, and a needless upsert
  // bumps updatedAt and risks CAS/race noise (Hermes impl-review P2). If the record already matches
  // the desired shape, return it without writing.
  if (existingInfill
    && existingInfill.kind === 'infill' && existingInfill.name === 'cartesia'
    && existingInfill.tier === 'paid' && existingInfill.secretRef === secretRef
    && existingInfill.model === model
    && (existingInfill.baseUrl ?? undefined) === (baseUrl ?? undefined)) {
    return existingInfill;
  }
  return upsertProvider({
    ...input,
    provider: {
      id: 'infill.cartesia',
      kind: 'infill',
      name: 'cartesia',
      tier: 'paid',
      secretRef,
      model,
      ...(baseUrl ? { baseUrl } : {})
    }
  });
}

/**
 * Idempotently upsert the `clone.elevenlabs` provider record (S1b ⟨Q5⟩/⟨R4⟩) so
 * `runProvider({ kind:'clone', providerId:'clone.elevenlabs' })` resolves a real record with a
 * secretRef instead of engine.ts's synthetic fallback (which has none and would 401).
 *
 * The secretRef is inherited from the user's existing ElevenLabs TTS record when present, so a
 * custom-named key keeps working; otherwise the conventional 'elevenlabs' ref. Like
 * ensureCartesiaInfillProvider, this record is NOT a default for its kind and is not surfaced
 * in settings UI. The secretRef doubles as the clone cache's `accountRef` discriminator (⟨F11⟩).
 */
export function ensureElevenLabsCloneProvider(input: SettingsPathsInput = {}): ProviderRecord {
  const registry = readProviderRegistry(input).value;
  const ttsEl = registry.providers.find((p) => p.id === 'tts.elevenlabs');
  const existing = registry.providers.find((p) => p.id === 'clone.elevenlabs');
  const baseUrl = existing?.baseUrl ?? ttsEl?.baseUrl;
  const secretRef = existing?.secretRef ?? ttsEl?.secretRef ?? 'elevenlabs';
  if (existing
    && existing.kind === 'clone' && existing.name === 'elevenlabs'
    && existing.tier === 'paid' && existing.secretRef === secretRef
    && (existing.baseUrl ?? undefined) === (baseUrl ?? undefined)) {
    return existing;
  }
  return upsertProvider({
    ...input,
    provider: {
      id: 'clone.elevenlabs',
      kind: 'clone',
      name: 'elevenlabs',
      tier: 'paid',
      secretRef,
      ...(baseUrl ? { baseUrl } : {})
    }
  });
}

/**
 * Idempotently upsert the `tts.elevenlabs-sts` provider record (S1b D7) so the speech-to-speech
 * half of the clone chain resolves its own secretRef and is accounted under its OWN provider id
 * — separate spend cap and separate ledger rows from plain TTS. Like the clone record, it
 * inherits the user's existing ElevenLabs key reference and is never made a default.
 */
export function ensureElevenLabsStsProvider(input: SettingsPathsInput = {}): ProviderRecord {
  const registry = readProviderRegistry(input).value;
  const ttsEl = registry.providers.find((p) => p.id === 'tts.elevenlabs');
  const existing = registry.providers.find((p) => p.id === 'tts.elevenlabs-sts');
  const baseUrl = existing?.baseUrl ?? ttsEl?.baseUrl;
  const secretRef = existing?.secretRef ?? ttsEl?.secretRef ?? 'elevenlabs';
  if (existing
    && existing.kind === 'tts' && existing.name === 'elevenlabs-sts'
    && existing.tier === 'paid' && existing.secretRef === secretRef
    && (existing.baseUrl ?? undefined) === (baseUrl ?? undefined)) {
    return existing;
  }
  return upsertProvider({
    ...input,
    provider: {
      id: 'tts.elevenlabs-sts',
      kind: 'tts',
      name: 'elevenlabs-sts',
      tier: 'paid',
      secretRef,
      ...(baseUrl ? { baseUrl } : {})
    }
  });
}

/**
 * Idempotently upsert the `tts.elevenlabs` record. The clone chain's TTS step needs a resolvable
 * secretRef exactly like the other two; without a record the engine's synthetic fallback has
 * none and the call 401s. Never made a default — the user's own TTS default is untouched.
 */
export function ensureElevenLabsTtsProvider(input: SettingsPathsInput = {}): ProviderRecord {
  const registry = readProviderRegistry(input).value;
  const existing = registry.providers.find((p) => p.id === 'tts.elevenlabs');
  if (existing) return existing;
  return upsertProvider({ ...input, provider: { id: 'tts.elevenlabs', kind: 'tts', name: 'elevenlabs', tier: 'paid', secretRef: 'elevenlabs' } });
}

function legacyEnvProvider(kind: ProviderKind, env: Record<string, string | undefined>): ProviderRecord | null {
  if (kind === 'stt') {
    const url = resolveWhisperBaseUrl(env);
    if (url) return ProviderRecordSchema.parse({ schemaVersion: 1, id: 'stt.homelab-whisper', kind: 'stt', name: 'homelab-whisper', tier: 'local', baseUrl: url, default: true, enabled: true, source: 'env-import', createdAt: nowIso(), updatedAt: nowIso() });
  }
  if (kind === 'studio-sound' && env.ETVS_STUDIO_SOUND_PROVIDER) {
    const name = env.ETVS_STUDIO_SOUND_PROVIDER.replace(/^studio-sound\./, '').replace(/_/g, '-');
    return ProviderRecordSchema.parse({ schemaVersion: 1, id: `studio-sound.${name}`, kind: 'studio-sound', name, tier: name === 'ffmpeg-local' ? 'local' : 'paid', default: true, enabled: true, source: 'env-import', createdAt: nowIso(), updatedAt: nowIso() });
  }
  return null;
}

export function resolveProviderForKind(input: SettingsPathsInput & { kind: ProviderKind; flagProviderId?: string; env?: Record<string, string | undefined>; persistMigration?: boolean }): ProviderRecord | null {
  const env = input.env ?? process.env;
  const fromEnv = env.ETVS_PROVIDER_OVERRIDE;
  const registry = readProviderRegistry(input).value;
  const byId = (id?: string) => id ? registry.providers.find((provider) => provider.id === id || provider.id === `${input.kind}.${id}`) ?? null : null;
  if (input.flagProviderId) return byId(input.flagProviderId);
  if (fromEnv) return byId(fromEnv);
  if (env.ETVS_SETTINGS_MODE === 'env') return legacyEnvProvider(input.kind, env);
  if (input.workspacePath) {
    // Workspace defaults only hold user-facing task kinds; 'infill' is not user-selectable
    // so it will never appear in defaults — the cast is safe and returns undefined.
    const workspaceDefault = (readWorkspaceSettings(input.workspacePath).value.defaults as Record<string, string | undefined>)[input.kind];
    const workspaceProvider = byId(workspaceDefault);
    if (workspaceProvider?.kind === input.kind && workspaceProvider.enabled) return workspaceProvider;
  }
  const configured = registry.providers.find((provider) => provider.kind === input.kind && provider.default && provider.enabled);
  if (configured) return configured;
  return legacyEnvProvider(input.kind, env);
}

const SECRET_PATTERN = /secret|token|key|password|credential|api[_-]?key/i;
const BEARER_PATTERN = /Bearer\s+[^\s"']+/gi;
const BASIC_PATTERN = /Basic\s+[^\s"']+/gi;
const QUERY_SECRET_PATTERN = /([?&][^=]*(?:secret|token|key|password|credential|api[_-]?key)[^=]*=)[^&#\s]+/gi;
const URL_USERINFO_PATTERN = /\b(https?:\/\/)([^\s/@?#]+(?::[^\s/@?#]*)?@)/gi;

function binaryDescriptor(value: unknown): { type: string; bytes: number } | null {
  if (Buffer.isBuffer(value)) return { type: 'Buffer', bytes: value.byteLength };
  if (ArrayBuffer.isView(value)) return { type: value.constructor.name || 'TypedArray', bytes: value.byteLength };
  if (value instanceof ArrayBuffer) return { type: 'ArrayBuffer', bytes: value.byteLength };
  return null;
}

// `redactKeys` (default true) replaces any value under a secret-looking key name.
// That heuristic suits log/error scrubbing but corrupts structured API responses
// whose field names legitimately contain "secret"/"key" (e.g. `secrets`,
// `secretRef`) — pass `redactKeys: false` to scrub only secret-bearing strings.
export function redactSecrets(value: unknown, options: { redactKeys?: boolean } = {}): unknown {
  if (typeof value === 'string') {
    return value
      .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
      .replace(BASIC_PATTERN, 'Basic [REDACTED]')
      .replace(URL_USERINFO_PATTERN, '$1[REDACTED]@')
      .replace(QUERY_SECRET_PATTERN, '$1[REDACTED]');
  }
  const binary = binaryDescriptor(value);
  if (binary) return binary;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, options));
  if (value && typeof value === 'object') {
    if (value instanceof Error) return redactSecrets(value.message, options);
    const redactKeys = options.redactKeys ?? true;
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactKeys && SECRET_PATTERN.test(key) ? '[REDACTED]' : redactSecrets(nested, options);
    }
    return out;
  }
  return value;
}

export function settingsErrorEnvelope(error: unknown): { error: { code: string; message: string; details?: unknown } } {
  if (error instanceof SettingsError) return { error: { code: error.code, message: String(redactSecrets(error.message)), ...(error.details === undefined ? {} : { details: redactSecrets(error.details) }) } };
  return { error: { code: 'invalid_settings', message: String(redactSecrets(error instanceof Error ? error.message : String(error))) } };
}
