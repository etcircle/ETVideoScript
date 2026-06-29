import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadEnvFile } from './config';

describe('local API config env loading', () => {
  it('loads root .env-style values without overriding explicit environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'etvideo-env-'));
    try {
      const envFile = join(root, '.env');
      writeFileSync(envFile, [
        '# local e2e secrets',
        'XAI_API_KEY=xai-placeholder',
        'ETVIDEO_WORKSPACE_ROOT="/tmp/etvideo workspaces"',
        'ETVIDEO_API_PORT=9999',
        'ETVIDEO_API_HOST=0.0.0.0',
        ''
      ].join('\n'));
      const target: Record<string, string | undefined> = { ETVIDEO_API_HOST: '127.0.0.1' };

      loadEnvFile(envFile, target);

      expect(target.XAI_API_KEY).toBe('xai-placeholder');
      expect(target.ETVIDEO_WORKSPACE_ROOT).toBe('/tmp/etvideo workspaces');
      expect(target.ETVIDEO_API_PORT).toBe('9999');
      expect(target.ETVIDEO_API_HOST).toBe('127.0.0.1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers ETVS aliases while falling back to ETVIDEO variables', () => {
    const aliased = loadConfig({
      envFile: null,
      env: {
        ETVIDEO_API_HOST: '0.0.0.0',
        ETVS_API_HOST: '127.0.0.1',
        ETVIDEO_API_PORT: '4317',
        ETVS_API_PORT: '5317',
        ETVIDEO_WORKSPACE_ROOT: '/tmp/legacy',
        ETVS_WORKSPACE_ROOT: '/tmp/etvs',
        ETVIDEO_ALLOWED_ORIGINS: 'http://legacy.local',
        ETVS_ALLOWED_ORIGINS: 'http://etvs.local',
        ETVIDEO_HOME: '/tmp/legacy-home',
        ETVS_HOME: '/tmp/etvs-home',
        ETVIDEO_ENABLE_TERMINAL: '0',
        ETVS_ENABLE_TERMINAL: '1',
        ETVS_TERMINAL_TOKEN: 'token'
      }
    });

    expect(aliased.host).toBe('127.0.0.1');
    expect(aliased.port).toBe(5317);
    expect(aliased.workspaceRoot).toBe('/tmp/etvs');
    expect(aliased.settingsHome).toBe('/tmp/etvs-home');
    expect(aliased.allowedOrigins).toEqual(['http://etvs.local']);
    expect(aliased.enableTerminal).toBe(true);
    expect(aliased.terminalToken).toBe('token');

    const legacy = loadConfig({
      envFile: null,
      env: {
        ETVIDEO_API_HOST: '127.0.0.1',
        ETVIDEO_API_PORT: '4317',
        ETVIDEO_WORKSPACE_ROOT: '/tmp/legacy',
        ETVIDEO_HOME: '/tmp/legacy-home',
        ETVIDEO_ENABLE_TERMINAL: '0'
      }
    });

    expect(legacy.host).toBe('127.0.0.1');
    expect(legacy.port).toBe(4317);
    expect(legacy.workspaceRoot).toBe('/tmp/legacy');
    expect(legacy.settingsHome).toBe('/tmp/legacy-home');
    expect(legacy.enableTerminal).toBe(false);
  });
});
