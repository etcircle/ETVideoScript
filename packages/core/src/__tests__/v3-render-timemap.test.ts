import { describe, expect, it } from 'vitest';
import {
  buildBaseTimeline,
  buildFfmpegCommandV3,
  buildRenderPlanV3,
  captionsToSrtV3,
  composeTimeMap,
  cutOperationKind,
  deriveEditedScriptFromTimeMapV3,
  derivePreviewScriptFromTimeMapV3,
  muteOperationKind,
  outputRangeForClipSourceSpan,
  outputTimeV3,
  projectCaptionsV3,
  renderStageHandlersV3,
  sourceTimeAt,
  type ManifestV3,
  type TimeMap,
  type V3PreviewScriptToken,
  validateManifestV3Document,
  voicePatchOperationKind
} from '../index';
import type { TranscriptWords } from '../schemas';

const now = '2026-05-17T00:00:00.000Z';
const presets = { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: '1920x1080', videoBitrate: '6000k', audioBitrate: '192k' } };

function op(id: string, type: 'cut' | 'mute' | 'voice_patch', start: number, end: number, extras = {}) {
  return { id, type, status: 'approved' as const, target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start, end }, proposedBy: 'agent' as const, createdBy: 'user' as const, createdAt: now, ...(type === 'voice_patch' ? { text: 'patched line', assetId: 'asset_voice_001' } : {}), ...extras };
}

function manifest(operations: ManifestV3['operations'] = []): ManifestV3 {
  return {
    manifestVersion: 3,
    projectId: 'v3-render',
    createdAt: now,
    updatedAt: now,
    assets: [
      { assetId: 'asset_video_001', kind: 'video', path: 'assets/video/source.mp4', durationSec: 12, provenance: 'imported', video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000 } },
      { assetId: 'asset_video_002', kind: 'video', path: 'assets/video/top.mp4', durationSec: 4, provenance: 'imported', video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000 } },
      { assetId: 'asset_music_001', kind: 'audio', path: 'assets/audio/music.wav', durationSec: 12, provenance: 'imported', audio: { sampleRate: 48000 } },
      { assetId: 'asset_voice_001', kind: 'audio', path: 'assets/voice/patch.wav', durationSec: 1, provenance: 'generated', audio: { sampleRate: 48000 } }
    ],
    tracks: [
      { trackId: 'track_video_001', kind: 'video', name: 'Base video', order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 2, sourceEnd: 12, timelineStart: 0 }] },
      { trackId: 'track_video_002', kind: 'video', name: 'Top video', order: 10, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [{ clipId: 'clip_top', assetId: 'asset_video_002', sourceStart: 0, sourceEnd: 4, timelineStart: 3, audioDetached: true }] },
      { trackId: 'track_audio_001', kind: 'audio', subtype: 'music', name: 'Music', order: 1, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [{ clipId: 'clip_music', assetId: 'asset_music_001', sourceStart: 0, sourceEnd: 12, timelineStart: 0 }] }
    ],
    operations,
    outputs: [{ outputId: 'output_full_001', kind: 'full', aspects: ['16:9'], status: 'manual' }],
    renderPresets: presets
  };
}

const transcript: TranscriptWords = {
  schemaVersion: 1,
  source: 'source.mp4',
  provider: { name: 'mock', model: 'mock', requestId: null, timing: 'mock' },
  language: 'en',
  durationSec: 10,
  words: [
    { id: 'w1', text: 'hello', normalized: 'hello', start: 0.2, end: 0.6, speaker: 'speaker_1', confidence: 1, segmentId: 's1', clipId: 'clip_001' },
    { id: 'w2', text: 'cut', normalized: 'cut', start: 2.2, end: 2.6, speaker: 'speaker_1', confidence: 1, segmentId: 's1', clipId: 'clip_001' },
    { id: 'w3', text: 'muted', normalized: 'muted', start: 5.2, end: 5.6, speaker: 'speaker_1', confidence: 1, segmentId: 's1', clipId: 'clip_001' }
  ],
  segments: [{ id: 's1', speaker: 'speaker_1', start: 0, end: 6, text: 'hello cut muted' }]
};

describe('v3 time-map composition', () => {
  it('builds one base segment per clip at clip timelineStart', () => {
    const base = buildBaseTimeline(manifest().tracks);
    expect(base.segments.map((segment) => [segment.clipId, segment.outputStart, segment.outputEnd])).toEqual([
      ['clip_001', 0, 10],
      ['clip_music', 0, 12],
      ['clip_top', 3, 7]
    ]);
  });

  it('folds cuts and walks source/output rate-aware', () => {
    const timeMap = composeTimeMap(manifest([op('op_cut_001', 'cut', 2, 4)]).tracks, [op('op_cut_001', 'cut', 2, 4)] as ManifestV3['operations']);
    expect(timeMap.segments.filter((segment) => segment.clipId === 'clip_001').map((segment) => [segment.sourceStart, segment.sourceEnd, segment.outputStart, segment.outputEnd])).toEqual([[0, 2, 0, 2], [4, 10, 2, 8]]);
    // Lip-drift fix: transcript cuts are global, so non-target tracks overlapping the cut window split/ripple too.
    expect(timeMap.segments.filter((segment) => segment.clipId === 'clip_music').map((segment) => [segment.sourceStart, segment.sourceEnd, segment.outputStart, segment.outputEnd])).toEqual([[0, 2, 0, 2], [4, 12, 2, 10]]);
    // Lip-drift fix: a non-target overlay clip that overlaps the removed output band is split cleanly instead of staying at stale output time.
    expect(timeMap.segments.filter((segment) => segment.clipId === 'clip_top').map((segment) => [segment.sourceStart, segment.sourceEnd, segment.outputStart, segment.outputEnd])).toEqual([[1, 4, 2, 5]]);
    expect(outputTimeV3(timeMap, 'clip_001', 5)).toBe(3);
    expect(outputTimeV3(timeMap, 'clip_001', 3)).toBeNull();
    const clipOnlyMap: TimeMap = { segments: timeMap.segments.filter((segment) => segment.clipId === 'clip_001') };
    expect(sourceTimeAt(clipOnlyMap, 3)).toMatchObject({ clipId: 'clip_001', sourceTime: 5 });

    const synthetic: TimeMap = { segments: [{ trackId: 't', clipId: 'c', sourceStart: 0, sourceEnd: 8, outputStart: 0, outputEnd: 4, rate: 2 }] };
    expect(outputTimeV3(synthetic, 'c', 6)).toBe(3);
    expect(sourceTimeAt(synthetic, 3)).toMatchObject({ clipId: 'c', sourceTime: 6 });
  });

  it('cuts at a non-target clip boundary without double-shifting that clip', () => {
    const m = manifest([op('op_cut_001', 'cut', 2, 4)]);
    m.tracks[1]!.clips[0]!.timelineStart = 4;
    const timeMap = composeTimeMap(m.tracks, m.operations);

    expect(timeMap.segments.find((segment) => segment.clipId === 'clip_top')).toMatchObject({ outputStart: 2, outputEnd: 6, sourceStart: 0, sourceEnd: 4 });
  });

  it('returns degenerate range at seam between consecutive segments', () => {
    const seamMap: TimeMap = {
      segments: [
        { trackId: 'track_video_001', clipId: 'clip_001', sourceStart: 0, sourceEnd: 1, outputStart: 0, outputEnd: 1, rate: 1 },
        { trackId: 'track_video_001', clipId: 'clip_001', sourceStart: 1, sourceEnd: 2, outputStart: 1, outputEnd: 2, rate: 1 }
      ]
    };

    expect(outputRangeForClipSourceSpan(seamMap, 'clip_001', 1, 1)).toEqual({ start: 1, end: 1 });
  });

  it('returns null on genuine inversion', () => {
    const invertedMap: TimeMap = {
      segments: [
        { trackId: 'track_video_001', clipId: 'clip_001', sourceStart: 0, sourceEnd: 1, outputStart: 10, outputEnd: 11, rate: 1 },
        { trackId: 'track_video_001', clipId: 'clip_001', sourceStart: 1, sourceEnd: 2, outputStart: 0, outputEnd: 1, rate: 1 }
      ]
    };

    expect(outputRangeForClipSourceSpan(invertedMap, 'clip_001', 0.5, 1.5)).toBeNull();
  });

  it('returns null for nonzero source span collapsed to zero output by an upstream cut', () => {
    // cut [2,4] removes the middle of a clip; a downstream op (mute / overlay / speed)
    // targeting source [2,4] would have both endpoints map to the same cut seam at
    // output=2. The EPSILON-tolerant range check accepts genuinely zero-length source
    // spans (Chunk B's chained-ripple seam case) but must REJECT this case — a
    // nonzero source span that collapsed to zero output would otherwise leak a 10ms
    // blip into render output via the silence/audio-insert min-duration floor in
    // pipeline.ts. Codex review P2, 2026-05-22.
    const postCutMap: TimeMap = {
      segments: [
        { trackId: 'track_video_001', clipId: 'clip_001', sourceStart: 0, sourceEnd: 2, outputStart: 0, outputEnd: 2, rate: 1 },
        { trackId: 'track_video_001', clipId: 'clip_001', sourceStart: 4, sourceEnd: 10, outputStart: 2, outputEnd: 8, rate: 1 }
      ]
    };
    expect(outputRangeForClipSourceSpan(postCutMap, 'clip_001', 2, 4)).toBeNull();
  });
});

