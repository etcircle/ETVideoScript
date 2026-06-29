import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts');

function run(args: string[], env: Record<string, string | undefined> = {}, input?: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, ...env }
  });
}

describe('ets quickstart', () => {
  it('refuses to run interactively when --json is set', () => {
    const root = mkdtempSync(join(tmpdir(), 'ets-quickstart-cli-'));
    try {
      const result = run(['--json', 'quickstart'], { ETVS_HOME: root });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('quickstart is interactive and cannot run with --json');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('adds a local provider, tests it, and sets it as default', () => {
    const root = mkdtempSync(join(tmpdir(), 'ets-quickstart-cli-'));
    try {
      const input = [
        'stt',
        'homelab-whisper',
        'local',
        'http://127.0.0.1:9000',
        '',
        'y'
      ].join('\n') + '\n';
      const result = run(['quickstart'], { ETVS_HOME: root }, input);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Provider added: stt.homelab-whisper');
      expect(result.stdout).toContain('Connection test: ok');
      expect(result.stdout).toContain('Default set: stt.homelab-whisper');
      const registry = JSON.parse(readFileSync(join(root, '.etvs', 'providers.json'), 'utf8'));
      expect(registry.providers[0]).toMatchObject({ id: 'stt.homelab-whisper', kind: 'stt', tier: 'local', default: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('requires explicit confirmation before setting a paid provider as default', () => {
    const root = mkdtempSync(join(tmpdir(), 'ets-quickstart-cli-'));
    try {
      const input = [
        'studio-sound',
        'elevenlabs-isolation',
        'paid',
        'https://api.elevenlabs.io',
        'sk-test-secret',
        'y',
        'n'
      ].join('\n') + '\n';
      const result = run(['quickstart'], { ETVS_HOME: root }, input);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Provider added: studio-sound.elevenlabs-isolation');
      expect(result.stdout).toContain('Paid default not set');
      const registry = JSON.parse(readFileSync(join(root, '.etvs', 'providers.json'), 'utf8'));
      expect(registry.providers[0]).toMatchObject({ id: 'studio-sound.elevenlabs-isolation', tier: 'paid', default: false, secretRef: 'studio-sound.elevenlabs-isolation.api-key' });
      const secrets = JSON.parse(readFileSync(join(root, '.etvs', 'secrets.json'), 'utf8'));
      expect(secrets.secrets['studio-sound.elevenlabs-isolation.api-key']).toBe('sk-test-secret');
      expect(result.stdout).not.toContain('sk-test-secret');
      expect(result.stderr).not.toContain('sk-test-secret');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
