import { ManifestV3Schema, type ManifestV3 } from './schema';
import { getOperationKind, type Operation } from '../operations/registry';

export interface ManifestV3ValidationContext {
  assetExists?: (assetId: string) => boolean;
  providerRequestExists?: (id: string) => boolean;
}

export interface ManifestV3ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface OverlapCandidate {
  id: string;
  type: string;
  status: string;
  target:
    | { kind: 'clip-span'; trackId: string; clipId: string; start: number; end: number }
    | { kind: 'clip-boundary'; trackId: string; clipId: string }
    | { kind: 'track'; trackId: string };
}

export function operationPrecedence(type: string): number {
  return getOperationKind(type).precedence;
}

type ClipSpanOverlapCandidate = OverlapCandidate & { target: Extract<OverlapCandidate['target'], { kind: 'clip-span' }> };
type ClipBoundaryOverlapCandidate = OverlapCandidate & { target: Extract<OverlapCandidate['target'], { kind: 'clip-boundary' }> };
type TrackOverlapCandidate = OverlapCandidate & { target: Extract<OverlapCandidate['target'], { kind: 'track' }> };

function overlaps(a: Pick<ClipSpanOverlapCandidate['target'], 'start' | 'end'>, b: Pick<ClipSpanOverlapCandidate['target'], 'start' | 'end'>): boolean {
  return a.start < b.end && a.end > b.start;
}

function conflictMessage(a: OverlapCandidate, b: OverlapCandidate): string | null {
  const aKind = getOperationKind(a.type);
  const bKind = getOperationKind(b.type);
  if (aKind.conflictsWith?.includes(b.type) || bKind.conflictsWith?.includes(a.type)) {
    return `${a.id} and ${b.id}: ${a.type} may not overlap ${b.type}`;
  }
  return null;
}

export function validateOperationOverlaps(operations: Operation[]): string[] {
  const errors: string[] = [];
  const approved = operations.filter((op): op is OverlapCandidate => op.status === 'approved');
  const clipSpan = approved.filter((op): op is ClipSpanOverlapCandidate => op.target.kind === 'clip-span').sort((a, b) =>
    a.target.trackId.localeCompare(b.target.trackId)
    || a.target.clipId.localeCompare(b.target.clipId)
    || a.target.start - b.target.start
    || operationPrecedence(b.type) - operationPrecedence(a.type)
  );

  for (let i = 0; i < clipSpan.length; i++) {
    const current = clipSpan[i]!;
    for (let j = i + 1; j < clipSpan.length; j++) {
      const next = clipSpan[j]!;
      if (current.target.trackId !== next.target.trackId || current.target.clipId !== next.target.clipId) continue;
      if (!overlaps(current.target, next.target)) continue;
      const conflict = conflictMessage(current, next);
      if (conflict) {
        errors.push(conflict);
        continue;
      }
      if (operationPrecedence(current.type) === operationPrecedence(next.type)) {
        errors.push(`${current.id} and ${next.id}: ${current.type}/${next.type} ranges overlap at the same precedence`);
      }
    }
  }

  const clipBoundary = approved.filter((op): op is ClipBoundaryOverlapCandidate => op.target.kind === 'clip-boundary').sort((a, b) =>
    a.target.trackId.localeCompare(b.target.trackId) || a.target.clipId.localeCompare(b.target.clipId) || operationPrecedence(b.type) - operationPrecedence(a.type)
  );
  for (let i = 0; i < clipBoundary.length; i++) {
    const current = clipBoundary[i]!;
    for (let j = i + 1; j < clipBoundary.length; j++) {
      const next = clipBoundary[j]!;
      if (current.target.trackId !== next.target.trackId || current.target.clipId !== next.target.clipId) continue;
      const conflict = conflictMessage(current, next);
      if (conflict) errors.push(conflict);
      else if (operationPrecedence(current.type) === operationPrecedence(next.type)) errors.push(`${current.id} and ${next.id}: ${current.type}/${next.type} target the same boundary at the same precedence`);
    }
  }

  const trackTargets = approved.filter((op): op is TrackOverlapCandidate => op.target.kind === 'track').sort((a, b) =>
    a.target.trackId.localeCompare(b.target.trackId) || operationPrecedence(b.type) - operationPrecedence(a.type)
  );
  for (let i = 0; i < trackTargets.length; i++) {
    const current = trackTargets[i]!;
    for (let j = i + 1; j < trackTargets.length; j++) {
      const next = trackTargets[j]!;
      if (current.target.trackId !== next.target.trackId) continue;
      const conflict = conflictMessage(current, next);
      if (conflict) errors.push(conflict);
      else if (operationPrecedence(current.type) === operationPrecedence(next.type)) errors.push(`${current.id} and ${next.id}: ${current.type}/${next.type} target the same track at the same precedence`);
    }
  }
  return errors;
}

