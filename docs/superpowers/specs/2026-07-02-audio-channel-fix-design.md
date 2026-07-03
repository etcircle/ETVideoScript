# Audio Channel Fix (single-channel mic) - Design

Date: 2026-07-02
Status: approved by user (brainstorming session)

## Problem

Some source recordings have the microphone on only one stereo channel: speech on L (or R), silence/noise on the other. Today:

- Renders pass source audio through with no channel mapping, so the output plays speech in one ear.
- Audio extraction uses `-ac 1`, which averages both channels, mixing the dead channel in and halving loudness for transcription and voice-clone reference audio.

## Goal

Detect a one-sided recording, persist that fact as a reversible project-level setting, and apply the fix everywhere audio is consumed: extraction uses only the live channel; renders duplicate the live channel to both L and R.

## Non-goals

- No modification of `input/source.mp4` (hard rule: never overwritten).
- No generic channel-mapping UI for arbitrary layouts (5.1 etc.). Stereo-with-one-dead-channel only.
- No per-clip channel settings; this is a whole-project property of the recording.

## Decisions made

- Detection: automatic with explicit override (`--channel left|right`).
- Scope: manifest-level setting applied to both extraction and render (not render-only, not a one-shot audio rewrite).
- Activation: auto-detection runs during `extract-audio`; if clearly one-sided, the setting is written with `status: 'approved'` and reported. A CLI verb allows re-run, override, inspect, and disable.

## Design

### 1. Core primitive: detection

New function in `@etvideo/core` (new module `src/audio/channel-balance.ts`):

```ts
analyzeChannelBalance(mediaPath: string): Promise<{
  channels: number;
  leftRmsDb: number | null;   // null when source is mono
  rightRmsDb: number | null;
  recommendation: 'left' | 'right' | null;
}>
```

- Implemented with ffmpeg `astats` (per-channel RMS level), parsed from stderr, matching how other media probes in `src/media.ts` shell out to ffmpeg/ffprobe.
- `recommendation` is non-null only when the source has 2 channels AND the live channel is at least 20 dB louder AND the dead channel RMS is below -55 dB. Mono sources, balanced stereo, and ambiguous cases return `null`.
- Thresholds are exported constants so tests and future tuning reference one place.

### 2. Manifest schema

Optional field on the manifest (same pattern as `studioCleanup` in `packages/core/src/manifest/schema.ts`):

```ts
audioChannelFix?: {
  status: 'approved' | 'disabled';
  sourceChannel: 'left' | 'right';
  detection: { leftRmsDb: number; rightRmsDb: number; auto: boolean };
  appliedAt: string; // ISO timestamp
}
```

- Reversible: disabling sets `status: 'disabled'`; history is never deleted. A manifest revision is saved before every write, as with all manifest edits.
- `auto: true` means detection wrote it; `auto: false` means the user forced a channel.

### 3. Effect on extraction

In `packages/core/src/media.ts`, when the manifest has an approved `audioChannelFix`:

- `extractAudio`, `extractClipAudio`, `extractFullBandReference` replace plain `-ac 1` with `-af "pan=mono|c0=<c>"` (where `<c>` is `c0` for left, `c1` for right) so only the live channel feeds transcription and voice-clone reference audio.
- The extraction functions take an optional `sourceChannel?: 'left' | 'right'` parameter; callers (CLI, API jobs) read it from the manifest. Core stays pure - it does not reach into the manifest itself.
- `isValidFullBandReference` continues to expect 1 channel; unchanged.

### 4. Effect on render

In `packages/core/src/render/pipeline.ts` (`buildFfmpegCommand`):

