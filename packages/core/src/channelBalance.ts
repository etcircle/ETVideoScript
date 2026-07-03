import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { probeRecordingMedia } from './media';
import { assertInside, nowIso } from './filesystem';
import { loadManifestV3, saveManifestV3 } from './manifest/io';
import type { AudioChannelFix, ManifestV3 } from './manifest/schema';

/** Minimum RMS advantage (dB) the live channel must have for an auto-recommendation. */
export const CHANNEL_FIX_MIN_DELTA_DB = 20;
/** The dead channel must be at or below this RMS (dB) for an auto-recommendation. */
export const CHANNEL_FIX_DEAD_MAX_RMS_DB = -55;
/** RMS substituted when astats reports -inf (digital silence) so arithmetic stays finite. */
export const CHANNEL_FIX_SILENCE_FLOOR_DB = -120;

export type ChannelBalance = {
  channels: number;
  /** Per-channel RMS in dBFS; null when the source is not 2-channel stereo. */
  leftRmsDb: number | null;
  rightRmsDb: number | null;
  /** Non-null ONLY for a clearly one-sided 2-channel source (see thresholds above). */
  recommendation: 'left' | 'right' | null;
};

/**
 * Parse per-channel "RMS level dB" lines from ffmpeg astats output. Each value
 * belongs to the most recent "Channel: N" line; the Overall block's RMS line is
 * ignored because no Channel line precedes it (the tracker resets after each
 * capture). Exported for direct unit testing without shelling out.
 */
export function parseAstatsChannelRms(output: string): number[] {
  const rms: number[] = [];
  let channelIndex = -1;
  for (const line of output.split('\n')) {
    const channelMatch = /\]\s*Channel:\s*(\d+)/.exec(line);
    if (channelMatch) { channelIndex = Number(channelMatch[1]) - 1; continue; }
    const rmsMatch = /\]\s*RMS level dB:\s*(-?[\d.]+|-inf)/.exec(line);
    if (rmsMatch && channelIndex >= 0) {
      rms[channelIndex] = rmsMatch[1] === '-inf' ? CHANNEL_FIX_SILENCE_FLOOR_DB : Number(rmsMatch[1]);
      channelIndex = -1;
    }
  }
  return rms;
}

/**
 * Measure per-channel loudness of the first audio stream and recommend a live
 * channel when the recording is clearly one-sided (single-channel mic on a
 * stereo track). Non-stereo sources and balanced/ambiguous stereo return
 * recommendation: null. Throws when ffmpeg/ffprobe cannot read the file —
 * callers that must not fail (extract-audio auto-detection) wrap this.
 */
