import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { assertInside } from '../filesystem';
import { captionsToSrt } from '../captions/project';
import type { RenderStage } from './types';
import type { V3RenderPlan } from './plan';

export type ProgressEvent = { clipId?: string; phase: 'encode'; percent: number };
export type V3RenderPipelineOptions = { output?: string; overwrite?: boolean; onProgress?: (event: ProgressEvent) => void; dryRun?: boolean };
export type FfmpegCommand = { command: 'ffmpeg'; args: string[]; cwd: string };

export function assertRenderOutputPathV3(workspacePath: string, outputRel: string): string {
  if (outputRel.startsWith('/') || outputRel.includes('..')) throw new Error('Render output must be a workspace-relative path under renders/');
  if (!outputRel.startsWith('renders/')) throw new Error('Render output must stay under renders/ to preserve source media');
  return assertInside(workspacePath, outputRel);
}

export function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return { stdout: result.stdout, stderr: result.stderr, command: `${command} ${args.map((arg) => JSON.stringify(arg)).join(' ')}` };
}

export function runFfmpegProgress(args: string[], cwd: string, plan: V3RenderPlan, onProgress?: (event: ProgressEvent) => void): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffmpeg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let current: Record<string, string> = {};
    let settled = false;
    const abort = (error: unknown) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore kill failures */ }
      reject(error);
    };
    const emit = () => {
      if (!onProgress) return;
      const us = Number(current.out_time_us ?? current.out_time_ms ?? '0');
      const outTime = Number.isFinite(us) ? us / 1_000_000 : 0;
      const total = Math.max(plan.outputDurationSec, 0.001);
      const percent = Math.max(0, Math.min(100, (outTime / total) * 100));
      const segment = plan.composition.videoBase.find((candidate) => outTime >= candidate.outputStart && outTime <= candidate.outputEnd);
      onProgress({ clipId: segment?.clipId, phase: 'encode', percent });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [key, ...rest] = line.split('=');
        current[key!] = rest.join('=');
        if (key === 'progress') {
          try {
            emit();
          } catch (error) {
            abort(error);
            return;
          }
          current = {};
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', abort);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      code === 0 ? resolvePromise() : reject(new Error(`ffmpeg failed: ${stderr}`));
    });
  });
}

