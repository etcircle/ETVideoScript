# Audio Channel Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect recordings where the mic landed on only one stereo channel, persist that as a reversible manifest setting, and apply it everywhere: extraction uses only the live channel; renders duplicate the live channel to both L and R.

**Architecture:** A new core primitive (`analyzeChannelBalance`, ffmpeg astats) feeds a manifest-level `audioChannelFix` field (same pattern as `studioCleanup`). Extraction in `media.ts` swaps `-ac 1` for `pan=mono|c0=<live>`; render planning carries `audioSourceChannel` on the plan; the pipeline prepends `pan=stereo|c0=<live>|c1=<live>` to embedded-audio filter chains. The CLI auto-detects during `extract-audio` and adds a `fix-channels` verb.

**Tech Stack:** TypeScript, zod, vitest, ffmpeg/ffprobe via `spawnSync`. Monorepo: all work is in `packages/core` and `packages/etvideo-cli`.

**Spec:** `docs/superpowers/specs/2026-07-02-audio-channel-fix-design.md` — read it before starting any task.

## Global Constraints

- Never overwrite `input/source.mp4` or `renders/final.mp4`.
- Manifest edits are reversible: disable means `status: 'disabled'`, never delete. `saveManifestV3` already saves a revision before writes — just use it.
- Detection failure must NEVER block `extract-audio` (wrap in try/catch, warn, continue).
- Auto-detection never overwrites an existing `audioChannelFix` (approved OR disabled).
- Run tests from the repo root: `pnpm --filter @etvideoscript/core test -- run <file>` (vitest) and `pnpm -r typecheck` before each commit.
- Tests may assume ffmpeg/ffprobe exist (the rest of the suite does; `pnpm doctor` is the gate).
- Match surrounding code style: dense, heavily-commented-where-subtle, no semicolonless lines, single quotes.
- Commit after each task. Do NOT add any co-author line to commit messages.

---

### Task 1: `AudioChannelFixSchema` + manifest field

**Files:**
- Modify: `packages/core/src/manifest/schema.ts`
- Test: `packages/core/src/__tests__/audio-channel-fix.test.ts` (create)

**Interfaces:**
- Produces: `AudioChannelFixSchema`, `type AudioChannelFix`, optional `audioChannelFix` field on `ManifestV3Schema`. Later tasks import `AudioChannelFix` from `../manifest/schema` and read `manifest.audioChannelFix`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/audio-channel-fix.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AudioChannelFixSchema, ManifestV3Schema } from '../index';

const now = '2026-07-03T00:00:00.000Z';
const presets = { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: '1920x1080', videoBitrate: '6000k', audioBitrate: '192k' } };

// Minimal valid ManifestV3 fixture (mirrors studioCleanup.test.ts).
export function baseManifest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    manifestVersion: 3 as const,
    projectId: 'channel-fix-test',
    createdAt: now,
    updatedAt: now,
    assets: [
      { assetId: 'asset_video_001', kind: 'video' as const, path: 'input/source.mp4', durationSec: 10, provenance: 'imported' as const, video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } }
    ],
    tracks: [
      { trackId: 'track_video_001', kind: 'video' as const, name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 10, timelineStart: 0 }] }
    ],
    operations: [],
    outputs: [{ outputId: 'out_001', kind: 'full' as const, aspects: ['16:9' as const], status: 'manual' as const }],
    renderPresets: presets,
    ...overrides
  };
}

export const validFix = {
  status: 'approved' as const,
  sourceChannel: 'left' as const,
  detection: { leftRmsDb: -18.2, rightRmsDb: -92.4, auto: true },
  appliedAt: now
};

describe('AudioChannelFixSchema', () => {
  it('round-trips a valid approved record', () => {
    const parsed = AudioChannelFixSchema.parse(validFix);
    expect(parsed.status).toBe('approved');
    expect(parsed.sourceChannel).toBe('left');
    expect(parsed.detection.auto).toBe(true);
  });

  it('accepts disabled status and right channel', () => {
    const parsed = AudioChannelFixSchema.parse({ ...validFix, status: 'disabled', sourceChannel: 'right' });
    expect(parsed.status).toBe('disabled');
    expect(parsed.sourceChannel).toBe('right');
  });

  it('rejects unknown status, unknown channel, and missing detection', () => {
    expect(() => AudioChannelFixSchema.parse({ ...validFix, status: 'pending' })).toThrow();
    expect(() => AudioChannelFixSchema.parse({ ...validFix, sourceChannel: 'center' })).toThrow();
    const { detection: _detection, ...withoutDetection } = validFix;
    expect(() => AudioChannelFixSchema.parse(withoutDetection)).toThrow();
  });
});

