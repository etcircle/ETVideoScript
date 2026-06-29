import type { ManifestV3 } from '../manifest/schema';
import { validateManifestV3Document } from '../manifest/validate';
import type { Asset } from './schema';

function validateNext(manifest: ManifestV3): ManifestV3 {
  const result = validateManifestV3Document(manifest);
  if (!result.valid) throw new Error(`Manifest asset edit rejected:\n${result.errors.join('\n')}`);
  return manifest;
}

function touch(manifest: ManifestV3): ManifestV3 {
  return { ...manifest, updatedAt: new Date().toISOString() };
}

export function addAsset(manifest: ManifestV3, asset: Asset): { manifest: ManifestV3; asset: Asset } {
  if (manifest.assets.some((candidate) => candidate.assetId === asset.assetId)) throw new Error(`Asset already exists: ${asset.assetId}`);
  return { manifest: validateNext(touch({ ...manifest, assets: [...manifest.assets, asset] })), asset };
}

export function removeAsset(manifest: ManifestV3, input: { assetId: string }): { manifest: ManifestV3; asset: Asset } {
  const asset = manifest.assets.find((candidate) => candidate.assetId === input.assetId);
  if (!asset) throw new Error(`Asset not found: ${input.assetId}`);
  const referencingClip = manifest.tracks.flatMap((track) => track.clips).find((clip) => clip.assetId === input.assetId);
  if (referencingClip) throw new Error(`Cannot remove asset ${input.assetId}; referenced by clip ${referencingClip.clipId}`);
  return { manifest: validateNext(touch({ ...manifest, assets: manifest.assets.filter((candidate) => candidate.assetId !== input.assetId) })), asset };
}

export function updateAsset(manifest: ManifestV3, input: { assetId: string; patch: Partial<Omit<Asset, 'assetId'>> }): { manifest: ManifestV3; asset: Asset } {
  let updated: Asset | undefined;
  const assets = manifest.assets.map((asset) => {
    if (asset.assetId !== input.assetId) return asset;
    updated = { ...asset, ...input.patch, assetId: asset.assetId };
    return updated;
  });
  if (!updated) throw new Error(`Asset not found: ${input.assetId}`);
  return { manifest: validateNext(touch({ ...manifest, assets })), asset: updated };
}