describe('v3 operation render/time-map hooks', () => {
  function withDownstreamSameTrackClip(operations: ManifestV3['operations'] = []): ManifestV3 {
    const m = manifest(operations);
    m.tracks[0]!.clips.push({ clipId: 'clip_002', assetId: 'asset_video_002', sourceStart: 0, sourceEnd: 4, timelineStart: 10 });
    return m;
  }

  function onlyBaseVideoClip(operations: ManifestV3['operations'] = []): ManifestV3 {
    const m = manifest(operations);
    m.tracks = [m.tracks[0]!];
    return m;
  }

  it('projects cut time-map and maps mute / voice_patch ranges to output time', () => {
    const m = manifest([op('op_cut_001', 'cut', 2, 4), op('op_mute_001', 'mute', 5, 6), op('op_voice_001', 'voice_patch', 6, 7)]);
    const cutMap = cutOperationKind.projectTimeMap!(m.operations[0]!, buildBaseTimeline(m.tracks));
    expect(outputTimeV3(cutMap, 'clip_001', 5)).toBe(3);
    expect(muteOperationKind.renderContribution!(m.operations[1]!, { manifest: m, timeMap: cutMap })).toEqual({ kind: 'silence', range: { start: 3, end: 4 } });
    expect(voicePatchOperationKind.renderContribution!(m.operations[2]!, { manifest: m, timeMap: cutMap })).toMatchObject({ kind: 'audio-insert', asset: 'assets/voice/patch.wav', range: { start: 4, end: 5 } });
  });

  it('ripples downstream segments on every track by +delta and marks all overflowing tails (including the anchor track) when assetDuration > requestedDuration', () => {
    const m = withDownstreamSameTrackClip([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.5 })]);
    const baseMap = buildBaseTimeline(m.tracks);
    const projected = voicePatchOperationKind.projectTimeMap!(m.operations[0]!, baseMap);

    // Anchor video track also freezes the overflow now (post-2026-05-25 anchor-freeze fix).
    expect(projected.segments.filter((segment) => segment.clipId === 'clip_001').map((segment) => [segment.sourceStart, segment.sourceEnd, segment.outputStart, segment.outputEnd, segment.freezeTailSec ?? 0])).toEqual([[0, 5, 0, 5, 0.5], [5, 10, 5.5, 10.5, 0]]);
    expect(projected.segments.find((segment) => segment.clipId === 'clip_002')).toMatchObject({ sourceStart: 0, sourceEnd: 4, outputStart: 10.5, outputEnd: 14.5 });
    // Lip-drift fix: voice_patch ripple is global, not target-track-only; overflow freezes the non-patched video/audio tails.
    expect(projected.segments.filter((segment) => segment.clipId === 'clip_music').map((segment) => [segment.sourceStart, segment.sourceEnd, segment.outputStart, segment.outputEnd, segment.freezeTailSec ?? 0])).toEqual([[0, 5, 0, 5, 0.5], [5, 12, 5.5, 12.5, 0]]);
  });

  it('does NOT shrink the timeline when assetDuration < requestedDuration (phase-1 rule, 2026-05-25)', () => {
    // Phase-1 rule: shorter voice_patch generated audio leaves the time map untouched.
    // The original slot duration is preserved; downstream output timing is unchanged;
    // the slack tail is rendered as silence by the audio-insert mute window in pipeline.ts.
    // Pre-2026-05-25 this case shrunk all tracks by |delta| — the Test-Emo rush bug.
    const m = withDownstreamSameTrackClip([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 0.4 })]);
    const baseMap = buildBaseTimeline(m.tracks);
    const projected = voicePatchOperationKind.projectTimeMap!(m.operations[0]!, baseMap);

    expect(projected).toEqual(baseMap);
  });

  it('returns the map unchanged when delta is within EPSILON of zero', () => {
    const m = withDownstreamSameTrackClip([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.0000000005 })]);
    const baseMap = buildBaseTimeline(m.tracks);
    const projected = voicePatchOperationKind.projectTimeMap!(m.operations[0]!, baseMap);

    expect(projected).toEqual(baseMap);
  });

  it('chains two ripples in source order; downstream segments shift by sum of deltas', () => {
    const m = withDownstreamSameTrackClip([
      op('op_voice_001', 'voice_patch', 2, 3, { durationGeneratedSec: 1.5 }),
      op('op_voice_002', 'voice_patch', 6, 7, { durationGeneratedSec: 1.7 })
    ]);
    const projected = composeTimeMap(m.tracks, m.operations);

    const seg002 = projected.segments.find((segment) => segment.clipId === 'clip_002')!;
    expect(seg002.outputStart).toBeCloseTo(11.2, 9);
    expect(seg002.outputEnd).toBeCloseTo(15.2, 9);
  });

  it('ripples correctly when patch starts at the segment sourceStart boundary', () => {
    const m = withDownstreamSameTrackClip([op('op_voice_001', 'voice_patch', 0, 1, { durationGeneratedSec: 1.5 })]);
    const baseMap = buildBaseTimeline(m.tracks);
    const projected = voicePatchOperationKind.projectTimeMap!(m.operations[0]!, baseMap);

    expect(projected.segments.find((segment) => segment.clipId === 'clip_002')).toMatchObject({ outputStart: 10.5, outputEnd: 14.5 });
  });

  it('ripples correctly when clip.timelineStart != 0', () => {
    const m = manifest([op('op_voice_001', 'voice_patch', 1, 2, { durationGeneratedSec: 1.5 })]);
    m.tracks = [m.tracks[0]!];
    m.tracks[0]!.clips[0]!.timelineStart = 3;
    m.tracks[0]!.clips.push({ clipId: 'clip_002', assetId: 'asset_video_002', sourceStart: 0, sourceEnd: 4, timelineStart: 15 });
    const baseMap = buildBaseTimeline(m.tracks);
    const projected = voicePatchOperationKind.projectTimeMap!(m.operations[0]!, baseMap);

    expect(baseMap.segments.find((segment) => segment.clipId === 'clip_001')).toMatchObject({ outputStart: 3, outputEnd: 13 });
    expect(projected.segments.find((segment) => segment.clipId === 'clip_002')).toMatchObject({ outputStart: 15.5, outputEnd: 19.5 });
  });

  it('render plan outputDurationSec extends by total ripple delta', () => {
    // Two-clip fixture: clip_001 is the anchor (source [0,10]); clip_002 is downstream
    // at timelineStart:10 (source [0,4], outputStart:10). Ripple +0.5 shifts clip_002
    // to outputStart:10.5, outputEnd:14.5. Max outputEnd = 14.5 → outputDurationSec = 14.5.
    const m = withDownstreamSameTrackClip([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.5 })]);
    const plan = buildRenderPlanV3(m);

    expect(plan.outputDurationSec).toBe(14.5);
  });

  it('render plan outputDurationSec extends for an interior overflow patch even without a downstream clip', () => {
    // Lip-drift/overflow fix: an interior voice_patch longer than its source span inserts a
    // freeze band into the same clip, so outputDurationSec grows even without a separate downstream clip.
    const m = onlyBaseVideoClip([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.5 })]);
    const plan = buildRenderPlanV3(m);

    expect(plan.outputDurationSec).toBe(10.5);
  });

  it('render plan outputDurationSec extends past segment.outputEnd via freezeTailSec for terminal-overflow patches', () => {
    // Codex P2 (2026-05-25 anchor-freeze follow-up): when a longer voice_patch ends exactly
    // at the clip's last segment outputEnd, the anchor segment gets freezeTailSec but its
    // outputEnd does NOT shift (no downstream segment to ripple). outputDurationSec must
    // account for the trailing freeze tail or the encoder cuts the render at the pre-overflow
    // boundary and the freeze-frame stage at [outputEnd, outputEnd+delta] is silently dropped.
    const m = onlyBaseVideoClip([op('op_voice_001', 'voice_patch', 9, 10, { durationGeneratedSec: 1.5 })]);
    const plan = buildRenderPlanV3(m);

    expect(plan.outputDurationSec).toBe(10.5);
    // sourceTime is the segment-end boundary (asset EOF here); the pipeline trim captures
    // frames strictly before it, so ffmpeg holds the LAST decodable frame of the asset.
    expect(plan.stages).toContainEqual({ kind: 'freeze-frame', asset: 'assets/video/source.mp4', sourceTime: 12, sourceFps: 30, range: { start: 10, end: 10.5 } });
  });

  it('validateManifestV3Document rejects overlapping cut and voice_patch on the same clip', () => {
    const result = validateManifestV3Document(manifest([
      op('op_cut_001', 'cut', 3, 5),
      op('op_voice_001', 'voice_patch', 4, 6)
    ]));

    expect(result.errors.some((error) => /op_cut_001.*op_voice_001.*overlap|op_voice_001.*op_cut_001.*overlap|op_cut_001.*op_voice_001.*conflict|op_voice_001.*op_cut_001.*conflict/i.test(error))).toBe(true);
  });

  it('accepts non-overlapping cut and voice_patch on the same clip', () => {
    const result = validateManifestV3Document(manifest([
      op('op_cut_001', 'cut', 2, 3),
      op('op_voice_001', 'voice_patch', 6, 7)
    ]));

    expect(result.errors.some((error) => /op_cut_001.*op_voice_001.*overlap|op_voice_001.*op_cut_001.*overlap|op_cut_001.*op_voice_001.*conflict|op_voice_001.*op_cut_001.*conflict/i.test(error))).toBe(false);
  });

  // ─── Audio precision + smart-fade tests (2026-05-26 slice) ─────────────────────────

  it('emits 6-decimal exact timing on audio trim/atrim boundaries', () => {
    // sec() (3-decimal) replaced by roundSec6() (6-decimal) for trim/atrim/silence/duration.
    // Sub-ms cut boundaries (Whisper exact-timing word ends) now survive without ms rounding.
    // Fixture clip_001 has sourceStart=2, so asset-time atrim = clip.sourceStart + segment.source.
    const m = onlyBaseVideoClip([op('op_cut_001', 'cut', 2.2994, 2.4604)]);
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    // Pre-cut: clip-local [0, 2.2994) → asset-time [2, 4.2994).
    expect(filter).toContain('atrim=start=2.000000:end=4.299400');
    // Post-cut: clip-local [2.4604, 10) → asset-time [4.4604, 12).
    expect(filter).toContain('atrim=start=4.460400:end=12.000000');
  });

  it('positions inserted audio via sub-ms-precision adelay (asetpts reverted: amix drops PTS-gapped streams)', () => {
    // Plan v6 proposed asetpts=PTS-STARTPTS+offset/TB. The implementation pass found amix
    // does not honor PTS gaps and the asset stream got dropped. Reverted to adelay with
    // sub-ms precision via adelayMs() — ffmpeg adelay accepts float ms and quantizes to
    // the nearest audio sample (~21 µs at 48 kHz). Same precision target, format amix expects.
    const m = manifest([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.5 })]);
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('adelay=4000.000000|4000.000000');
    expect(filter).not.toMatch(/adelay=4000\|4000\b/);
  });

  it('does not fade zero-op base audio segments', () => {
    // Zero operations → no cut source jumps → no afade anywhere on base segments.
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(manifest()), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    const lines = filter.split(';');
    const baseSegmentLines = lines.filter((line) => /^\[\d+:a\]atrim=start=[\d.]+:end=[\d.]+,asetpts=PTS-STARTPTS[^,]*\[a/.test(line));
    expect(baseSegmentLines.length).toBeGreaterThan(0);
    for (const line of baseSegmentLines) {
      expect(line).not.toMatch(/afade=t=(in|out)/);
    }
  });

  it('fades the pre-cut segment with afade=t=out anchored to its atrim source range', () => {
    // Hermes P1.3 (v1 review): cardinality alone is insufficient. Assert the FILTER LINE
    // containing the fade also contains the expected atrim source range so the fade lands
    // on the RIGHT segment, not just any segment.
    const m = onlyBaseVideoClip([op('op_cut_001', 'cut', 2, 4)]);
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    const lines = filter.split(';');
    // Fixture clip_001 has sourceStart=2, so asset-time atrim = clip.sourceStart + segment.source.
    // Pre-cut: clip-local [0, 2) → asset-time [2, 4). afade=t=out, no fade-in.
    const preCut = lines.find((line) => line.includes('atrim=start=2.000000:end=4.000000'));
    expect(preCut).toBeDefined();
    expect(preCut).toMatch(/afade=t=out:st=1\.998000:d=0\.002000/);
    expect(preCut).not.toMatch(/afade=t=in/);
    // Post-cut: clip-local [4, 10) → asset-time [6, 12). afade=t=in, no fade-out.
    const postCut = lines.find((line) => line.includes('atrim=start=6.000000:end=12.000000'));
    expect(postCut).toBeDefined();
    expect(postCut).toMatch(/afade=t=in:st=0:d=0\.002000/);
    expect(postCut).not.toMatch(/afade=t=out/);
  });

  it('chained cuts with a retained sliver: the sliver gets both fade-in and fade-out', () => {
    // Mirrors Test-Emo's [2.299, 2.460] + [2.519, 2.839] "doing"+"mate" cut pattern.
    const m = onlyBaseVideoClip([
      op('cut_a', 'cut', 2.299, 2.460),
      op('cut_b', 'cut', 2.519, 2.839)
    ]);
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    const lines = filter.split(';');
    // Fixture clip_001 has sourceStart=2; sliver clip-local [2.460, 2.519) → asset-time [4.460, 4.519).
    const sliver = lines.find((line) => line.includes('atrim=start=4.460000:end=4.519000'));
    expect(sliver).toBeDefined();
    expect(sliver).toMatch(/afade=t=in/);
    expect(sliver).toMatch(/afade=t=out/);
  });

  it('two adjacent same-track clips: no fade across the cross-clip seam', () => {
    // Same-track clip boundaries are concatenation seams, NOT same-clip source jumps.
    // The smart-fade predicate requires sameTrackClip (both trackId AND clipId match).
    const m = withDownstreamSameTrackClip();
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    const lines = filter.split(';');
    const baseSegmentLines = lines.filter((line) => /^\[\d+:a\]atrim=start=[\d.]+:end=[\d.]+,asetpts=PTS-STARTPTS[^,]*\[a/.test(line));
    for (const line of baseSegmentLines) {
      expect(line).not.toMatch(/afade=t=(in|out)/);
    }
  });

  it('longer voice_patch: no smart-fade on the freeze-overflow boundary', () => {
    // Longer voice_patch inserts a freeze STAGE (plan.stages), not a videoBase adjacency.
    // The smart-fade predicate looks at videoBase only → voice_patch boundaries don't fire.
    // The audio-insert crossfade + base-mute window handle this transition separately.
    const m = onlyBaseVideoClip([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.5 })]);
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    const lines = filter.split(';');
    const baseSegmentLines = lines.filter((line) => /^\[\d+:a\]atrim=start=[\d.]+:end=[\d.]+,asetpts=PTS-STARTPTS[^,]*\[a/.test(line));
    for (const line of baseSegmentLines) {
      expect(line).not.toMatch(/afade=t=(in|out)/);
    }
  });

  it('shorter voice_patch: no smart-fade on the slot boundary', () => {
    // Phase-1 rule: shorter voice_patch leaves the time-map unchanged. Single base segment,
    // no source jumps, no afade.
    const m = onlyBaseVideoClip([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 0.4 })]);
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    const lines = filter.split(';');
    const baseSegmentLines = lines.filter((line) => /^\[\d+:a\]atrim=start=[\d.]+:end=[\d.]+,asetpts=PTS-STARTPTS[^,]*\[a/.test(line));
    for (const line of baseSegmentLines) {
      expect(line).not.toMatch(/afade=t=(in|out)/);
    }
  });
});