- The render plan (`buildRenderPlan` in `plan.ts`) carries `audioSourceChannel?: 'left' | 'right'` when the manifest setting is approved.
- When set, every audio chain that reads from the source video input gets `pan=stereo|c0=<c>|c1=<c>` prepended (where `<c>` is `c0` for left, `c1` for right).
- Generated audio is unaffected: voice-patch clips and `anullsrc` silence are already stereo.
- `studioCleanupAudioPath` is derived from extracted audio, which is already channel-fixed upstream; when it substitutes for source audio it needs no pan filter (it is mono upmixed by the existing chain).

### 5. Activation and CLI

- `ets extract-audio` runs `analyzeChannelBalance` on the source first. If it returns a recommendation and no `audioChannelFix` exists yet, it writes the setting (`status: 'approved'`, `auto: true`), logs what it found (both RMS values), and extracts using the live channel. If a setting already exists (approved or disabled), detection does not overwrite it.
- New verb:

```
ets fix-channels [--channel left|right] [--disable] [--detect-only] --json
```

  - no flags: run detection, apply recommendation (or report "balanced, nothing to do")
  - `--channel`: force a channel (`auto: false`)
  - `--disable`: set `status: 'disabled'`
  - `--detect-only`: print analysis without writing the manifest
  - `--json`: machine-readable output, consistent with other verbs

- API/UI: the setting rides along in the manifest the UI already reads. No dedicated UI in this slice; the manifest panel shows it like other manifest state. (Future: a toggle in a project-audio settings panel.)

## Error handling

- ffmpeg/astats failure during detection: log a warning, skip auto-detection, extraction proceeds with current behavior. Detection failure must never block extract-audio.
- Mono source (1 channel): detection returns `recommendation: null`; nothing is written; existing `-ac 1` path is a no-op semantically.
- Setting references a channel on a source that later probes as mono: render planning ignores the setting and logs a warning rather than failing the render.

## Testing

In `packages/core/src/__tests__/`:

1. Schema test: `audioChannelFix` validates; bad values rejected; manifest without it still validates.
2. Detection test: synthesize small WAVs (tone on one channel, silence on the other; balanced tone; mono) and assert `analyzeChannelBalance` recommendations and RMS parsing.
3. Render pipeline test: manifest with approved fix produces `pan=stereo|c0=cN|c1=cN` in the ffmpeg args on source-audio chains, deterministically across runs; disabled/absent setting produces no pan filter. Follows `render-enhance-determinism.test.ts` patterns.
4. Extraction test: with `sourceChannel` set, extraction args contain `pan=mono|c0=<c>` and not `-ac 1`.

## Rollout

Single slice: core primitive + schema + extraction + render + CLI verb + tests. No migration needed (field is optional). Existing projects are unaffected until extract-audio is re-run or `ets fix-channels` is invoked.

## Post-review hardening

An adversarial (codex) review found 8 confirmed issues in the initial implementation, all closed in a follow-up fix wave:

