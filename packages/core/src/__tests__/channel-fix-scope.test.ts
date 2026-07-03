import { mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channelFixFingerprint } from '../channelFixScope';
import { channelFixSidecarFresh, readChannelFixSidecar, writeChannelFixSidecar } from '../channelFixSidecar';

describe('channelFixScope sidecar primitives', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'etv-chanfix-scope-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('readChannelFixSidecar returns undefined (not "none") when the sidecar file is missing (issue #6)', () => {
    expect(readChannelFixSidecar(join(dir, 'derivative.wav'))).toBeUndefined();
  });

  it('channelFixSidecarFresh is false when the sidecar is missing, even though "none" would otherwise match a no-fix state', () => {
    const output = join(dir, 'derivative.wav');
    const source = join(dir, 'source.mp4');
    writeFileSync(source, 'source bytes');
    writeFileSync(output, 'derivative bytes');
    // No sidecar written at all — a missing sidecar must never be treated as an implicit
    // 'none' fingerprint match.
    expect(channelFixSidecarFresh(output, undefined, source)).toBe(false);
  });

  it('is fresh once a sidecar matching the current fingerprint is written, and stale for any other fingerprint', () => {
    const output = join(dir, 'derivative.wav');
    const source = join(dir, 'source.mp4');
    writeFileSync(source, 'source bytes');
    writeFileSync(output, 'derivative bytes');
    writeChannelFixSidecar(output, 'left');
    expect(readChannelFixSidecar(output)).toBe('left');
    expect(channelFixSidecarFresh(output, 'left', source)).toBe(true);
    expect(channelFixSidecarFresh(output, 'right', source)).toBe(false);
    expect(channelFixSidecarFresh(output, undefined, source)).toBe(false);
  });

  it('is stale when the source is newer than the derivative, even with a matching sidecar (issue #2)', () => {
    const output = join(dir, 'derivative.wav');
    const source = join(dir, 'source.mp4');
    writeFileSync(output, 'derivative bytes');
    writeChannelFixSidecar(output, undefined);
    const past = new Date(Date.now() - 10_000);
    utimesSync(output, past, past);
    writeFileSync(source, 'source bytes'); // freshly written: newer mtime than the derivative
    expect(channelFixSidecarFresh(output, undefined, source)).toBe(false);
  });

  it('writeChannelFixSidecar replaces a planted symlink instead of writing through it (issue #8)', () => {
    const output = join(dir, 'derivative.wav');
    writeFileSync(output, 'derivative bytes');
    const outsideTarget = join(dir, 'outside-secret.txt');
    writeFileSync(outsideTarget, 'do-not-touch');
    symlinkSync(outsideTarget, `${output}.channelfix`);

    writeChannelFixSidecar(output, 'left');

    // The symlink's target must be untouched...
    expect(readFileSync(outsideTarget, 'utf8')).toBe('do-not-touch');
    // ...and the sidecar path itself now holds the fingerprint directly (symlink replaced
    // by renameSync, not followed).
    expect(readFileSync(`${output}.channelfix`, 'utf8')).toBe(channelFixFingerprint('left'));
  });

  it('channelFixSidecarFresh treats a symlinked derivative output as stale', () => {
    const real = join(dir, 'real.wav');
    const output = join(dir, 'derivative.wav');
    const source = join(dir, 'source.mp4');
    writeFileSync(real, 'x');
    writeFileSync(source, 'y');
    symlinkSync(real, output);
    writeChannelFixSidecar(output, undefined);
    expect(channelFixSidecarFresh(output, undefined, source)).toBe(false);
  });
});