export function analyzeChannelBalance(mediaPath: string): ChannelBalance {
  const channels = probeRecordingMedia(mediaPath).audio?.channels ?? 0;
  if (channels !== 2) return { channels, leftRmsDb: null, rightRmsDb: null, recommendation: null };
  // astats prints to stderr; measure_overall=none keeps the output to the two per-channel blocks.
  const result = spawnSync('ffmpeg', ['-hide_banner', '-i', mediaPath, '-map', '0:a:0', '-af', 'astats=measure_perchannel=RMS_level:measure_overall=none', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg astats failed: ${result.stderr || result.stdout}`);
  const rms = parseAstatsChannelRms(result.stderr);
  const leftRmsDb = rms[0];
  const rightRmsDb = rms[1];
  if (leftRmsDb === undefined || rightRmsDb === undefined) throw new Error(`Could not parse per-channel RMS from astats output for ${mediaPath}`);
  let recommendation: ChannelBalance['recommendation'] = null;
  if (leftRmsDb - rightRmsDb >= CHANNEL_FIX_MIN_DELTA_DB && rightRmsDb <= CHANNEL_FIX_DEAD_MAX_RMS_DB) recommendation = 'left';
  else if (rightRmsDb - leftRmsDb >= CHANNEL_FIX_MIN_DELTA_DB && leftRmsDb <= CHANNEL_FIX_DEAD_MAX_RMS_DB) recommendation = 'right';
  return { channels, leftRmsDb, rightRmsDb, recommendation };
}

export type ChannelFixOutcome =
  | { action: 'applied'; fix: AudioChannelFix; balance: ChannelBalance }
  | { action: 'disabled'; fix: AudioChannelFix }
  | { action: 'unchanged'; reason: string; fix?: AudioChannelFix }
  | { action: 'none'; reason: string; balance: ChannelBalance };

// Backfills the base recording asset's probed channel count whenever a fix is applied.
// buildRenderPlan's render-time guard trusts this field strictly (channels === 2); keeping
// it accurate here means a stale/missing channel count on a legacy asset can no longer
// cause a mono source to get panned into digital silence at render time (issue #7).
function withBaseAssetChannels(manifest: ManifestV3, channels: number): ManifestV3 {
  return {
    ...manifest,
    assets: manifest.assets.map((asset) =>
      asset.path === 'input/source.mp4' && asset.audio?.channels !== channels
        ? { ...asset, audio: { ...(asset.audio ?? {}), channels } }
        : asset
    )
  };
}

/**
 * Detect and persist (or override / disable) the project-level audioChannelFix.
 * Auto mode (no options) NEVER overwrites an existing record — approved or
 * disabled — so re-running extract-audio cannot flip a decision the user made.
 * An explicit `channel` always wins (auto: false). Reversible: disable retains
 * the record with status 'disabled'; saveManifestV3 snapshots a revision first.
 */
export function applyChannelFix(
  workspacePath: string,
  options: { channel?: 'left' | 'right'; disable?: boolean; analyze?: typeof analyzeChannelBalance } = {}
): ChannelFixOutcome {
  if (options.channel && options.disable) throw new Error('--channel and --disable are mutually exclusive; pick one');
  const workspace = resolve(workspacePath);
  const analyze = options.analyze ?? analyzeChannelBalance;
  const manifest = loadManifestV3(workspace);
  const existing = manifest.audioChannelFix;

  if (options.disable) {
    if (!existing) return { action: 'unchanged', reason: 'no channel fix to disable' };
    // Same-value no-op (issue #9): re-disabling an already-disabled record must not bump
    // appliedAt — a churned timestamp with no actual value change would wrongly stale-out
    // a studioCleanup fingerprinted against the fix's VALUE, not this timestamp.
    if (existing.status === 'disabled') return { action: 'unchanged', reason: 'already disabled', fix: existing };
    // appliedAt tracks "created or last changed" (any status transition), not just creation —
    // extractFullBandReference's cache freshness check depends on it staying current.
    const fix: AudioChannelFix = { ...existing, status: 'disabled', appliedAt: nowIso() };
    saveManifestV3(workspace, { ...manifest, audioChannelFix: fix });
    return { action: 'disabled', fix };
  }

  const source = assertInside(workspace, 'input/source.mp4');
  if (!existsSync(source)) throw new Error('input/source.mp4 not found; run etvideo import first');

  if (options.channel) {
    const balance = analyze(source);
    if (balance.channels !== 2) throw new Error(`Cannot force a channel on a non-stereo source (${balance.channels} channel(s)); the fix targets 2-channel recordings`);
    const baseAsset = manifest.assets.find((asset) => asset.path === 'input/source.mp4');
    // Same-value no-op (issue #9): re-applying the SAME channel is only a true no-op when
    // there is also nothing left to backfill — a legacy record with stale/missing asset
    // channel metadata still needs the write below (see withBaseAssetChannels/issue #7).
    const alreadyCorrect = existing?.status === 'approved' && existing.sourceChannel === options.channel && baseAsset?.audio?.channels === balance.channels;
    if (alreadyCorrect) return { action: 'unchanged', reason: 'audioChannelFix already set to this channel', fix: existing! };
    const fix: AudioChannelFix = {
      status: 'approved',
      sourceChannel: options.channel,
      detection: { leftRmsDb: balance.leftRmsDb ?? 0, rightRmsDb: balance.rightRmsDb ?? 0, auto: false },
      appliedAt: nowIso()
    };
    saveManifestV3(workspace, withBaseAssetChannels({ ...manifest, audioChannelFix: fix }, balance.channels));
    return { action: 'applied', fix, balance };
  }

  if (existing) {
    // Legacy/hand-edited approved fix whose base asset channel metadata never got
    // backfilled (issue #7 — e.g. a partial update_asset patch dropped audio.channels)
    // self-heals here: extract-audio auto-runs applyChannelFix() on every invocation, so
    // this early-return path is the one place a stale record would otherwise stay inert
    // forever (buildRenderPlan's channels===2 guard permanently rejects it). Best-effort:
    // never throw or block the early return on a probe failure.
    if (existing.status === 'approved') {
      const baseAsset = manifest.assets.find((asset) => asset.path === 'input/source.mp4');
      if (baseAsset?.audio?.channels !== 2) {
        try {
          const channels = probeRecordingMedia(source).audio?.channels ?? 0;
          if (channels === 2) saveManifestV3(workspace, withBaseAssetChannels(manifest, channels));
        } catch { /* best-effort backfill only; auto mode must never throw here */ }
      }
    }
    return { action: 'unchanged', reason: 'existing audioChannelFix preserved', fix: existing };
  }
  const balance = analyze(source);
  if (!balance.recommendation) return { action: 'none', reason: 'channel balance does not indicate a single-channel recording', balance };
  const fix: AudioChannelFix = {
    status: 'approved',
    sourceChannel: balance.recommendation,
    detection: { leftRmsDb: balance.leftRmsDb ?? 0, rightRmsDb: balance.rightRmsDb ?? 0, auto: true },
    appliedAt: nowIso()
  };
  saveManifestV3(workspace, withBaseAssetChannels({ ...manifest, audioChannelFix: fix }, balance.channels));
  return { action: 'applied', fix, balance };
}
