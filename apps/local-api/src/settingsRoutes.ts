import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import {
  cloneElevenLabsVoice,
  cloneCartesiaVoice,
  deleteProviderSecret,
  ProviderKindSchema,
  ProviderExecutionError,
  readProviderRegistry,
  readSecrets,
  readVoicesLibrary,
  readWorkspaceSettings,
  redactSecrets,
  removeProvider,
  removeVoice,
  secretsPath,
  setDefaultProvider,
  setProviderSecret,
  SettingsError,
  settingsErrorEnvelope,
  upsertProvider,
  upsertVoice,
  writeWorkspaceSettings,
  type ProviderRecord,
  type SettingsPathsInput,
  type SettingsSnapshot,
  type VoiceCloneSample,
  type VoiceRecord,
  type WorkspaceSettingsFile
} from '@etvideoscript/core';
import { guardedFetch } from '@etvideoscript/core/network/guardedFetch';
import type { ApiConfig } from './config';
import { isLocalHost } from './config';

// Keyed clone-provider dispatch table. Cartesia is opt-in via the multipart `provider`
// form field (sent alongside name/description/sample, like the rest of this route's
// metadata); the DEFAULT stays 'elevenlabs' so this wave is purely additive and does not break the
// existing Studio add-voice flow (which sends no provider field and surfaces only EL
// voices). The consent-gated flip of the default to Cartesia is W8, after the UI learns
// to choose + surface Cartesia voices.
// Both adapters are assignable to this shared call shape; the routes only ever pass
// these fields. Cartesia's extra optionals (language/baseUrl/timeoutMs) are absent
// here and default inside the adapter. Typed (no `any`) so a signature drift in
// either adapter is caught at compile time.
type CloneFn = (input: {
  name: string;
  description?: string;
  samples: VoiceCloneSample[];
  secret: string;
  signal: AbortSignal;
}) => Promise<{ voiceId: string }>;
type CloneProviderKey = 'elevenlabs' | 'cartesia';
// maxSamples encodes the provider's clip capability so the route can reject excess
// recordings with a 4xx (client input error) BEFORE the adapter — the adapter's own
// rejection surfaces as ProviderExecutionError → HTTP 502 (a server-failure class),
// which would mislead a user who simply sent too many clips. Cartesia IVC is single-clip.
const CLONE_PROVIDERS: Record<CloneProviderKey, { secretKey: CloneProviderKey; label: string; clone: CloneFn; maxSamples: number }> = {
  elevenlabs: { secretKey: 'elevenlabs', label: 'ElevenLabs', clone: cloneElevenLabsVoice, maxSamples: 25 },
  cartesia: { secretKey: 'cartesia', label: 'Cartesia', clone: cloneCartesiaVoice, maxSamples: 1 }
};

type ExpectedSnapshot = Pick<SettingsSnapshot<any>, 'mtimeMs' | 'hash'>;
const MAX_VOICE_SAMPLE_BYTES = 25 * 1024 * 1024;

function statusForSettingsError(error: unknown): number {
  if (!(error instanceof SettingsError)) return 500;
  if (error.code === 'settings_stale' || error.code === 'paid_default_requires_ack' || error.code === 'provider_disabled') return 409;
  if (error.code === 'provider_not_found' || error.code === 'voice_not_found') return 404;
  if (error.code === 'invalid_settings' || error.code === 'invalid_base_url') return 400;
  if (error.code === 'ssrf_blocked') return 400;
  if (['provider_unreachable', 'tls_failed', 'auth_failed', 'model_missing'].includes(error.code)) return 502;
  return 500;
}

function sendSettingsError(reply: FastifyReply, error: unknown) {
  if (error instanceof SettingsError) return reply.code(statusForSettingsError(error)).send(settingsErrorEnvelope(error));
  if (error && typeof error === 'object' && (error as { name?: string }).name === 'ZodError') {
    return reply.code(400).send(settingsErrorEnvelope(new SettingsError('invalid_settings', 'Settings request validation failed.', error)));
  }
  return reply.code(500).send(settingsErrorEnvelope(new SettingsError('invalid_settings', 'Settings request failed.')));
}

