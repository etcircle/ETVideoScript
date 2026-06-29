import { describe, expect, it, vi } from 'vitest';

vi.mock('node:dns', () => ({
  lookup: vi.fn((hostname: string, options: any, callback: (...args: any[]) => void) => {
    const answers: Record<string, { address: string; family: 4 | 6 }> = {
      'private.test': { address: '192.168.0.10', family: 4 },
      'mapped.test': { address: '::ffff:192.168.0.10', family: 6 },
      'cgnat.test': { address: '100.64.1.2', family: 4 },
      'benchmark.test': { address: '198.18.0.1', family: 4 },
      'multicast.test': { address: '224.0.0.1', family: 4 },
      'doc-v6.test': { address: '2001:db8::1', family: 6 },
      '127.0.0.1': { address: '127.0.0.1', family: 4 }
    };
    const answer = answers[hostname] ?? { address: '93.184.216.34', family: 4 };
    if (options?.all) return callback(null, [answer]);
    return callback(null, answer.address, answer.family);
  })
}));

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './server';
import { SETTINGS_ROUTE_METHODS } from './settingsRoutes';

function config(root: string, overrides = {}) {
  return { host: '127.0.0.1', port: 0, workspaceRoot: root, enableTerminal: false, allowedOrigins: ['http://127.0.0.1:4318'], lanOrigins: [], terminalToken: null, ...overrides };
}

function specRoutes(): string[] {
  const yaml = readFileSync(join(process.cwd(), 'apps/local-api/openapi/settings.yaml'), 'utf8');
  const routes: string[] = [];
  let path = '';
  for (const line of yaml.split(/\r?\n/)) {
    const pathMatch = /^  (\/api\/settings\/[^:]+):$/.exec(line);
    if (pathMatch) { path = pathMatch[1]; continue; }
    const methodMatch = /^    (get|post|put|patch|delete):$/.exec(line);
    if (path && methodMatch) routes.push(`${methodMatch[1].toUpperCase()} ${path}`);
  }
  return routes.sort();
}

function specStatusCodes(pathName: string, methodName: string): string[] {
  const yaml = readFileSync(join(process.cwd(), 'apps/local-api/openapi/settings.yaml'), 'utf8');
  const statuses: string[] = [];
  let inPath = false;
  let inMethod = false;
  for (const line of yaml.split(/\r?\n/)) {
    const pathMatch = /^  (\/api\/settings\/[^:]+):$/.exec(line);
    if (pathMatch) { inPath = pathMatch[1] === pathName; inMethod = false; continue; }
    const methodMatch = /^    (get|post|put|patch|delete):$/.exec(line);
    if (methodMatch) { inMethod = inPath && methodMatch[1] === methodName; continue; }
    const statusMatch = /^        '([0-9]{3})':/.exec(line);
    if (inMethod && statusMatch) statuses.push(statusMatch[1]);
  }
  return statuses;
}

