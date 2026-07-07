import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildBaseTimeline,
  buildFfmpegCommandV3,
  buildRenderPlanV3,
  captionStyleOperationKind,
  CaptionStyleOperationSchemaV3,
  composeTimeMap,
  cutOperationKind,
  OverlayOperationSchemaV3,
  overlayOperationKind,
  SpeedOperationSchemaV3,
  speedOperationKind,
  TransitionOperationSchemaV3,
  transitionOperationKind,
  validateManifestV3Document,
  type ManifestV3
} from '../index';
import type { TranscriptWords } from '../schemas';

const now = '2026-05-17T00:00:00.000Z';
const presets = { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: '1920x1080', videoBitrate: '6000k', audioBitrate: '192k' } };

function speedOp(extras = {}) {
  return { id: 'op_speed_001', type: 'speed' as const, status: 'approved' as const, target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 2, end: 6 }, rate: 4 as const, bed: 'pitched' as const, proposedBy: 'agent' as const, createdBy: 'user' as const, createdAt: now, ...extras };
}
function overlayOp(extras = {}) {
  return { id: 'op_overlay_001', type: 'overlay' as const, status: 'approved' as const, target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 1, end: 3 }, source: { kind: 'text' as const, text: 'HELLO' }, zIndex: 1, rect: { x: 10, y: 20, width: 200, height: 32 }, opacity: 0.8, proposedBy: 'agent' as const, createdBy: 'user' as const, createdAt: now, ...extras };
}
function transitionOp(extras = {}) {
  return { id: 'op_transition_001', type: 'transition' as const, status: 'approved' as const, target: { kind: 'clip-boundary' as const, trackId: 'track_video_001', clipId: 'clip_001' }, transitionType: 'crossfade' as const, durationMs: 500, proposedBy: 'agent' as const, createdBy: 'user' as const, createdAt: now, ...extras };
}
function captionStyleOp(extras = {}) {
  return { id: 'op_caption_001', type: 'caption_style' as const, status: 'approved' as const, target: { kind: 'track' as const, trackId: 'track_caption_001' }, styleId: 'large', proposedBy: 'agent' as const, createdBy: 'user' as const, createdAt: now, ...extras };
}

function manifest(operations: ManifestV3['operations'] = []): ManifestV3 {
  return {
    manifestVersion: 3,
    projectId: 'v3-new-ops',
    createdAt: now,
    updatedAt: now,
    assets: [
      { assetId: 'asset_video_001', kind: 'video', path: 'assets/video/source.mp4', durationSec: 12, provenance: 'imported', video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000 } },
      { assetId: 'asset_video_002', kind: 'video', path: 'assets/video/next.mp4', durationSec: 4, provenance: 'imported', video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000 } },
      { assetId: 'asset_overlay_001', kind: 'image', path: 'assets/images/logo.png', durationSec: 1, provenance: 'imported' }
    ],
    tracks: [
      { trackId: 'track_video_001', kind: 'video', name: 'Video', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [
        { clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 10, timelineStart: 0 },
        { clipId: 'clip_002', assetId: 'asset_video_002', sourceStart: 0, sourceEnd: 4, timelineStart: 10 }
      ] },
      { trackId: 'track_video_002', kind: 'video', name: 'Other', order: 1, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [
        { clipId: 'clip_other', assetId: 'asset_video_002', sourceStart: 0, sourceEnd: 4, timelineStart: 0 }
      ] },
      { trackId: 'track_caption_001', kind: 'caption', name: 'Captions', order: 10, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [] }
    ],
    operations,
    outputs: [{ outputId: 'output_full_001', kind: 'full', aspects: ['16:9'], status: 'manual' }],
    takeGroups: [],
    renderPresets: presets
  };
}

const transcript: TranscriptWords = {
  schemaVersion: 1,
  source: 'source.mp4',
  provider: { name: 'mock', model: 'mock', requestId: null, timing: 'mock' },
  language: 'en',
  durationSec: 10,
  words: [{ id: 'w1', text: 'caption', normalized: 'caption', start: 0.2, end: 0.6, speaker: 'speaker_1', confidence: 1, segmentId: 's1', clipId: 'clip_001' }],
  segments: [{ id: 's1', speaker: 'speaker_1', start: 0, end: 1, text: 'caption' }]
};