function sendProviderCloneError(reply: FastifyReply, error: ProviderExecutionError) {
  // provider_auth_failed and provider_bad_request are request-class errors (bad key / bad
  // payload / a degraded-but-200 provider response we refused) → 400, not a 502 server
  // failure. Only a real upstream status >= 400, or an unclassified error, falls through to 502.
  const status = error.providerStatus && error.providerStatus >= 400
    ? error.providerStatus
    : (error.code === 'provider_auth_failed' || error.code === 'provider_bad_request' ? 400 : 502);
  const code = status === 401 || status === 403 || error.code === 'provider_auth_failed'
    ? 'provider_auth_failed'
    : status >= 500
      ? 'provider_unavailable'
      : 'provider_failed';
  return reply.code(status).send({ error: { code, message: error.message, ...(error.providerStatus == null ? {} : { statusCode: error.providerStatus }) } });
}

function providerPayload(body: any): Omit<Partial<ProviderRecord>, 'schemaVersion' | 'createdAt' | 'updatedAt'> & Pick<ProviderRecord, 'id' | 'kind' | 'name' | 'tier'> {
  const raw = body?.provider ?? body ?? {};
  const kind = ProviderKindSchema.parse(raw.kind ?? String(raw.id || '').split('.')[0]);
  const id = String(raw.id || `${kind}.${raw.name || 'provider'}`);
  const name = String(raw.name || id.replace(`${kind}.`, ''));
  if (!raw.tier) throw new SettingsError('invalid_settings', 'Provider tier is required.');
  // baseUrl protocol:
  //   omitted from body  → inherit existing (upsertProvider merge keeps it)
  //   null or ""         → explicit clear, override existing with undefined
  //   non-empty string   → set to that URL
  // The explicit-clear path matters for adapters (e.g. xAI) whose adapter code
  // treats provider.baseUrl as the final endpoint rather than a root, so a
  // stale persisted root would route real calls to a 404.
  const baseUrlField =
    raw.baseUrl === null || raw.baseUrl === ''
      ? { baseUrl: undefined }
      : raw.baseUrl
        ? { baseUrl: String(raw.baseUrl) }
        : {};
  return {
    id,
    kind,
    name,
    tier: raw.tier,
    ...baseUrlField,
    ...(raw.secretRef ? { secretRef: String(raw.secretRef) } : {}),
    ...(raw.model ? { model: String(raw.model) } : {}),
    ...(raw.default != null ? { default: Boolean(raw.default) } : {}),
    ...(raw.enabled != null ? { enabled: Boolean(raw.enabled) } : {}),
    ...(raw.costPerUnit ? { costPerUnit: raw.costPerUnit } : {}),
    ...(raw.source ? { source: raw.source } : {})
  } as any;
}

function snapshotWire<T>(snapshot: SettingsSnapshot<T>) {
  return { updatedAt: snapshot.updatedAt, mtimeMs: snapshot.mtimeMs, hash: snapshot.hash };
}

// Settings responses carry no secret values — only structured config (provider
// records, secret ref names, paths). Scrub secret-bearing strings (e.g. userinfo
// or query secrets embedded in a baseUrl), but do not redact by key name: that
// would nuke legitimately-named fields like `secrets` and `secretRef`.
function success<T>(body: T): T {
  return redactSecrets(body, { redactKeys: false }) as T;
}

function secretsMetadata(input: SettingsPathsInput = {}) {
  const path = secretsPath(input);
  const secrets = readSecrets(input);
  let chmod: string | null = null;
  try { chmod = (statSync(path).mode & 0o777).toString(8).padStart(3, '0'); } catch { chmod = null; }
  return { path, displayPath: input.homeDir ? path : '~/.etvs/secrets.json', chmod, plaintext: true, keys: Object.keys(secrets.secrets).sort() };
}

function fieldValue(field: unknown): string | undefined {
  if (!field || typeof field !== 'object' || !('value' in field)) return undefined;
  const value = (field as { value?: unknown }).value;
  return typeof value === 'string' ? value : value == null ? undefined : String(value);
}