function voiceCloneMultipart(input: { file: Buffer; type?: string; name?: string; description?: string; originProjectId?: string; fileFirst?: boolean }) {
  const boundary = `----etvs-${Math.random().toString(36).slice(2)}`;
  const fields = [
    ['name', input.name ?? 'Eve'],
    ...(input.description ? [['description', input.description]] : []),
    ...(input.originProjectId ? [['originProjectId', input.originProjectId]] : [])
  ].map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="sample"; filename="sample.wav"\r\nContent-Type: ${input.type ?? 'audio/wav'}\r\n\r\n`);
  const filePart = Buffer.concat([head, input.file, Buffer.from('\r\n')]);
  const tail = Buffer.from(`--${boundary}--\r\n`);
  const ordered = input.fileFirst ? [filePart, ...fields, tail] : [...fields, filePart, tail];
  const payload = Buffer.concat(ordered);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) } };
}

describe('settings API routes', () => {
  it('keeps the registered settings routes in sync with the checked-in OpenAPI spec', () => {
    expect([...SETTINGS_ROUTE_METHODS].sort()).toEqual(specRoutes());
    expect(specStatusCodes('/api/settings/workspace/{projectId}', 'put')).toContain('409');
    expect(specStatusCodes('/api/settings/providers/{id}/test', 'post')).toEqual(expect.arrayContaining(['400', '502']));
  });

  it('CRUDs providers and maps paid default acknowledgement failures to 409 envelopes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const app = createApp(config(root));
    try {
      const created = await app.inject({ method: 'POST', url: '/api/settings/providers', payload: { id: 'studio-sound.elevenlabs-isolation', kind: 'studio-sound', name: 'elevenlabs-isolation', tier: 'paid', enabled: true } });
      expect(created.statusCode).toBe(200);
      const refused = await app.inject({ method: 'POST', url: '/api/settings/providers/studio-sound.elevenlabs-isolation/default', payload: { kind: 'studio-sound' } });
      expect(refused.statusCode).toBe(409);
      expect(JSON.parse(refused.body).error.code).toBe('paid_default_requires_ack');
      const accepted = await app.inject({ method: 'POST', url: '/api/settings/providers/studio-sound.elevenlabs-isolation/default', payload: { kind: 'studio-sound', acknowledgePaid: true } });
      expect(accepted.statusCode).toBe(200);
      const listed = await app.inject({ method: 'GET', url: '/api/settings/providers' });
      expect(JSON.parse(listed.body).snapshot.hash).toMatch(/^[a-f0-9]{64}$/);
    } finally { await app.close(); process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('treats provider PUT with baseUrl: null as an explicit clear', async () => {
    // Regression: xAI adapter code treats provider.baseUrl as a full endpoint,
    // so leaving a stale vendor-root baseUrl on the record routes real calls to
    // a 404. The Save flow has to be able to clear that field on existing records;
    // an omitted/undefined baseUrl is silently dropped by JSON.stringify and the
    // server falls back to the existing.baseUrl during upsertProvider's merge.
    // Sending baseUrl: null is the explicit "drop this field" signal.
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const app = createApp(config(root));
    try {
      const initial = await app.inject({ method: 'POST', url: '/api/settings/providers', payload: { id: 'image-gen.xai', kind: 'image-gen', name: 'xai', tier: 'paid', baseUrl: 'https://api.x.ai', enabled: true } });
      expect(initial.statusCode).toBe(200);
      expect(JSON.parse(initial.body).provider.baseUrl).toBe('https://api.x.ai');
      const omitted = await app.inject({ method: 'PUT', url: '/api/settings/providers/image-gen.xai', payload: { kind: 'image-gen', name: 'xai', tier: 'paid', enabled: true } });
      expect(omitted.statusCode).toBe(200);
      expect(JSON.parse(omitted.body).provider.baseUrl).toBe('https://api.x.ai');
      const cleared = await app.inject({ method: 'PUT', url: '/api/settings/providers/image-gen.xai', payload: { kind: 'image-gen', name: 'xai', tier: 'paid', baseUrl: null, enabled: true } });
      expect(cleared.statusCode).toBe(200);
      expect(JSON.parse(cleared.body).provider.baseUrl).toBeUndefined();
      const emptyString = await app.inject({ method: 'PUT', url: '/api/settings/providers/image-gen.xai', payload: { kind: 'image-gen', name: 'xai', tier: 'paid', baseUrl: 'https://api.x.ai/v1/images/generations', enabled: true } });
      expect(JSON.parse(emptyString.body).provider.baseUrl).toBe('https://api.x.ai/v1/images/generations');
      const clearedAgain = await app.inject({ method: 'PUT', url: '/api/settings/providers/image-gen.xai', payload: { kind: 'image-gen', name: 'xai', tier: 'paid', baseUrl: '', enabled: true } });
      expect(JSON.parse(clearedAgain.body).provider.baseUrl).toBeUndefined();
    } finally { await app.close(); process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('CRUDs voices with upsert semantics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const app = createApp(config(root));
    try {
      const empty = await app.inject({ method: 'GET', url: '/api/settings/voices' });
      expect(empty.statusCode).toBe(200);
      expect(JSON.parse(empty.body).voices).toEqual([]);

      const voice = { id: 'narrator-a', name: 'Narrator A', provider: 'elevenlabs', voiceId: 'el-voice-a', sampleAssetPath: 'assets/sample.wav', originProjectId: 'project-a' };
      const created = await app.inject({ method: 'POST', url: '/api/settings/voices', payload: voice });
      expect(created.statusCode).toBe(200);
      expect(JSON.parse(created.body).voice).toMatchObject(voice);

      const listed = await app.inject({ method: 'GET', url: '/api/settings/voices' });
      expect(JSON.parse(listed.body).voices).toHaveLength(1);
      expect(JSON.parse(listed.body).voices[0]).toMatchObject(voice);

      const updated = await app.inject({ method: 'POST', url: '/api/settings/voices', payload: { ...voice, name: 'Narrator A Updated' } });
      expect(updated.statusCode).toBe(200);
      expect(JSON.parse(updated.body).voice).toMatchObject({ id: 'narrator-a', name: 'Narrator A Updated', voiceId: 'el-voice-a' });
      const afterUpdate = await app.inject({ method: 'GET', url: '/api/settings/voices' });
      expect(JSON.parse(afterUpdate.body).voices).toHaveLength(1);
      expect(JSON.parse(afterUpdate.body).voices[0].name).toBe('Narrator A Updated');

      const removed = await app.inject({ method: 'DELETE', url: '/api/settings/voices/narrator-a' });
      expect(removed.statusCode).toBe(200);
      expect(JSON.parse(removed.body).voice.id).toBe('narrator-a');
      const afterDelete = await app.inject({ method: 'GET', url: '/api/settings/voices' });
      expect(JSON.parse(afterDelete.body).voices).toEqual([]);
    } finally { await app.close(); process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('maps voice not found and invalid voice payloads to settings envelopes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const app = createApp(config(root));
    try {
      const missing = await app.inject({ method: 'DELETE', url: '/api/settings/voices/missing-voice' });
      expect(missing.statusCode).toBe(404);
      expect(JSON.parse(missing.body).error.code).toBe('voice_not_found');

      const invalid = await app.inject({ method: 'POST', url: '/api/settings/voices', payload: { id: 'bad-voice', name: 'Bad Voice', provider: 'elevenlabs', voiceId: 'el-bad', sampleAssetPath: '../sample.wav' } });
      expect(invalid.statusCode).toBe(400);
      expect(JSON.parse(invalid.body).error.code).toBe('invalid_settings');

      // Null / non-object bodies must round-trip as 400 — pre-fix this returned a generic 500
      // because upsertVoice dereferences `.id` before any zod parse.
      const nullBody = await app.inject({ method: 'POST', url: '/api/settings/voices', payload: 'null', headers: { 'content-type': 'application/json' } });
      expect(nullBody.statusCode).toBe(400);
      expect(JSON.parse(nullBody.body).error.code).toBe('invalid_settings');

      const arrayBody = await app.inject({ method: 'POST', url: '/api/settings/voices', payload: [] });
      expect(arrayBody.statusCode).toBe(400);
      expect(JSON.parse(arrayBody.body).error.code).toBe('invalid_settings');
    } finally { await app.close(); process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('rejects a duplicate (provider, voiceId) pair via the route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const app = createApp(config(root));
    try {
      const first = await app.inject({ method: 'POST', url: '/api/settings/voices', payload: { id: 'eve-one', name: 'Eve 1', provider: 'elevenlabs', voiceId: 'el_same' } });
      expect(first.statusCode).toBe(200);
      // Second slug pointing at the same upstream voice handle — schema's superRefine on the
      // read after upsert must reject it; the original entry stays intact.
      const dup = await app.inject({ method: 'POST', url: '/api/settings/voices', payload: { id: 'eve-two', name: 'Eve 2', provider: 'elevenlabs', voiceId: 'el_same' } });
      expect(dup.statusCode).toBe(400);
      expect(JSON.parse(dup.body).error.code).toBe('invalid_settings');
      const stillThere = await app.inject({ method: 'GET', url: '/api/settings/voices' });
      const voices = JSON.parse(stillThere.body).voices;
      expect(voices.map((v: { id: string }) => v.id)).toEqual(['eve-one']);
    } finally { await app.close(); process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('clones an ElevenLabs voice sample and persists the voice record', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    const oldFetch = globalThis.fetch;
    process.env.HOME = home;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ voice_id: 'el_xxx' }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
    const app = createApp(config(root));
    try {
      await app.inject({ method: 'PUT', url: '/api/settings/secrets/elevenlabs', payload: { value: 'el-secret' } });
      const body = voiceCloneMultipart({ file: Buffer.from('wav'), name: 'Eve' });
      const response = await app.inject({ method: 'POST', url: '/api/settings/voices/clone', payload: body.payload, headers: body.headers });
      expect(response.statusCode).toBe(200);
      const voice = JSON.parse(response.body).voice;
      expect(voice).toMatchObject({ name: 'Eve', provider: 'elevenlabs', voiceId: 'el_xxx' });
      expect(voice.id).toMatch(/^voice-[a-f0-9]{8}$/);
      expect(JSON.parse(readFileSync(join(home, '.etvs', 'voices.json'), 'utf8')).voices[0]).toMatchObject({ id: voice.id, voiceId: 'el_xxx' });
    } finally { await app.close(); globalThis.fetch = oldFetch; process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('rejects voice clone when ElevenLabs is not configured without calling fetch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    const oldFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    process.env.HOME = home;
    globalThis.fetch = fetchMock as any;
    const app = createApp(config(root));
    try {
      const body = voiceCloneMultipart({ file: Buffer.from('wav') });
      const response = await app.inject({ method: 'POST', url: '/api/settings/voices/clone', payload: body.payload, headers: body.headers });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toMatchObject({ code: 'provider_auth_failed', message: expect.stringContaining('Configure ElevenLabs in Keys') });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await app.close(); globalThis.fetch = oldFetch; process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('clones successfully when the sample file arrives before the metadata fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    const oldFetch = globalThis.fetch;
    process.env.HOME = home;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ voice_id: 'el_first' }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
    const app = createApp(config(root));
    try {
      await app.inject({ method: 'PUT', url: '/api/settings/secrets/elevenlabs', payload: { value: 'el-secret' } });
      const body = voiceCloneMultipart({ file: Buffer.from('wav'), name: 'Eve', fileFirst: true });
      const response = await app.inject({ method: 'POST', url: '/api/settings/voices/clone', payload: body.payload, headers: body.headers });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).voice).toMatchObject({ name: 'Eve', provider: 'elevenlabs', voiceId: 'el_first' });
    } finally { await app.close(); globalThis.fetch = oldFetch; process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('rejects empty voice samples before calling ElevenLabs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    const oldFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    process.env.HOME = home;
    globalThis.fetch = fetchMock as any;
    const app = createApp(config(root));
    try {
      await app.inject({ method: 'PUT', url: '/api/settings/secrets/elevenlabs', payload: { value: 'el-secret' } });
      const body = voiceCloneMultipart({ file: Buffer.alloc(0) });
      const response = await app.inject({ method: 'POST', url: '/api/settings/voices/clone', payload: body.payload, headers: body.headers });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toMatchObject({ code: 'invalid_settings', message: expect.stringContaining('empty') });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await app.close(); globalThis.fetch = oldFetch; process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('rejects oversized voice names before calling ElevenLabs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    const oldFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    process.env.HOME = home;
    globalThis.fetch = fetchMock as any;
    const app = createApp(config(root));
    try {
      await app.inject({ method: 'PUT', url: '/api/settings/secrets/elevenlabs', payload: { value: 'el-secret' } });
      const body = voiceCloneMultipart({ file: Buffer.from('wav'), name: 'x'.repeat(201) });
      const response = await app.inject({ method: 'POST', url: '/api/settings/voices/clone', payload: body.payload, headers: body.headers });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toMatchObject({ code: 'invalid_settings', message: expect.stringContaining('200 characters') });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await app.close(); globalThis.fetch = oldFetch; process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('rejects non-audio voice clone samples without calling fetch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    const oldFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    process.env.HOME = home;
    globalThis.fetch = fetchMock as any;
    const app = createApp(config(root));
    try {
      await app.inject({ method: 'PUT', url: '/api/settings/secrets/elevenlabs', payload: { value: 'el-secret' } });
      const body = voiceCloneMultipart({ file: Buffer.from('nope'), type: 'text/plain' });
      const response = await app.inject({ method: 'POST', url: '/api/settings/voices/clone', payload: body.payload, headers: body.headers });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe('invalid_settings');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await app.close(); globalThis.fetch = oldFetch; process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('renames voices without changing provider identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const app = createApp(config(root));
    try {
      const original = { id: 'eve', name: 'Eve', provider: 'elevenlabs', voiceId: 'el_eve', originProjectId: 'episode-1' };
      await app.inject({ method: 'POST', url: '/api/settings/voices', payload: original });
      const renamed = await app.inject({ method: 'PATCH', url: '/api/settings/voices/eve', payload: { name: 'Eve Updated' } });
      expect(renamed.statusCode).toBe(200);
      expect(JSON.parse(renamed.body).voice).toMatchObject({ ...original, name: 'Eve Updated' });
    } finally { await app.close(); process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('maps missing voice rename to voice_not_found', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const app = createApp(config(root));
    try {
      const response = await app.inject({ method: 'PATCH', url: '/api/settings/voices/missing', payload: { name: 'Missing' } });
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error.code).toBe('voice_not_found');
    } finally { await app.close(); process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('writes provider secrets under config.settingsHome instead of process HOME', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const realHome = mkdtempSync(join(tmpdir(), 'etvideo-real-home-'));
    const settingsHome = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = realHome;
    const app = createApp(config(root, { settingsHome }));
    try {
      const response = await app.inject({ method: 'PUT', url: '/api/settings/secrets/sandbox-key', payload: { value: 'sandbox-secret-value' } });
      expect(response.statusCode).toBe(200);
      const secretPath = join(settingsHome, '.etvs', 'secrets.json');
      expect(existsSync(secretPath)).toBe(true);
      expect(existsSync(join(realHome, '.etvs', 'secrets.json'))).toBe(false);
      const secrets = JSON.parse(readFileSync(secretPath, 'utf8'));
      expect(secrets.secrets['sandbox-key']).toBe('sandbox-secret-value');
      expect(JSON.parse(response.body).secrets.displayPath).toBe(secretPath);
    } finally {
      await app.close();
      process.env.HOME = oldHome;
      rmSync(root, { recursive: true, force: true });
      rmSync(realHome, { recursive: true, force: true });
      rmSync(settingsHome, { recursive: true, force: true });
    }
  });

  it('refuses settings routes on LAN bind unless explicitly allowed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const app = createApp(config(root, { host: '0.0.0.0', terminalToken: 'token' }));
    const old = process.env.ETVS_SETTINGS_ALLOW_LAN;
    delete process.env.ETVS_SETTINGS_ALLOW_LAN;
    try {
      const response = await app.inject({ method: 'GET', url: '/api/settings/providers' });
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error.code).toBe('invalid_settings');
      process.env.ETVS_SETTINGS_ALLOW_LAN = '1';
      const allowed = await app.inject({ method: 'GET', url: '/api/settings/providers' });
      expect(allowed.statusCode).toBe(200);
    } finally { await app.close(); if (old == null) delete process.env.ETVS_SETTINGS_ALLOW_LAN; else process.env.ETVS_SETTINGS_ALLOW_LAN = old; rmSync(root, { recursive: true, force: true }); }
  });

  it('blocks paid provider DNS answers to private and IPv4-mapped private addresses, but allows local loopback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const app = createApp(config(root));
    try {
      await app.inject({ method: 'POST', url: '/api/settings/providers', payload: { id: 'stt.public-paid', kind: 'stt', name: 'public-paid', tier: 'paid', enabled: true, baseUrl: 'http://private.test' } });
      await app.inject({ method: 'POST', url: '/api/settings/providers', payload: { id: 'stt.mapped-paid', kind: 'stt', name: 'mapped-paid', tier: 'paid', enabled: true, baseUrl: 'http://mapped.test' } });
      await app.inject({ method: 'POST', url: '/api/settings/providers', payload: { id: 'stt.local-loopback', kind: 'stt', name: 'local-loopback', tier: 'local', enabled: true, baseUrl: 'http://127.0.0.1:1' } });
      const privateHit = await app.inject({ method: 'POST', url: '/api/settings/providers/stt.public-paid/test' });
      expect(privateHit.statusCode).toBe(400);
      expect(JSON.parse(privateHit.body).error.code).toBe('ssrf_blocked');
      const mappedHit = await app.inject({ method: 'POST', url: '/api/settings/providers/stt.mapped-paid/test' });
      expect(mappedHit.statusCode).toBe(400);
      expect(JSON.parse(mappedHit.body).error.code).toBe('ssrf_blocked');
      const localHit = await app.inject({ method: 'POST', url: '/api/settings/providers/stt.local-loopback/test' });
      expect([400, 502]).toContain(localHit.statusCode);
      expect(JSON.parse(localHit.body).error.code).not.toBe('ssrf_blocked');
    } finally { await app.close(); process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('blocks .local and redirect-to-private for paid provider tests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1:1/private' } })) as any;
    const app = createApp(config(root));
    try {
      await app.inject({ method: 'POST', url: '/api/settings/providers', payload: { id: 'stt.localdomain-paid', kind: 'stt', name: 'localdomain-paid', tier: 'paid', enabled: true, baseUrl: 'http://printer.local' } });
      await app.inject({ method: 'POST', url: '/api/settings/providers', payload: { id: 'stt.redirect-paid', kind: 'stt', name: 'redirect-paid', tier: 'paid', enabled: true, baseUrl: 'http://redirect.test' } });
      const local = await app.inject({ method: 'POST', url: '/api/settings/providers/stt.localdomain-paid/test' });
      expect(local.statusCode).toBe(400);
      expect(JSON.parse(local.body).error.code).toBe('ssrf_blocked');
      const redirect = await app.inject({ method: 'POST', url: '/api/settings/providers/stt.redirect-paid/test' });
      expect(redirect.statusCode).toBe(400);
      expect(JSON.parse(redirect.body).error.code).toBe('ssrf_blocked');
    } finally { await app.close(); globalThis.fetch = oldFetch; process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });


  it('maps disabled providers and validation failures to non-500 settings envelopes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const app = createApp(config(root));
    try {
      const invalid = await app.inject({ method: 'POST', url: '/api/settings/providers', payload: { id: 'bad', kind: 'nope', name: 'bad', tier: 'local' } });
      expect(invalid.statusCode).toBe(400);
      expect(JSON.parse(invalid.body).error.code).toBe('invalid_settings');

      await app.inject({ method: 'POST', url: '/api/settings/providers', payload: { id: 'stt.disabled-one', kind: 'stt', name: 'disabled-one', tier: 'local', enabled: false, baseUrl: 'http://127.0.0.1:1' } });
      const disabled = await app.inject({ method: 'POST', url: '/api/settings/providers/stt.disabled-one/test' });
      expect(disabled.statusCode).toBe(409);
      expect(JSON.parse(disabled.body).error.code).toBe('provider_disabled');
    } finally { await app.close(); process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('redacts secret-bearing provider baseUrl values and omits absolute snapshot paths in success responses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const app = createApp(config(root));
    try {
      const created = await app.inject({ method: 'POST', url: '/api/settings/providers', payload: { id: 'llm.openrouter', kind: 'llm', name: 'openrouter', tier: 'paid', enabled: true, baseUrl: 'https://u:p@example.com/v1?api_key=value&safe=1' } });
      expect(created.statusCode).toBe(200);
      expect(created.body).not.toContain('u:p');
      expect(created.body).not.toContain('value&safe');
      const listed = await app.inject({ method: 'GET', url: '/api/settings/providers' });
      const body = JSON.parse(listed.body);
      expect(listed.statusCode).toBe(200);
      expect(body.snapshot.path).toBeUndefined();
      expect(JSON.stringify(body)).toContain('https://[REDACTED]@example.com/v1?api_key=[REDACTED]&safe=1');
      expect(JSON.stringify(body)).not.toContain('u:p');
      expect(JSON.stringify(body)).not.toContain('value&safe');
    } finally { await app.close(); process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('preserves secret metadata and provider secretRef in success responses (no blanket key-name redaction)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const app = createApp(config(root));
    try {
      const stored = await app.inject({ method: 'PUT', url: '/api/settings/secrets/xai-key', payload: { value: 'super-secret-value' } });
      expect(stored.statusCode).toBe(200);
      expect(JSON.parse(stored.body).secrets.keys).toContain('xai-key');
      await app.inject({ method: 'POST', url: '/api/settings/providers', payload: { id: 'tts.xai', kind: 'tts', name: 'xai', tier: 'paid', enabled: true, secretRef: 'xai-key' } });
      const listed = await app.inject({ method: 'GET', url: '/api/settings/providers' });
      expect(listed.statusCode).toBe(200);
      const body = JSON.parse(listed.body);
      // The metadata object is named `secrets` — it must not be blanket-redacted away.
      expect(body.secrets).toMatchObject({ displayPath: '~/.etvs/secrets.json', plaintext: true });
      expect(body.secrets.keys).toEqual(['xai-key']);
      // secretRef is a label/pointer, not a secret value — it must survive.
      const provider = body.registry.providers.find((candidate: any) => candidate.id === 'tts.xai');
      expect(provider.secretRef).toBe('xai-key');
      // The actual secret value is never part of any settings response.
      expect(listed.body).not.toContain('super-secret-value');
    } finally { await app.close(); process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('blocks non-global paid provider dial addresses including CGNAT, benchmark, multicast, and IPv6 documentation ranges', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-settings-api-'));
    const home = mkdtempSync(join(tmpdir(), 'etvideo-settings-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const app = createApp(config(root));
    try {
      const cases = [
        ['stt.cgnat-paid', 'cgnat-paid', 'http://cgnat.test'],
        ['stt.benchmark-paid', 'benchmark-paid', 'http://benchmark.test'],
        ['stt.multicast-paid', 'multicast-paid', 'http://multicast.test'],
        ['stt.doc-v6-paid', 'doc-v6-paid', 'http://doc-v6.test']
      ];
      for (const [id, name, baseUrl] of cases) {
        await app.inject({ method: 'POST', url: '/api/settings/providers', payload: { id, kind: 'stt', name, tier: 'paid', enabled: true, baseUrl } });
        const response = await app.inject({ method: 'POST', url: `/api/settings/providers/${id}/test` });
        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).error.code).toBe('ssrf_blocked');
      }
    } finally { await app.close(); process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });
});