describe('v3 render plan and pipeline', () => {
  it('builds time-map, ordered stages, top video base, and audio mix', () => {
    const plan = buildRenderPlanV3(manifest([op('op_cut_001', 'cut', 2, 4), op('op_mute_001', 'mute', 5, 6), op('op_voice_001', 'voice_patch', 6, 7)]));
    expect(plan.timeMap.segments.some((segment) => segment.clipId === 'clip_001' && segment.sourceStart === 4)).toBe(true);
    expect(plan.stages[0]).toEqual({ kind: 'silence', range: { start: 3, end: 4 } });
    expect(plan.stages[1]).toMatchObject({ kind: 'audio-insert', asset: 'assets/voice/patch.wav', range: { start: 4, end: 5 } });
    expect(plan.composition.videoBase.some((segment) => segment.clipId === 'clip_top')).toBe(true);
    expect(plan.composition.audioMix.some((segment) => segment.clipId === 'clip_music' && segment.source === 'audio-track')).toBe(true);
    expect(plan.composition.audioMix.some((segment) => segment.clipId === 'clip_top')).toBe(false);
  });

  it('constructs ffmpeg filters for silence, audio insert, structural audio, and gaps without spawning', () => {
    const gappy = manifest([op('op_mute_001', 'mute', 1, 2), op('op_voice_001', 'voice_patch', 4, 5)]);
    gappy.tracks[0]!.clips[0]!.timelineStart = 2;
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(gappy), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    expect(command.args).toContain('/tmp/etv3/renders/draft.mp4');
    expect(filter).toContain('color=c=black');
    expect(filter).toContain("volume=enable='between(t,3.000000,4.000000)':volume=0");
    expect(filter).toContain("volume=enable='between(t,6.000000,7.000000)':volume=0");
    // adelay kept (asetpts shift dropped the asset from amix); precision tightened
    // from integer-ms to sub-ms via adelayMs() — 6.0s → "6000.000000".
    expect(filter).toContain('adelay=6000.000000|6000.000000');
    expect(filter).toContain('amix=inputs=');
  });

  it('final amix uses normalize=0 so voice_patch audio plays at full volume (replace, not overlay)', () => {
    // Regression guard for the "I can't hear the patched audio" bug: amix default normalize=1
    // halves the patch signal even when the base under it is silenced, producing ~-6 dB
    // attenuation. We need normalize=0 on the FINAL mix (the one that combines stagebase + the
    // additive patch streams) while keeping the STRUCTURAL amix on default normalize=1 so
    // multiple structural audio sources stay balanced.
    const gappy = manifest([op('op_voice_001', 'voice_patch', 4, 5)]);
    gappy.tracks[0]!.clips[0]!.timelineStart = 2;
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(gappy), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    // Final mix label is [a_stage]; assert it has normalize=0 and the defensive limiter.
    expect(filter).toMatch(/amix=inputs=\d+:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0\.97\[a_stage\]/);
    // Structural amix (if present) feeds [premix] and must NOT carry normalize=0 — it's the
    // "balance multiple structural audio sources" mix, not the "replace base with patch" mix.
    if (filter.includes('[premix]')) {
      expect(filter).not.toMatch(/amix=inputs=\d+:duration=first:dropout_transition=0:normalize=0\[premix\]/);
    }
  });

  it('uses silence for detached base-video embedded audio slots', () => {
    const detached = manifest();
    detached.tracks[0]!.clips[0]!.audioDetached = true;
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(detached), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('anullsrc=channel_layout=stereo:sample_rate=48000:d=3.000000[a0]');
    expect(filter).not.toContain('[0:a]atrim=start=2.000000:end=5.000000');
  });

  it('normalizes mixed-resolution clip segments before concat', () => {
    const mixed = manifest();
    const topAsset = mixed.assets.find((asset) => asset.assetId === 'asset_video_002');
    if (topAsset?.kind === 'video') topAsset.video = { width: 640, height: 360, fps: 30 };

    const plan = buildRenderPlanV3(mixed);
    const command = buildFfmpegCommandV3('/tmp/etv3', plan, 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    const normalizeChain = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1';

    expect(filter.split(normalizeChain).length - 1).toBe(plan.composition.videoBase.length);
    expect(filter).toContain(`trim=start=2.000000:end=5.000000,setpts=PTS-STARTPTS,${normalizeChain}[v0]`);
    expect(filter).toContain(`trim=start=0.000000:end=4.000000,setpts=PTS-STARTPTS,${normalizeChain}[v1]`);
  });

  it('exposes concrete Chunk-4 stage handlers', () => {
    expect(renderStageHandlersV3.audioBed).toBeTypeOf('function');
    expect(renderStageHandlersV3.visualOverlay).toBeTypeOf('function');
    expect(renderStageHandlersV3.transition).toBeTypeOf('function');
    expect(renderStageHandlersV3.captionBurn).toBeTypeOf('function');
  });

  it('audio-insert atrim uses durationGeneratedSec when it exceeds the requested window', () => {
    const m = manifest([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.5 })]);
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('atrim=0:1.500000');
    expect(filter).not.toContain('atrim=0:1.000000');
  });

  it('audio-insert plays generated duration and mutes the full original slot for shorter patches', () => {
    // Phase-1 rule (2026-05-25): the slot duration is preserved. The asset plays only
    // its own duration, but the base audio is muted for the FULL original slot so the
    // slack tail does not leak source-speaker audio.
    const m = manifest([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 0.4 })]);
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    // Asset plays only its own duration:
    expect(filter).toContain('atrim=0:0.400000');
    // Base audio muted for the FULL original slot, not just the asset playback window:
    expect(filter).toContain("volume=enable='between(t,4.000000,5.000000)':volume=0");
    expect(filter).not.toContain("volume=enable='between(t,4.000000,4.400000)':volume=0");
  });

  it('renderContribution emits audio-insert with full slot range and playSec=assetDuration (Test-Emo regression)', () => {
    // Regression pin for the Test-Emo rush bug (2026-05-25). The shorter "Hello" patch
    // on [1.100, 1.419] must keep the slot intact and carry playSec=0.255833 so the
    // pipeline trims the asset to its own duration without shrinking the slot.
    const m = manifest([op('op_voice_001', 'voice_patch', 1.100, 1.419, { durationGeneratedSec: 0.255833 })]);
    const projectedMap = composeTimeMap(m.tracks, m.operations);
    const stage = voicePatchOperationKind.renderContribution!(m.operations[0]!, { manifest: m, timeMap: projectedMap });

    expect(stage).toMatchObject({
      kind: 'audio-insert',
      range: { start: 1.100, end: 1.419 },
      playSec: 0.255833,
    });
  });

  it('pipeline emits full-slot base-mute for Test-Emo numbers', () => {
    const m = manifest([op('op_voice_001', 'voice_patch', 1.100, 1.419, { durationGeneratedSec: 0.255833 })]);
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    // 0.255833 rounded to microsecond precision (Test-Emo gen duration).
    expect(filter).toContain('atrim=0:0.255833');
    expect(filter).toContain("volume=enable='between(t,1.100000,1.419000)':volume=0");
    expect(filter).not.toContain("volume=enable='between(t,1.100000,1.355833)':volume=0");
  });

  it('audio-insert filter contains adaptive afade=t=in for typical-length patches', () => {
    // Adaptive fade cap (2026-05-25): xf = min(requestedFade, duration/10, 0.02).
    // For a 1.0s patch with requestedFade=0.05 → xf = min(0.05, 0.1, 0.02) = 0.020.
    const m = manifest([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.0 })]);
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('afade=t=in:st=0:d=0.020');
  });

  it('audio-insert filter contains afade=t=out when duration > 2×crossfadeSec', () => {
    const m = manifest([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.0 })]);
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('afade=t=out:');
  });

  it('audio-insert filter omits afade when crossfadeSec is absent', () => {
    const filters: string[] = [];
    const mixInputs: string[] = [];
    renderStageHandlersV3.audioInsert({ kind: 'audio-insert', asset: 'a.wav', range: { start: 2, end: 3 } }, 1, filters, mixInputs);
    expect(filters[0]).not.toContain('afade');
    expect(filters[0]).toContain('atrim=0:1.000000');
  });

  // ─── W5 seam-bake double-fade guard ────────────────────────────────────────

  it('seamBaked:true → renderContribution emits crossfadeSec:0 (double-fade guard)', () => {
    // When the seam is already baked into the WAV with equal-power qsin crossfades,
    // renderContribution must emit crossfadeSec:0 so the pipeline does NOT apply
    // another adaptive afade on top — two fades produce an audible dip.
    const m = manifest([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.0, seamBaked: true })]);
    const timeMap = composeTimeMap(m.tracks, m.operations);
    const stage = voicePatchOperationKind.renderContribution!(m.operations[0]!, { manifest: m, timeMap });
    expect(stage).not.toBeNull();
    expect(stage && 'crossfadeSec' in stage && stage.crossfadeSec).toBe(0);
  });

  it('seamBaked:true → filter graph contains NO afade on the audio-insert line', () => {
    const m = manifest([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.0, seamBaked: true })]);
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    // The audio-insert line with the patch asset should contain NO afade
    // (crossfadeSec:0 → xf=0 → no afade emitted by pipeline)
    const lines = filter.split(';');
    const insertLine = lines.find((l) => l.includes('adelay=4000.000000'));
    expect(insertLine).toBeDefined();
    expect(insertLine).not.toMatch(/afade=t=(in|out)/);
  });

  it('seamBaked absent/false → still emits crossfadeSec:0.05 and afade (regression pin)', () => {
    // Non-baked ops keep the existing adaptive afade behavior.
    const m = manifest([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.0 })]);
    const timeMap = composeTimeMap(m.tracks, m.operations);
    const stage = voicePatchOperationKind.renderContribution!(m.operations[0]!, { manifest: m, timeMap });
    expect(stage).not.toBeNull();
    expect(stage && 'crossfadeSec' in stage && stage.crossfadeSec).toBe(0.05);
    // The filter for a non-baked op still carries afade
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('afade=t=in:st=0:d=0.020');
  });

  it('audio-insert adaptive fade emits fade-out on short patches once xf is capped', () => {
    // Pre-2026-05-25: fixed 50ms crossfade on an 80ms clip → xf=0.05, duration ≤ 2×xf → no fade-out.
    // Adaptive cap (2026-05-25): xf = min(0.05, 0.08/10, 0.02) = 0.008. duration (0.08) > 2×xf (0.016),
    // so fade-out NOW emits. The original "omit fade-out when patch shorter than 2×crossfadeSec"
    // guard still exists in the audioInsert handler, but the adaptive cap makes it rarely trigger.
    const filters: string[] = [];
    const mixInputs: string[] = [];
    renderStageHandlersV3.audioInsert({ kind: 'audio-insert', asset: 'a.wav', range: { start: 0, end: 0.08 }, crossfadeSec: 0.05 }, 0, filters, mixInputs);
    expect(filters[0]).toContain('afade=t=in:st=0:d=0.008');
    expect(filters[0]).toContain('afade=t=out:');
  });

  it('silence extends to cover full play duration so base audio does not bleed past the patch window', () => {
    // Regression guard for Codex P1 (2026-05-23): when playSec > requestedDuration the
    // base audio must be muted through the full patch play window [start, start+playSec].
    // Muting only [start, end] leaves the anchor clip's base audio unsilenced during the
    // extended tail and both streams sum in the final amix.
    const m = manifest([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.5 })]);
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain("volume=enable='between(t,4.000000,5.500000)':volume=0");
    expect(filter).not.toContain("volume=enable='between(t,4.000000,5.000000)':volume=0");
  });

  it('emits freeze-frame video and silence stages for voice_patch overflow bands', () => {
    const plan = buildRenderPlanV3(manifest([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.5 })]));

    // sourceTime is the segment-end boundary in asset time; the pipeline converts it to a
    // trim that captures frames STRICTLY BEFORE this point (see plan.ts comment + pipeline.ts).
    // sourceFps comes from asset.video.fps so the pipeline can size a single-frame trim window.
    expect(plan.stages).toContainEqual({ kind: 'freeze-frame', asset: 'assets/video/top.mp4', sourceTime: 2, sourceFps: 30, range: { start: 5, end: 5.5 } });
    expect(plan.stages).toContainEqual({ kind: 'silence', range: { start: 5, end: 5.5 } });
  });

  it('builds freeze-frame ffmpeg segments with cloned source frame duration', () => {
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(manifest([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.5 })])), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;

    expect(filter).toContain('tpad=stop_mode=clone:stop_duration=0.500');
    expect(filter).not.toContain('color=c=black:s=1280x720:d=0.500');
  });

  it('emits a freeze-frame stage for the anchor video track on longer patches (single-track project)', () => {
    // Anchor-freeze regression guard (2026-05-25 follow-up). On a project with only the
    // anchor video track, the overflow band MUST be covered by a freeze-frame stage so
    // the rendered mp4 does not fall back to black via pipeline's gap-filler.
    const m = manifest([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.5 })]);
    m.tracks = [m.tracks[0]!]; // only the anchor video track
    const plan = buildRenderPlanV3(m);

    const freezeStages = plan.stages.filter((stage): stage is Extract<typeof plan.stages[number], { kind: 'freeze-frame' }> => stage.kind === 'freeze-frame');
    expect(freezeStages).toHaveLength(1);
    expect(freezeStages[0]).toMatchObject({
      kind: 'freeze-frame',
      asset: 'assets/video/source.mp4',
      range: { start: 5, end: 5.5 }
    });
    // sourceTime is the segment-end boundary: clip.sourceStart(2) + segment.sourceEnd(5).
    expect(freezeStages[0]?.sourceTime).toBeCloseTo(7, 9);
    expect(freezeStages[0]?.sourceFps).toBe(30);
  });

  it('FFmpeg filter graph emits tpad freeze for the anchor video track on a single-track longer patch', () => {
    const m = manifest([op('op_voice_001', 'voice_patch', 4, 5, { durationGeneratedSec: 1.5 })]);
    m.tracks = [m.tracks[0]!]; // only the anchor video track
    const command = buildFfmpegCommandV3('/tmp/etv3', buildRenderPlanV3(m), 'renders/draft.mp4');
    const filter = command.args[command.args.indexOf('-filter_complex') + 1]!;

    // The anchor track's last frame (source time 7s) is held for the 0.5s overflow band.
    expect(filter).toContain('tpad=stop_mode=clone:stop_duration=0.500');
    // Trim end == sourceTime and start is one frame period earlier; both truncated to
    // microseconds so toFixed(3) rounding cannot cross the boundary (Codex P2 2026-05-25).
    expect(filter).toContain('trim=start=6.966666:end=7.000000');
    // And critically — NO black-fill in the overflow band.
    expect(filter).not.toContain('color=c=black:s=1280x720:d=0.500');
  });
});

