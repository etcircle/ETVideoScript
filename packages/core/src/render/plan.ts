import type { ManifestV3 } from '../manifest/schema';
import { resolveChannelFixForAsset, sourceChannelFixFingerprint } from '../channelFixScope';
import { getOperationKind } from '../operations/registry';
import type { RenderStage } from './types';
import type { Clip, Track } from '../tracks/schema';
import type { Asset } from '../assets/schema';
import type { TimeMapSegment } from '../timeMap/types';
import { composeTimeMap } from '../timeMap/compose';
import { projectCaptions, type V3CaptionCue } from '../captions/project';
import type { TranscriptWords } from '../schemas';

export interface RenderProfile {
  resolution: string;
  videoBitrate: string;
  audioBitrate: string;
  aspect: string;
}

export interface VideoBaseSegment extends TimeMapSegment {
  asset: Asset;
  clip: Clip;
  track: Track;
}

export interface AudioMixSegment extends TimeMapSegment {
  asset: Asset;
  clip: Clip;
  track: Track;
  source: 'embedded-video-audio' | 'audio-track';
}

export interface TrackComposition {
  videoBase: VideoBaseSegment[];
  audioMix: AudioMixSegment[];
}

export interface V3RenderPlan {
  schemaVersion: 3;
  planVersion: 1;
  timeMap: ReturnType<typeof composeTimeMap>;
  stages: RenderStage[];
  composition: TrackComposition;
  targetProfile: RenderProfile;
  outputDurationSec: number;
  captionCues?: V3CaptionCue[];
  /**
   * When set, the render pipeline replaces ALL embedded-video-audio segments
   * with audio read from this file (the project-level studio-cleaned WAV).
   * The source timings (sourceStart/sourceEnd) are preserved — only the audio
   * INPUT file is swapped from the base video file to this path.
   *
   * Populated by buildRenderPlan when manifest.studioCleanup.status === 'approved'.
   * Absent when no cleanup is active or it is disabled.
   */
  studioCleanupAudioPath?: string;
  /**
   * True when an approved studioCleanup was suppressed because it predates the
   * current audioChannelFix decision (see the studioCleanupStale computation
   * below). Callers (CLI/API) should surface this as a warning: the render
   * falls back to the base video audio (re-panned by audioSourceChannel)
   * instead of a cleaned asset that was produced from the OLD channel mix.
   */
  studioCleanupStale?: boolean;
  /**
   * When set, the pipeline duplicates this channel of embedded video audio to
   * both stereo channels (single-channel-mic fix, pan=stereo|c0=cN|c1=cN).
   * Populated by buildRenderPlan when manifest.audioChannelFix.status ===
   * 'approved', the project has a single video source (same scope guard as
   * studioCleanup), and the base asset is known to be exactly 2-channel.
   */
  audioSourceChannel?: 'left' | 'right';
}

/** User-facing warning when a render falls back off a stale studioCleanup (see studioCleanupStale above). */
export const STUDIO_CLEANUP_STALE_WARNING = 'Studio cleanup predates the current channel-fix decision; this render uses raw (re-panned) audio instead of the cleaned asset. Re-run studio cleanup (paid) to restore noise removal for the corrected channel.';

function assetById(manifest: ManifestV3): Map<string, Asset> {
  return new Map(manifest.assets.map((asset) => [asset.assetId, asset]));
}

function clipLookup(tracks: Track[]): Map<string, { clip: Clip; track: Track }> {
  const lookup = new Map<string, { clip: Clip; track: Track }>();
  for (const track of tracks) for (const clip of track.clips) lookup.set(clip.clipId, { clip, track });
  return lookup;
}

