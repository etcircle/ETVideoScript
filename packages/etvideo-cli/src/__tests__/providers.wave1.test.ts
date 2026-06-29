import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts');

function run(args: string[], env: Record<string, string | undefined> = {}, input?: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, '--json', ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, ...env }
  });
}

describe('ets providers CLI', () => {
  it('round-trips providers with JSON envelopes and refuses paid default without ack', () => {
    const root = mkdtempSync(join(tmpdir(), 'ets-providers-cli-'));
    try {
      const env = { ETVS_HOME: root };
      const addLocal = run(['providers', 'add', '--id', 'studio-sound.ffmpeg-local', '--kind', 'studio-sound', '--name', 'ffmpeg-local', '--tier', 'local', '--default'], env);
      expect(addLocal.status).toBe(0);
      expect(JSON.parse(addLocal.stdout).ok).toBe(true);

      const addPaid = run(['providers', 'add', '--id', 'studio-sound.elevenlabs-isolation', '--kind', 'studio-sound', '--name', 'elevenlabs-isolation', '--tier', 'paid', '--secret-ref', 'elevenlabs'], env);
      expect(addPaid.status).toBe(0);

      const secret = run(['providers', 'set-secret', 'elevenlabs', '--stdin'], env, 'super-secret-api-key\n');
      expect(secret.status).toBe(0);
      expect(secret.stderr).not.toContain('super-secret-api-key');

      const refused = run(['providers', 'set-default', 'studio-sound', 'studio-sound.elevenlabs-isolation'], env);
      expect(refused.status).toBe(12);
      const refusedJson = JSON.parse(refused.stdout);
      expect(refusedJson.ok).toBe(false);
      expect(refusedJson.error).toMatchObject({ code: 'paid_default_requires_ack' });

      const accepted = run(['providers', 'set-default', 'studio-sound', 'studio-sound.elevenlabs-isolation', '--yes'], env);
      expect(accepted.status).toBe(0);
      expect(JSON.parse(accepted.stdout).defaultProvider).toBe('studio-sound.elevenlabs-isolation');

      const list = run(['providers', 'list'], env);
      expect(list.status).toBe(0);
      expect(JSON.parse(list.stdout).providers.map((provider: any) => provider.id)).toEqual(['studio-sound.elevenlabs-isolation', 'studio-sound.ffmpeg-local']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
