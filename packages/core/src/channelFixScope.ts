import type { ManifestV3 } from './manifest/schema';

// Pure, dependency-free (no node:fs): this module is transitively re-exported by
// browser.ts through render/plan.ts (buildRenderPlanV3), so it must stay safe to bundle
// for the client. Filesystem-touching sidecar helpers live in ./channelFixSidecar
// instead — never import node:fs here.

/**
 * True iff `manifest.audioChannelFix` is approved AND describes the asset at
 * `assetPath`. applyChannelFix always analyzes exactly input/source.mp4
 * (channelBalance.ts), so the fix only ever describes that literal file —
 * never an unrelated import, b-roll, or a detached-audio derivative of
 * another source, regardless of how many other video assets exist in the
 * project. Extraction/detach call sites that operate on an arbitrary clip's
 * asset must go through this instead of trusting the fix unconditionally.
 */
// Structural subsets of ManifestV3 — the predicates below only READ these fields, and the
// multi-window clone path (voiceClone.ts) verifies cleanup freshness from a caller-supplied
// subset rather than a full manifest. A full ManifestV3 stays assignable everywhere.
export type ChannelFixState = Pick<ManifestV3, 'audioChannelFix'>;
export type StudioCleanupState = Pick<ManifestV3, 'studioCleanup' | 'audioChannelFix'>;

export function resolveChannelFixForAsset(manifest: ChannelFixState, assetPath: string): 'left' | 'right' | undefined {
  if (manifest.audioChannelFix?.status !== 'approved') return undefined;
  return assetPath === 'input/source.mp4' ? manifest.audioChannelFix.sourceChannel : undefined;
}

/** Fingerprint of the channel decision actually baked into an extraction derivative's bytes. */
export function channelFixFingerprint(sourceChannel: 'left' | 'right' | undefined): string {
  return sourceChannel ?? 'none';
}

/** Fingerprint of the base recording's channel-fix state as it stands in `manifest` right now. */
export function sourceChannelFixFingerprint(manifest: ChannelFixState): string {
  return channelFixFingerprint(resolveChannelFixForAsset(manifest, 'input/source.mp4'));
}

/**
 * Cleanup-freshness rule, factored out of buildRenderPlan so the multi-window clone
 * selector (voiceClone.ts) mirrors render's staleness semantics EXACTLY instead of
 * re-deriving them (drift here would let a clone train from a stale cleaned bed while
 * render falls back to raw — the dry-on-dry invariant the plan pins). This is the PURE
 * half only: approved + fingerprint-current. The "artifact bytes exist on disk" check
 * stays at the Node call sites (render pipeline / cloneCleanClip) because this module is
 * browser-reachable and must not touch node:fs.
 *
 * A cleanup with a MISSING audioChannelFixFingerprint counts as stale only when an
 * audioChannelFix record actually exists to compare against — a cleanup with no
 * channel-fix history at all (the common case, and every pre-fingerprint manifest) is
 * never stale on this axis. Byte-identical to render/plan.ts:236-239.
 */
export function isStudioCleanupFresh(manifest: StudioCleanupState): boolean {
  const cleanup = manifest.studioCleanup;
  if (!cleanup || cleanup.status !== 'approved') return false;
  // Stale iff a channel-fix record exists AND the cleanup's recorded fingerprint no
  // longer matches the current one. No channel-fix history ⇒ never stale.
  const stale = !!manifest.audioChannelFix
    && cleanup.audioChannelFixFingerprint !== sourceChannelFixFingerprint(manifest);
  return !stale;
}

/** ffmpeg pan filter selecting only the live channel into a mono output. */
export function channelFixMonoPan(sourceChannel: 'left' | 'right'): string {
  return `pan=mono|c0=${sourceChannel === 'left' ? 'c0' : 'c1'}`;
}

/** ffmpeg pan filter duplicating the live channel to both stereo output channels. */
export function channelFixStereoPan(sourceChannel: 'left' | 'right'): string {
  const live = sourceChannel === 'left' ? 'c0' : 'c1';
  return `pan=stereo|c0=${live}|c1=${live}`;
}
