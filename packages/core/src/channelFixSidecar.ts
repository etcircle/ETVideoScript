import { existsSync, lstatSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { channelFixFingerprint } from './channelFixScope';

// Filesystem-touching sidecar helpers, split out from channelFixScope.ts so that pure
// planning logic (render/plan.ts, re-exported by browser.ts) never transitively pulls
// node:fs into a client bundle. Node-only callers (media.ts, tracks/operations.ts,
// apps/local-api) import from here.

const sidecarPath = (outputPath: string) => `${outputPath}.channelfix`;

/**
 * Reads the fingerprint sidecar next to an extraction derivative. Returns
 * undefined when the sidecar is missing — a MISSING sidecar is a distinct,
 * always-stale state, never treated as an implicit 'none' (issue #6/#10).
 * Collapsing "missing" into 'none' let a derivative whose sidecar write was
 * interrupted (process killed between ffmpeg and the sidecar write, or a
 * pre-feature derivative with no sidecar at all) get silently reused as if
 * it had never been fixed. A missing sidecar now always forces exactly one
 * regeneration — cheap, local, non-paid — after which the sidecar exists
 * and future calls are cache hits again.
 */
export function readChannelFixSidecar(outputPath: string): string | undefined {
  try { return readFileSync(sidecarPath(outputPath), 'utf8').trim(); } catch { return undefined; }
}

/**
 * Writes the fingerprint sidecar via stage-then-rename (same directory, same
 * filesystem): the sidecar path can be a planted symlink, and renameSync
 * REPLACES whatever sits at the target rather than following it — closes
 * the symlink write-through (issue #8), matching extractFullBandReference's
 * existing stage-then-rename precedent for the derivative itself.
 */
export function writeChannelFixSidecar(outputPath: string, sourceChannel: 'left' | 'right' | undefined): void {
  const target = sidecarPath(outputPath);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, channelFixFingerprint(sourceChannel));
  renameSync(tmp, target);
}

/**
 * True iff a fresh (existing, non-stale) derivative sits at outputPath for
 * the given fix state. Freshness has three dimensions:
 *   - the derivative is a REAL file, not a symlink (a symlink could redirect
 *     a later overwrite onto something outside the derivative area);
 *   - its mtime is at least as new as sourcePath's (issue #2) — otherwise a
 *     source replace (importSource bumps target's mtime via renameSync)
 *     would keep serving audio extracted from the OLD recording forever,
 *     even when the fix state itself (e.g. 'none') happens not to change;
 *   - its sidecar fingerprint matches the CURRENT fix state (issue #1/#6).
 */
export function channelFixSidecarFresh(outputPath: string, sourceChannel: 'left' | 'right' | undefined, sourcePath: string): boolean {
  if (!existsSync(outputPath) || lstatSync(outputPath).isSymbolicLink()) return false;
  if (statSync(outputPath).mtimeMs < statSync(sourcePath).mtimeMs) return false;
  const sidecar = readChannelFixSidecar(outputPath);
  return sidecar !== undefined && sidecar === channelFixFingerprint(sourceChannel);
}
