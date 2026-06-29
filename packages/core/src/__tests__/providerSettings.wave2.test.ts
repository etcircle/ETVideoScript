import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readWorkspaceSettings,
  readProviderRegistry,
  resolveProviderForKind,
  upsertProvider,
  writeProviderRegistry,
  writeWorkspaceSettings,
  providerRegistryPath,
  workspaceSettingsPath,
  emptyProviderRegistry,
  redactSecrets,
  ensureCartesiaInfillProvider,
  type WorkspaceSettingsFile
} from '../index';

function tempRoot() { return mkdtempSync(join(tmpdir(), 'etvs-settings-w2-')); }
function cleanup(root: string) { rmSync(root, { recursive: true, force: true }); }

function workspaceSettings(value: Partial<WorkspaceSettingsFile> = {}): WorkspaceSettingsFile {
  return { schemaVersion: 1, defaults: {}, paidCaps: {}, taskOptions: { tts: {} }, updatedAt: '2026-05-16T00:00:00.000Z', ...value };
}

describe('Wave 2 workspace settings', () => {
  it('round-trips workspace settings with a snapshot hash for CAS writes', () => {
    const root = tempRoot();
    try {
      const ws = join(root, 'workspace');
      const empty = readWorkspaceSettings(ws);
      expect(empty.value).toMatchObject({ schemaVersion: 1, defaults: {}, paidCaps: {} });
      expect(empty.hash).toBeNull();

      const written = writeWorkspaceSettings(ws, workspaceSettings({ defaults: { stt: 'stt.workspace-choice' }, paidCaps: { 'studio-sound.adobe-enhance': 12.5 } }), empty);
      expect(written.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(readWorkspaceSettings(ws).value.defaults.stt).toBe('stt.workspace-choice');
      expect(readWorkspaceSettings(ws).value.paidCaps['studio-sound.adobe-enhance']).toBe(12.5);
    } finally { cleanup(root); }
  });

  it('rejects stale workspace settings writes with settings_stale', () => {
    const root = tempRoot();
    try {
      const ws = join(root, 'workspace');
      const first = readWorkspaceSettings(ws);
      writeWorkspaceSettings(ws, workspaceSettings({ defaults: { stt: 'stt.first' } }), first);
      expect(() => writeWorkspaceSettings(ws, workspaceSettings({ defaults: { stt: 'stt.second' } }), first)).toThrow(/workspace settings changed/i);
    } finally { cleanup(root); }
  });

  it('reports malformed workspace settings without silently resetting it', () => {
    const root = tempRoot();
    try {
      const ws = join(root, 'workspace');
      mkdirSync(join(ws, '.etvs'), { recursive: true });
      const path = join(ws, '.etvs/settings.json');
      writeFileSync(path, '{broken');
      expect(() => readWorkspaceSettings(ws)).toThrow(/Malformed settings JSON/);
      expect(readFileSync(path, 'utf8')).toBe('{broken');
    } finally { cleanup(root); }
  });

  it('uses a valid enabled workspace default before the global registry default', () => {
    const root = tempRoot();
    try {
      const ws = join(root, 'workspace');
      upsertProvider({ homeDir: root, provider: { id: 'stt.global-default', kind: 'stt', name: 'global-default', tier: 'local', default: true, baseUrl: 'http://127.0.0.1:8788' } });
      upsertProvider({ homeDir: root, provider: { id: 'stt.workspace-choice', kind: 'stt', name: 'workspace-choice', tier: 'local', enabled: true, baseUrl: 'http://127.0.0.1:9999' } });
      writeWorkspaceSettings(ws, workspaceSettings({ defaults: { stt: 'stt.workspace-choice' } }));
      expect(resolveProviderForKind({ homeDir: root, workspacePath: ws, kind: 'stt', env: {} })?.id).toBe('stt.workspace-choice');
      expect(resolveProviderForKind({ homeDir: root, workspacePath: ws, kind: 'stt', flagProviderId: 'stt.global-default', env: {} })?.id).toBe('stt.global-default');
    } finally { cleanup(root); }
  });

  it('ignores workspace defaults when the target provider is missing or disabled', () => {
    const root = tempRoot();
    try {
      const missingWs = join(root, 'missing');
      const disabledWs = join(root, 'disabled');
      upsertProvider({ homeDir: root, provider: { id: 'stt.global-default', kind: 'stt', name: 'global-default', tier: 'local', default: true, baseUrl: 'http://127.0.0.1:8788' } });
      upsertProvider({ homeDir: root, provider: { id: 'stt.disabled-choice', kind: 'stt', name: 'disabled-choice', tier: 'local', enabled: false, baseUrl: 'http://127.0.0.1:9999' } });
      writeWorkspaceSettings(missingWs, workspaceSettings({ defaults: { stt: 'stt.not-found' } }));
      writeWorkspaceSettings(disabledWs, workspaceSettings({ defaults: { stt: 'stt.disabled-choice' } }));
      expect(resolveProviderForKind({ homeDir: root, workspacePath: missingWs, kind: 'stt', env: {} })?.id).toBe('stt.global-default');
      expect(resolveProviderForKind({ homeDir: root, workspacePath: disabledWs, kind: 'stt', env: {} })?.id).toBe('stt.global-default');
    } finally { cleanup(root); }
  });


  it('redacts URL userinfo and secret query parameters recursively', () => {
    expect(redactSecrets({ url: 'https://u:p@example.com/v1?api_key=value&safe=1', auth: 'Bearer dummy-value' })).toEqual({
      url: 'https://[REDACTED]@example.com/v1?api_key=[REDACTED]&safe=1',
      auth: 'Bearer [REDACTED]'
    });
  });

  it('round-trips provider default model preference in the registry', () => {
    const root = tempRoot();
    try {
      upsertProvider({ homeDir: root, provider: { id: 'tts.elevenlabs', kind: 'tts', name: 'elevenlabs', tier: 'paid', secretRef: 'elevenlabs', model: 'eleven_turbo_v2_5' } });
      expect(readProviderRegistry({ homeDir: root }).value.providers[0]?.model).toBe('eleven_turbo_v2_5');
    } finally { cleanup(root); }
  });

  it('round-trips taskOptions.tts.defaultVoice on workspace settings', () => {
    const root = tempRoot();
    try {
      const ws = join(root, 'workspace');
      const empty = readWorkspaceSettings(ws);
      expect(empty.value.taskOptions.tts).toEqual({});
      const written = writeWorkspaceSettings(ws, workspaceSettings({ taskOptions: { tts: { defaultVoice: { providerId: 'tts.elevenlabs', voiceId: 'el_voice_abc123' } } } }), empty);
      expect(written.value.taskOptions.tts.defaultVoice).toEqual({ providerId: 'tts.elevenlabs', voiceId: 'el_voice_abc123' });
      expect(readWorkspaceSettings(ws).value.taskOptions.tts.defaultVoice?.providerId).toBe('tts.elevenlabs');
    } finally { cleanup(root); }
  });

  it('rejects defaultVoice with a non-tts providerId', () => {
    const root = tempRoot();
    try {
      const ws = join(root, 'workspace');
      mkdirSync(join(ws, '.etvs'), { recursive: true });
      // Hand-write a malformed file so we exercise the parse, not the helper.
      writeFileSync(join(ws, '.etvs/settings.json'), JSON.stringify({ schemaVersion: 1, defaults: {}, paidCaps: {}, taskOptions: { tts: { defaultVoice: { providerId: 'image-gen.xai', voiceId: 'eve' } } }, updatedAt: '2026-05-20T00:00:00.000Z' }));
      let caught: unknown;
      try { readWorkspaceSettings(ws); } catch (err) { caught = err; }
      expect((caught as { code?: string })?.code).toBe('invalid_settings');
      // Zod issue is preserved in details so callers can render a useful error.
      expect(JSON.stringify((caught as { details?: unknown })?.details)).toMatch(/providerId must be a tts/i);
    } finally { cleanup(root); }
  });

  it('parses pre-taskOptions workspace settings files without resetting the defaults map', () => {
    const root = tempRoot();
    try {
      // Simulate an on-disk file written before taskOptions existed (no taskOptions key).
      const ws = join(root, 'workspace');
      mkdirSync(join(ws, '.etvs'), { recursive: true });
      const path = join(ws, '.etvs/settings.json');
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, defaults: { stt: 'stt.homelab-whisper' }, paidCaps: { 'tts.xai': 0.5 }, updatedAt: '2026-05-19T00:00:00.000Z' }));
      const loaded = readWorkspaceSettings(ws);
      expect(loaded.value.defaults.stt).toBe('stt.homelab-whisper');
      expect(loaded.value.paidCaps['tts.xai']).toBe(0.5);
      // New field is materialized with empty defaults — no migration needed, no schemaVersion bump.
      expect(loaded.value.taskOptions).toEqual({ tts: {} });
    } finally { cleanup(root); }
  });

  it('ignores malicious expected.path values for workspace and provider CAS writes', () => {
    const root = tempRoot();
    const oldHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const ws = join(root, 'workspace');
      const workspacePwn = join(root, 'workspace-pwn.json');
      const registryPwn = join(root, 'registry-pwn.json');

      writeWorkspaceSettings(ws, workspaceSettings({ defaults: { stt: 'stt.safe' } }), { path: workspacePwn, mtimeMs: null, hash: null } as any);
      expect(existsSync(workspacePwn)).toBe(false);
      expect(existsSync(workspaceSettingsPath(ws))).toBe(true);
      expect(readWorkspaceSettings(ws).value.defaults.stt).toBe('stt.safe');

      writeProviderRegistry(emptyProviderRegistry('2026-05-16T00:00:00.000Z'), { path: registryPwn, mtimeMs: null, hash: null } as any);
      expect(existsSync(registryPwn)).toBe(false);
      expect(existsSync(providerRegistryPath({ homeDir: root }))).toBe(true);
    } finally { process.env.HOME = oldHome; cleanup(root); }
  });
});