describe('ManifestV3Schema audioChannelFix field', () => {
  it('parses without the field (back-compat)', () => {
    const parsed = ManifestV3Schema.parse(baseManifest());
    expect(parsed.audioChannelFix).toBeUndefined();
  });

  it('parses with the field and round-trips it', () => {
    const parsed = ManifestV3Schema.parse(baseManifest({ audioChannelFix: validFix }));
    expect(parsed.audioChannelFix?.sourceChannel).toBe('left');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @etvideoscript/core exec vitest run src/__tests__/audio-channel-fix.test.ts`
Expected: FAIL — `AudioChannelFixSchema` is not exported.

- [ ] **Step 3: Implement the schema**

In `packages/core/src/manifest/schema.ts`, after `StudioCleanupSchema`/`StudioCleanup` (line 44), add:

```ts
/**
 * Project-level single-channel-mic fix. Some recordings land the mic on only
 * one stereo channel (speech on L or R, silence on the other). A top-level
 * FIELD (not an OperationKind) for the same reason as studioCleanup: it is a
 * property of the whole recording, not of a clip span.
 *
 * When status is 'approved':
 *   - extraction reads ONLY the live channel (pan=mono) instead of -ac 1
 *     averaging the dead channel in,
 *   - buildRenderPlan sets audioSourceChannel so the pipeline duplicates the
 *     live channel to both L and R (pan=stereo).
 * Set status to 'disabled' to revert without losing the record.
 */
export const AudioChannelFixSchema = z.object({
  /** 'approved' → extraction + render use sourceChannel. 'disabled' → inert, record retained. */
  status: z.enum(['approved', 'disabled']),
  /** Which input channel carries the real audio. */
  sourceChannel: z.enum(['left', 'right']),
  /** Measured per-channel RMS at decision time; auto=false means the user forced the channel. */
  detection: z.object({ leftRmsDb: z.number(), rightRmsDb: z.number(), auto: z.boolean() }),
  /** ISO timestamp of when this record was created. */
  appliedAt: z.string().datetime()
});

export type AudioChannelFix = z.infer<typeof AudioChannelFixSchema>;
```

In `ManifestV3Schema`, after the `studioCleanup` line, add:

```ts
  /** Optional project-level single-channel-mic fix. Absent = stereo source untouched. */
  audioChannelFix: AudioChannelFixSchema.optional()
```

(Remember the comma after the `studioCleanup` entry.)

Check the schema exports reach `../index`: `packages/core/src/browser.ts` or `index.ts` must re-export `manifest/schema`. Run `grep -n "manifest/schema" packages/core/src/browser.ts packages/core/src/index.ts` — if `StudioCleanupSchema` is importable from `../index` (studioCleanup.test.ts does it), `AudioChannelFixSchema` will be too via the same star/named export. If it's a named export list, add `AudioChannelFixSchema` and `type AudioChannelFix` to it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @etvideoscript/core exec vitest run src/__tests__/audio-channel-fix.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -r typecheck
git add packages/core/src/manifest/schema.ts packages/core/src/__tests__/audio-channel-fix.test.ts packages/core/src/browser.ts
git commit -m "feat(core): add AudioChannelFixSchema manifest field"
```

---

### Task 2: `analyzeChannelBalance` detection primitive

**Files:**
- Create: `packages/core/src/channelBalance.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './channelBalance';` after the `./media` export line)
- Test: `packages/core/src/__tests__/channel-balance.test.ts` (create)

**Interfaces:**
- Consumes: `probeRecordingMedia(filePath)` from `./media` (returns `{ audio?: { channels?: number } }`).
- Produces:
  - `CHANNEL_FIX_MIN_DELTA_DB = 20`, `CHANNEL_FIX_DEAD_MAX_RMS_DB = -55`, `CHANNEL_FIX_SILENCE_FLOOR_DB = -120` (exported consts)
  - `type ChannelBalance = { channels: number; leftRmsDb: number | null; rightRmsDb: number | null; recommendation: 'left' | 'right' | null }`
  - `parseAstatsChannelRms(output: string): number[]` (pure, exported for tests)
  - `analyzeChannelBalance(mediaPath: string): ChannelBalance` (throws on ffmpeg failure)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/channel-balance.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHANNEL_FIX_SILENCE_FLOOR_DB,
  analyzeChannelBalance,
  parseAstatsChannelRms
} from '../index';

// Synthesize a 1s stereo WAV where the right channel is the left scaled by `rightGain`.
// rightGain 0 → digital silence on the right (the single-channel-mic case).
function makeStereoWav(dir: string, name: string, rightGain: number): string {
  const path = join(dir, name);
  const result = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000', '-af', `pan=stereo|c0=c0|c1=${rightGain}*c0`, '-acodec', 'pcm_s16le', path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr}`);
  return path;
}

function makeMonoWav(dir: string, name: string): string {
  const path = join(dir, name);
  const result = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000', '-ac', '1', '-acodec', 'pcm_s16le', path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr}`);
  return path;
}

describe('parseAstatsChannelRms', () => {
  it('parses per-channel RMS lines and maps -inf to the silence floor', () => {
    const stderr = [
      '[Parsed_astats_0 @ 0x1] Channel: 1',
      '[Parsed_astats_0 @ 0x1] RMS level dB: -18.234567',
      '[Parsed_astats_0 @ 0x1] Channel: 2',
      '[Parsed_astats_0 @ 0x1] RMS level dB: -inf',
      '[Parsed_astats_0 @ 0x1] Overall',
      '[Parsed_astats_0 @ 0x1] RMS level dB: -21.0'
    ].join('\n');
    const rms = parseAstatsChannelRms(stderr);
    expect(rms).toHaveLength(2);
    expect(rms[0]).toBeCloseTo(-18.234567, 3);
    expect(rms[1]).toBe(CHANNEL_FIX_SILENCE_FLOOR_DB);
  });

  it('ignores the Overall block RMS (no preceding Channel line)', () => {
    const rms = parseAstatsChannelRms('[x] Overall\n[x] RMS level dB: -20.0');
    expect(rms).toHaveLength(0);
  });
});

describe('analyzeChannelBalance', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'etv-chanbal-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('recommends left when the right channel is digitally silent', () => {
    const balance = analyzeChannelBalance(makeStereoWav(dir, 'left-only.wav', 0));
    expect(balance.channels).toBe(2);
    expect(balance.recommendation).toBe('left');
    expect(balance.leftRmsDb).not.toBeNull();
    expect(balance.leftRmsDb! > -10).toBe(true);
    expect(balance.rightRmsDb! <= -55).toBe(true);
  });

  it('recommends nothing for balanced stereo', () => {
    const balance = analyzeChannelBalance(makeStereoWav(dir, 'balanced.wav', 1));
    expect(balance.recommendation).toBeNull();
  });

  it('recommends nothing when the quiet channel is merely quieter, not dead', () => {
    // 0.5x gain ≈ -6 dB relative: well inside the 20 dB delta threshold.
    const balance = analyzeChannelBalance(makeStereoWav(dir, 'quieter.wav', 0.5));
    expect(balance.recommendation).toBeNull();
  });

  it('returns null RMS and no recommendation for mono sources', () => {
    const balance = analyzeChannelBalance(makeMonoWav(dir, 'mono.wav'));
    expect(balance.channels).toBe(1);
    expect(balance.leftRmsDb).toBeNull();
    expect(balance.rightRmsDb).toBeNull();
    expect(balance.recommendation).toBeNull();
  });

  it('throws on a nonexistent file', () => {
    expect(() => analyzeChannelBalance(join(dir, 'missing.wav'))).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @etvideoscript/core exec vitest run src/__tests__/channel-balance.test.ts`
Expected: FAIL — `parseAstatsChannelRms` not exported.

- [ ] **Step 3: Implement `channelBalance.ts`**

Create `packages/core/src/channelBalance.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { probeRecordingMedia } from './media';

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
```

Add to `packages/core/src/index.ts` after `export * from './media';`:

```ts
export * from './channelBalance';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @etvideoscript/core exec vitest run src/__tests__/channel-balance.test.ts`
Expected: PASS (7 tests). If the astats parse fails, run the ffmpeg command by hand on a fixture and check the exact stderr line format ("RMS level dB:") — older ffmpeg builds may not support `measure_perchannel`; if so, drop the `astats=` options (plain `astats`) and rely on the parser's Overall-block skip.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -r typecheck
git add packages/core/src/channelBalance.ts packages/core/src/index.ts packages/core/src/__tests__/channel-balance.test.ts
git commit -m "feat(core): add analyzeChannelBalance detection primitive"
```

---

### Task 3: `applyChannelFix` manifest writer

**Files:**
- Modify: `packages/core/src/channelBalance.ts`
- Test: `packages/core/src/__tests__/channel-fix-apply.test.ts` (create)

**Interfaces:**
- Consumes: `analyzeChannelBalance`, `ChannelBalance` (Task 2); `AudioChannelFix` from `./manifest/schema` (Task 1); `loadManifestV3`, `saveManifestV3` from `./manifest/io`; `assertInside`, `nowIso` from `./filesystem`.
- Produces:

```ts
export type ChannelFixOutcome =
  | { action: 'applied'; fix: AudioChannelFix; balance: ChannelBalance }
  | { action: 'disabled'; fix: AudioChannelFix }
  | { action: 'unchanged'; reason: string; fix?: AudioChannelFix }
  | { action: 'none'; reason: string; balance: ChannelBalance };

export function applyChannelFix(
  workspacePath: string,
  options?: { channel?: 'left' | 'right'; disable?: boolean; analyze?: typeof analyzeChannelBalance }
): ChannelFixOutcome;
```

Semantics:
- `disable: true` → if a fix exists, set `status: 'disabled'` (action `disabled`); if absent, action `unchanged` with reason `'no channel fix to disable'`.
- `channel` set (explicit override) → analyze the source for the detection record (throw if the source is not 2-channel: forcing a channel on mono is an error), write `{ status: 'approved', sourceChannel: channel, detection: { ..., auto: false } }`, OVERWRITING any existing fix (explicit user intent wins). Action `applied`.
- neither (auto mode) → if a fix already exists (any status), action `unchanged` with reason `'existing audioChannelFix preserved'`. Otherwise analyze `input/source.mp4`; if `recommendation` is non-null write the fix with `auto: true` (action `applied`); else action `none` with reason `'channel balance does not indicate a single-channel recording'`.
- `analyze` is dependency-injected for tests only; defaults to `analyzeChannelBalance`.
- The media path analyzed is always `assertInside(workspace, 'input/source.mp4')`; throw if it does not exist.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/channel-fix-apply.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyChannelFix, loadManifestV3, saveManifestV3, type ChannelBalance } from '../index';

const now = '2026-07-03T00:00:00.000Z';
const presets = { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: '1920x1080', videoBitrate: '6000k', audioBitrate: '192k' } };

function manifestFixture() {
  return {
    manifestVersion: 3 as const,
    projectId: 'chanfix-apply-test',
    createdAt: now,
    updatedAt: now,
    assets: [{ assetId: 'asset_video_001', kind: 'video' as const, path: 'input/source.mp4', durationSec: 10, provenance: 'imported' as const, video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } }],
    tracks: [{ trackId: 'track_video_001', kind: 'video' as const, name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 10, timelineStart: 0 }] }],
    operations: [],
    outputs: [{ outputId: 'out_001', kind: 'full' as const, aspects: ['16:9' as const], status: 'manual' as const }],
    renderPresets: presets
  };
}

