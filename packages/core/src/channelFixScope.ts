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
export function resolveChannelFixForAsset(manifest: ManifestV3, assetPath: string): 'left' | 'right' | undefined {
  if (manifest.audioChannelFix?.status !== 'approved') return undefined;
  return assetPath === 'input/source.mp4' ? manifest.audioChannelFix.sourceChannel : undefined;
}

/** Fingerprint of the channel decision actually baked into an extraction derivative's bytes. */
export function channelFixFingerprint(sourceChannel: 'left' | 'right' | undefined): string {
  return sourceChannel ?? 'none';
}