describe('v3 new operation schemas and hooks', () => {
  it('parses valid payloads and rejects invalid ones', () => {
    expect(SpeedOperationSchemaV3.safeParse(speedOp()).success).toBe(true);
    expect(SpeedOperationSchemaV3.safeParse(speedOp({ rate: 3 })).success).toBe(false);
    expect(OverlayOperationSchemaV3.safeParse(overlayOp()).success).toBe(true);
    expect(OverlayOperationSchemaV3.safeParse(overlayOp({ opacity: 2 })).success).toBe(false);
    expect(TransitionOperationSchemaV3.safeParse(transitionOp()).success).toBe(true);
    expect(TransitionOperationSchemaV3.safeParse(transitionOp({ transitionType: 'wipe' })).success).toBe(false);
    expect(TransitionOperationSchemaV3.safeParse(transitionOp({ durationMs: 0 })).success).toBe(false);
    expect(CaptionStyleOperationSchemaV3.safeParse(captionStyleOp()).success).toBe(true);
    expect(CaptionStyleOperationSchemaV3.safeParse(captionStyleOp({ styleId: '' })).success).toBe(false);
  });

  it('validates local invariants', () => {
    const m = manifest();
    const track = m.tracks[0]!;
    const clip = track.clips[0]!;
    expect(speedOperationKind.validateLocal(speedOp({ target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 9, end: 11 } }), { manifest: m, track, clip })).toContain('op_speed_001: operation ends after clip clip_001 duration 10');
    expect(overlayOperationKind.validateLocal(overlayOp({ source: { kind: 'asset', asset: 'missing' } }), { manifest: m, track, clip, assetExists: () => false }).join('\n')).toContain('overlay asset does not exist');
    expect(transitionOperationKind.validateLocal(transitionOp({ target: { kind: 'clip-boundary', trackId: 'track_video_001', clipId: 'clip_002' } }), { manifest: m, track, clip: track.clips[1]! }).join('\n')).toContain('no following clip');
    expect(captionStyleOperationKind.validateLocal(captionStyleOp({ target: { kind: 'track', trackId: 'track_video_001' } }), { manifest: m, track }).join('\n')).toContain('caption tracks');
  });

  it('returns render stage shapes from renderContribution', () => {
    const m = manifest([speedOp(), overlayOp(), transitionOp(), captionStyleOp()]);
    const timeMap = composeTimeMap(m.tracks, m.operations);
    expect(speedOperationKind.renderContribution!(m.operations[0]!, { manifest: m, timeMap })).toEqual({ kind: 'audio-bed', bed: 'pitched', range: { start: 2, end: 3 } });
    expect(overlayOperationKind.renderContribution!(m.operations[1]!, { manifest: m, timeMap })).toMatchObject({ kind: 'visual-overlay', zIndex: 1, range: { start: 1, end: 2.25 } });
    expect(transitionOperationKind.renderContribution!(m.operations[2]!, { manifest: m, timeMap })).toMatchObject({ kind: 'transition', boundary: 7 });
    expect(captionStyleOperationKind.renderContribution!(m.operations[3]!, { manifest: m, timeMap })).toEqual({ kind: 'caption-burn', styleId: 'large', range: { start: 0, end: 11 } });
  });
});