function sec(value: number): string { return value.toFixed(3); }
// Microsecond formatters for ffmpeg trim/atrim/silence/duration/enable timings that
// must not round across segment edges and where millisecond granularity accumulates
// drift (Hermes P1, 2026-05-26). `sec()` (3-decimal) is retained ONLY for visual
// geometry (drawtext/drawbox/overlay x/y/w/h pixel coordinates).
function roundSec6(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Invalid ffmpeg timestamp: ${value}`);
  return (Math.round(value * 1_000_000) / 1_000_000).toFixed(6);
}
// Floor variant for boundary-EXCLUSIVE timings — specifically the freeze-frame trim
// end where rounding-up could cross the segment boundary and include the first frame
// of the NEXT segment. Renamed from `truncMicro` (Hermes P2, 2026-05-26).
function floorSec6(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Invalid ffmpeg timestamp: ${value}`);
  return (Math.floor(value * 1_000_000) / 1_000_000).toFixed(6);
}
// Sub-ms-precision `adelay` argument. ffmpeg's adelay accepts float milliseconds
// (e.g., `adelay=4000.123456|4000.123456` shifts by 4.000123 seconds). FFmpeg
// truncates/floors to an integer sample (verified against FFmpeg 8.0.1: 0.7 ms @
// 48 kHz → first sample at index 33, not 34); error < one sample (~21 µs at 48 kHz).
// Replaces the prior integer-ms rounding (`Math.round(seconds * 1000)`) which lost
// sub-ms precision entirely. The asetpts alternative (Hermes v4 P2 candidate) was
// reverted in the Wave 1 implementation pass after the voice-patch-longer-render
// integration test confirmed that amix does NOT honor PTS gaps the way adelay's
// pre-padded-silence form does (asset stream got dropped from the mix entirely).
// Sub-ms-float adelay is the pragmatic fix that preserves the silence-insertion
// contract amix expects. If exact-sample placement is ever needed, use `adelay`'s
// `S` suffix with an explicitly computed sample count instead.
function adelayMs(seconds: number): string {
  return (Math.max(seconds, 0) * 1000).toFixed(6);
}
// Predicates for the smart-fade gate (Hermes P1, 2026-05-26). They identify base-concat
// source-time discontinuities caused by ripple `cut` operations on the SAME clip+track:
// composeTimeMap splits a clip into multiple time-map segments only when a cut removes a
// source range, so two adjacent same-clip same-track segments whose source ends/starts
// don't meet IS a cut boundary by construction. Voice_patch boundaries are NOT in
// videoBase (longer voice_patch inserts a freeze STAGE; shorter leaves the time-map
// unchanged) and are handled by the audio-insert crossfade + base-mute window elsewhere.
function sameTrackClip(
  a: V3RenderPlan['composition']['videoBase'][number],
  b: V3RenderPlan['composition']['videoBase'][number]
): boolean {
  return a.trackId === b.trackId && a.clipId === b.clipId;
}
function hasCutSourceJumpBefore(plan: V3RenderPlan, segment: V3RenderPlan['composition']['videoBase'][number]): boolean {
  return plan.composition.videoBase.some((candidate) =>
    sameTrackClip(candidate, segment) &&
    Math.abs(candidate.outputEnd - segment.outputStart) < 1e-6 &&
    Math.abs(candidate.sourceEnd - segment.sourceStart) > 1e-6
  );
}
function hasCutSourceJumpAfter(plan: V3RenderPlan, segment: V3RenderPlan['composition']['videoBase'][number]): boolean {
  return plan.composition.videoBase.some((candidate) =>
    sameTrackClip(segment, candidate) &&
    Math.abs(segment.outputEnd - candidate.outputStart) < 1e-6 &&
    Math.abs(segment.sourceEnd - candidate.sourceStart) > 1e-6
  );
}
function escDrawtext(value: string): string { return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/\n/g, ' '); }
function escFilterPath(value: string): string { return value.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'"); }

function parseResolution(value: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function atempoChain(rate: number): string {
  const parts: string[] = [];
  let remaining = rate;
  while (remaining > 2.0001) { parts.push('atempo=2'); remaining /= 2; }
  while (remaining < 0.4999) { parts.push('atempo=0.5'); remaining *= 2; }
  parts.push(`atempo=${remaining.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`);
  return parts.join(',');
}

export const stageHandlers = {
  silence(stage: Extract<RenderStage, { kind: 'silence' }>, filters: string[]) {
    filters.push(`volume=enable='between(t,${roundSec6(stage.range.start)},${roundSec6(stage.range.end)})':volume=0`);
  },
  audioInsert(stage: Extract<RenderStage, { kind: 'audio-insert' }>, index: number, filters: string[], mixInputs: string[]) {
    const requestedDuration = stage.range.end - stage.range.start;
    const duration = Math.max(stage.playSec ?? requestedDuration, 0.01);
    // Adaptive fade cap (2026-05-25): a fixed 50 ms fade on a 256 ms voice clip
    // is ~40 % of the audio in ramps. Cap fades at 1/10th the clip duration or
    // 20 ms, whichever is smaller. Pre-cap behavior was hard-coded `0.05` and
    // produced clipped/soft short-word patches.
    const requestedFade = stage.crossfadeSec ?? 0;
    const xf = Math.min(requestedFade, duration / 10, 0.02);
    const fadeIn = xf > 0 ? `afade=t=in:st=0:d=${roundSec6(xf)},` : '';
    const fadeOut = xf > 0 && duration > xf * 2 ? `,afade=t=out:st=${roundSec6(duration - xf)}:d=${roundSec6(xf)}` : '';
    // Sub-ms-precision adelay (was integer-ms `Math.round`). asetpts+amix dropped the
    // stream — adelay's pre-padded silence is the contract amix expects.
    const delay = adelayMs(stage.range.start);
    filters.push(`[${index}:a]${fadeIn}atrim=0:${roundSec6(duration)},asetpts=PTS-STARTPTS${fadeOut},adelay=${delay}|${delay}[ai${index}]`);
    mixInputs.push(`[ai${index}]`);
  },
  audioBed(stage: Extract<RenderStage, { kind: 'audio-bed' }>, filters: string[], mixInputs: string[], plan: V3RenderPlan, inputPaths: string[], labelSeed: number) {
    if (stage.bed === 'silence') return labelSeed;
    const duration = Math.max(stage.range.end - stage.range.start, 0.01);
    const label = `ab${labelSeed}`;
    const delay = adelayMs(stage.range.start);
    if (stage.bed === 'music') {
      filters.push(`sine=frequency=220:sample_rate=48000:d=${roundSec6(duration)},volume=0.08,adelay=${delay}|${delay}[${label}]`);
      mixInputs.push(`[${label}]`);
      return labelSeed + 1;
    }
    const segment = [...plan.composition.audioMix]
      .filter((candidate) => candidate.outputStart <= stage.range.start + 1e-6 && candidate.outputEnd >= stage.range.end - 1e-6)
      .sort((a, b) => b.rate - a.rate || a.outputStart - b.outputStart)[0];
    if (!segment) {
      filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000:d=${roundSec6(duration)},adelay=${delay}|${delay}[${label}]`);
      mixInputs.push(`[${label}]`);
      return labelSeed + 1;
    }
    const inputIndex = inputPaths.indexOf(segment.asset.path);
    const sourceStart = segment.clip.sourceStart + segment.sourceStart + ((stage.range.start - segment.outputStart) * segment.rate);
    const sourceEnd = segment.clip.sourceStart + segment.sourceStart + ((stage.range.end - segment.outputStart) * segment.rate);
    const tempo = Math.max((sourceEnd - sourceStart) / duration, 0.01);
    filters.push(`[${inputIndex}:a]atrim=start=${roundSec6(sourceStart)}:end=${roundSec6(sourceEnd)},asetpts=PTS-STARTPTS,${atempoChain(tempo)},atrim=0:${roundSec6(duration)},adelay=${delay}|${delay}[${label}]`);
    mixInputs.push(`[${label}]`);
    return labelSeed + 1;
  },
  visualOverlay(stage: Extract<RenderStage, { kind: 'visual-overlay' }>, currentVideo: string, filters: string[], inputPaths: string[], labelSeed: number) {
    const label = `vo${labelSeed}`;
    const enable = `between(t,${roundSec6(stage.range.start)},${roundSec6(stage.range.end)})`;
    if (stage.source.kind === 'text') {
      filters.push(`${currentVideo}drawtext=text='${escDrawtext(stage.source.text)}':x=${sec(stage.rect.x)}:y=${sec(stage.rect.y)}:fontsize=${Math.max(stage.rect.height, 12).toFixed(0)}:fontcolor=white@${stage.opacity}:box=1:boxcolor=black@0.35:enable='${enable}'[${label}]`);
    } else if (stage.source.kind === 'shape') {
      filters.push(`${currentVideo}drawbox=x=${sec(stage.rect.x)}:y=${sec(stage.rect.y)}:w=${sec(stage.rect.width)}:h=${sec(stage.rect.height)}:color=white@${stage.opacity}:t=fill:enable='${enable}'[${label}]`);
    } else {
      const inputIndex = inputPaths.indexOf(stage.source.asset);
      filters.push(`[${inputIndex}:v]scale=${Math.max(stage.rect.width, 1).toFixed(0)}:${Math.max(stage.rect.height, 1).toFixed(0)},format=rgba,colorchannelmixer=aa=${stage.opacity}[ov${labelSeed}]`);
      filters.push(`${currentVideo}[ov${labelSeed}]overlay=x=${sec(stage.rect.x)}:y=${sec(stage.rect.y)}:enable='${enable}'[${label}]`);
    }
    return { label: `[${label}]`, nextSeed: labelSeed + 1 };
  },
  transition(stage: Extract<RenderStage, { kind: 'transition' }>, currentVideo: string, currentAudio: string, filters: string[], labelSeed: number) {
    const duration = Math.max(stage.durationMs / 1000, 0.001);
    const start = Math.max(stage.boundary - duration / 2, 0);
    const vLabel = `trv${labelSeed}`;
    const aLabel = `tra${labelSeed}`;
    if (stage.transitionType === 'crossfade' || stage.transitionType === 'fade') {
      filters.push(`${currentVideo}fade=t=out:st=${roundSec6(start)}:d=${roundSec6(duration / 2)},fade=t=in:st=${roundSec6(stage.boundary)}:d=${roundSec6(duration / 2)}[${vLabel}]`);
      filters.push(`${currentAudio}afade=t=out:st=${roundSec6(start)}:d=${roundSec6(duration / 2)},afade=t=in:st=${roundSec6(stage.boundary)}:d=${roundSec6(duration / 2)}[${aLabel}]`);
    } else {
      filters.push(`${currentVideo}fade=t=out:st=${roundSec6(start)}:d=${roundSec6(duration / 2)}:color=black,fade=t=in:st=${roundSec6(stage.boundary)}:d=${roundSec6(duration / 2)}[${vLabel}]`);
      filters.push(`${currentAudio}afade=t=out:st=${roundSec6(start)}:d=${roundSec6(duration / 2)},afade=t=in:st=${roundSec6(stage.boundary)}:d=${roundSec6(duration / 2)}[${aLabel}]`);
    }
    return { video: `[${vLabel}]`, audio: `[${aLabel}]`, nextSeed: labelSeed + 1 };
  },
  captionBurn(stage: Extract<RenderStage, { kind: 'caption-burn' }>, currentVideo: string, filters: string[], workspace: string, plan: V3RenderPlan, labelSeed: number) {
    const label = `cap${labelSeed}`;
    const subtitleRel = `temp/render/captions-${stage.styleId.replace(/[^a-zA-Z0-9_-]/g, '_')}.srt`;
    const subtitlePath = assertInside(workspace, subtitleRel);
    mkdirSync(join(workspace, 'temp', 'render'), { recursive: true });
    writeFileSync(subtitlePath, captionsToSrt(plan.captionCues ?? []), 'utf8');
    const forceStyle = stage.styleId === 'large' ? ':force_style=Fontsize=28' : '';
    filters.push(`${currentVideo}subtitles='${escFilterPath(subtitlePath)}'${forceStyle}[${label}]`);
    return { label: `[${label}]`, nextSeed: labelSeed + 1 };
  }
};

export function buildFfmpegCommand(workspacePath: string, plan: V3RenderPlan, outputRel = 'renders/draft.mp4'): FfmpegCommand {
  const workspace = resolve(workspacePath);
  const output = assertRenderOutputPathV3(workspace, outputRel);
  const baseInputs = Array.from(new Map(plan.composition.videoBase.map((segment) => [segment.asset.path, segment.asset.path])).values());
  const insertStages = plan.stages.filter((stage): stage is Extract<RenderStage, { kind: 'audio-insert' }> => stage.kind === 'audio-insert');
  const freezeStages = plan.stages.filter((stage): stage is Extract<RenderStage, { kind: 'freeze-frame' }> => stage.kind === 'freeze-frame');
  const overlayAssetInputs = plan.stages.flatMap((stage) => stage.kind === 'visual-overlay' && stage.source.kind === 'asset' ? [stage.source.asset] : []);
  const baseAudioCovered = (candidate: V3RenderPlan['composition']['audioMix'][number]) => plan.composition.videoBase.some((base) =>
    base.clipId === candidate.clipId &&
    base.trackId === candidate.trackId &&
    Math.abs(base.outputStart - candidate.outputStart) < 1e-9 &&
    Math.abs(base.outputEnd - candidate.outputEnd) < 1e-9 &&
    Math.abs(base.sourceStart - candidate.sourceStart) < 1e-9 &&
    Math.abs(base.sourceEnd - candidate.sourceEnd) < 1e-9
  );
  const structuralAudioSegments = plan.composition.audioMix.filter((segment) => segment.rate === 1 && (segment.source === 'audio-track' || !baseAudioCovered(segment)));
  const structuralAudioAssets = Array.from(new Map(structuralAudioSegments.map((segment) => [segment.asset.path, segment.asset.path])).values());
  // Studio-clean audio swap: when studioCleanupAudioPath is set (manifest.studioCleanup
  // status === 'approved'), all embedded-video-audio read operations use the cleaned WAV
  // instead of the original video file's audio stream. We add the cleaned WAV as an
  // extra input and record its index. Video (:v) streams are unaffected.
  const cleanAudioPath = plan.studioCleanupAudioPath;
  const inputPaths = Array.from(new Set([...baseInputs, ...structuralAudioAssets, ...insertStages.map((stage) => stage.asset), ...freezeStages.map((stage) => stage.asset), ...overlayAssetInputs, ...(cleanAudioPath ? [cleanAudioPath] : [])]));
  if (!inputPaths.length) throw new Error('Render plan has no video base segments to render');
  // Index of the cleaned audio file in inputPaths (undefined when no cleanup active).
  const cleanInputIndex = cleanAudioPath !== undefined ? inputPaths.indexOf(cleanAudioPath) : undefined;

  const filters: string[] = [];
  const concatInputs: string[] = [];
  const targetResolution = parseResolution(plan.targetProfile.resolution);
  const normalizeVideo = targetResolution
    ? `scale=${targetResolution.width}:${targetResolution.height}:force_original_aspect_ratio=decrease,pad=${targetResolution.width}:${targetResolution.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
    : null;
  let pair = 0;
  const orderedVisuals = [
    ...plan.composition.videoBase.map((segment) => ({ kind: 'segment' as const, outputStart: segment.outputStart, outputEnd: segment.outputEnd, segment })),
    ...freezeStages.map((stage) => ({ kind: 'freeze-frame' as const, outputStart: stage.range.start, outputEnd: stage.range.end, stage }))
  ].sort((a, b) => a.outputStart - b.outputStart || a.outputEnd - b.outputEnd);
  let cursor = 0;
  for (const visual of orderedVisuals) {
    if (visual.outputStart > cursor) {
      const gap = visual.outputStart - cursor;
      filters.push(`color=c=black:s=${plan.targetProfile.resolution}:d=${roundSec6(gap)},setsar=1[v${pair}]`);
      filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000:d=${roundSec6(gap)}[a${pair}]`);
      concatInputs.push(`[v${pair}][a${pair}]`);
      pair += 1;
    }
    if (visual.kind === 'freeze-frame') {
      const inputIndex = inputPaths.indexOf(visual.stage.asset);
      const duration = Math.max(visual.outputEnd - visual.outputStart, 0.001);
      // Freeze the LAST frame strictly before sourceTime, then clone it for the overflow
      // duration. Trim boundaries use floorSec6 (formerly truncMicro) so toFixed cannot
      // round past the segment boundary — at NTSC 29.97 fps a sub-millisecond boundary
      // frame would otherwise be included as the first frame of the next segment
      // (Codex P2, 2026-05-25). Window width is one frame period; for common rates this
      // leaves exactly one frame, and tpad clones it for the full overflow band.
      const framePeriod = 1 / Math.max(visual.stage.sourceFps, 1);
      const rawStart = Math.max(0, visual.stage.sourceTime - framePeriod);
      const trimEnd = floorSec6(visual.stage.sourceTime);
      const trimStart = floorSec6(rawStart);
      const vf = [`trim=start=${trimStart}:end=${trimEnd}`, 'setpts=PTS-STARTPTS', `tpad=stop_mode=clone:stop_duration=${roundSec6(duration)}`, `trim=duration=${roundSec6(duration)}`];
      if (normalizeVideo) vf.push(normalizeVideo);
      filters.push(`[${inputIndex}:v]${vf.join(',')}[v${pair}]`);
      filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000:d=${roundSec6(duration)}[a${pair}]`);
      concatInputs.push(`[v${pair}][a${pair}]`);
      pair += 1;
      cursor = Math.max(cursor, visual.outputEnd);
      continue;
    }
    const segment = visual.segment;
    const inputIndex = inputPaths.indexOf(segment.asset.path);
    const clipOffset = segment.clip.sourceStart + segment.sourceStart;
    const clipEnd = segment.clip.sourceStart + segment.sourceEnd;
    const vf = [`trim=start=${roundSec6(clipOffset)}:end=${roundSec6(clipEnd)}`, 'setpts=PTS-STARTPTS'];
    const af = [`atrim=start=${roundSec6(clipOffset)}:end=${roundSec6(clipEnd)}`, 'asetpts=PTS-STARTPTS'];
    if (segment.rate !== 1) vf.push(`setpts=PTS/${segment.rate}`);
    if (normalizeVideo) vf.push(normalizeVideo);
    filters.push(`[${inputIndex}:v]${vf.join(',')}[v${pair}]`);
    if (segment.clip.audioDetached || segment.rate !== 1) {
      filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000:d=${roundSec6(segment.outputEnd - segment.outputStart)}[a${pair}]`);
    } else {
      // Studio-clean audio swap: when cleanInputIndex is defined (studioCleanup approved),
      // read audio from the cleaned WAV at the same source timings instead of the video file.
      // The cleaned WAV has the same duration as the source recording (EL Isolator preserves
      // length), so sourceStart/sourceEnd timings are directly reusable.
      const audioInputIndex = cleanInputIndex !== undefined ? cleanInputIndex : inputIndex;
      // Smart fade: emit afade ONLY at ripple-cut source-time discontinuities (NOT at every
      // segment boundary). Cuts glue segments back-to-back; the sample-step at the seam
      // creates a click/pop ffmpeg-side. Voice_patch boundaries are handled separately by
      // the audio-insert crossfade + base-mute window machinery, not here. Cross-clip seams
      // (different clipId on each side) do NOT fade — they're concatenation, not cuts.
      // Duration reduced 10ms → 2ms (96 samples @ 48kHz): enough for sample-step click
      // suppression, not enough to attenuate audible content. Hermes P1+P2, 2026-05-26.
      const segDuration = Math.max(segment.outputEnd - segment.outputStart, 0.001);
      const fade = Math.min(0.002, segDuration / 8);
      if (hasCutSourceJumpBefore(plan, segment)) af.push(`afade=t=in:st=0:d=${roundSec6(fade)}`);
      if (hasCutSourceJumpAfter(plan, segment)) af.push(`afade=t=out:st=${roundSec6(Math.max(segDuration - fade, 0))}:d=${roundSec6(fade)}`);
      filters.push(`[${audioInputIndex}:a]${af.join(',')}[a${pair}]`);
    }
    concatInputs.push(`[v${pair}][a${pair}]`);
    pair += 1;
    cursor = Math.max(cursor, segment.outputEnd);
  }
  if (plan.outputDurationSec > cursor) {
    const gap = plan.outputDurationSec - cursor;
    filters.push(`color=c=black:s=${plan.targetProfile.resolution}:d=${roundSec6(gap)},setsar=1[v${pair}]`);
    filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000:d=${roundSec6(gap)}[a${pair}]`);
    concatInputs.push(`[v${pair}][a${pair}]`);
    pair += 1;
  }
  filters.push(`${concatInputs.join('')}concat=n=${Math.max(pair, 1)}:v=1:a=1[cv][basea]`);

  const audioFilters: string[] = [];
  const mixInputs = ['[basea]'];
  let structuralAudioIndex = 0;
  for (const segment of structuralAudioSegments) {
    const inputIndex = inputPaths.indexOf(segment.asset.path);
    const clipOffset = segment.clip.sourceStart + segment.sourceStart;
    const clipEnd = segment.clip.sourceStart + segment.sourceEnd;
    const delay = adelayMs(segment.outputStart);
    audioFilters.push(`[${inputIndex}:a]atrim=start=${roundSec6(clipOffset)}:end=${roundSec6(clipEnd)},asetpts=PTS-STARTPTS,adelay=${delay}|${delay}[mix${structuralAudioIndex}]`);
    mixInputs.push(`[mix${structuralAudioIndex}]`);
    structuralAudioIndex += 1;
  }
  const silenceFilters: string[] = [];
  let audioBedSeed = 0;
  for (const stage of plan.stages) {
    switch (stage.kind) {
      case 'silence':
        stageHandlers.silence(stage, silenceFilters);
        break;
      case 'audio-insert': {
        // Base-mute window covers max(slot, asset play window). This handles both:
        //   - shorter patch: mute the full original slot so the slack tail does
        //     NOT leak source-speaker audio after the generated asset finishes.
        //   - longer patch: mute through the full asset playback window (which
        //     overflows the original slot) so both streams do not overlap.
        // Pre-2026-05-25 derived this from playSec alone, leaving the shorter-
        // patch slack tail unmuted (the Test-Emo rush bug).
        const rangeDuration = stage.range.end - stage.range.start;
        const playDuration = stage.playSec ?? rangeDuration;
        const muteDuration = Math.max(rangeDuration, playDuration);
        stageHandlers.silence({ kind: 'silence', range: { start: stage.range.start, end: stage.range.start + muteDuration } }, silenceFilters);
        stageHandlers.audioInsert(stage, inputPaths.indexOf(stage.asset), audioFilters, mixInputs);
        break;
      }
      case 'audio-bed':
        stageHandlers.silence({ kind: 'silence', range: stage.range }, silenceFilters);
        audioBedSeed = stageHandlers.audioBed(stage, audioFilters, mixInputs, plan, inputPaths, audioBedSeed);
        break;
      case 'freeze-frame':
      case 'visual-overlay':
      case 'transition':
      case 'caption-burn':
        break;
      default: {
        const exhaustive: never = stage;
        throw new Error(`Unknown render stage: ${(exhaustive as { kind?: string }).kind}`);
      }
    }
  }
  filters.push(...audioFilters);
  const structuralInputs = mixInputs.filter((label) => label === '[basea]' || label.startsWith('[mix'));
  const additiveInputs = mixInputs.filter((label) => label.startsWith('[ai') || label.startsWith('[ab'));
  if (structuralInputs.length > 1) filters.push(`${structuralInputs.join('')}amix=inputs=${structuralInputs.length}:duration=first:dropout_transition=0[premix]`);
  else filters.push('[basea]anull[premix]');
  if (silenceFilters.length) filters.push(`[premix]${silenceFilters.join(',')}[stagebase]`);
  else filters.push('[premix]anull[stagebase]');
  const finalMixInputs = ['[stagebase]', ...additiveInputs];
  // normalize=0 on the FINAL mix so voice_patch audio plays at full volume rather than getting
  // halved by amix's default 1/N normalization. The base has already been silenced under each
  // patch range via [premix]volume=...:enable=between(t,…):volume=0[stagebase], so summing
  // (silenced_base + patch) === patch — i.e. replace semantics. With the default normalize=1
  // the patch ends up at ~ -6 dB inside its range even though the original is fully silenced,
  // which is the "I hear nothing / I hear it but it's quiet" symptom users report.
  // Structural amix above keeps normalize=1 because there we DO want to balance multiple
  // structural audio sources (extra audio tracks, voiceover, etc).
  //
  // alimiter is a defensive limiter that catches edge cases where two voice_patches on
  // separate tracks both fire in the same output instant (validate.ts only rejects same-clip
  // overlaps, so cross-track simultaneous patches sum unbounded and could clip on peaks).
  // -0.3 dBFS ceiling keeps headroom without audible compression on typical speech.
  if (finalMixInputs.length > 1) filters.push(`${finalMixInputs.join('')}amix=inputs=${finalMixInputs.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.97[a_stage]`);
  else filters.push('[stagebase]anull[a_stage]');

  let videoLabel = '[cv]';
  let audioLabel = '[a_stage]';
  let videoSeed = 0;
  const visualStages = [...plan.stages]
    .filter((stage): stage is Extract<RenderStage, { kind: 'visual-overlay' }> => stage.kind === 'visual-overlay')
    .sort((a, b) => a.zIndex - b.zIndex || a.range.start - b.range.start || a.range.end - b.range.end);
  for (const stage of visualStages) {
    const result = stageHandlers.visualOverlay(stage, videoLabel, filters, inputPaths, videoSeed);
    videoLabel = result.label;
    videoSeed = result.nextSeed;
  }
  for (const stage of plan.stages.filter((candidate): candidate is Extract<RenderStage, { kind: 'transition' }> => candidate.kind === 'transition')) {
    const result = stageHandlers.transition(stage, videoLabel, audioLabel, filters, videoSeed);
    videoLabel = result.video;
    audioLabel = result.audio;
    videoSeed = result.nextSeed;
  }
  for (const stage of plan.stages.filter((candidate): candidate is Extract<RenderStage, { kind: 'caption-burn' }> => candidate.kind === 'caption-burn')) {
    if (stage.range.end <= stage.range.start) continue;
    const result = stageHandlers.captionBurn(stage, videoLabel, filters, workspace, plan, videoSeed);
    videoLabel = result.label;
    videoSeed = result.nextSeed;
  }

  const args = ['-y', ...inputPaths.flatMap((path) => ['-i', assertInside(workspace, path)]), '-filter_complex', filters.join(';'), '-map', videoLabel, '-map', audioLabel, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-progress', 'pipe:1', output];
  return { command: 'ffmpeg', args, cwd: workspace };
}

export async function renderPlan(workspacePath: string, plan: V3RenderPlan, options: V3RenderPipelineOptions = {}): Promise<string | FfmpegCommand> {
  const workspace = resolve(workspacePath);
  const outputRel = options.output ?? 'renders/draft.mp4';
  const output = assertRenderOutputPathV3(workspace, outputRel);
  if (existsSync(output) && outputRel === 'renders/final.mp4' && !options.overwrite) throw new Error('Refusing to overwrite renders/final.mp4 without --yes');
  mkdirSync(join(workspace, 'renders'), { recursive: true });
  const command = buildFfmpegCommand(workspace, plan, outputRel);
  if (options.dryRun) return command;
  await runFfmpegProgress(command.args, command.cwd, plan, options.onProgress);
  return outputRel;
}