function topVisibleVideoSegments(manifest: ManifestV3, timeMap: V3RenderPlan['timeMap']): VideoBaseSegment[] {
  const assets = assetById(manifest);
  const clips = clipLookup(manifest.tracks);
  const visibleVideoTracks = new Set(manifest.tracks.filter((track) => track.kind === 'video' && !track.hidden).map((track) => track.trackId));
  const outputBreaks = Array.from(new Set(timeMap.segments.flatMap((segment) => [segment.outputStart, segment.outputEnd]))).sort((a, b) => a - b);
  const result: VideoBaseSegment[] = [];
  for (let i = 0; i < outputBreaks.length - 1; i++) {
    const start = outputBreaks[i]!;
    const end = outputBreaks[i + 1]!;
    if (end <= start) continue;
    const covering = timeMap.segments
      .filter((segment) => visibleVideoTracks.has(segment.trackId) && segment.outputStart <= start && segment.outputEnd >= end)
      .map((segment) => ({ segment, ref: clips.get(segment.clipId) }))
      .filter((entry): entry is { segment: TimeMapSegment; ref: { clip: Clip; track: Track } } => !!entry.ref)
      .sort((a, b) => a.ref.track.order - b.ref.track.order);
    const top = covering.at(-1);
    if (!top) continue;
    const asset = assets.get(top.ref.clip.assetId);
    if (!asset) throw new Error(`Missing asset ${top.ref.clip.assetId} for clip ${top.ref.clip.clipId}`);
    const sourceStart = top.segment.sourceStart + ((start - top.segment.outputStart) * top.segment.rate);
    const sourceEnd = top.segment.sourceStart + ((end - top.segment.outputStart) * top.segment.rate);
    result.push({ ...top.segment, outputStart: start, outputEnd: end, sourceStart, sourceEnd, asset, clip: top.ref.clip, track: top.ref.track });
  }
  return result;
}

function audioMixSegments(manifest: ManifestV3, timeMap: V3RenderPlan['timeMap']): AudioMixSegment[] {
  const assets = assetById(manifest);
  const clips = clipLookup(manifest.tracks);
  const soloExists = manifest.tracks.some((track) => track.solo && !track.hidden);
  const audibleTracks = new Set(manifest.tracks
    .filter((track) => !track.hidden && !track.muted && (!soloExists || track.solo))
    .map((track) => track.trackId));
  const result: AudioMixSegment[] = [];
  for (const segment of timeMap.segments) {
    const ref = clips.get(segment.clipId);
    if (!ref || !audibleTracks.has(ref.track.trackId)) continue;
    const asset = assets.get(ref.clip.assetId);
    if (!asset) throw new Error(`Missing asset ${ref.clip.assetId} for clip ${ref.clip.clipId}`);
    if (ref.track.kind === 'audio') {
      result.push({ ...segment, asset, clip: ref.clip, track: ref.track, source: 'audio-track' });
    } else if (ref.track.kind === 'video' && !ref.clip.audioDetached) {
      result.push({ ...segment, asset, clip: ref.clip, track: ref.track, source: 'embedded-video-audio' });
    }
  }
  return result.sort((a, b) => a.outputStart - b.outputStart || a.track.order - b.track.order);
}

function freezeTailStages(manifest: ManifestV3, timeMap: V3RenderPlan['timeMap']): RenderStage[] {
  const assets = assetById(manifest);
  const clips = clipLookup(manifest.tracks);
  const soloExists = manifest.tracks.some((track) => track.solo && !track.hidden);
  const audibleTracks = new Set(manifest.tracks
    .filter((track) => !track.hidden && !track.muted && (!soloExists || track.solo))
    .map((track) => track.trackId));
  const visibleVideoTracks = new Set(manifest.tracks.filter((track) => track.kind === 'video' && !track.hidden).map((track) => track.trackId));
  const videoByRange = new Map<string, { stage: Extract<RenderStage, { kind: 'freeze-frame' }>; order: number }>();
  const stages: RenderStage[] = [];

  for (const segment of timeMap.segments) {
    const freezeTailSec = segment.freezeTailSec ?? 0;
    if (freezeTailSec <= 0) continue;
    const ref = clips.get(segment.clipId);
    if (!ref) continue;
    const range = { start: segment.outputEnd, end: segment.outputEnd + freezeTailSec };
    if (ref.track.kind === 'video' && visibleVideoTracks.has(ref.track.trackId)) {
      const asset = assets.get(ref.clip.assetId);
      if (!asset) throw new Error(`Missing asset ${ref.clip.assetId} for clip ${ref.clip.clipId}`);
      // sourceTime is the conceptual segment-end boundary in asset time. The pipeline
      // converts this to an ffmpeg trim that captures the LAST FRAME WITHIN the segment
      // (PTS strictly less than sourceTime). That way a freeze at a color boundary or
      // at asset EOF holds the correct frame instead of the first frame past the boundary
      // (Codex P1, 2026-05-25). sourceFps lets the pipeline pick a single-frame window.
      const sourceFps = (asset.kind === 'video' ? asset.video?.fps : undefined) ?? 30;
      const key = `${range.start}:${range.end}`;
      const stage = { kind: 'freeze-frame' as const, asset: asset.path, sourceTime: ref.clip.sourceStart + segment.sourceEnd, sourceFps, range };
      const existing = videoByRange.get(key);
      if (!existing || existing.order <= ref.track.order) videoByRange.set(key, { stage, order: ref.track.order });
    }
    if (audibleTracks.has(ref.track.trackId) && (ref.track.kind === 'audio' || (ref.track.kind === 'video' && !ref.clip.audioDetached))) {
      stages.push({ kind: 'silence', range });
    }
  }

  return [...Array.from(videoByRange.values()).map((entry) => entry.stage), ...stages];
}

