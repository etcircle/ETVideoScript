import type { ManifestV3 } from '../manifest/schema';
import { validateManifestV3Document } from '../manifest/validate';
import { isKnownBrandPackId } from './catalog';

function validateNext(manifest: ManifestV3): ManifestV3 {
  const result = validateManifestV3Document(manifest);
  if (!result.valid) throw new Error(`Manifest brand-pack edit rejected:\n${result.errors.join('\n')}`);
  return manifest;
}

function touch(manifest: ManifestV3): ManifestV3 {
  return { ...manifest, updatedAt: new Date().toISOString() };
}

export function setBrandPackId(
  manifest: ManifestV3,
  brandPackId: string | null
): { manifest: ManifestV3 } {
  if (brandPackId !== null) {
    if (!isKnownBrandPackId(brandPackId)) throw new Error(`Unknown brand pack: ${brandPackId}`);
    return { manifest: validateNext(touch({ ...manifest, brandPackId })) };
  }

  const { brandPackId: _brandPackId, ...rest } = manifest;
  return { manifest: validateNext(touch(rest)) };
}
