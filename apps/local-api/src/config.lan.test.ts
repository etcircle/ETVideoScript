import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'etvideo-lan-config-'));
}

describe('LAN config validation', () => {
  it('rejects LAN binding without an explicit terminal token', () => {
    const root = tempRoot();
    try {
      expect(() => loadConfig({ envFile: null, env: { ETVS_BIND: '0.0.0.0', ETVS_WORKSPACE_ROOT: root } })).toThrow(/LAN mode requires ETVS_TERMINAL_TOKEN to be set/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects non-IP bind values', () => {
    const root = tempRoot();
    try {
      expect(() => loadConfig({ envFile: null, env: { ETVS_BIND: 'invalid-ip', ETVS_WORKSPACE_ROOT: root, ETVS_TERMINAL_TOKEN: 'token' } })).toThrow(/ETVS_BIND.*valid IPv4 or IPv6/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed LAN origins', () => {
    const root = tempRoot();
    try {
      expect(() => loadConfig({ envFile: null, env: { ETVS_LAN_ORIGINS: 'not-a-url', ETVS_WORKSPACE_ROOT: root } })).toThrow(/ETVS_LAN_ORIGINS/);
      expect(() => loadConfig({ envFile: null, env: { ETVS_LAN_ORIGINS: 'ftp://192.168.0.10:4318', ETVS_WORKSPACE_ROOT: root } })).toThrow(/http\/https/);
      expect(() => loadConfig({ envFile: null, env: { ETVS_LAN_ORIGINS: 'http://192.168.0.10:4318/path', ETVS_WORKSPACE_ROOT: root } })).toThrow(/explicit http\/https origins/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts valid bind and explicit LAN origin combinations', () => {
    const root = tempRoot();
    try {
      const cfg = loadConfig({
        envFile: null,
        env: {
          ETVS_BIND: '0.0.0.0',
          ETVS_LAN_ORIGINS: 'http://192.168.0.100:4318,https://192.168.0.101:4318',
          ETVS_TERMINAL_TOKEN: 'token',
          ETVS_WORKSPACE_ROOT: root
        }
      });
      expect(cfg.host).toBe('0.0.0.0');
      expect(cfg.lanOrigins).toEqual(['http://192.168.0.100:4318', 'https://192.168.0.101:4318']);
      expect(cfg.allowedOrigins).toEqual(expect.arrayContaining(cfg.lanOrigins));
      expect(cfg.terminalToken).toBe('token');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps generated tokens stable unless ETVS_REGENERATE_TOKEN=1 is set', () => {
    const root = tempRoot();
    try {
      const first = loadConfig({ envFile: null, env: { ETVS_WORKSPACE_ROOT: root } });
      const second = loadConfig({ envFile: null, env: { ETVS_WORKSPACE_ROOT: root } });
      expect(second.terminalToken).toBe(first.terminalToken);
      expect(readFileSync(join(root, 'logs/api-token.txt'), 'utf8').trim()).toBe(first.terminalToken);

      const rotated = loadConfig({ envFile: null, env: { ETVS_WORKSPACE_ROOT: root, ETVS_REGENERATE_TOKEN: '1' } });
      expect(rotated.terminalToken).not.toBe(first.terminalToken);
      expect(readFileSync(join(root, 'logs/api-token.txt'), 'utf8').trim()).toBe(rotated.terminalToken);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
