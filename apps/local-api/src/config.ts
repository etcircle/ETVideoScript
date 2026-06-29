import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';

export type EnvTarget = Record<string, string | undefined>;

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

export function findEnvFile(start = process.cwd()): string | null {
  const candidates = [
    resolve(start, '.env'),
    resolve(start, '../.env'),
    resolve(start, '../../.env')
  ];
  return candidates.find((path) => existsSync(path)) || null;
}

export function loadEnvFile(path: string | null = findEnvFile(), target: EnvTarget = process.env): void {
  if (!path || !existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (target[key] != null) continue;
    target[key] = unquoteEnvValue(trimmed.slice(eq + 1));
  }
}

export interface ApiConfig {
  host: string;
  port: number;
  workspaceRoot: string;
  settingsHome?: string;
  enableTerminal: boolean;
  enableAgent?: boolean;
  allowedOrigins: string[];
  lanOrigins: string[];
  terminalToken: string | null;
  disableLiveOverdub?: boolean;
}

export function isLocalHost(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'].includes(host);
}

export interface LoadConfigOptions {
  envFile?: string | null;
  env?: EnvTarget;
}

function envValue(env: EnvTarget, key: string): string | undefined {
  // ETVideoScript prefers ETVS_* aliases while preserving ETVIDEO_* compatibility.
  return env[`ETVS_${key}`] ?? env[`ETVIDEO_${key}`];
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const origins = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!origins.length) throw new Error('ETVS_LAN_ORIGINS must contain one or more explicit http/https origins.');
  return origins.map((origin) => {
    let parsed: URL;
    try { parsed = new URL(origin); }
    catch { throw new Error(`Invalid ETVS_LAN_ORIGINS origin: ${origin}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error(`Invalid ETVS_LAN_ORIGINS origin: ${origin}. Use explicit http/https origins only, e.g. http://192.168.0.100:4318.`);
    }
    return parsed.origin;
  });
}

function loadOrGenerateToken(env: EnvTarget, workspaceRoot: string): string | null {
  const explicit = envValue(env, 'TERMINAL_TOKEN');
  const tokenPath = join(workspaceRoot, 'logs/api-token.txt');
  if (explicit && envValue(env, 'REGENERATE_TOKEN') !== '1') return explicit;
  if (envValue(env, 'REGENERATE_TOKEN') !== '1' && existsSync(tokenPath)) return readFileSync(tokenPath, 'utf8').trim() || null;
  const token = randomBytes(24).toString('hex');
  mkdirSync(join(workspaceRoot, 'logs'), { recursive: true });
  writeFileSync(tokenPath, `${token}\n`);
  return token;
}

export function loadConfig(options: LoadConfigOptions = {}): ApiConfig {
  const env = options.env || process.env;
  loadEnvFile(options.envFile === undefined ? findEnvFile() : options.envFile, env);
  const enableTerminal = envValue(env, 'ENABLE_TERMINAL') === '1';
  const enableAgentExplicit = envValue(env, 'ENABLE_AGENT') === '1';
  const enableAgent = enableTerminal || enableAgentExplicit;
  const host = envValue(env, 'BIND') || envValue(env, 'API_HOST') || '127.0.0.1';
  if (isIP(host) === 0) throw new Error(`Invalid ETVS_BIND value: ${host}. ETVS_BIND must be a valid IPv4 or IPv6 address.`);
  const workspaceRoot = resolve(envValue(env, 'WORKSPACE_ROOT') || './workspaces');
  const settingsHome = envValue(env, 'HOME');
  const lanOrigins = parseOrigins(envValue(env, 'LAN_ORIGINS'));
  const explicitToken = envValue(env, 'TERMINAL_TOKEN') || null;
  if (!isLocalHost(host) && !explicitToken) throw new Error('LAN mode requires ETVS_TERMINAL_TOKEN to be set.');
  const terminalToken = explicitToken || loadOrGenerateToken(env, workspaceRoot);
  if (enableTerminal && !isLocalHost(host)) throw new Error('Refusing to enable terminal WebSocket unless API is bound to localhost/127.0.0.1');
  return {
    host,
    port: Number(envValue(env, 'API_PORT') || 4317),
    workspaceRoot,
    ...(settingsHome ? { settingsHome } : {}),
    enableTerminal,
    enableAgent,
    terminalToken,
    lanOrigins,
    disableLiveOverdub: envValue(env, 'DISABLE_LIVE_OVERDUB') === '1',
    allowedOrigins: [
      ...(envValue(env, 'ALLOWED_ORIGINS') || 'http://127.0.0.1:4318,http://localhost:4318').split(',').map((s) => s.trim()).filter(Boolean),
      ...lanOrigins
    ]
  };
}