- **Scope primitive.** New `packages/core/src/channelFixScope.ts` exports `resolveChannelFixForAsset(manifest, assetPath)`, which returns the fix's `sourceChannel` only when `assetPath === 'input/source.mp4'` (the only file `applyChannelFix` ever analyzes). `extractClipAudio`, `extractFullBandReference`, and `extractAudioAssetInWorkspace` (detach) now go through this instead of trusting the fix unconditionally — a multi-source project's unrelated clips/b-roll/imports are never panned by the base recording's fix.
- **Fingerprint caching.** The same module exposes a `.channelfix` sidecar (`channelFixFingerprint`, `readChannelFixSidecar`, `writeChannelFixSidecar`, `channelFixSidecarFresh`) written next to every extraction derivative (`media/extracted-audio.wav`, `media/<clipId>/extracted-audio.wav`, `media/<clipId>/reference-48k.wav`, `assets/audio/<assetId>.wav`). Cache reuse now requires the sidecar to match the fix's CURRENT resolved state (`'left' | 'right' | 'none'`), replacing the old existence-only check and the order-dependent `appliedAt`/mtime comparison — both were fooled by a fix applied after the first extraction, a restored older manifest revision, or a hand-edited `sourceChannel`.
- **Import replace.** `importSource` now captures the workspace's previously recorded source hash before overwriting, and — only when the replacement's content genuinely differs — sets any approved `audioChannelFix` to `status: 'disabled'` (never deleted) and refreshes the base asset's probed metadata (incl. `audio.channels`). A no-op `--yes` re-import of identical bytes doesn't churn the fix.
- **Detach.** `extractAudioAssetInWorkspace` (the detach path) now applies the pan (previously it silently extracted plain stereo, undoing the fix) and shares the same scope + fingerprint-freshness rules as extraction. `probeRecordingMedia` was extracted into a dependency-free `packages/core/src/ffprobe.ts` (re-exported from `media.ts` for back-compat) so `tracks/operations.ts` can live-probe the source's channel count without a circular import (`media.ts` already imports `tracks/operations.ts`).
- **Studio-cleanup staleness.** `buildRenderPlan` now suppresses an approved `studioCleanup` when `audioChannelFix.appliedAt` postdates `studioCleanup.createdAt` (pure timestamp comparison, no fs access) and exposes `studioCleanupStale: true` on the plan. The paid cleanup is never auto-rerun — render falls back to raw video audio, which `audioSourceChannel` then correctly re-pans. CLI (`ets render`) and the API render job both surface a warning when this triggers.
- **Channel-count guards.** Extraction only pans when a live probe reports exactly 2 channels (`!== 2` skips the pan, covering both mono and 5.1/7.1 sources). `buildRenderPlan`'s render-time guard was tightened from "channels ≥ 2 or missing" to strictly `channels === 2` — trusting missing/stale metadata could pan a since-gone-mono source into digital silence. `applyChannelFix` now backfills the base asset's `audio.channels` from its own live probe on every apply, so the tightened guard stays reliable for both new imports and pre-existing legacy assets.
- **CLI conflict.** `applyChannelFix` itself (not just the CLI) now throws if both `channel` and `disable` are passed, so `--channel right --disable` fails fast instead of silently disabling.

### Round 2

A second adversarial (codex) pass, arbitrated by a controller synthesis, found further gaps in round 1's hardening — one blocker and six majors, all closed in this wave:

- **Validate-then-promote on import replace (blocker).** `importSource` previously promoted the staged bytes (`renameSync`) and saved `project.json` BEFORE building/validating the manifest mutation, so a shorter replacement (new duration < an existing clip's `sourceEnd`) left `input/source.mp4` and `project.json` already updated while the manifest write threw — a split-brain workspace, and a retry silently repeated it. `importSource` now stages the new bytes (when copying), probes and builds the prospective manifest mutation entirely in memory against the staged bytes, and only promotes/saves `project.json`/`edits/manifest.json` after `addAsset`/`updateAsset`/`addClip`'s internal validation succeeds. A rejection now touches nothing on disk; a retry throws identically. `contentReplaced` also now compares against the staged/final bytes' hash (`finalMetadata.sha256`) instead of the pre-copy probe, closing a narrow window where the external source file changes between the initial probe and the copy.
- **Source-mtime freshness dimension.** `channelFixSidecarFresh` (now in `packages/core/src/channelFixSidecar.ts`) gained a third freshness check — `statSync(output).mtimeMs >= statSync(source).mtimeMs` — alongside the symlink and fingerprint checks, folding in the mtime/symlink logic `extractFullBandReference` already had privately. All four extraction call sites (`extractAudio`, `extractClipAudio`, `extractFullBandReference`, `extractAudioAssetInWorkspace`) now share it, so a source replace that doesn't happen to change the fix's fingerprint (e.g. `'none'` before and after, no fix ever applied) still forces re-extraction instead of silently serving audio from the OLD recording forever.
- **Studio-cleanup staleness by value fingerprint, not timestamp ordering.** `StudioCleanupSchema` gained an optional `audioChannelFixFingerprint` field, stamped by `studioCleanupRoutes.ts` at creation time (`channelFixFingerprint(resolveChannelFixForAsset(current, 'input/source.mp4'))`), after first self-freshening the source audio (`extractAudio`/`extractClipAudio`) so the hash/paid call is never taken over stale bytes. `buildRenderPlan`'s `studioCleanupStale` check now compares this fingerprint against the CURRENT one instead of `Date.parse(audioChannelFix.appliedAt) > Date.parse(studioCleanup.createdAt)` — immune to a same-value re-apply/re-disable churning `appliedAt` with no real change, same-millisecond races, and future-dated hand edits. A missing fingerprint only counts as stale when an `audioChannelFix` record actually exists to compare against, so the common case (a cleanup with no channel-fix history at all, or any pre-fingerprint-field manifest) is never wrongly flagged. `applyChannelFix` itself became a true no-op (no `appliedAt` bump) on a same-value re-apply/re-disable, so the fingerprint mechanism isn't defeated by its own producer.
- **Sidecar atomicity + symlink safety.** `readChannelFixSidecar` now returns `undefined` (not an implicit `'none'`) when the sidecar file is missing — a missing sidecar (interrupted write, or a pre-feature derivative) always forces exactly one regeneration rather than being silently treated as "no fix applied". `writeChannelFixSidecar` now stages to a same-directory temp file and `renameSync`s over the target, matching `extractFullBandReference`'s existing stage-then-rename precedent, so a planted symlink at the sidecar path is replaced rather than written through.
- **Detach revisits stale bytes via an explicit `refresh` flag.** `detachAudioInWorkspace` gained `refresh?: boolean` (default `false`, preserving the pre-existing "Clip audio already detached" throw). `refresh: true` on an already-detached clip skips the (now-inapplicable) `detachAudio` track mutation and just resolves the existing companion clip/track/asset — `extractAudioAssetInWorkspace`'s freshness check above it has already re-extracted the underlying WAV in place if the fix changed since the last detach. Wired through the existing `POST /clips/:clipId/detach-audio` route (`{ refresh: true }` in the body, no new route) and surfaced by the CLI's `fix-channels` summary, which now lists any clips with detached audio needing a refresh.
- **Render plan scope check reuses the shared primitive.** `buildRenderPlan` previously derived `audioSourceChannel`'s scope from "exactly one video source" plus channel-count metadata alone — if the base clip was removed and a single unrelated two-channel asset remained, that asset got panned. Both `audioSourceChannel` and `studioCleanupAudioPath` now additionally require the sole remaining video source to literally BE `input/source.mp4` (via `resolveChannelFixForAsset` / a direct path check), the same rule extraction and detach already enforced.
- **Legacy fix channel backfill on the auto-mode early return.** `applyChannelFix`'s auto-mode `if (existing) return unchanged` path previously returned immediately for ANY existing approved fix, even one whose base-asset `audio.channels` metadata had gone missing (e.g. a partial `update_asset` patch). Since `extract-audio` auto-runs `applyChannelFix()` on every invocation, this path now best-effort backfills the channel count (via a live probe, wrapped in try/catch so a probe failure never blocks the early return) without touching the fix record itself — so a legacy/hand-edited record self-heals the next time `extract-audio` runs, instead of `buildRenderPlan`'s exact `channels === 2` guard permanently rejecting it.

Architectural note: `channelFixScope.ts` was split into two modules during this round — it stays pure (`resolveChannelFixForAsset`, `channelFixFingerprint`, no `node:fs`) because `render/plan.ts` imports it and is re-exported by `browser.ts` for the studio-web client bundle; the filesystem-touching sidecar helpers (`readChannelFixSidecar`, `writeChannelFixSidecar`, `channelFixSidecarFresh`) moved to a new `channelFixSidecar.ts`. Missing this split broke the Turbopack client build (`node:fs` in a browser chunk) during this round's work.