export function validateManifestV3Document(input: unknown, ctx: ManifestV3ValidationContext = {}): ManifestV3ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = ManifestV3Schema.safeParse(input);
  if (!parsed.success) return { valid: false, errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`), warnings };
  const manifest = parsed.data;

  const assetIds = new Set<string>();
  for (const asset of manifest.assets) {
    if (assetIds.has(asset.assetId)) errors.push(`Asset id is duplicated: ${asset.assetId}`);
    assetIds.add(asset.assetId);
  }

  const trackEntries = new Map<string, ManifestV3['tracks'][number]>();
  const clipEntries = new Map<string, { track: ManifestV3['tracks'][number]; clip: ManifestV3['tracks'][number]['clips'][number] }>();
  for (const track of manifest.tracks) {
    trackEntries.set(track.trackId, track);
    for (const clip of track.clips) {
      if (clipEntries.has(clip.clipId)) errors.push(`Clip id is duplicated: ${clip.clipId}`);
      clipEntries.set(clip.clipId, { track, clip });
      if (!assetIds.has(clip.assetId)) errors.push(`${clip.clipId}: unknown assetId ${clip.assetId}`);
      const asset = manifest.assets.find((candidate) => candidate.assetId === clip.assetId);
      if (asset && clip.sourceEnd > asset.durationSec) errors.push(`${clip.clipId}: clip sourceEnd exceeds asset ${clip.assetId} duration ${asset.durationSec}`);
    }
  }

  const opIds = new Set<string>();
  for (const op of manifest.operations) {
    if (opIds.has(op.id)) errors.push(`Operation id is duplicated: ${op.id}`);
    opIds.add(op.id);

    const target = op.target;
    const track = trackEntries.get(target.trackId);
    if (!track) {
      errors.push(`${op.id}: unknown trackId ${target.trackId}`);
      continue;
    }

    let clip: ManifestV3['tracks'][number]['clips'][number] | undefined;
    if (target.kind !== 'track') {
      const entry = clipEntries.get(target.clipId);
      if (!entry) {
        errors.push(`${op.id}: unknown clipId ${target.clipId}`);
        continue;
      }
      if (entry.track.trackId !== target.trackId) errors.push(`${op.id}: trackId ${target.trackId} does not own clipId ${target.clipId}`);
      clip = entry.clip;
    }

    const kind = getOperationKind(String(op.type));
    errors.push(...kind.validateLocal(op as Operation, {
      manifest,
      track,
      clip,
      assetExists: (assetId) => assetIds.has(assetId) && (ctx.assetExists?.(assetId) ?? true),
      providerRequestExists: ctx.providerRequestExists
    }));
    if ('providerRequestId' in op && op.providerRequestId && ctx.providerRequestExists && !ctx.providerRequestExists(op.providerRequestId)) {
      warnings.push(`${op.id}: provider request id not found: ${op.providerRequestId}`);
    }
  }

  const stagingTracks = manifest.tracks.filter((track) => track.role === 'staging');
  if (stagingTracks.length > 1) errors.push(`Manifest may have at most one staging track, found ${stagingTracks.length}`);
  for (const track of stagingTracks) {
    if (track.kind !== 'video') errors.push(`${track.trackId}: staging track must be a video track`);
  }

  const stagingClipIds = new Set(stagingTracks.flatMap((track) => track.clips.map((clip) => clip.clipId)));
  const groupIds = new Set<string>();
  const groupedClipIds = new Set<string>();
  for (const group of manifest.takeGroups) {
    if (groupIds.has(group.groupId)) errors.push(`Take group id is duplicated: ${group.groupId}`);
    groupIds.add(group.groupId);
    for (const clipId of group.clipIds) {
      if (!stagingClipIds.has(clipId)) errors.push(`Take group ${group.groupId}: ${clipId} is not on the staging track`);
      if (groupedClipIds.has(clipId)) errors.push(`${clipId} appears in more than one take group`);
      groupedClipIds.add(clipId);
    }
    if (group.reference?.kind === 'take' && !group.clipIds.includes(group.reference.clipId)) {
      errors.push(`Take group ${group.groupId}: reference clip ${group.reference.clipId} is not in the group`);
    }
  }

  errors.push(...validateOperationOverlaps(manifest.operations));
  return { valid: errors.length === 0, errors, warnings };
}

export const validateManifest = validateManifestV3Document;