async function readMultipartBuffer(part: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of part.file) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_VOICE_SAMPLE_BYTES) {
      part.file.resume?.();
      throw new SettingsError('invalid_settings', 'Voice sample must be 25 MiB or smaller.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

// Provider roots (e.g. https://api.elevenlabs.io, https://api.x.ai) are not health
// endpoints — they return 404/421/etc. To verify both reachability and that the
// stored API key actually authenticates, each vendor needs a real probe path and
// its own auth-header recipe. baseUrl here is the vendor root used by the probe
// only; the adapter may interpret provider.baseUrl differently (e.g. xAI treats
// it as the full endpoint), so we never fall back to provider.baseUrl when a
// vendor match exists.
const PROVIDER_PROBES: Record<string, { baseUrl: string; path: string; authHeader?: (key: string) => Record<string, string> }> = {
  elevenlabs: { baseUrl: 'https://api.elevenlabs.io', path: '/v1/voices', authHeader: (key) => ({ 'xi-api-key': key }) },
  xai: { baseUrl: 'https://api.x.ai', path: '/v1/api-key', authHeader: (key) => ({ Authorization: `Bearer ${key}` }) },
  openai: { baseUrl: 'https://api.openai.com', path: '/v1/models', authHeader: (key) => ({ Authorization: `Bearer ${key}` }) },
  'openai-whisper': { baseUrl: 'https://api.openai.com', path: '/v1/models', authHeader: (key) => ({ Authorization: `Bearer ${key}` }) }
};

async function probeProvider(provider: ProviderRecord, settingsPaths: SettingsPathsInput) {
  const probe = PROVIDER_PROBES[provider.name];
  const probeRoot = probe?.baseUrl ?? provider.baseUrl?.replace(/\/$/, '');
  if (!probeRoot) throw new SettingsError('invalid_base_url', 'Provider has no baseUrl to test.');
  const url = `${probeRoot}${probe?.path ?? ''}`;
  const headers: Record<string, string> = {};
  if (probe?.authHeader && provider.secretRef) {
    const key = readSecrets(settingsPaths).secrets[provider.secretRef];
    if (!key) throw new SettingsError('auth_failed', `Secret '${provider.secretRef}' is not configured. Paste the API key in Keys → ${provider.name} and Save first.`);
    Object.assign(headers, probe.authHeader(key));
  }
  const response = await guardedFetch(url, { method: 'GET', tier: provider.tier, timeoutMs: 5000, maxRedirects: 4, headers });
  if (response.status === 401 || response.status === 403) throw new SettingsError('auth_failed', 'Provider authentication failed — check the API key.');
  if (response.status === 404) throw new SettingsError('model_missing', 'Provider endpoint or model was not found.');
  if (!response.ok) throw new SettingsError('provider_unreachable', `Provider returned HTTP ${response.status}.`);
  return { ok: true, status: response.status, checkedAt: new Date().toISOString() };
}


export async function registerSettingsRoutes(app: FastifyInstance, config: ApiConfig, workspace: (projectId: string) => string) {
  const settingsPaths: SettingsPathsInput = { homeDir: config.settingsHome };

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/settings/')) return;
    if (isLocalHost(config.host) || process.env.ETVS_SETTINGS_ALLOW_LAN === '1') return;
    return reply.code(403).send(settingsErrorEnvelope(new SettingsError('invalid_settings', 'Settings API is unavailable when bound to LAN unless explicitly enabled.')));
  });

  app.get('/api/settings/providers', async (_, reply) => {
    try {
      const registry = readProviderRegistry(settingsPaths);
      return success({ registry: registry.value, snapshot: snapshotWire(registry), secrets: secretsMetadata(settingsPaths) });
    } catch (err) { return sendSettingsError(reply, err); }
  });

  app.post('/api/settings/providers', async (req, reply) => {
    try { return success({ provider: upsertProvider({ ...settingsPaths, provider: providerPayload(req.body) }) }); }
    catch (err) { return sendSettingsError(reply, err); }
  });

  app.put<{ Params: { id: string } }>('/api/settings/providers/:id', async (req, reply) => {
    try { return success({ provider: upsertProvider({ ...settingsPaths, provider: { ...providerPayload(req.body), id: req.params.id } }) }); }
    catch (err) { return sendSettingsError(reply, err); }
  });

  app.delete<{ Params: { id: string } }>('/api/settings/providers/:id', async (req, reply) => {
    try { return success({ provider: removeProvider({ ...settingsPaths, id: req.params.id }) }); }
    catch (err) { return sendSettingsError(reply, err); }
  });

  app.post<{ Params: { id: string }; Body: { kind?: string; acknowledgePaid?: boolean } }>('/api/settings/providers/:id/default', async (req, reply) => {
    try {
      const kind = ProviderKindSchema.parse(req.body?.kind ?? req.params.id.split('.')[0]);
      return success({ provider: setDefaultProvider({ ...settingsPaths, kind, id: req.params.id, acknowledgePaid: Boolean(req.body?.acknowledgePaid) }) });
    } catch (err) { return sendSettingsError(reply, err); }
  });

  app.post<{ Params: { id: string } }>('/api/settings/providers/:id/test', async (req, reply) => {
    try {
      const registry = readProviderRegistry(settingsPaths).value;
      const provider = registry.providers.find((candidate) => candidate.id === req.params.id);
      if (!provider) throw new SettingsError('provider_not_found', `Provider not found: ${req.params.id}`);
      if (!provider.enabled) throw new SettingsError('provider_disabled', `Provider is disabled: ${req.params.id}`);
      return success({ providerId: provider.id, result: await probeProvider(provider, settingsPaths) });
    } catch (err) { return sendSettingsError(reply, err); }
  });

  app.put<{ Params: { ref: string }; Body: { value?: string } }>('/api/settings/secrets/:ref', async (req, reply) => {
    try { setProviderSecret({ ...settingsPaths, secretRef: req.params.ref, value: String(req.body?.value ?? '') }); return success({ secrets: secretsMetadata(settingsPaths) }); }
    catch (err) { return sendSettingsError(reply, err); }
  });

  app.delete<{ Params: { ref: string } }>('/api/settings/secrets/:ref', async (req, reply) => {
    try { deleteProviderSecret({ ...settingsPaths, secretRef: req.params.ref }); return success({ secrets: secretsMetadata(settingsPaths) }); }
    catch (err) { return sendSettingsError(reply, err); }
  });

  app.get('/api/settings/voices', async (_, reply) => {
    try { return success({ voices: readVoicesLibrary(settingsPaths).value.voices }); }
    catch (err) { return sendSettingsError(reply, err); }
  });

  app.post<{ Body: Omit<VoiceRecord, 'schemaVersion' | 'createdAt' | 'updatedAt'> }>('/api/settings/voices', async (req, reply) => {
    try {
      // Guard against null / non-object bodies before the core helper dereferences `.id`;
      // otherwise a TypeError leaks past sendSettingsError as a generic 500.
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new SettingsError('invalid_settings', 'Voice payload must be a JSON object.');
      }
      return success({ voice: upsertVoice({ ...settingsPaths, voice: req.body }) });
    }
    catch (err) { return sendSettingsError(reply, err); }
  });

  app.post('/api/settings/voices/clone', async (req, reply) => {
    try {
      const contentLength = Number(req.headers['content-length'] || 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_VOICE_SAMPLE_BYTES + 1024 * 1024) {
        return reply.code(413).send(settingsErrorEnvelope(new SettingsError('invalid_settings', 'Voice sample must be 25 MiB or smaller.')));
      }
      // Iterate parts independent of order — multipart spec does not require `name` before
      // `sample`, so a valid client appending the file first must not lose its metadata.
      let sampleAudio: Buffer | null = null;
      let sampleFileName = 'sample';
      let sampleMimeType = 'audio/wav';
      const fields: Record<string, string> = {};
      for await (const part of (req as any).parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'sample' || sampleAudio) { part.file.resume?.(); continue; }
          if (!String(part.mimetype || '').startsWith('audio/')) {
            part.file.resume?.();
            throw new SettingsError('invalid_settings', `Unsupported voice sample MIME: ${part.mimetype || 'unknown'}.`);
          }
          sampleMimeType = part.mimetype;
          sampleFileName = part.filename || 'sample';
          sampleAudio = await readMultipartBuffer(part);
        } else if (typeof part.fieldname === 'string') {
          const value = (part as any).value;
          fields[part.fieldname] = typeof value === 'string' ? value : value == null ? '' : String(value);
        }
      }
      if (!sampleAudio) throw new SettingsError('invalid_settings', 'Voice sample audio file is required.');
      if (sampleAudio.byteLength === 0) throw new SettingsError('invalid_settings', 'Voice sample audio file is empty.');
      const name = (fields.name ?? '').trim();
      if (!name) throw new SettingsError('invalid_settings', 'Voice name is required.');
      // Validate against VoiceRecordSchema limits before the paid call so we don't strand an
      // orphan cloned voice when upsertVoice would later reject the local record.
      if (name.length > 200) throw new SettingsError('invalid_settings', 'Voice name must be 200 characters or fewer.');
      const description = (fields.description ?? '').trim() || undefined;
      const originProjectId = (fields.originProjectId ?? '').trim() || undefined;
      if (originProjectId && originProjectId.length > 200) throw new SettingsError('invalid_settings', 'originProjectId must be 200 characters or fewer.');
      // Default stays elevenlabs (additive wave; W8 flips the default under consent).
      const providerKey = ((fields.provider ?? 'elevenlabs') as string) as CloneProviderKey;
      const cfg = CLONE_PROVIDERS[providerKey];
      if (!cfg) throw new SettingsError('invalid_settings', `Unsupported clone provider: ${providerKey}.`);
      const secret = readSecrets(settingsPaths).secrets[cfg.secretKey];
      if (!secret) return reply.code(400).send({ error: { code: 'provider_auth_failed', message: `Configure ${cfg.label} in Keys before cloning voices.` } });
      const result = await cfg.clone({
        name,
        description,
        samples: [{ audio: sampleAudio, fileName: sampleFileName, mimeType: sampleMimeType }],
        secret,
        signal: new AbortController().signal
      });
      const voice = upsertVoice({ ...settingsPaths, voice: { id: `voice-${randomBytes(4).toString('hex')}`, name, provider: providerKey, voiceId: result.voiceId, ...(originProjectId ? { originProjectId } : {}), provenance: { method: 'ivc', createdBy: 'clone-route' } } });
      return success({ voice });
    } catch (err) {
      if (err instanceof ProviderExecutionError) return sendProviderCloneError(reply, err);
      return sendSettingsError(reply, err);
    }
  });

  app.post('/api/settings/voices/enroll', async (req, reply) => {
    try {
      const contentLength = Number(req.headers['content-length'] || 0);
      if (Number.isFinite(contentLength) && contentLength > 25 * MAX_VOICE_SAMPLE_BYTES + 1024 * 1024) {
        return reply.code(413).send(settingsErrorEnvelope(new SettingsError('invalid_settings', 'Enrollment recordings too large (25 MiB per file, 25 files max).')));
      }
      const samples: Array<{ audio: Buffer; fileName: string; mimeType: string }> = [];
      const fields: Record<string, string> = {};
      // Override the global multipart files:1 limit for this route — enrollment accepts up to 25.
      for await (const part of (req as any).parts({ limits: { files: 25 } })) {
        if (part.type === 'file') {
          if (part.fieldname !== 'recordings' && part.fieldname !== 'recordings[]') { part.file.resume?.(); continue; }
          if (samples.length >= 25) { part.file.resume?.(); throw new SettingsError('invalid_settings', 'At most 25 enrollment recordings are accepted per request.'); }
          if (!String(part.mimetype || '').startsWith('audio/')) {
            part.file.resume?.();
            throw new SettingsError('invalid_settings', `Unsupported recording MIME type: ${part.mimetype || 'unknown'}.`);
          }
          const audio = await readMultipartBuffer(part);
          if (audio.byteLength === 0) throw new SettingsError('invalid_settings', `Recording "${part.filename || part.fieldname}" is empty.`);
          samples.push({ audio, fileName: part.filename || `recording-${samples.length + 1}.wav`, mimeType: part.mimetype });
        } else if (typeof part.fieldname === 'string') {
          const value = (part as any).value;
          fields[part.fieldname] = typeof value === 'string' ? value : value == null ? '' : String(value);
        }
      }
      if (samples.length === 0) throw new SettingsError('invalid_settings', 'At least one enrollment recording is required.');
      const name = (fields.name ?? '').trim();
      if (!name) throw new SettingsError('invalid_settings', 'Voice name is required.');
      if (name.length > 200) throw new SettingsError('invalid_settings', 'Voice name must be 200 characters or fewer.');
      const description = (fields.description ?? '').trim() || undefined;
      const originProjectId = (fields.originProjectId ?? '').trim() || undefined;
      if (originProjectId && originProjectId.length > 200) throw new SettingsError('invalid_settings', 'originProjectId must be 200 characters or fewer.');
      // Enroll defaults to 'elevenlabs' (multi-sample model) — Cartesia IVC is single-clip,
      // so multi-recording enrollment stays on ElevenLabs unless caller overrides.
      const enrollProviderKey = ((fields.provider ?? 'elevenlabs') as string) as CloneProviderKey;
      const enrollCfg = CLONE_PROVIDERS[enrollProviderKey];
      if (!enrollCfg) throw new SettingsError('invalid_settings', `Unsupported enroll provider: ${enrollProviderKey}.`);
      // Reject excess recordings with a 4xx before the (single-clip) adapter would 502.
      if (samples.length > enrollCfg.maxSamples) throw new SettingsError('invalid_settings', `${enrollCfg.label} accepts at most ${enrollCfg.maxSamples} recording${enrollCfg.maxSamples === 1 ? '' : 's'}; received ${samples.length}.`);
      const secret = readSecrets(settingsPaths).secrets[enrollCfg.secretKey];
      if (!secret) return reply.code(400).send({ error: { code: 'provider_auth_failed', message: `Configure ${enrollCfg.label} in Keys before enrolling voices.` } });
      // Voice enrollment is a paid call billed by plan tier (not per-character). Disclose before calling.
      const result = await enrollCfg.clone({ name, description, samples, secret, signal: new AbortController().signal });
      const voice = upsertVoice({ ...settingsPaths, voice: { id: `voice-${randomBytes(4).toString('hex')}`, name, provider: enrollProviderKey, voiceId: result.voiceId, ...(originProjectId ? { originProjectId } : {}), provenance: { method: 'enroll', createdBy: 'enroll-route' } } });
      return success({ voice, sampleCount: samples.length, provider: enrollProviderKey, estimatedCostUsd: null });
    } catch (err) {
      if (err instanceof ProviderExecutionError) return sendProviderCloneError(reply, err);
      return sendSettingsError(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: { name?: string } }>('/api/settings/voices/:id', async (req, reply) => {
    try {
      const name = String(req.body?.name ?? '').trim();
      if (!name) throw new SettingsError('invalid_settings', 'Voice name is required.');
      const existing = readVoicesLibrary(settingsPaths).value.voices.find((voice) => voice.id === req.params.id);
      if (!existing) throw new SettingsError('voice_not_found', `Voice not found: ${req.params.id}`);
      return success({ voice: upsertVoice({ ...settingsPaths, voice: { ...existing, name } }) });
    } catch (err) { return sendSettingsError(reply, err); }
  });

  app.delete<{ Params: { id: string } }>('/api/settings/voices/:id', async (req, reply) => {
    try { return success({ voice: removeVoice({ ...settingsPaths, id: req.params.id }) }); }
    catch (err) { return sendSettingsError(reply, err); }
  });

  app.get<{ Params: { projectId: string } }>('/api/settings/workspace/:projectId', async (req, reply) => {
    try {
      const snapshot = readWorkspaceSettings(workspace(req.params.projectId));
      return success({ settings: snapshot.value, snapshot: snapshotWire(snapshot) });
    } catch (err) { return sendSettingsError(reply, err); }
  });

  app.put<{ Params: { projectId: string }; Body: { settings?: WorkspaceSettingsFile; expected?: ExpectedSnapshot } }>('/api/settings/workspace/:projectId', async (req, reply) => {
    try {
      const value = req.body?.settings ?? req.body;
      const snapshot = writeWorkspaceSettings(workspace(req.params.projectId), value as WorkspaceSettingsFile, req.body?.expected);
      return success({ settings: snapshot.value, snapshot: snapshotWire(snapshot) });
    } catch (err) { return sendSettingsError(reply, err); }
  });
}

export const SETTINGS_ROUTE_METHODS = [
  'GET /api/settings/providers',
  'POST /api/settings/providers',
  'PUT /api/settings/providers/{id}',
  'DELETE /api/settings/providers/{id}',
  'POST /api/settings/providers/{id}/default',
  'POST /api/settings/providers/{id}/test',
  'PUT /api/settings/secrets/{ref}',
  'DELETE /api/settings/secrets/{ref}',
  'GET /api/settings/voices',
  'POST /api/settings/voices',
  'POST /api/settings/voices/clone',
  'PATCH /api/settings/voices/{id}',
  'DELETE /api/settings/voices/{id}',
  'GET /api/settings/workspace/{projectId}',
  'PUT /api/settings/workspace/{projectId}'
] as const;
