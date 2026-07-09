import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

// Every run() spawns a fresh node + tsx compile of the CLI (~3-4s each), so the
// original single mega-test (6 spawns ≈ 21s) sat right under vitest's default 30s
// budget and timed out under full-suite parallel load. Split into sequential steps
// sharing one ETVS_HOME (vitest runs its within a describe in order), each with an
// explicit timeout that prices in the per-spawn compile cost.
// NOTE: the steps are deliberately ORDER-COUPLED (later its read providers the
// earlier ones registered into the shared ETVS_HOME) — run the whole file; a -t
// filter on a later step alone fails on the missing shared state.
const SPAWN_TEST_TIMEOUT = 60_000;

describe('ets providers CLI', () => {
  let root: string;
  let env: Record<string, string>;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ets-providers-cli-'));
    env = { ETVS_HOME: root };
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it('adds local and paid providers with JSON envelopes', () => {
    const addLocal = run(['providers', 'add', '--id', 'studio-sound.ffmpeg-local', '--kind', 'studio-sound', '--name', 'ffmpeg-local', '--tier', 'local', '--default'], env);
    expect(addLocal.status).toBe(0);
    expect(JSON.parse(addLocal.stdout).ok).toBe(true);

    const addPaid = run(['providers', 'add', '--id', 'studio-sound.elevenlabs-isolation', '--kind', 'studio-sound', '--name', 'elevenlabs-isolation', '--tier', 'paid', '--secret-ref', 'elevenlabs'], env);
    expect(addPaid.status).toBe(0);
  }, SPAWN_TEST_TIMEOUT);

  it('stores secrets via stdin without echoing and refuses paid default without ack', () => {
    const secret = run(['providers', 'set-secret', 'elevenlabs', '--stdin'], env, 'super-secret-api-key\n');
    expect(secret.status).toBe(0);
    expect(secret.stderr).not.toContain('super-secret-api-key');

    const refused = run(['providers', 'set-default', 'studio-sound', 'studio-sound.elevenlabs-isolation'], env);
    expect(refused.status).toBe(12);
    const refusedJson = JSON.parse(refused.stdout);
    expect(refusedJson.ok).toBe(false);
    expect(refusedJson.error).toMatchObject({ code: 'paid_default_requires_ack' });
  }, SPAWN_TEST_TIMEOUT);

  it('accepts paid default with --yes and lists providers', () => {
    const accepted = run(['providers', 'set-default', 'studio-sound', 'studio-sound.elevenlabs-isolation', '--yes'], env);
    expect(accepted.status).toBe(0);
    expect(JSON.parse(accepted.stdout).defaultProvider).toBe('studio-sound.elevenlabs-isolation');

    const list = run(['providers', 'list'], env);
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout).providers.map((provider: any) => provider.id)).toEqual(['studio-sound.elevenlabs-isolation', 'studio-sound.ffmpeg-local']);
  }, SPAWN_TEST_TIMEOUT);
});
