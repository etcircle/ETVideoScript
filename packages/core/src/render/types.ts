export interface OutputRange {
  start: number;
  end: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OverlaySource =
  | { kind: 'asset'; asset: string }
  | { kind: 'text'; text: string }
  | { kind: 'shape'; shape: string };

export type RenderStage =
  | { kind: 'silence'; range: OutputRange }
  // audio-insert carries opId + playSec whenever the originating op has a known
  // durationGeneratedSec, regardless of whether the asset is shorter or longer than
  // the source window. playSec is computed at plan-build time in renderContribution
  // so pipeline.ts does not need the manifest. opId threads the originating op for
  // auditability. The pipeline derives the base-mute window from
  // max(range.duration, playSec), so:
  //   - shorter patch: mute the full original slot; asset plays only its duration;
  //     the slack tail is silent (not room-toned).
  //   - longer patch: mute the full asset playback window; downstream is shifted
  //     later by the overflow via projectTimeMap (positive delta).
  // Adding a raw `assetDurationSec` would duplicate asset state and risk drift —
  // playSec is the rendered decision, not the asset's own duration.
  // See eng review P2-C, 2026-05-22 and shorter-semantics fix 2026-05-25.
  | { kind: 'audio-insert'; asset: string; range: OutputRange; opId?: string; playSec?: number; crossfadeSec?: number }
  // Freeze-frame renders one source frame for the whole output range, used to hold video during
  // voice_patch overflow bands while generated audio runs longer than the replaced source span.
  // sourceTime is the segment-end BOUNDARY in asset time; the pipeline trims frames whose PTS
  // is strictly less than sourceTime so a freeze at a color boundary or EOF holds the last
  // frame WITHIN the segment, not the first frame past it. sourceFps lets the pipeline pick a
  // single-frame trim window robustly across rates (default 30 when asset metadata is missing).
  | { kind: 'freeze-frame'; asset: string; sourceTime: number; sourceFps: number; range: OutputRange }
  | { kind: 'audio-bed'; bed: 'music' | 'silence' | 'pitched'; range: OutputRange }
  | { kind: 'visual-overlay'; source: OverlaySource; zIndex: number; rect: Rect; opacity: number; range: OutputRange }
  | { kind: 'transition'; boundary: number; transitionType: string; durationMs: number }
  | { kind: 'caption-burn'; styleId: string; range: OutputRange };
