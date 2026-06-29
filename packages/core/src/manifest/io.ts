import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { assertInside, atomicWriteJson, nowIso, readJson, writeManifestRevisionSync } from '../filesystem';
import { ManifestV3Schema, type ManifestV3 } from './schema';
import { validateManifestV3Document } from './validate';

export interface SaveManifestV3Options {
  revision?: boolean;
}

function lockManifestSync(manifestPath: string): () => void {
  let lastError: unknown;
  const retries = 5;
  const baseDelayMs = 100;
  const maxDelayMs = 1000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return lockfile.lockSync(manifestPath);
    } catch (err) {
      lastError = err;
      if (attempt < retries) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function loadManifestV3(workspacePath: string): ManifestV3 {
  const workspace = resolve(workspacePath);
  const manifestPath = assertInside(workspace, 'edits/manifest.json');
  let release: (() => void) | undefined;
  try {
    release = lockManifestSync(manifestPath);
    return ManifestV3Schema.parse(readJson<unknown>(manifestPath));
  } finally {
    if (release) {
      try { release(); } catch {}
    }
  }
}

export function saveManifestV3(workspacePath: string, manifest: ManifestV3, options: SaveManifestV3Options = {}): void {
  const workspace = resolve(workspacePath);
  const manifestPath = assertInside(workspace, 'edits/manifest.json');
  mkdirSync(assertInside(workspace, 'edits'), { recursive: true });
  const next = ManifestV3Schema.parse({ ...manifest, updatedAt: nowIso() });
  const result = validateManifestV3Document(next);
  if (!result.valid) throw new Error(`Manifest v3 save rejected:\n${result.errors.join('\n')}`);

  let release: (() => void) | undefined;
  try {
    release = existsSync(manifestPath) ? lockManifestSync(manifestPath) : undefined;
    if (options.revision !== false && existsSync(manifestPath)) writeManifestRevisionSync(workspace);
    atomicWriteJson(join(workspace, 'edits/manifest.json'), next);
  } finally {
    if (release) {
      try { release(); } catch {}
    }
  }
}