function renderProfile(manifest: ManifestV3): RenderProfile {
  const preset = manifest.renderPresets.draft;
  const output = manifest.outputs.find((candidate) => candidate.status === 'approved') ?? manifest.outputs[0];
  return { resolution: preset.resolution, videoBitrate: preset.videoBitrate, audioBitrate: preset.audioBitrate, aspect: output?.aspects[0] ?? '16:9' };
}

export function buildRenderPlan(manifest: ManifestV3, transcript?: TranscriptWords): V3RenderPlan {
  const timeMap = composeTimeMap(manifest.tracks, manifest.operations);
  const operationStages = manifest.operations
    .filter((op) => op.status === 'approved')
    .map((op) => ({ op, kind: getOperationKind(op.type) }))
    .filter(({ kind }) => !!kind.renderContribution)
    .sort((a, b) => a.op.target.trackId.localeCompare(b.op.target.trackId) || a.kind.precedence - b.kind.precedence || a.op.id.localeCompare(b.op.id))
    .map(({ op, kind }) => kind.renderContribution!(op, { manifest, timeMap }))
    .filter((stage): stage is RenderStage => stage !== null);
  const stages = [...operationStages, ...freezeTailStages(manifest, timeMap)]
    .sort((a, b) => ('range' in a && 'range' in b ? a.range.start - b.range.start || a.range.end - b.range.end : 0));

  // outputDurationSec must include trailing freezeTailSec or terminal-overflow patches
  // (where a longer voice_patch ends at the clip's outputEnd with no downstream segment
  // to ripple) end up with a freeze-frame stage at [outputEnd, outputEnd+delta] that the
  // encoder cuts off because the total render duration was reported pre-freeze.
  const outputDurationSec = Math.max(0, ...timeMap.segments.map((segment) => segment.outputEnd + (segment.freezeTailSec ?? 0)));
  const hasCaptionBurn = stages.some((stage) => stage.kind === 'caption-burn');

  // Studio-clean audio swap: when the manifest has an approved studio cleanup, tell
  // the pipeline to read embedded-video-audio from the cleaned WAV instead of the
  // original video file. Length-preservation is guaranteed (EL Isolator returns a
  // same-duration file), so sourceStart/sourceEnd timings are unchanged — only the
  // audio INPUT file is swapped. This is purely additive: studioCleanupAudioPath is
  // absent when cleanup is missing or status !== 'approved'.
  //
  // SCOPE GUARD (codex P2): the cleanup cleans the single project base audio
  // (media/extracted-audio.wav), i.e. the audio of the original/base source. The
  // pipeline swaps this for ALL embedded-video-audio segments, which is only correct
  // when every video segment comes from that one source. For a multi-asset project
  // (video clips added from other sources) swapping all would read the wrong audio.
  // Until per-source cleanup is modelled, only apply the swap when the project has a
  // single distinct video source; otherwise leave the original audio (cleanup inert).
  const videoSourceIds = new Set(
    manifest.tracks
      .filter((t) => t.kind === 'video' && t.role !== 'staging')
      .flatMap((t) => (t.clips ?? []).map((c) => c.assetId))
  );

  const baseVideoAssetId = videoSourceIds.size === 1 ? Array.from(videoSourceIds)[0] : undefined;
  const baseVideoAsset = baseVideoAssetId !== undefined ? manifest.assets.find((asset) => asset.assetId === baseVideoAssetId) : undefined;

  // Staleness guard: a channel-fix apply/disable AFTER the cleanup was generated means
  // the cleaned asset was produced from audio with the OLD (or absent) channel mix.
  // Re-running the cleanup is a PAID call (studio-sound.elevenlabs-isolation) that must
  // never happen automatically, so instead of silently serving stale cleaned audio, fall
  // back to the base video audio — audioSourceChannel (below) then correctly repans it.
  //
  // Keyed by a VALUE fingerprint of the fix (issue #3/#9/#11), not appliedAt/createdAt
  // ordering: timestamp ordering can't tell a real fix change from a same-value re-apply
  // churning appliedAt, races on same-millisecond timestamps, and is defeated by a
  // future-dated hand edit. studioCleanupRoutes stamps audioChannelFixFingerprint at
  // creation time; a MISSING fingerprint only counts as stale when an audioChannelFix
  // record actually exists to compare against — a cleanup + no channel-fix history at
  // all (the common case, and every pre-fingerprint-field manifest) is never stale.
  const currentFixFingerprint = sourceChannelFixFingerprint(manifest);
  const studioCleanupStale =
    manifest.studioCleanup?.status === 'approved'
    && !!manifest.audioChannelFix
    && manifest.studioCleanup.audioChannelFixFingerprint !== currentFixFingerprint;

  // SCOPE GUARD (issue #5): studioCleanup describes ONLY input/source.mp4's audio — a
  // project whose single remaining video source is some OTHER asset (e.g. the base clip
  // was removed, leaving one unrelated import) must not have that asset's audio swapped
  // for the cleaned WAV. resolveChannelFixForAsset already encodes this literal-path rule
  // for the channel fix below; studioCleanup reuses the same check directly since its
  // scope guard is identical (single project-level record describing input/source.mp4).
  const studioCleanupAudioPath =
    manifest.studioCleanup?.status === 'approved' && videoSourceIds.size <= 1 && baseVideoAsset?.path === 'input/source.mp4' && !studioCleanupStale
      ? manifest.studioCleanup.assetPath
      : undefined;

  // Single-channel-mic fix: same single-source scope guard as studioCleanup — the
  // fix describes the base recording, so a multi-source project must not pan clips
  // it does not describe. resolveChannelFixForAsset enforces the input/source.mp4 path
  // check directly (issue #5) instead of trusting "exactly one video source" alone,
  // which would still pan an unrelated single remaining asset. The channels guard
  // requires EXACTLY 2 (a pan referencing a channel a mono file lacks would fail the
  // ffmpeg run; a 5.1/7.1 source would drop center-channel dialogue by selecting only
  // c0/c1). applyChannelFix backfills this asset's audio.channels from its live probe
  // at apply time, so this stays reliable for both new imports and pre-existing legacy
  // assets once a fix is (re-)applied.
  const scopedChannel = baseVideoAsset ? resolveChannelFixForAsset(manifest, baseVideoAsset.path) : undefined;
  const audioSourceChannel =
    videoSourceIds.size <= 1 && baseVideoAsset?.audio?.channels === 2 ? scopedChannel : undefined;

  return {
    schemaVersion: 3,
    planVersion: 1,
    timeMap,
    stages,
    composition: {
      videoBase: topVisibleVideoSegments(manifest, timeMap),
      audioMix: audioMixSegments(manifest, timeMap)
    },
    targetProfile: renderProfile(manifest),
    outputDurationSec,
    captionCues: hasCaptionBurn && transcript ? projectCaptions(manifest, transcript, timeMap) : undefined,
    ...(studioCleanupAudioPath !== undefined ? { studioCleanupAudioPath } : {}),
    ...(studioCleanupStale ? { studioCleanupStale } : {}),
    ...(audioSourceChannel !== undefined ? { audioSourceChannel } : {})
  };
}
