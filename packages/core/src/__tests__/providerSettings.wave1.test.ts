import { describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  atomicWriteJson,
  importLegacyEnvProviders,
  materializeAudioEnhance,
  readProviderRegistry,
  readProviderRequests,
  readSecrets,
  redactSecrets,
  resolveProviderForKind,
  setDefaultProvider,
  setProviderSecret,
  upsertProvider,
  writeProviderRegistry,
  type ProviderRegistryFile
} from '../index';

function tempRoot() { return mkdtempSync(join(tmpdir(), 'etvs-settings-')); }
function cleanup(root: string) { rmSync(root, { recursive: true, force: true }); }

describe('Wave 1 provider settings registry', () => {
  it('round-trips provider registry JSON and upgrades v0 with a backup', () => {
    const root = tempRoot();
    try {
      const etvsDir = join(root, '.etvs');
      mkdirSync(etvsDir, { recursive: true });
      const path = join(etvsDir, 'providers.json');
      writeFileSync(path, JSON.stringify({ providers: [{ id: 'stt.homelab-whisper', kind: 'stt', name: 'homelab-whisper', tier: 'local', baseUrl: 'http://127.0.0.1:8788/inference' }] }));
      const snapshot = readProviderRegistry({ homeDir: root });
      expect(snapshot.value.schemaVersion).toBe(1);
      expect(snapshot.value.providers[0]?.schemaVersion).toBe(1);
      expect(existsSync(`${path}.v0.bak`)).toBe(true);
      const added = upsertProvider({ homeDir: root, provider: { id: 'studio-sound.ffmpeg-local', kind: 'studio-sound', name: 'ffmpeg-local', tier: 'local', default: true } });
      expect(added.id).toBe('studio-sound.ffmpeg-local');
      expect(readProviderRegistry({ homeDir: root }).value.providers.map((provider) => provider.id)).toEqual(['stt.homelab-whisper', 'studio-sound.ffmpeg-local']);
    } finally { cleanup(root); }
  });

  it('fails closed for newer provider registry schemaVersion', () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, '.etvs'), { recursive: true });
      writeFileSync(join(root, '.etvs/providers.json'), JSON.stringify({ schemaVersion: 999, providers: [], updatedAt: '2026-05-15T00:00:00.000Z' }));
      expect(() => readProviderRegistry({ homeDir: root })).toThrow(/Unsupported provider registry schemaVersion 999/);
    } finally { cleanup(root); }
  });

  it('uses atomic JSON writes without corrupting the original or leaving tmp litter on write failure', () => {
    const root = tempRoot();
    try {
      const path = join(root, 'settings.json');
      atomicWriteJson(path, { ok: true });
      chmodSync(path, 0o400);
      expect(() => atomicWriteJson(path, { ok: false })).not.toThrow();
      expect(JSON.parse(readFileSync(path, 'utf8')).ok).toBe(false);
      expect(readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([]);
    } finally { cleanup(root); }
  });

  it('honors secure mode on atomic JSON temp-file creation', () => {
    const root = tempRoot();
    const previousUmask = process.umask(0);
    try {
      const path = join(root, 'secure.json');
      atomicWriteJson(path, { ok: true }, 0o600);
      expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    } finally {
      process.umask(previousUmask);
      cleanup(root);
    }
  });

  it('rejects stale concurrent writes with settings_stale', () => {
    const root = tempRoot();
    try {
      const first = readProviderRegistry({ homeDir: root });
      writeProviderRegistry({ ...first.value, providers: [], updatedAt: '2026-05-15T00:00:00.000Z' }, first, { homeDir: root });
      expect(() => writeProviderRegistry({ ...first.value, providers: [], updatedAt: '2026-05-15T00:00:01.000Z' }, first, { homeDir: root })).toThrow(/settings changed/i);
    } finally { cleanup(root); }
  });

  it('reports malformed providers.json without silently resetting it', () => {
    const root = tempRoot();
    try {
      const path = join(root, '.etvs/providers.json');
      mkdirSync(join(root, '.etvs'), { recursive: true });
      writeFileSync(path, '{broken');
      expect(() => readProviderRegistry({ homeDir: root })).toThrow(/Malformed settings JSON/);
      expect(readFileSync(path, 'utf8')).toBe('{broken');
    } finally { cleanup(root); }
  });

  it('stores secrets in chmod 0600 secrets.json and redacts sensitive values recursively', () => {
    const root = tempRoot();
    try {
      setProviderSecret({ homeDir: root, secretRef: 'elevenlabs-api-key', value: '***' });
      const path = join(root, '.etvs/secrets.json');
      expect(readSecrets({ homeDir: root }).secrets['elevenlabs-api-key']).toBe('***');
      expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
      expect(JSON.stringify(redactSecrets({ headers: { authorization: 'Bearer secret-token' }, apiKey: 'secret-key', url: 'https://x.test/?api_key=secret-query' }))).not.toContain('secret');
    } finally { cleanup(root); }
  });

  it('imports legacy env idempotently and providers.json wins after import', () => {
    const root = tempRoot();
    try {
      const env = { WHISPER_BASE_URL: 'http://127.0.0.1:8788/inference' };
      expect(importLegacyEnvProviders({ homeDir: root, env }).map((provider) => provider.id)).toEqual(['stt.homelab-whisper']);
      expect(importLegacyEnvProviders({ homeDir: root, env }).map((provider) => provider.id)).toEqual(['stt.homelab-whisper']);
      upsertProvider({ homeDir: root, provider: { id: 'stt.custom-local', kind: 'stt', name: 'custom-local', tier: 'local', default: true, baseUrl: 'http://127.0.0.1:9999/inference' } });
      expect(resolveProviderForKind({ homeDir: root, kind: 'stt', env })?.id).toBe('stt.custom-local');
      expect(readProviderRegistry({ homeDir: root }).value.providers.filter((provider) => provider.id === 'stt.homelab-whisper')).toHaveLength(1);
    } finally { cleanup(root); }
  });

  it('writes paid audio_enhance started and succeeded rows and skips partial trailing JSONL', async () => {
    const root = tempRoot();
    try {
      const input = join(root, 'in.wav');
      const output = join(root, 'out.wav');
      writeFileSync(input, 'audio');
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await materializeAudioEnhance({ inputPath: input, outputPath: output, workspacePath: root, projectId: 'episode-001', op: { type: 'audio_enhance', provider: 'elevenlabs-isolation', profile: 'clean_voice', filterChainVersion: 0 }, clipSourceSha256: 'sha', durationSec: 30, env: { ETVS_PAID_PROVIDER_TEST_MODE: '1' } });
      } finally { stderr.mockRestore(); }
      writeFileSync(join(root, 'logs/provider-requests.jsonl'), `${readFileSync(join(root, 'logs/provider-requests.jsonl'), 'utf8')}{partial`, { flag: 'w' });
      const events = readProviderRequests(root).filter((event) => 'type' in event && event.type === 'audio_enhance');
      expect(events.map((event) => event.status)).toEqual(['started', 'succeeded']);
      expect(events[0]).toMatchObject({ cost: { currency: 'USD', estimated: 0.05 } });
    } finally { cleanup(root); }
  });

  it('refuses paid default without acknowledgement', () => {
    const root = tempRoot();
    try {
      upsertProvider({ homeDir: root, provider: { id: 'studio-sound.elevenlabs-isolation', kind: 'studio-sound', name: 'elevenlabs-isolation', tier: 'paid', enabled: true } });
      expect(() => setDefaultProvider({ homeDir: root, kind: 'studio-sound', id: 'studio-sound.elevenlabs-isolation' })).toThrow(/requires --yes/);
      expect(setDefaultProvider({ homeDir: root, kind: 'studio-sound', id: 'studio-sound.elevenlabs-isolation', acknowledgePaid: true }).default).toBe(true);
    } finally { cleanup(root); }
  });
});