const oneSided: ChannelBalance = { channels: 2, leftRmsDb: -18, rightRmsDb: -92, recommendation: 'left' };
const balanced: ChannelBalance = { channels: 2, leftRmsDb: -18, rightRmsDb: -19, recommendation: null };
const mono: ChannelBalance = { channels: 1, leftRmsDb: null, rightRmsDb: null, recommendation: null };

describe('applyChannelFix', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'etv-chanfix-'));
    mkdirSync(join(workspace, 'input'), { recursive: true });
    writeFileSync(join(workspace, 'input/source.mp4'), 'stub'); // analyze is injected; content never read
    saveManifestV3(workspace, manifestFixture(), { revision: false });
  });
  afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

  it('auto mode applies a recommended fix and persists it', () => {
    const outcome = applyChannelFix(workspace, { analyze: () => oneSided });
    expect(outcome.action).toBe('applied');
    const manifest = loadManifestV3(workspace);
    expect(manifest.audioChannelFix?.status).toBe('approved');
    expect(manifest.audioChannelFix?.sourceChannel).toBe('left');
    expect(manifest.audioChannelFix?.detection).toEqual({ leftRmsDb: -18, rightRmsDb: -92, auto: true });
  });

  it('auto mode is a no-op on balanced stereo', () => {
    const outcome = applyChannelFix(workspace, { analyze: () => balanced });
    expect(outcome.action).toBe('none');
    expect(loadManifestV3(workspace).audioChannelFix).toBeUndefined();
  });

  it('auto mode never overwrites an existing fix, even a disabled one', () => {
    applyChannelFix(workspace, { analyze: () => oneSided });
    applyChannelFix(workspace, { disable: true });
    const outcome = applyChannelFix(workspace, { analyze: () => ({ ...oneSided, recommendation: 'right' as const }) });
    expect(outcome.action).toBe('unchanged');
    expect(loadManifestV3(workspace).audioChannelFix?.status).toBe('disabled');
    expect(loadManifestV3(workspace).audioChannelFix?.sourceChannel).toBe('left');
  });

  it('explicit channel overrides an existing fix with auto:false', () => {
    applyChannelFix(workspace, { analyze: () => oneSided });
    const outcome = applyChannelFix(workspace, { channel: 'right', analyze: () => balanced });
    expect(outcome.action).toBe('applied');
    const fix = loadManifestV3(workspace).audioChannelFix;
    expect(fix?.sourceChannel).toBe('right');
    expect(fix?.detection.auto).toBe(false);
  });

  it('explicit channel on a non-stereo source throws', () => {
    expect(() => applyChannelFix(workspace, { channel: 'left', analyze: () => mono })).toThrow(/stereo/i);
  });

  it('disable flips status and preserves the record; disable with no fix is unchanged', () => {
    expect(applyChannelFix(workspace, { disable: true }).action).toBe('unchanged');
    applyChannelFix(workspace, { analyze: () => oneSided });
    const outcome = applyChannelFix(workspace, { disable: true });
    expect(outcome.action).toBe('disabled');
    expect(loadManifestV3(workspace).audioChannelFix?.status).toBe('disabled');
  });

  it('throws when input/source.mp4 is missing and analysis is needed', () => {
    rmSync(join(workspace, 'input/source.mp4'));
    expect(() => applyChannelFix(workspace, { analyze: () => oneSided })).toThrow(/source\.mp4/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @etvideoscript/core exec vitest run src/__tests__/channel-fix-apply.test.ts`
Expected: FAIL — `applyChannelFix` not exported.

- [ ] **Step 3: Implement `applyChannelFix`**

Append to `packages/core/src/channelBalance.ts` (new imports at top: `existsSync` from `node:fs`; `resolve` from `node:path`; `assertInside`, `nowIso` from `./filesystem`; `loadManifestV3`, `saveManifestV3` from `./manifest/io`; `type AudioChannelFix` from `./manifest/schema`):

```ts
export type ChannelFixOutcome =
  | { action: 'applied'; fix: AudioChannelFix; balance: ChannelBalance }
  | { action: 'disabled'; fix: AudioChannelFix }
  | { action: 'unchanged'; reason: string; fix?: AudioChannelFix }
  | { action: 'none'; reason: string; balance: ChannelBalance };

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
  const workspace = resolve(workspacePath);
  const analyze = options.analyze ?? analyzeChannelBalance;
  const manifest = loadManifestV3(workspace);
  const existing = manifest.audioChannelFix;

  if (options.disable) {
    if (!existing) return { action: 'unchanged', reason: 'no channel fix to disable' };
    const fix: AudioChannelFix = { ...existing, status: 'disabled' };
    saveManifestV3(workspace, { ...manifest, audioChannelFix: fix });
    return { action: 'disabled', fix };
  }

  const source = assertInside(workspace, 'input/source.mp4');
  if (!existsSync(source)) throw new Error('input/source.mp4 not found; run etvideo import first');

  if (options.channel) {
    const balance = analyze(source);
    if (balance.channels !== 2) throw new Error(`Cannot force a channel on a non-stereo source (${balance.channels} channel(s)); the fix targets 2-channel recordings`);
    const fix: AudioChannelFix = {
      status: 'approved',
      sourceChannel: options.channel,
      detection: { leftRmsDb: balance.leftRmsDb ?? 0, rightRmsDb: balance.rightRmsDb ?? 0, auto: false },
      appliedAt: nowIso()
    };
    saveManifestV3(workspace, { ...manifest, audioChannelFix: fix });
    return { action: 'applied', fix, balance };
  }

  if (existing) return { action: 'unchanged', reason: 'existing audioChannelFix preserved', fix: existing };
  const balance = analyze(source);
  if (!balance.recommendation) return { action: 'none', reason: 'channel balance does not indicate a single-channel recording', balance };
  const fix: AudioChannelFix = {
    status: 'approved',
    sourceChannel: balance.recommendation,
    detection: { leftRmsDb: balance.leftRmsDb ?? 0, rightRmsDb: balance.rightRmsDb ?? 0, auto: true },
    appliedAt: nowIso()
  };
  saveManifestV3(workspace, { ...manifest, audioChannelFix: fix });
  return { action: 'applied', fix, balance };
}
```

Note: `nowIso` must exist in `./filesystem` (media.ts already imports it from there). If `assertInside`/`nowIso` names differ, match media.ts's imports exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @etvideoscript/core exec vitest run src/__tests__/channel-fix-apply.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -r typecheck
git add packages/core/src/channelBalance.ts packages/core/src/__tests__/channel-fix-apply.test.ts
git commit -m "feat(core): add applyChannelFix manifest writer"
```

---

### Task 4: extraction uses only the live channel

**Files:**
- Modify: `packages/core/src/media.ts`
- Test: `packages/core/src/__tests__/channel-fix-extract.test.ts` (create)

**Interfaces:**
- Consumes: `manifest.audioChannelFix` (Task 1), `applyChannelFix` + `parseAstatsChannelRms` (Tasks 2-3, test only).
- Produces: no new public API. `extractAudio`, `extractClipAudio`, `extractFullBandReference` honor an approved `audioChannelFix` internally.

**Background:** all three extraction functions currently pass `'-ac', '1'`, which AVERAGES both channels — a silent channel dilutes speech by ~6 dB. With an approved fix they must instead pass `'-af', 'pan=mono|c0=c0'` (left) or `'-af', 'pan=mono|c0=c1'` (right).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/channel-fix-extract.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyChannelFix, createWorkspace, extractAudio, importSource, parseAstatsChannelRms } from '../index';

// One-sided test video: 320x240 testsrc video + 440 Hz sine on the LEFT channel only.
function makeOneSidedVideo(dir: string): string {
  const path = join(dir, 'one-sided.mp4');
  const result = spawnSync('ffmpeg', ['-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000',
    '-filter_complex', '[1:a]pan=stereo|c0=c0|c1=0*c0[a]',
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr}`);
  return path;
}

// Mono RMS of a wav via astats (parseAstatsChannelRms returns [channel0]).
function rmsDb(path: string): number {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-i', path, '-af', 'astats=measure_perchannel=RMS_level:measure_overall=none', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`astats failed: ${result.stderr}`);
  const rms = parseAstatsChannelRms(result.stderr);
  if (rms[0] === undefined) throw new Error('no RMS parsed');
  return rms[0];
}

describe('extraction honors audioChannelFix', () => {
  let dir: string;
  let workspace: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'etv-chanfix-extract-'));
    workspace = join(dir, 'ws');
    await createWorkspace({ workspacePath: workspace, projectId: 'chanfix-extract', title: 'Channel fix extract test' });
    await importSource(workspace, makeOneSidedVideo(dir));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('extracts only the live channel when the fix is approved (≈6 dB louder than averaging)', async () => {
    // Baseline: no fix → -ac 1 averages the silent channel in.
    await extractAudio(workspace, { overwrite: true, logJob: false });
    const averagedRms = rmsDb(join(workspace, 'media/extracted-audio.wav'));

    const outcome = applyChannelFix(workspace);
    expect(outcome.action).toBe('applied');
    if (outcome.action === 'applied') expect(outcome.fix.sourceChannel).toBe('left');

    await extractAudio(workspace, { overwrite: true, logJob: false });
    const fixedRms = rmsDb(join(workspace, 'media/extracted-audio.wav'));

    // Averaging a dead channel costs 6.02 dB; allow encoder slack.
    expect(fixedRms - averagedRms).toBeGreaterThan(4);
  }, 60_000);

  it('a disabled fix falls back to plain -ac 1 averaging', async () => {
    applyChannelFix(workspace, { disable: true });
    await extractAudio(workspace, { overwrite: true, logJob: false });
    const disabledRms = rmsDb(join(workspace, 'media/extracted-audio.wav'));
    applyChannelFix(workspace, { channel: 'left' }); // restore for any later test
    await extractAudio(workspace, { overwrite: true, logJob: false });
    const fixedRms = rmsDb(join(workspace, 'media/extracted-audio.wav'));
    expect(fixedRms - disabledRms).toBeGreaterThan(4);
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @etvideoscript/core exec vitest run src/__tests__/channel-fix-extract.test.ts`
Expected: FAIL on the dB-delta assertions (extraction ignores the fix, so both RMS values are equal). If it fails on fixture creation instead, fix the fixture before proceeding.

- [ ] **Step 3: Implement in `media.ts`**

Add two helpers to `packages/core/src/media.ts` above `extractAudio` (`loadManifestV3` is already imported):

```ts
// Approved audioChannelFix → live channel of the base recording; undefined otherwise.
// Tolerates a missing/invalid manifest: extraction must keep working in degraded
// workspaces, and the fix simply doesn't apply there.
function manifestSourceChannel(workspace: string): 'left' | 'right' | undefined {
  try {
    const manifest = loadManifestV3(workspace);
    return manifest.audioChannelFix?.status === 'approved' ? manifest.audioChannelFix.sourceChannel : undefined;
  } catch {
    return undefined;
  }
}

// Mono-downmix args for extraction. Default `-ac 1` AVERAGES all channels, so a
// dead channel dilutes speech by ~6 dB; with an approved channel fix we take ONLY
// the live channel. Falls back to -ac 1 when the file is not stereo — a pan
// referencing a missing input channel would fail the whole ffmpeg run.
function monoDownmixArgs(sourceChannel: 'left' | 'right' | undefined, sourcePath: string): string[] {
  if (!sourceChannel) return ['-ac', '1'];
  const channels = probeRecordingMedia(sourcePath).audio?.channels ?? 0;
  if (channels < 2) return ['-ac', '1'];
  return ['-af', `pan=mono|c0=${sourceChannel === 'left' ? 'c0' : 'c1'}`];
}
```

Then change the three ffmpeg invocations:

1. `extractAudio` (currently `run('ffmpeg', ['-y', '-i', source, '-vn', '-ac', '1', '-ar', String(options.sampleRate || 16000), ...codec, output], workspace);`):

```ts
  run('ffmpeg', ['-y', '-i', source, '-vn', ...monoDownmixArgs(manifestSourceChannel(workspace), source), '-ar', String(options.sampleRate || 16000), ...codec, output], workspace);
```

2. `extractClipAudio` — same replacement of `'-ac', '1'`, but it already has `manifest` in scope, so use it directly instead of re-loading:

```ts
  const sourceChannel = manifest.audioChannelFix?.status === 'approved' ? manifest.audioChannelFix.sourceChannel : undefined;
  run('ffmpeg', ['-y', '-i', source, '-vn', ...monoDownmixArgs(sourceChannel, source), '-ar', String(options.sampleRate || 16000), ...codec, output], workspace);
```

3. `extractFullBandReference` — same pattern (it also has `manifest` in scope); replace `'-ac', '1'` in the `run('ffmpeg', ...)` call with `...monoDownmixArgs(sourceChannel, source)` after computing `sourceChannel` the same way. The output stays mono, so `isValidFullBandReference` is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @etvideoscript/core exec vitest run src/__tests__/channel-fix-extract.test.ts`
Expected: PASS (2 tests).

Also run the neighboring media suites to catch regressions:
`pnpm --filter @etvideoscript/core exec vitest run src/__tests__/media.v2.test.ts src/__tests__/reference-audio.test.ts src/__tests__/audio-clip.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -r typecheck
git add packages/core/src/media.ts packages/core/src/__tests__/channel-fix-extract.test.ts
git commit -m "feat(core): extraction honors audioChannelFix live channel"
```

---

### Task 5: render plan carries `audioSourceChannel`; import records channel count

**Files:**
- Modify: `packages/core/src/render/plan.ts`
- Modify: `packages/core/src/media.ts` (importSource: record `channels` in asset audio metadata)
- Test: extend `packages/core/src/__tests__/audio-channel-fix.test.ts`

**Interfaces:**
- Consumes: `manifest.audioChannelFix` (Task 1).
- Produces: `V3RenderPlan.audioSourceChannel?: 'left' | 'right'` — Task 6's pipeline reads exactly this property name.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/__tests__/audio-channel-fix.test.ts` (import `buildRenderPlanV3` from `../index`; reuse `baseManifest` and `validFix` from Task 1 — they are exported):

```ts
describe('buildRenderPlan audioSourceChannel', () => {
  it('is set when the fix is approved', () => {
    const manifest = ManifestV3Schema.parse(baseManifest({ audioChannelFix: validFix }));
    expect(buildRenderPlanV3(manifest).audioSourceChannel).toBe('left');
  });

  it('is absent when the fix is disabled or missing', () => {
    const disabled = ManifestV3Schema.parse(baseManifest({ audioChannelFix: { ...validFix, status: 'disabled' } }));
    expect(buildRenderPlanV3(disabled).audioSourceChannel).toBeUndefined();
    expect(buildRenderPlanV3(ManifestV3Schema.parse(baseManifest())).audioSourceChannel).toBeUndefined();
  });

  it('is absent when the base asset is known mono (stale fix must not fail the render)', () => {
    const fixture = baseManifest({ audioChannelFix: validFix });
    (fixture.assets as Array<{ audio?: { sampleRate?: number; channels?: number } }>)[0]!.audio = { sampleRate: 48000, channels: 1 };
    expect(buildRenderPlanV3(ManifestV3Schema.parse(fixture)).audioSourceChannel).toBeUndefined();
  });

  it('is absent for multi-video-source projects (fix describes only the base recording)', () => {
    const fixture = baseManifest({ audioChannelFix: validFix });
    (fixture.assets as unknown[]).push({ assetId: 'asset_video_002', kind: 'video', path: 'assets/video/b.mp4', durationSec: 5, provenance: 'imported', video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } });
    (fixture.tracks as Array<{ clips: unknown[] }>)[0]!.clips.push({ clipId: 'clip_002', assetId: 'asset_video_002', sourceStart: 0, sourceEnd: 5, timelineStart: 10 });
    expect(buildRenderPlanV3(ManifestV3Schema.parse(fixture)).audioSourceChannel).toBeUndefined();
  });

  it('trusts the fix when channel metadata is absent (older imports)', () => {
    const fixture = baseManifest({ audioChannelFix: validFix });
    (fixture.assets as Array<{ audio?: { sampleRate?: number } }>)[0]!.audio = { sampleRate: 48000 };
    expect(buildRenderPlanV3(ManifestV3Schema.parse(fixture)).audioSourceChannel).toBe('left');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @etvideoscript/core exec vitest run src/__tests__/audio-channel-fix.test.ts`
Expected: the new describe block FAILS (`audioSourceChannel` is undefined everywhere / not a property); Task 1's tests still pass.

- [ ] **Step 3: Implement**

In `packages/core/src/render/plan.ts`:

(a) Add to the `V3RenderPlan` interface, after `studioCleanupAudioPath`:

```ts
  /**
   * When set, the pipeline duplicates this channel of embedded video audio to
   * both stereo channels (single-channel-mic fix, pan=stereo|c0=cN|c1=cN).
   * Populated by buildRenderPlan when manifest.audioChannelFix.status ===
   * 'approved', the project has a single video source (same scope guard as
   * studioCleanup), and the base asset is not known to be mono.
   */
  audioSourceChannel?: 'left' | 'right';
```

(b) In `buildRenderPlan`, right after the existing `studioCleanupAudioPath` computation (it already computes `videoSourceIds`):

```ts
  // Single-channel-mic fix: same single-source scope guard as studioCleanup — the
  // fix describes the base recording, so a multi-source project must not pan clips
  // it does not describe. The channels guard skips assets recorded mono (a pan
  // referencing input channel c1 would fail the ffmpeg run); channels === undefined
  // (imports that predate channel metadata) trusts the fix, which is only ever
  // written after probing 2 channels on the source.
  const baseVideoAssetId = videoSourceIds.size === 1 ? Array.from(videoSourceIds)[0] : undefined;
  const baseVideoAsset = baseVideoAssetId !== undefined ? manifest.assets.find((asset) => asset.assetId === baseVideoAssetId) : undefined;
  const audioSourceChannel =
    manifest.audioChannelFix?.status === 'approved'
    && videoSourceIds.size <= 1
    && (baseVideoAsset?.audio?.channels === undefined || baseVideoAsset.audio.channels >= 2)
      ? manifest.audioChannelFix.sourceChannel
      : undefined;
```

(c) In the returned object, after the `studioCleanupAudioPath` spread:

```ts
    ...(audioSourceChannel !== undefined ? { audioSourceChannel } : {})
```

(d) In `packages/core/src/media.ts` `importSource`, record the channel count so the plan-level mono guard has data. Change the `addAsset` audio line from:

```ts
      audio: clipSource.audioSampleRate ? { sampleRate: clipSource.audioSampleRate, codec: clipSource.audioCodec || undefined } : undefined
```

to:

```ts
      audio: clipSource.audioSampleRate ? { sampleRate: clipSource.audioSampleRate, channels: probeRecordingMedia(target).audio?.channels, codec: clipSource.audioCodec || undefined } : undefined
```

(`AudioMetadataSchema` in `packages/core/src/assets/schema.ts` already has an optional `channels` field — no schema change needed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @etvideoscript/core exec vitest run src/__tests__/audio-channel-fix.test.ts src/__tests__/studioCleanup.test.ts src/__tests__/v3-render-timemap.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -r typecheck
git add packages/core/src/render/plan.ts packages/core/src/media.ts packages/core/src/__tests__/audio-channel-fix.test.ts
git commit -m "feat(core): render plan carries audioSourceChannel for channel fix"
```

---

### Task 6: pipeline duplicates the live channel to both L and R

**Files:**
- Modify: `packages/core/src/render/pipeline.ts`
- Test: extend `packages/core/src/__tests__/audio-channel-fix.test.ts`

**Interfaces:**
- Consumes: `plan.audioSourceChannel` (Task 5).
- Produces: no new API — `buildFfmpegCommand` output changes.

**Where the pan goes.** Three places read embedded audio from the source video; each gets `pan=stereo|c0=<c>|c1=<c>` (where `<c>` is `c0` for left, `c1` for right) PREPENDED to the chain when `plan.audioSourceChannel` is set:

1. The base concat audio chain (`[N:a]atrim=...` in the main visual loop's else-branch) — but ONLY when reading the original video (`cleanInputIndex === undefined`). The studio-cleaned WAV is derived from channel-fixed extraction and is not one-sided.
2. Structural audio chains (`[N:a]atrim=...adelay...[mixK]`) — only for segments with `source === 'embedded-video-audio'` (separate audio-track files are not the base recording).
3. `stageHandlers.audioBed`'s sampled-segment branch — only when the sampled segment has `source === 'embedded-video-audio'`.

Generated audio (anullsrc silence, voice-patch inserts, sine beds) is already stereo — untouched.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/__tests__/audio-channel-fix.test.ts` (add `buildFfmpegCommandV3` to the imports from `../index`):

```ts
describe('buildFfmpegCommand channel-fix pan', () => {
  function filterComplex(fixtureOverrides: Partial<Record<string, unknown>> = {}) {
    const manifest = ManifestV3Schema.parse(baseManifest(fixtureOverrides));
    const command = buildFfmpegCommandV3('/tmp/etv-chanfix', buildRenderPlanV3(manifest), 'renders/draft.mp4');
    const index = command.args.indexOf('-filter_complex');
    return command.args[index + 1]!;
  }

  it('prepends pan=stereo duplication for an approved left fix', () => {
    expect(filterComplex({ audioChannelFix: validFix })).toContain('pan=stereo|c0=c0|c1=c0');
  });

  it('uses c1 for a right-channel fix', () => {
    expect(filterComplex({ audioChannelFix: { ...validFix, sourceChannel: 'right' } })).toContain('pan=stereo|c0=c1|c1=c1');
  });

  it('emits no pan when the fix is disabled or absent', () => {
    expect(filterComplex({ audioChannelFix: { ...validFix, status: 'disabled' } })).not.toContain('pan=stereo');
    expect(filterComplex()).not.toContain('pan=stereo');
  });

  it('does not pan the studio-cleaned WAV (cleanup swap wins)', () => {
    const cleanup = { status: 'approved' as const, assetPath: 'assets/studio-clean/k.wav', cacheKey: 'k', provider: 'studio-sound.test', createdAt: '2026-07-03T00:00:00.000Z' };
    const fc = filterComplex({ audioChannelFix: validFix, studioCleanup: cleanup });
    // The base audio chain reads the cleaned WAV; no stereo pan on it.
    expect(fc).not.toContain('pan=stereo');
  });

  it('is deterministic across runs', () => {
    expect(filterComplex({ audioChannelFix: validFix })).toBe(filterComplex({ audioChannelFix: validFix }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @etvideoscript/core exec vitest run src/__tests__/audio-channel-fix.test.ts`
Expected: the two positive-pan tests FAIL (no `pan=stereo` emitted); the negative tests pass.

- [ ] **Step 3: Implement in `pipeline.ts`**

(a) Add a helper next to `atempoChain`:

```ts
// Single-channel-mic fix: duplicate the live channel of a one-sided recording to
// both stereo channels. Applied ONLY to chains reading embedded audio from the
// source video; generated audio (anullsrc, voice patches, sine beds) and the
// studio-cleaned WAV (derived from channel-fixed extraction) are not one-sided.
function channelFixPan(channel: 'left' | 'right'): string {
  const live = channel === 'left' ? 'c0' : 'c1';
  return `pan=stereo|c0=${live}|c1=${live}`;
}
```

(b) In `buildFfmpegCommand`'s main visual loop, in the else-branch that builds the embedded audio chain (where `audioInputIndex` is computed from `cleanInputIndex`), add immediately after the `const audioInputIndex = ...` line:

```ts
      // Channel fix applies only when reading the ORIGINAL video audio; the studio-
      // cleaned WAV swap already carries fixed audio.
      if (plan.audioSourceChannel && cleanInputIndex === undefined) af.unshift(channelFixPan(plan.audioSourceChannel));
```

(c) In the structural-audio loop (`for (const segment of structuralAudioSegments)`), change the `audioFilters.push(...)` line to:

```ts
    const pan = plan.audioSourceChannel && segment.source === 'embedded-video-audio' ? `${channelFixPan(plan.audioSourceChannel)},` : '';
    audioFilters.push(`[${inputIndex}:a]${pan}atrim=start=${roundSec6(clipOffset)}:end=${roundSec6(clipEnd)},asetpts=PTS-STARTPTS,adelay=${delay}|${delay}[mix${structuralAudioIndex}]`);
```

(d) In `stageHandlers.audioBed`, the final sampled-segment `filters.push` (the one starting `[${inputIndex}:a]atrim=start=...`) becomes:

```ts
    const pan = plan.audioSourceChannel && segment.source === 'embedded-video-audio' ? `${channelFixPan(plan.audioSourceChannel)},` : '';
    filters.push(`[${inputIndex}:a]${pan}atrim=start=${roundSec6(sourceStart)}:end=${roundSec6(sourceEnd)},asetpts=PTS-STARTPTS,${atempoChain(tempo)},atrim=0:${roundSec6(duration)},adelay=${delay}|${delay}[${label}]`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @etvideoscript/core exec vitest run src/__tests__/audio-channel-fix.test.ts`
Expected: PASS.

Then run the full render-adjacent suites to catch filter-chain regressions:
`pnpm --filter @etvideoscript/core exec vitest run src/__tests__/v3-render-timemap.test.ts src/__tests__/v3-new-ops.test.ts src/__tests__/voice-patch-shorter-render.test.ts src/__tests__/voice-patch-longer-render.test.ts src/__tests__/render-enhance-determinism.test.ts src/__tests__/studioCleanup.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -r typecheck
git add packages/core/src/render/pipeline.ts packages/core/src/__tests__/audio-channel-fix.test.ts
git commit -m "feat(core): render pipeline duplicates live channel to both stereo channels"
```

---

### Task 7: CLI — `fix-channels` verb + auto-detect in `extract-audio`

**Files:**
- Modify: `packages/etvideo-cli/src/index.ts`
- Test: run the CLI end-to-end by hand against a synthesized workspace (steps below); the core behavior is already unit-tested.

**Interfaces:**
- Consumes: `analyzeChannelBalance`, `applyChannelFix`, `type ChannelFixOutcome` from `@etvideoscript/core` (add them to the big import at the top of the CLI file).

- [ ] **Step 1: Auto-detection in `handleExtractAudioCommand`**

In `packages/etvideo-cli/src/index.ts`, extend `CliHandlerDeps` with `applyChannelFix: typeof applyChannelFix;` and add it to `defaultCliDeps`. Then at the top of `handleExtractAudioCommand`, after `const workspace = ...`:

```ts
  // Auto-detect single-channel-mic recordings before extraction so the pan applies to
  // this run. Never blocks extraction: detection failure is a warning, and an existing
  // audioChannelFix (approved or disabled) is always preserved by applyChannelFix.
  let channelFix: ReturnType<typeof applyChannelFix> | undefined;
  try {
    channelFix = deps.applyChannelFix(workspace);
    if (channelFix.action === 'applied') {
      const { detection } = channelFix.fix;
      console.warn(`Detected single-channel recording (L ${detection.leftRmsDb.toFixed(1)} dB / R ${detection.rightRmsDb.toFixed(1)} dB); using ${channelFix.fix.sourceChannel} channel. Revert with: ets fix-channels --disable`);
    }
  } catch (err) {
    console.warn(`Channel-balance detection skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
```

And include it in the JSON output: change the `deps.print(...)` line to:

```ts
  deps.print(rootOpts.json ? { outputs, ...(channelFix && channelFix.action !== 'unchanged' ? { channelFix } : {}) } : `Audio ready: ${outputs.join(', ')}`, rootOpts.json);
```

Check for existing CLI tests that construct `CliHandlerDeps` (run `grep -rn "CliHandlerDeps\|handleExtractAudioCommand" packages/etvideo-cli/src packages/etvideo-cli/test 2>/dev/null`) and add the new `applyChannelFix` field to any test fixtures (a stub returning `{ action: 'none', reason: 'test', balance: { channels: 2, leftRmsDb: -18, rightRmsDb: -19, recommendation: null } }` is fine).

- [ ] **Step 2: Add the `fix-channels` verb**

After the `peaks` command registration:

```ts
program.command('fix-channels').description('Detect/repair single-channel mic recordings (fill both channels from the live one)')
  .option('--channel <side>', 'force left or right as the live channel')
  .option('--disable', 'disable an existing channel fix (record is kept)')
  .option('--detect-only', 'analyze and print channel balance without writing the manifest')
  .action((opts) => {
    const workspace = workspaceOption(program.opts().workspace);
    if (opts.channel && !['left', 'right'].includes(opts.channel)) throw new Error('--channel must be left or right');
    if (opts.detectOnly) {
      const balance = analyzeChannelBalance(resolve(workspace, 'input/source.mp4'));
      print(program.opts().json ? balance : `channels: ${balance.channels}\nleft RMS: ${balance.leftRmsDb?.toFixed(1) ?? 'n/a'} dB\nright RMS: ${balance.rightRmsDb?.toFixed(1) ?? 'n/a'} dB\nrecommendation: ${balance.recommendation ?? 'none (balanced or non-stereo)'}`, program.opts().json);
      return;
    }
    const outcome = applyChannelFix(workspace, { channel: opts.channel as 'left' | 'right' | undefined, disable: Boolean(opts.disable) });
    const summary = outcome.action === 'applied'
      ? `Channel fix applied: ${outcome.fix.sourceChannel} (auto: ${outcome.fix.detection.auto}). Re-run "ets extract-audio --yes" and "ets transcribe" to refresh derived audio.`
      : outcome.action === 'disabled' ? 'Channel fix disabled (record kept). Re-run "ets extract-audio --yes" to restore averaged extraction.'
      : outcome.action === 'unchanged' ? `No change: ${outcome.reason}`
      : `No fix needed: ${outcome.reason}`;
    print(program.opts().json ? outcome : summary, program.opts().json);
  });
```

Add `analyzeChannelBalance` and `applyChannelFix` to the `@etvideoscript/core` import list at the top of the file.

- [ ] **Step 3: Typecheck, build, run the full test suite**

```bash
pnpm -r typecheck && pnpm build && pnpm test
```
Expected: all green.

- [ ] **Step 4: E2E smoke test**

```bash
cd /tmp && rm -rf etv-chanfix-e2e && mkdir etv-chanfix-e2e && cd etv-chanfix-e2e
ffmpeg -y -f lavfi -i "testsrc=duration=2:size=320x240:rate=30" -f lavfi -i "sine=frequency=440:duration=2:sample_rate=48000" -filter_complex "[1:a]pan=stereo|c0=c0|c1=0*c0[a]" -map 0:v -map "[a]" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest one-sided.mp4
node <repo>/packages/etvideo-cli/dist/index.js init --project-id chanfix-e2e --title "Chanfix E2E" --workspace ./ws   # or `pnpm --filter @etvideoscript/etvideo-cli exec ets ...` — use however the repo runs the CLI
ets --workspace ./ws import ../one-sided.mp4
ets --workspace ./ws fix-channels --detect-only        # expect: recommendation: left
ets --workspace ./ws extract-audio                     # expect: "Detected single-channel recording..." warning
ets --workspace ./ws fix-channels --json               # expect: action unchanged (already applied)
ets --workspace ./ws render --preset draft
ffprobe -v error -select_streams a:0 -show_entries stream=channels -of default=noprint_wrappers=1 ws/renders/draft.mp4   # expect: channels=2
# Verify both channels carry signal:
ffmpeg -hide_banner -i ws/renders/draft.mp4 -af "astats=measure_perchannel=RMS_level:measure_overall=none" -f null - 2>&1 | grep "RMS level dB"
# expect: BOTH channel RMS values within ~1 dB of each other and > -30 dB (i.e., neither is silent)
```

Record the actual RMS output in the task report.

- [ ] **Step 5: Commit**

```bash
git add packages/etvideo-cli/src/index.ts
git commit -m "feat(cli): fix-channels verb and extract-audio auto-detection"
```

---

## Final verification (after all tasks)

- [ ] `pnpm -r typecheck && pnpm build && pnpm test` — all green from a clean state.
- [ ] Re-read the spec (`docs/superpowers/specs/2026-07-02-audio-channel-fix-design.md`) section by section and confirm each requirement maps to shipped code.
- [ ] Confirm `input/source.mp4` in the E2E workspace was never modified (`shasum` before/after).