describe('ensureCartesiaInfillProvider', () => {
  it('creates infill.cartesia record with correct fields on an empty registry', () => {
    const root = tempRoot();
    try {
      const record = ensureCartesiaInfillProvider({ homeDir: root });
      expect(record.id).toBe('infill.cartesia');
      expect(record.kind).toBe('infill');
      expect(record.name).toBe('cartesia');
      expect(record.tier).toBe('paid');
      expect(record.secretRef).toBe('cartesia');
      expect(record.model).toBe('sonic-3-2026-01-12');
      expect(record.default).toBe(false);
      // Not a default — must not surface as user-selectable task
      const registry = readProviderRegistry({ homeDir: root }).value;
      const infillRecord = registry.providers.find((p) => p.id === 'infill.cartesia');
      expect(infillRecord).toBeDefined();
      expect(infillRecord?.kind).toBe('infill');
    } finally { cleanup(root); }
  });

  it('is idempotent — calling twice yields the same record without errors', () => {
    const root = tempRoot();
    try {
      const first = ensureCartesiaInfillProvider({ homeDir: root });
      const second = ensureCartesiaInfillProvider({ homeDir: root });
      expect(second.id).toBe(first.id);
      expect(second.secretRef).toBe(first.secretRef);
      expect(second.model).toBe(first.model);
      // Registry should contain exactly one infill.cartesia record
      const registry = readProviderRegistry({ homeDir: root }).value;
      const infillRecords = registry.providers.filter((p) => p.id === 'infill.cartesia');
      expect(infillRecords).toHaveLength(1);
    } finally { cleanup(root); }
  });

  it('inherits baseUrl from tts.cartesia when that record exists', () => {
    const root = tempRoot();
    try {
      upsertProvider({ homeDir: root, provider: { id: 'tts.cartesia', kind: 'tts', name: 'cartesia', tier: 'paid', secretRef: 'cartesia', baseUrl: 'https://api.cartesia.ai' } });
      const record = ensureCartesiaInfillProvider({ homeDir: root });
      expect(record.baseUrl).toBe('https://api.cartesia.ai');
    } finally { cleanup(root); }
  });

  it('does not set infill.cartesia as a workspace default (infill is internal, not user-selectable)', () => {
    const root = tempRoot();
    try {
      ensureCartesiaInfillProvider({ homeDir: root });
      const registry = readProviderRegistry({ homeDir: root }).value;
      const infillRecord = registry.providers.find((p) => p.id === 'infill.cartesia');
      expect(infillRecord?.default).toBe(false);
    } finally { cleanup(root); }
  });
});