describe('v3 caption and edited-script projection', () => {
  it('projects captions and voice patch text through the final TimeMap', () => {
    const m = manifest([op('op_cut_001', 'cut', 2, 4), op('op_voice_001', 'voice_patch', 5, 6)]);
    const timeMap = buildRenderPlanV3(m).timeMap;
    const cues = projectCaptionsV3(m, transcript, timeMap);
    expect(cues.map((cue) => cue.text)).toContain('hello');
    expect(cues.map((cue) => cue.text)).toContain('patched line');
    expect(cues.some((cue) => cue.text === 'cut')).toBe(false);
    expect(captionsToSrtV3(cues)).toContain('00:00:00,200 --> 00:00:00,600');
  });

  it('derives edited script from TimeMap and registry view hooks', () => {
    const m = manifest([op('op_cut_001', 'cut', 2, 4), op('op_mute_001', 'mute', 5, 6), op('op_voice_001', 'voice_patch', 5, 6)]);
    const edited = deriveEditedScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);
    expect(edited.hiddenWordIds).toContain('w2');
    expect(edited.plainText).toContain('[Cut');
    expect(edited.plainText).toContain('patched line');
  });

  // PREVIEW projection (Item 3 of 2026-05-24 post-ripple UX handoff) — what the user will
  // hear when the rendered draft plays. Cleaner than the edited view: no operation markers,
  // voice patches inlined as their replacement text.
  it('drops cut words entirely from the preview projection', () => {
    const m = manifest([op('op_cut_001', 'cut', 2, 4)]);
    const preview = derivePreviewScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);
    expect(preview.tokens.some((token) => token.type === 'word' && token.word.id === 'w2')).toBe(false);
    expect(preview.plainText).not.toContain('cut');
    // Surviving words remain as plain word tokens with no operation_marker noise.
    expect(preview.tokens.every((token) => token.type === 'word' || token.type === 'replacement')).toBe(true);
    expect(preview.plainText).toContain('hello');
    expect(preview.plainText).toContain('muted');
  });

  it('keeps muted words visible but flagged for the preview UI', () => {
    const m = manifest([op('op_mute_001', 'mute', 5, 6)]);
    const preview = derivePreviewScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);
    const mutedToken = preview.tokens.find((token) => token.type === 'word' && token.word.id === 'w3');
    expect(mutedToken).toBeTruthy();
    expect(mutedToken && mutedToken.type === 'word' && mutedToken.muted).toBe(true);
    expect(mutedToken && mutedToken.type === 'word' && mutedToken.operationIds).toContain('op_mute_001');
    // The word is still in plainText — preview shows the picture even though audio is gone.
    expect(preview.plainText).toContain('muted');
  });

  it('inlines voice_patch replacement text and marks it as re-recorded', () => {
    const m = manifest([op('op_voice_001', 'voice_patch', 5, 6)]);
    const preview = derivePreviewScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);
    const replacement = preview.tokens.find((token) => token.type === 'replacement');
    expect(replacement).toBeTruthy();
    expect(replacement && replacement.type === 'replacement' && replacement.text).toBe('patched line');
    expect(replacement && replacement.type === 'replacement' && replacement.isReRecorded).toBe(true);
    expect(replacement && replacement.type === 'replacement' && replacement.opType).toBe('voice_patch');
    expect(replacement && replacement.type === 'replacement' && replacement.replacedWordIds).toContain('w3');
    expect(preview.plainText).toContain('patched line');
    // The original word ("muted") is replaced — its text should NOT appear in the preview.
    expect(preview.plainText).not.toContain('muted');
  });

  it('combines cut + mute + voice_patch into a clean inline projection', () => {
    const m = manifest([op('op_cut_001', 'cut', 2, 4), op('op_mute_001', 'mute', 5, 6), op('op_voice_001', 'voice_patch', 5, 6)]);
    const preview = derivePreviewScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);
    // The cut word is gone; the voice patch wins over the mute (overlapping range, voice_patch
    // has the replacement text). Plain text: "hello" + "patched line".
    expect(preview.plainText).toBe('hello patched line');
    expect(preview.tokens.some((t) => t.type === 'word' && t.word.id === 'w2')).toBe(false);
  });

  // Codex P2-1: a voice_patch on clip A should NOT consume words from clip B even when the
  // source-time ranges overlap. Multi-clip projects (e.g. recorded take + screen recording)
  // have independent clips that share source-time ranges; matching purely by time would fold
  // an op on one clip onto the other's transcript.
  it('scopes clip-span operations to their target clip in the preview projection', () => {
    const multiClipTranscript: TranscriptWords = {
      ...transcript,
      words: [
        { id: 'w_a1', text: 'alpha', normalized: 'alpha', start: 5.2, end: 5.6, speaker: 'speaker_1', confidence: 1, segmentId: 's1', clipId: 'clip_001' },
        // Same source-time range as the op, but on a DIFFERENT clip. Must NOT be replaced.
        { id: 'w_b1', text: 'bravo', normalized: 'bravo', start: 0.2, end: 0.6, speaker: 'speaker_2', confidence: 1, segmentId: 's1', clipId: 'clip_top' }
      ],
      segments: [{ id: 's1', speaker: 'speaker_1', start: 0, end: 6, text: 'alpha bravo' }]
    };
    const m = manifest([op('op_voice_001', 'voice_patch', 5, 6)]); // targets clip_001
    const preview = derivePreviewScriptFromTimeMapV3(multiClipTranscript, m, buildRenderPlanV3(m).timeMap);
    // alpha (clip_001) is replaced; bravo (clip_top) survives untouched.
    expect(preview.plainText).toContain('patched line');
    expect(preview.plainText).toContain('bravo');
    expect(preview.plainText).not.toContain('alpha');
  });

  // Codex P2-2 (2026-05-24): two target-clip words wrapped around an interleaved foreign-clip
  // word must (a) emit the replacement only once, (b) keep the foreign word visible, and
  // (c) not silently skip past the foreign word.
  it('emits a replacement only once across interleaved foreign-clip words', () => {
    const interleavedTranscript: TranscriptWords = {
      ...transcript,
      words: [
        { id: 'w_a1', text: 'alpha', normalized: 'alpha', start: 5.05, end: 5.45, speaker: 'speaker_1', confidence: 1, segmentId: 's1', clipId: 'clip_001' },
        { id: 'w_b1', text: 'bravo', normalized: 'bravo', start: 0.20, end: 0.60, speaker: 'speaker_2', confidence: 1, segmentId: 's1', clipId: 'clip_top' },
        { id: 'w_a2', text: 'gamma', normalized: 'gamma', start: 5.55, end: 5.95, speaker: 'speaker_1', confidence: 1, segmentId: 's1', clipId: 'clip_001' }
      ],
      segments: [{ id: 's1', speaker: 'speaker_1', start: 0, end: 6, text: 'alpha bravo gamma' }]
    };
    const m = manifest([op('op_voice_001', 'voice_patch', 5, 6)]); // targets clip_001 only
    const preview = derivePreviewScriptFromTimeMapV3(interleavedTranscript, m, buildRenderPlanV3(m).timeMap);
    const replacementCount = preview.tokens.filter((t) => t.type === 'replacement' && t.operationId === 'op_voice_001').length;
    expect(replacementCount).toBe(1);
    expect(preview.plainText).toContain('bravo');
    expect(preview.plainText).toContain('patched line');
    // Neither target-clip word leaks through:
    expect(preview.plainText).not.toContain('alpha');
    expect(preview.plainText).not.toContain('gamma');
  });

  // Codex P2 pass 5 (2026-05-24): transcript_amend is display-only — affectsTimeline=false,
  // excluded from caption/render projection. The rendered audio still speaks the original
  // words; the amendment only updates the on-screen transcript record. PREVIEW must NOT
  // inline the amended text as if it were rendered speech.
  it('does not inline transcript_amend in the render-shaped preview', () => {
    const m = manifest([
      { id: 'op_amend_001', type: 'transcript_amend', status: 'approved', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 5, end: 6 }, proposedBy: 'agent', createdBy: 'user', createdAt: now, text: 'corrected words' }
    ] as ManifestV3['operations']);
    const preview = derivePreviewScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);
    // Render still speaks "muted" (the original word). Preview must NOT show "corrected
    // words" as if the render said it.
    expect(preview.plainText).not.toContain('corrected words');
    expect(preview.plainText).toContain('muted');
  });

  // 2026-05-24 evening — policy flipped per user feedback. Preview is the EDITING surface,
  // not a passive projection of rendered output. When a mute carries a draftText (the
  // type-over flow), the user needs to SEE what they typed; otherwise typing into a
  // selection looks like nothing happened (the word just goes faded, draftText invisible).
  // Render still silences the source audio until Generate runs — that's a Render concern,
  // not an editing-surface concern. The replacement token carries opType: 'mute' and
  // isReRecorded: false so the UI can mark it as "proposed / not yet generated", distinct
  // from voice_patch's "already-rendered" treatment.
  it('promotes mute draftText to a proposed replacement in preview (editing-surface intent)', () => {
    const m = manifest([
      { id: 'op_mute_draft', type: 'mute', status: 'approved', target: { kind: 'clip-span', trackId: 'track_video_001', clipId: 'clip_001', start: 5, end: 6 }, proposedBy: 'agent', createdBy: 'user', createdAt: now, draftText: 'planned re-record' }
    ] as ManifestV3['operations']);
    const preview = derivePreviewScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);
    expect(preview.plainText).toContain('planned re-record');
    const replacement = preview.tokens.find((t) => t.type === 'replacement' && t.operationId === 'op_mute_draft');
    expect(replacement && replacement.type === 'replacement' && replacement.opType).toBe('mute');
    expect(replacement && replacement.type === 'replacement' && replacement.isReRecorded).toBe(false);
    // The underlying source word disappears from the token list — the replacement stands in.
    const mutedSourceToken = preview.tokens.find((t) => t.type === 'word' && t.word.id === 'w3');
    expect(mutedSourceToken).toBeUndefined();
  });

  // Codex P2-4 (2026-05-24): single-clip transcripts default word.clipId to empty string
  // (schema default). The clipId filter must fall back to the project's default clip so
  // preview-mode still inlines voice patches and marks mutes on existing projects.
  it('treats empty word.clipId as the default clip for preview op matching', () => {
    const emptyClipTranscript: TranscriptWords = {
      ...transcript,
      words: [
        { id: 'wx1', text: 'hello', normalized: 'hello', start: 0.2, end: 0.6, speaker: 'speaker_1', confidence: 1, segmentId: 's1', clipId: '' },
        { id: 'wx2', text: 'muted', normalized: 'muted', start: 5.2, end: 5.6, speaker: 'speaker_1', confidence: 1, segmentId: 's1', clipId: '' }
      ],
      segments: [{ id: 's1', speaker: 'speaker_1', start: 0, end: 6, text: 'hello muted' }]
    };
    const m = manifest([op('op_voice_001', 'voice_patch', 5, 6)]);
    const preview = derivePreviewScriptFromTimeMapV3(emptyClipTranscript, m, buildRenderPlanV3(m).timeMap);
    // The voice_patch must still inline despite word.clipId being '' — defaultClipId
    // fallback should kick in.
    expect(preview.plainText).toContain('patched line');
    expect(preview.plainText).not.toContain('muted');
  });

  // Codex P2 pass 7 (2026-05-24): preview tokens must be ordered by rendered output time
  // so multi-clip / rearranged timelines read in playback order. Single-clip projects keep
  // their transcript order (sort is a no-op there).
  it('sorts preview tokens by rendered output time', () => {
    // clip_top sits on top at timeline 3-7s; its words at source 0-4s render at output 3-7s.
    // clip_001 spans output 0-10s. Put words in transcript order that DOESN'T match output
    // order so we can prove the sort runs.
    const reorderedTranscript: TranscriptWords = {
      ...transcript,
      words: [
        { id: 'wt1', text: 'on-top', normalized: 'on-top', start: 0.5, end: 1.0, speaker: 'speaker_2', confidence: 1, segmentId: 's_top', clipId: 'clip_top' },
        { id: 'wb1', text: 'before', normalized: 'before', start: 0.5, end: 1.0, speaker: 'speaker_1', confidence: 1, segmentId: 's_base', clipId: 'clip_001' },
        { id: 'wb2', text: 'after', normalized: 'after', start: 8.5, end: 9.0, speaker: 'speaker_1', confidence: 1, segmentId: 's_base', clipId: 'clip_001' }
      ],
      segments: [
        { id: 's_base', speaker: 'speaker_1', start: 0, end: 10, text: 'before after' },
        { id: 's_top', speaker: 'speaker_2', start: 0, end: 4, text: 'on-top' }
      ]
    };
    const preview = derivePreviewScriptFromTimeMapV3(reorderedTranscript, manifest(), buildRenderPlanV3(manifest()).timeMap);
    const outputStarts = preview.tokens.filter((t): t is Extract<V3PreviewScriptToken, { type: 'word' }> => t.type === 'word').map((t) => t.outputStart);
    expect(outputStarts).toEqual([...outputStarts].sort((a, b) => a - b));
    // Playback order should be: before (output ~0.5s, clip_001) → on-top (output 3.5s, clip_top) → after (output ~8.5s, clip_001).
    const wordTexts = preview.tokens.filter((t): t is Extract<V3PreviewScriptToken, { type: 'word' }> => t.type === 'word').map((t) => t.word.text);
    expect(wordTexts).toEqual(['before', 'on-top', 'after']);
  });

  // Codex P3 (2026-05-24): replacement tokens must carry rendered output positions so the
  // UI can seek to the right spot in the draft. Source timeline positions are wrong after a
  // preceding cut ripples the time map.
  it('projects replacement token output positions through the time map', () => {
    const m = manifest([op('op_cut_001', 'cut', 2, 4), op('op_voice_001', 'voice_patch', 5, 6)]);
    const preview = derivePreviewScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);
    const replacement = preview.tokens.find((t) => t.type === 'replacement');
    expect(replacement).toBeTruthy();
    // The voice_patch replaces w3 (source 5.2–5.6). With a preceding 2s cut, output position
    // of w3 is 5.2-2 = 3.2 (rendered) — not 5.2 (source). The exact value isn't important
    // for this test (renderPlan owns that math) but it MUST be < source position to prove
    // the time-map projection ran.
    expect(replacement && replacement.type === 'replacement' && replacement.outputStart).not.toBe(null);
    expect(replacement && replacement.type === 'replacement' && (replacement.outputStart ?? 0)).toBeLessThan(5.2);
  });

  // ─── G3b inline word marks: speed tagging ─────────────────────────────────

  it('tags words covered by an approved speed op with fx:speed and the factor', () => {
    // Speed op covering w1 (0.2–0.6) and w2 (2.2–2.6) in clip-local time [0, 3) at rate 4.
    const speedOp = {
      id: 'op_speed_001', type: 'speed' as const, status: 'approved' as const,
      target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 0, end: 3 },
      rate: 4 as const, bed: 'pitched' as const,
      proposedBy: 'agent' as const, createdBy: 'user' as const, createdAt: now
    };
    const m = manifest([speedOp]);
    const edited = deriveEditedScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);

    const w1Token = edited.tokens.find((t) => t.type === 'word' && t.word.id === 'w1');
    const w2Token = edited.tokens.find((t) => t.type === 'word' && t.word.id === 'w2');
    const w3Token = edited.tokens.find((t) => t.type === 'word' && t.word.id === 'w3');

    // Both covered words carry fx:speed and the correct factor.
    expect(w1Token?.type === 'word' && w1Token.fx).toBe('speed');
    expect(w1Token?.type === 'word' && w1Token.factor).toBe(4);
    expect(w2Token?.type === 'word' && w2Token.fx).toBe('speed');
    expect(w2Token?.type === 'word' && w2Token.factor).toBe(4);

    // w3 is not covered — no speed tag.
    expect(w3Token?.type === 'word' && w3Token.fx).toBeUndefined();
  });

  it('sets speedLast:true on the last word covered by the speed op', () => {
    // Speed op covers w1 and w2; w2 is the last covered word.
    const speedOp = {
      id: 'op_speed_001', type: 'speed' as const, status: 'approved' as const,
      target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 0, end: 3 },
      rate: 4 as const, bed: 'pitched' as const,
      proposedBy: 'agent' as const, createdBy: 'user' as const, createdAt: now
    };
    const m = manifest([speedOp]);
    const edited = deriveEditedScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);

    const w1Token = edited.tokens.find((t) => t.type === 'word' && t.word.id === 'w1');
    const w2Token = edited.tokens.find((t) => t.type === 'word' && t.word.id === 'w2');

    // Only the last covered word gets speedLast:true.
    expect(w1Token?.type === 'word' && w1Token.speedLast).toBeFalsy();
    expect(w2Token?.type === 'word' && w2Token.speedLast).toBe(true);
  });

  it('sets speedLast:true on a single covered word', () => {
    // Speed op covers only w1.
    const speedOp = {
      id: 'op_speed_001', type: 'speed' as const, status: 'approved' as const,
      target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 0, end: 1 },
      rate: 2 as const, bed: 'silence' as const,
      proposedBy: 'agent' as const, createdBy: 'user' as const, createdAt: now
    };
    const m = manifest([speedOp]);
    const edited = deriveEditedScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);

    const w1Token = edited.tokens.find((t) => t.type === 'word' && t.word.id === 'w1');
    expect(w1Token?.type === 'word' && w1Token.fx).toBe('speed');
    expect(w1Token?.type === 'word' && w1Token.speedLast).toBe(true);
  });

  it('does not set speed tags on words outside the speed op range', () => {
    // Speed op targets only w3 range [5, 6).
    const speedOp = {
      id: 'op_speed_001', type: 'speed' as const, status: 'approved' as const,
      target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 5, end: 6 },
      rate: 4 as const, bed: 'music' as const,
      proposedBy: 'agent' as const, createdBy: 'user' as const, createdAt: now
    };
    const m = manifest([speedOp]);
    const edited = deriveEditedScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);

    const w1Token = edited.tokens.find((t) => t.type === 'word' && t.word.id === 'w1');
    expect(w1Token?.type === 'word' && w1Token.fx).toBeUndefined();
  });

  // ─── G3b inline word marks: proposed tagging ──────────────────────────────

  it('tags words covered by a proposed op with proposed:true', () => {
    // Proposed cut covering w2 (clip-local [2, 3)).
    const proposedCut = {
      id: 'op_cut_prop', type: 'cut' as const, status: 'proposed' as const,
      target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 2, end: 3 },
      proposedBy: 'agent' as const, createdBy: 'agent' as const, createdAt: now
    };
    const m = manifest([proposedCut]);
    const edited = deriveEditedScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);

    const w2Token = edited.tokens.find((t) => t.type === 'word' && t.word.id === 'w2');
    const w1Token = edited.tokens.find((t) => t.type === 'word' && t.word.id === 'w1');

    // w2 is covered by the proposed op.
    expect(w2Token?.type === 'word' && w2Token.proposed).toBe(true);
    // w1 is not covered.
    expect(w1Token?.type === 'word' && w1Token.proposed).toBeUndefined();
  });

  it('tags words covered by an awaiting_approval op with proposed:true', () => {
    const awaitingOp = {
      id: 'op_mute_await', type: 'mute' as const, status: 'awaiting_approval' as const,
      target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 5, end: 6 },
      proposedBy: 'agent' as const, createdBy: 'agent' as const, createdAt: now
    };
    const m = manifest([awaitingOp]);
    const edited = deriveEditedScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);

    const w3Token = edited.tokens.find((t) => t.type === 'word' && t.word.id === 'w3');
    expect(w3Token?.type === 'word' && w3Token.proposed).toBe(true);
  });

  it('does not tag words as proposed when the op is approved (approved ops affect timeline, not proposed mark)', () => {
    // An approved mute should set muted:true, not proposed:true.
    const approvedMute = op('op_mute_001', 'mute', 5, 6);
    const m = manifest([approvedMute]);
    const edited = deriveEditedScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);

    const w3Token = edited.tokens.find((t) => t.type === 'word' && t.word.id === 'w3');
    expect(w3Token?.type === 'word' && w3Token.muted).toBe(true);
    expect(w3Token?.type === 'word' && w3Token.proposed).toBeUndefined();
  });

  it('existing tokens retain backward-compatible shape when no speed or proposed ops are present', () => {
    // Regression guard: plain cut + mute scenario must not gain unexpected fields.
    const m = manifest([op('op_cut_001', 'cut', 2, 4), op('op_mute_001', 'mute', 5, 6)]);
    const edited = deriveEditedScriptFromTimeMapV3(transcript, m, buildRenderPlanV3(m).timeMap);

    const w1Token = edited.tokens.find((t) => t.type === 'word' && t.word.id === 'w1');
    expect(w1Token?.type === 'word' && w1Token.fx).toBeUndefined();
    expect(w1Token?.type === 'word' && w1Token.proposed).toBeUndefined();
    // Cut word is hidden, not in tokens.
    expect(edited.hiddenWordIds).toContain('w2');
    // Muted word is still a word token.
    const w3Token = edited.tokens.find((t) => t.type === 'word' && t.word.id === 'w3');
    expect(w3Token?.type === 'word' && w3Token.muted).toBe(true);
    expect(w3Token?.type === 'word' && w3Token.fx).toBeUndefined();
  });
});