describe('v3 speed time-map and render plan', () => {
  it('rescales speed ranges, reflows only same-track downstream segments, and composes after cut by precedence', () => {
    const base = buildBaseTimeline(manifest().tracks);
    const speedMap = speedOperationKind.projectTimeMap!(speedOp(), base);
    expect(speedMap.segments.filter((segment) => segment.clipId === 'clip_001').map((segment) => [segment.sourceStart, segment.sourceEnd, segment.outputStart, segment.outputEnd, segment.rate])).toEqual([
      [0, 2, 0, 2, 1],
      [2, 6, 2, 3, 4],
      [6, 10, 3, 7, 1]
    ]);
    expect(speedMap.segments.find((segment) => segment.clipId === 'clip_002')).toMatchObject({ outputStart: 7, outputEnd: 11 });
    expect(speedMap.segments.find((segment) => segment.clipId === 'clip_other')).toMatchObject({ outputStart: 0, outputEnd: 4 });

    const cut = { id: 'op_cut_001', type: 'cut' as const, status: 'approved' as const, target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 1, end: 3 }, proposedBy: 'agent' as const, createdBy: 'user' as const, createdAt: now };
    const folded = composeTimeMap(manifest([speedOp(), cut]).tracks, [speedOp(), cut]);
    expect(folded.segments.filter((segment) => segment.clipId === 'clip_001').map((segment) => [segment.sourceStart, segment.sourceEnd, segment.outputStart, segment.outputEnd, segment.rate])).toEqual([
      [0, 1, 0, 1, 1],
      [3, 6, 1, 1.75, 4],
      [6, 10, 1.75, 5.75, 1]
    ]);
  });

  it('includes speed audio-bed stages in buildRenderPlan', () => {
    const plan = buildRenderPlanV3(manifest([speedOp()]));
    expect(plan.stages).toEqual([{ kind: 'audio-bed', bed: 'pitched', range: { start: 2, end: 3 } }]);
  });

  it('duration-matches sped base video audio with silence', () => {
    const m = manifest([speedOp()]);
    m.tracks[1]!.hidden = true;
    const plan = buildRenderPlanV3(m);
    expect(plan.outputDurationSec).toBe(11);
    expect(plan.composition.videoBase.find((segment) => segment.clipId === 'clip_001' && segment.rate === 4)).toMatchObject({ outputStart: 2, outputEnd: 3, sourceStart: 2, sourceEnd: 6 });
    const command = buildFfmpegCommandV3('/tmp/etv3', plan, 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('setpts=PTS/4');
    expect(filter).toContain('anullsrc=channel_layout=stereo:sample_rate=48000:d=1.000000[a1]');
    expect(filter).not.toContain('[0:a]atrim=start=2.000000:end=6.000000[a1]');
  });

  it('does not route sped covered video audio through structural audio', () => {
    const plan = buildRenderPlanV3(manifest([speedOp()]));
    const spedSegment = plan.composition.audioMix.find((segment) => segment.clipId === 'clip_001' && segment.rate === 4);
    expect(spedSegment).toMatchObject({ outputStart: 2, outputEnd: 3, sourceStart: 2, sourceEnd: 6 });
    expect(plan.composition.videoBase.find((segment) => segment.outputStart === 2 && segment.outputEnd === 3)).toMatchObject({ clipId: 'clip_other' });

    const command = buildFfmpegCommandV3('/tmp/etv3', plan, 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('[1:a]atrim=start=2.000000:end=6.000000,asetpts=PTS-STARTPTS,atempo=2,atempo=2,atrim=0:1.000000,adelay=2000.000000|2000.000000[ab0]');
    expect(filter).not.toContain('[1:a]atrim=start=2.000000:end=6.000000,asetpts=PTS-STARTPTS,adelay=2000.000000|2000.000000[mix');
  });
});

describe('v3 new operation validation and pipeline', () => {
  it('validates transition and caption_style through the manifest validator', () => {
    expect(validateManifestV3Document(manifest([transitionOp({ target: { kind: 'clip-boundary', trackId: 'track_video_001', clipId: 'clip_002' } })])).errors.join('\n')).toContain('no following clip');
    expect(validateManifestV3Document(manifest([captionStyleOp({ target: { kind: 'track', trackId: 'track_video_001' } })])).errors.join('\n')).toContain('caption tracks');
  });

  it('builds filtergraph contributions for all new stages', () => {
    const stages = [speedOp(), overlayOp(), transitionOp(), captionStyleOp()];
    const plan = buildRenderPlanV3(manifest(stages), transcript);
    const workspace = mkdtempSync(join(tmpdir(), 'etv3-captions-'));
    const command = buildFfmpegCommandV3(workspace, plan, 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    try {
      expect(filter).toContain("volume=enable='between(t,2.000000,3.000000)':volume=0");
      expect(filter).toContain('atempo=2,atempo=2');
      expect(filter).toContain('drawtext=text=');
      expect(filter).toContain('fade=t=out');
      expect(filter).toContain('subtitles=');
      expect(plan.captionCues?.map((cue) => cue.text)).toContain('caption');
      expect(readFileSync(join(workspace, 'temp/render/captions-large.srt'), 'utf8')).toContain('caption');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renders asset overlays and music beds with deterministic inputs/placeholders', () => {
    const plan = buildRenderPlanV3(manifest([
      speedOp({ bed: 'music' }),
      overlayOp({ source: { kind: 'asset', asset: 'asset_overlay_001' } })
    ]));
    const command = buildFfmpegCommandV3('/tmp/etv3', plan, 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    expect(command.args).toContain('/tmp/etv3/assets/images/logo.png');
    expect(filter).toContain('sine=frequency=220');
    expect(filter).toContain('overlay=x=10.000:y=20.000');
  });
});
