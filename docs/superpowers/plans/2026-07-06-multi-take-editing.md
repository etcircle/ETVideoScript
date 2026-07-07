# Multi-Take Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import multiple takes of the same content, deterministically align them to a reference script, and let a CLI-driven agent compose the best cut per section into the timeline, guided by a user brief.

**Architecture:** Takes are staged as clips on a non-renderable `role: 'staging'` track so existing per-clip transcription works unchanged. Pure functions in `@etvideoscript/core` compute cross-take alignment (`takes/alignment.json`) and materialize an agent-authored `takes/composition.json` into ordinary timeline clips. The render pipeline is untouched (multi-input concat already works).

**Tech Stack:** TypeScript, zod, vitest, Commander, pnpm monorepo. New dependency: `yaml@^2` in `@etvideoscript/core`.

**Spec:** `docs/superpowers/specs/2026-07-06-multi-take-editing-design.md` (committed). Section references (§) below point there. The spec is normative for every constant, formula, and rule; this plan repeats them where code needs them.

## Global Constraints

- Import from core as `@etvideoscript/core` (the real package name; docs sometimes write `@etvideo/core`).
- Run tests from the REPO ROOT: `npx vitest run <path>` (vitest breaks when invoked from package dirs - known gotcha).
- Typecheck: `pnpm -r typecheck`. Full suite: `npx vitest run`.
- Baseline failures: `apps/local-api/src/server.test.ts` has 10 known failures on main. Those are NOT regressions. Everything else must stay green.
- NEVER import `node:fs` (directly or transitively) from `packages/core/src/browser.ts` or anything it re-exports - it silently breaks the studio-web build. All new node-only modules are exported from `packages/core/src/index.ts` only.
- Pure functions must be deterministic: no `Date.now()`, `Math.random()`, `randomUUID()` inside them. Timestamps (`generatedAt`, `appliedAt`) are injected at the CLI/agent-tool layer via `nowIso()` from `../filesystem`.
- Manifest ops are never deleted - set `status: 'disabled'` (op status enum: `proposed | awaiting_approval | approved | rejected | disabled`).
- All workspace file paths go through `assertInside(workspace, relPath)` from `packages/core/src/filesystem.ts` (see `manifest/io.ts` for the pattern).
- Commit style: conventional commits (`feat(core): ...`, `test(core): ...`), NO co-author lines, no em dashes anywhere.
- Constants (already fixed by spec, do not re-derive): `MIN_CANDIDATE_COVERAGE = 0.5`, `MIN_ORPHAN_WORDS = 8`, `LOW_CONFIDENCE_MATCH_FRACTION = 0.3`, `BOUNDARY_WARN_THRESHOLD = 0.5`, `ALIGN_SCORES = { match: 2, mismatch: -1, gap: -1 }`, `COMPOSE_PAD = { headSec: 0.12, tailSec: 0.12 }`, span size 3..40 words, sentence-gap 0.8s, boundary-gap cap 2s over 0.6s ramp.

---

### Task 1: Staging track role

**Files:**
- Modify: `packages/core/src/tracks/schema.ts` (TrackSchema, ~line 28)
- Modify: `packages/core/src/timeMap/compose.ts:11-25` (`buildBaseTimeline`)
- Modify: `packages/core/src/transcript.ts:225-244` (`primaryVideoClips`, `transcribableClips`)
- Modify: `packages/core/src/manifest/validate.ts` (`validateManifestV3Document`, after the asset-id loop)
- Modify: `packages/core/src/render/plan.ts:213-217` (`videoSourceIds` computation - exclude staging tracks; see spec §12 point 3, added after the rebase onto spec/audio-channel-fix)
- Create: `packages/core/src/__tests__/takes-fixtures.ts`
- Test: `packages/core/src/__tests__/staging-track.test.ts`

**Interfaces:**
- Consumes: existing `TrackSchema`, `buildBaseTimeline(tracks)`, `validateManifestV3Document(input, ctx)`.
- Produces: `Track.role: 'timeline' | 'staging'` (default `'timeline'`); `makeManifest(partial?)` and `makeClip(id, assetId, dur)` fixture helpers used by Tasks 2, 9, 11.

- [ ] **Step 1: Write fixtures + failing tests**

`packages/core/src/__tests__/takes-fixtures.ts`:

```ts
import type { ManifestV3 } from '../manifest/schema';
import type { Clip, Track } from '../tracks/schema';

export function makeClip(clipId: string, assetId: string, durationSec: number, timelineStart = 0): Clip {
  return { clipId, assetId, sourceStart: 0, sourceEnd: durationSec, timelineStart, audioDetached: undefined, detachedFrom: undefined, transitionAfter: undefined };
}

export function makeTrack(partial: Partial<Track> & Pick<Track, 'trackId' | 'kind'>): Track {
  return { name: partial.trackId, order: 0, locked: false, muted: false, solo: false, hidden: false, role: 'timeline', clips: [], subtype: undefined, fx: undefined, ...partial };
}

export function makeManifest(partial: Partial<ManifestV3> = {}): ManifestV3 {
  return {
    manifestVersion: 3, projectId: 'proj_test',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    assets: [], tracks: [], operations: [], outputs: [],
    renderPresets: {
      draft: { resolution: '1280x720', videoBitrate: '2M', audioBitrate: '128k' },
      youtube: { resolution: '1920x1080', videoBitrate: '8M', audioBitrate: '192k' }
    },
    ...partial
  } as ManifestV3;
}

export function makeVideoAsset(assetId: string, durationSec: number, path = `input/takes/${assetId}.mp4`) {
  return { assetId, kind: 'video' as const, path, durationSec, provenance: 'imported' as const, video: { width: 1920, height: 1080, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } };
}
```

`packages/core/src/__tests__/staging-track.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TrackSchema } from '../tracks/schema';
import { buildBaseTimeline } from '../timeMap/compose';
import { primaryVideoClips, transcribableClips } from '../transcript';
import { validateManifestV3Document } from '../manifest/validate';
import { makeClip, makeManifest, makeTrack, makeVideoAsset } from './takes-fixtures';

const timeline = makeTrack({ trackId: 'track_video', kind: 'video', clips: [makeClip('clip_001', 'a1', 10)] });
const staging = makeTrack({ trackId: 'track_takes', kind: 'video', role: 'staging', hidden: true, order: 1000, clips: [makeClip('clip_take_01', 'a2', 20)] });

describe('Track.role', () => {
  it('defaults to timeline for existing manifests (back-compat)', () => {
    const parsed = TrackSchema.parse({ trackId: 't1', kind: 'video', name: 'V', order: 0, clips: [] });
    expect(parsed.role).toBe('timeline');
  });

  it('buildBaseTimeline excludes staging tracks', () => {
    const map = buildBaseTimeline([timeline, staging]);
    expect(map.segments.map((s) => s.clipId)).toEqual(['clip_001']);
  });

  it('transcribableClips includes staging clips after timeline clips', () => {
    const manifest = makeManifest({ assets: [makeVideoAsset('a1', 10), makeVideoAsset('a2', 20)], tracks: [timeline, staging] });
    expect(transcribableClips(manifest).map((c) => c.clipId)).toEqual(['clip_001', 'clip_take_01']);
  });

  it('transcribableClips still lists takes when timeline is empty (pre-compose)', () => {
    const emptyTimeline = makeTrack({ trackId: 'track_video', kind: 'video' });
    const manifest = makeManifest({ assets: [makeVideoAsset('a2', 20)], tracks: [emptyTimeline, staging] });
    expect(transcribableClips(manifest).map((c) => c.clipId)).toEqual(['clip_take_01']);
  });

  it('primaryVideoClips never returns staging clips', () => {
    const emptyTimeline = makeTrack({ trackId: 'track_video', kind: 'video' });
    const manifest = makeManifest({ assets: [makeVideoAsset('a2', 20)], tracks: [emptyTimeline, staging] });
    expect(primaryVideoClips(manifest)).toEqual([]);
  });

  it('rejects two staging tracks', () => {
    const staging2 = makeTrack({ trackId: 'track_takes2', kind: 'video', role: 'staging' });
    const result = validateManifestV3Document(makeManifest({ assets: [makeVideoAsset('a2', 20)], tracks: [staging, staging2] }));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/at most one staging track/i);
  });

  it('rejects a non-video staging track', () => {
    const badStaging = makeTrack({ trackId: 'track_takes', kind: 'audio', role: 'staging' });
    const result = validateManifestV3Document(makeManifest({ tracks: [badStaging] }));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/staging track must be a video track/i);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run packages/core/src/__tests__/staging-track.test.ts`
Expected: FAIL (role missing from type, staging not excluded, validation messages missing).

- [ ] **Step 3: Implement**

`tracks/schema.ts` - inside `TrackSchema` object, after `hidden`:

```ts
  role: z.enum(['timeline', 'staging']).default('timeline'),
```

`timeMap/compose.ts` - first line of `buildBaseTimeline`:

```ts
export function buildBaseTimeline(tracks: Track[]): TimeMap {
  const renderable = tracks.filter((track) => track.role !== 'staging');
  const segments = renderable.flatMap((track) => track.clips.map((clip) => {
```

(keep the rest of the body identical, using `renderable`).

`transcript.ts` - replace both functions:

```ts
export function primaryVideoClips(manifest: ManifestV3): Array<{ clipId: string }> {
  const timelineVideo = manifest.tracks.filter((t) => t.kind === 'video' && t.role !== 'staging');
  const track = timelineVideo.find((t) => t.clips.length > 0) ?? timelineVideo[0] ?? manifest.tracks.find((t) => t.role !== 'staging');
  return (track?.clips ?? []).flatMap((clip) => clip.clipId ? [{ clipId: clip.clipId }] : []);
}

export function transcribableClips(manifest: ManifestV3): Array<{ clipId: string }> {
  const timelineVideo = manifest.tracks.filter((t) => t.kind === 'video' && t.role !== 'staging');
  const videoTrack = timelineVideo.find((t) => t.clips.length > 0) ?? timelineVideo[0];
  const stagingTracks = manifest.tracks.filter((t) => t.role === 'staging');
  const voiceoverTracks = manifest.tracks.filter((t) => t.kind === 'audio' && t.subtype === 'voiceover');
  const seen = new Set<string>();
  // Preserve the EXISTING chronological (timelineStart) ordering for the renderable
  // timeline-video + voiceover clips — mergeTranscripts/transcribeAllClips consume this
  // order to assemble the merged transcript, and transcribableClips.test.ts pins it.
  const timelineOrdered = [videoTrack, ...voiceoverTracks]
    .flatMap((track) => (track?.clips ?? []).map((clip) => ({ clipId: clip.clipId, timelineStart: clip.timelineStart, order: track?.order ?? 0 })))
    .filter((clip) => clip.clipId)
    .sort((a, b) => a.timelineStart - b.timelineStart || a.order - b.order);
  // Append staging clips AFTER, in track/import order (not re-sorted — all staging clips
  // have timelineStart 0, so their meaningful order is import order).
  const stagingOrdered = stagingTracks
    .flatMap((track) => track.clips.map((clip) => ({ clipId: clip.clipId })))
    .filter((clip) => clip.clipId);
  return [...timelineOrdered, ...stagingOrdered]
    .filter((clip) => {
      if (seen.has(clip.clipId)) return false;
      seen.add(clip.clipId);
      return true;
    })
    .map((clip) => ({ clipId: clip.clipId }));
}
```

NOTE (corrected during Task 1 review): keep the EXISTING chronological sort for the renderable timeline-video + voiceover clips - `mergeTranscripts`/`transcribeAllClips` consume this order and `transcribableClips.test.ts` pins it, so removing the sort entirely would be a real regression. Staging clips are appended AFTER that ordered set, in track/import order (they all have timelineStart 0, so import order is their meaningful order). This satisfies both the new staging tests and the pre-existing pinned test.

`manifest/validate.ts` - inside `validateManifestV3Document`, right after the track/clip loop (~line 127):

```ts
  const stagingTracks = manifest.tracks.filter((track) => track.role === 'staging');
  if (stagingTracks.length > 1) errors.push(`Manifest may have at most one staging track, found ${stagingTracks.length}`);
  for (const track of stagingTracks) {
    if (track.kind !== 'video') errors.push(`${track.trackId}: staging track must be a video track`);
  }
```

`render/plan.ts:213-217` - exclude staging tracks from `videoSourceIds` (spec §12 point 3). Staging clips are never rendered, so they must not count as "video sources" that would suppress a legitimate single-source `audioChannelFix`/`studioCleanup`. Add the `role` filter:

```ts
  const videoSourceIds = new Set(
    manifest.tracks
      .filter((t) => t.kind === 'video' && t.role !== 'staging')
      .flatMap((t) => (t.clips ?? []).map((c) => c.assetId))
  );
```

Add this test to `staging-track.test.ts` (imports `buildRenderPlan` from `../render/plan` - confirm the exact exported name; it may be `buildRenderPlan` or re-exported as `buildRenderPlanV3` from the package root):

```ts
import { buildRenderPlan } from '../render/plan';

it('staging takes do not suppress a single-source channel fix in the render plan', () => {
  const sourceAsset = { assetId: 'asset_video_001', kind: 'video' as const, path: 'input/source.mp4', durationSec: 10, provenance: 'imported' as const, video: { width: 1920, height: 1080, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } };
  const sourceTrack = makeTrack({ trackId: 'track_video', kind: 'video', clips: [makeClip('clip_001', 'asset_video_001', 10)] });
  const withTakes = makeManifest({
    assets: [sourceAsset, makeVideoAsset('a2', 20)],
    tracks: [sourceTrack, staging],
    audioChannelFix: { status: 'approved', sourceChannel: 'left', detection: { leftRmsDb: -20, rightRmsDb: -60, auto: true }, appliedAt: '2026-01-01T00:00:00.000Z' }
  });
  const plan = buildRenderPlan(withTakes);
  expect(plan.composition.audioSourceChannel).toBe('left'); // still active despite the staged take
});
```

If `buildRenderPlan`'s return shape names the field differently, assert on whatever field carries the resolved channel (grep `audioSourceChannel` in `render/plan.ts`). The point of the test: adding a staging take must NOT flip `videoSourceIds.size` above 1 for scope purposes.

- [ ] **Step 4: Run tests + typecheck, verify pass**

Run: `npx vitest run packages/core/src/__tests__/staging-track.test.ts` - Expected: PASS.
Run: `pnpm -r typecheck` - Expected: clean. If other call sites construct `Track` literals without `role` and fail typecheck, fix them by parsing through `TrackSchema` or adding `role: 'timeline'`.
Run: `npx vitest run packages/core` - Expected: all core tests still green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src docs
git commit -m "feat(core): staging track role excluded from timeline, included in transcription"
```

---

### Task 2: takeGroups, composeState, TakesError, constants

**Files:**
- Create: `packages/core/src/takes/schema.ts`
- Modify: `packages/core/src/manifest/schema.ts` (ManifestV3Schema)
- Modify: `packages/core/src/manifest/validate.ts` (after Task 1's staging rules)
- Modify: `packages/core/src/index.ts` (add `export * from './takes/schema';`)
- Test: `packages/core/src/__tests__/take-groups.test.ts`

**Interfaces:**
- Produces (used by every later task): `TakeGroupSchema`, `TakeGroup`, `TakesError`, `TakesErrorCode`, `TAKES_CONSTANTS`, manifest fields `takeGroups: TakeGroup[]` (default `[]`) and `composeState?: { appliedAt: string; compositionHash: string }`.

- [ ] **Step 1: Write failing tests**

`packages/core/src/__tests__/take-groups.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ManifestV3Schema } from '../manifest/schema';
import { validateManifestV3Document } from '../manifest/validate';
import { TakesError, TAKES_CONSTANTS } from '../takes/schema';
import { makeClip, makeManifest, makeTrack, makeVideoAsset } from './takes-fixtures';

const staging = makeTrack({ trackId: 'track_takes', kind: 'video', role: 'staging', hidden: true, order: 1000,
  clips: [makeClip('clip_take_01', 'a1', 20), makeClip('clip_take_02', 'a2', 21)] });
const base = { assets: [makeVideoAsset('a1', 20), makeVideoAsset('a2', 21)], tracks: [staging] };

describe('takeGroups', () => {
  it('defaults to [] for existing manifests', () => {
    const raw = { ...makeManifest(), takeGroups: undefined } as Record<string, unknown>;
    delete raw.takeGroups;
    expect(ManifestV3Schema.parse(raw).takeGroups).toEqual([]);
  });

  it('accepts a valid group referencing staging clips', () => {
    const m = makeManifest({ ...base, takeGroups: [{ groupId: 'main', label: 'main', clipIds: ['clip_take_01', 'clip_take_02'] }] });
    expect(validateManifestV3Document(m).valid).toBe(true);
  });

  it('rejects a group clipId that is not on the staging track', () => {
    const m = makeManifest({ ...base, takeGroups: [{ groupId: 'main', label: 'main', clipIds: ['clip_nope'] }] });
    expect(validateManifestV3Document(m).errors.join('\n')).toMatch(/clip_nope.*not on the staging track/i);
  });

  it('rejects duplicate groupIds and shared clipIds', () => {
    const m = makeManifest({ ...base, takeGroups: [
      { groupId: 'main', label: 'a', clipIds: ['clip_take_01'] },
      { groupId: 'main', label: 'b', clipIds: ['clip_take_01'] }
    ] });
    const errors = validateManifestV3Document(m).errors.join('\n');
    expect(errors).toMatch(/duplicated: main/i);
    expect(errors).toMatch(/clip_take_01.*more than one take group/i);
  });

  it('accepts composeState and exposes constants', () => {
    const m = makeManifest({ composeState: { appliedAt: '2026-01-02T00:00:00.000Z', compositionHash: 'abc' } });
    expect(ManifestV3Schema.parse(m).composeState?.compositionHash).toBe('abc');
    expect(TAKES_CONSTANTS.MIN_CANDIDATE_COVERAGE).toBe(0.5);
    expect(new TakesError('TAKES_UNKNOWN_GROUP', 'nope').code).toBe('TAKES_UNKNOWN_GROUP');
  });
});
```

- [ ] **Step 2: Run, verify FAIL:** `npx vitest run packages/core/src/__tests__/take-groups.test.ts`

- [ ] **Step 3: Implement**

`packages/core/src/takes/schema.ts`:

```ts
import { z } from 'zod';

export const TAKES_CONSTANTS = {
  MIN_CANDIDATE_COVERAGE: 0.5,
  MIN_ORPHAN_WORDS: 8,
  LOW_CONFIDENCE_MATCH_FRACTION: 0.3,
  BOUNDARY_WARN_THRESHOLD: 0.5,
  SENTENCE_GAP_SEC: 0.8,
  SPAN_MAX_WORDS: 40,
  SPAN_MIN_WORDS: 3
} as const;

export type TakesErrorCode =
  | 'TAKES_MISSING_TRANSCRIPTS' | 'TAKES_UNKNOWN_GROUP' | 'TAKES_EMPTY_GROUP'
  | 'COMPOSE_VALIDATION' | 'ALIGNMENT_STALE' | 'CHAPTERS_STALE' | 'BRIEF_INVALID';

export class TakesError extends Error {
  constructor(public readonly code: TakesErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'TakesError';
  }
}

export const TakeGroupReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('take'), clipId: z.string().min(1) }),
  z.object({ kind: z.literal('file'), path: z.string().min(1) })
]);

export const TakeGroupSchema = z.object({
  groupId: z.string().min(1),
  label: z.string().min(1),
  clipIds: z.array(z.string().min(1)).min(1),
  reference: TakeGroupReferenceSchema.optional()
});
export type TakeGroup = z.infer<typeof TakeGroupSchema>;

export const ComposeStateSchema = z.object({
  appliedAt: z.string().datetime(),
  compositionHash: z.string().min(1)
});
export type ComposeState = z.infer<typeof ComposeStateSchema>;
```

`manifest/schema.ts` - import `{ TakeGroupSchema, ComposeStateSchema } from '../takes/schema';` and add to `ManifestV3Schema` after `studioCleanup`:

```ts
  takeGroups: z.array(TakeGroupSchema).default([]),
  composeState: ComposeStateSchema.optional()
```

`manifest/validate.ts` - after the Task 1 staging rules:

```ts
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
```

`index.ts` - add `export * from './takes/schema';` after the schemas export.

- [ ] **Step 4: Run + typecheck:** `npx vitest run packages/core/src/__tests__/take-groups.test.ts` PASS; `pnpm -r typecheck` clean; `npx vitest run packages/core` green.

- [ ] **Step 5: Commit:** `git add -A && git commit -m "feat(core): take groups, compose state, takes error codes"`

---

### Task 3: Brief module + brief CLI verbs

**Files:**
- Create: `packages/core/src/brief/schema.ts`, `packages/core/src/brief/io.ts`
- Modify: `packages/core/package.json` (dependency `yaml@^2`), `packages/core/src/index.ts`
- Modify: `packages/etvideo-cli/src/index.ts` (three verbs)
- Test: `packages/core/src/__tests__/brief.test.ts`

**Interfaces:**
- Produces: `BriefFrontmatterSchema`, `BriefSchema`, `Brief`, `readBrief(workspaceDir): Brief` (throws `TakesError('BRIEF_INVALID')`), `writeBrief(workspaceDir, brief)`, `briefTemplate(): string`. CLI: `ets brief init | set --file <p> [--force] | show`.

- [ ] **Step 1: Add dependency**

Run: `pnpm --filter @etvideoscript/core add yaml` (accept ^2 version). Expected: package.json updated, lockfile updated.

- [ ] **Step 2: Write failing tests**

`packages/core/src/__tests__/brief.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { briefTemplate, readBrief, writeBrief } from '../brief/io';
import { TakesError } from '../takes/schema';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function ws(): string { dir = mkdtempSync(join(tmpdir(), 'ets-brief-')); return dir; }

const VALID = `---\ntitle: "Webhooks demo"\naudience: "ETCircle admins"\ntone: "friendly"\ntargetDurationSec: 480\nstructure:\n  - "hook"\n  - "steps"\n---\nBody text here.\n`;

describe('brief', () => {
  it('round-trips a valid brief', () => {
    const w = ws();
    writeFileSync(join(w, 'brief.md'), VALID);
    const brief = readBrief(w);
    expect(brief.frontmatter.title).toBe('Webhooks demo');
    expect(brief.frontmatter.targetDurationSec).toBe(480);
    expect(brief.frontmatter.structure).toEqual(['hook', 'steps']);
    expect(brief.body.trim()).toBe('Body text here.');
    writeBrief(w, brief);
    expect(readBrief(w)).toEqual(brief);
  });

  it('throws BRIEF_INVALID when file is missing', () => {
    expect(() => readBrief(ws())).toThrowError(TakesError);
    try { readBrief(dir); } catch (err) { expect((err as TakesError).code).toBe('BRIEF_INVALID'); }
  });

  it('throws BRIEF_INVALID listing each bad frontmatter field', () => {
    const w = ws();
    writeFileSync(join(w, 'brief.md'), `---\ntitle: ""\ntargetDurationSec: -5\n---\n`);
    try {
      readBrief(w);
      expect.unreachable();
    } catch (err) {
      const message = (err as TakesError).message;
      expect(message).toMatch(/title/);
      expect(message).toMatch(/audience/);
      expect(message).toMatch(/targetDurationSec/);
    }
  });

  it('requires the document to start with frontmatter', () => {
    const w = ws();
    writeFileSync(join(w, 'brief.md'), 'no frontmatter');
    expect(() => readBrief(w)).toThrowError(/must start with ---/);
  });

  it('template parses once filled placeholders are replaced', () => {
    expect(briefTemplate()).toMatch(/^---\n/);
    expect(briefTemplate()).toMatch(/title:/);
  });
});
```

- [ ] **Step 3: Run, verify FAIL:** `npx vitest run packages/core/src/__tests__/brief.test.ts`

- [ ] **Step 4: Implement**

`packages/core/src/brief/schema.ts`:

```ts
import { z } from 'zod';

export const BriefFrontmatterSchema = z.object({
  title: z.string().min(1),
  audience: z.string().min(1),
  tone: z.string().min(1).optional(),
  targetDurationSec: z.number().int().positive().optional(),
  structure: z.array(z.string().min(1)).optional()
});

export const BriefSchema = z.object({
  frontmatter: BriefFrontmatterSchema,
  body: z.string()
});
export type Brief = z.infer<typeof BriefSchema>;
```

`packages/core/src/brief/io.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { assertInside } from '../filesystem';
import { TakesError } from '../takes/schema';
import { BriefFrontmatterSchema, BriefSchema, type Brief } from './schema';

export function readBrief(workspaceDir: string): Brief {
  const path = assertInside(resolve(workspaceDir), 'brief.md');
  if (!existsSync(path)) {
    throw new TakesError('BRIEF_INVALID', 'brief.md not found. Run `ets brief init` and fill it in, or `ets brief set --file <path>`.');
  }
  const raw = readFileSync(path, 'utf8');
  if (!raw.startsWith('---\n')) throw new TakesError('BRIEF_INVALID', 'brief.md must start with --- frontmatter on line 1');
  const closing = raw.indexOf('\n---', 4);
  if (closing === -1) throw new TakesError('BRIEF_INVALID', 'brief.md frontmatter is missing its closing ---');
  let data: unknown;
  try {
    data = parseYaml(raw.slice(4, closing));
  } catch (err) {
    throw new TakesError('BRIEF_INVALID', `brief.md frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = BriefFrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new TakesError('BRIEF_INVALID', `brief.md frontmatter invalid:\n${issues.join('\n')}`, issues);
  }
  const bodyStart = raw.indexOf('\n', closing + 1);
  return { frontmatter: parsed.data, body: bodyStart === -1 ? '' : raw.slice(bodyStart + 1) };
}

export function writeBrief(workspaceDir: string, brief: Brief): void {
  const validated = BriefSchema.parse(brief);
  const path = assertInside(resolve(workspaceDir), 'brief.md');
  writeFileSync(path, `---\n${stringifyYaml(validated.frontmatter)}---\n${validated.body}`);
}

export function briefTemplate(): string {
  return [
    '---',
    'title: "What this video is called"',
    'audience: "Who watches it and what they already know"',
    'tone: "e.g. friendly, concise"',
    '# targetDurationSec: 480',
    '# structure:',
    '#   - "hook: ..."',
    '#   - "main steps"',
    '---',
    'Explain here, in as much detail as you like: what the video is about, why the',
    'audience should care, what must stay in, what can be dropped. The editing agent',
    'grounds every cut decision in this document.',
    ''
  ].join('\n');
}
```

NOTE on `writeBrief` round-trip: `stringifyYaml` ends with `\n`, so `---\n...---\n` is well formed. The `readBrief` body slice keeps everything after the closing `---` line.

`index.ts`: add `export * from './brief/schema';` and `export * from './brief/io';`.

CLI (`packages/etvideo-cli/src/index.ts`) - add near the other commands; import `readBrief, writeBrief, briefTemplate, TakesError` from `@etvideoscript/core`, plus `copyFileSync` is NOT needed (set re-validates then writes):

```ts
function takesCliAction(json: boolean | undefined, fn: () => void) {
  try { fn(); } catch (err) {
    if (err instanceof TakesError) {
      if (json) print({ error: { code: err.code, message: err.message, details: err.details ?? null } }, true);
      else console.error(`${err.code}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

const briefCommand = program.command('brief').description('Manage the project brief that educates edit decisions');
briefCommand.command('init').description('Write a brief.md template to fill in')
  .action(() => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    const target = join(workspace, 'brief.md');
    if (existsSync(target)) throw new TakesError('BRIEF_INVALID', 'brief.md already exists; edit it directly or use `ets brief set --file --force`');
    writeFileSync(target, briefTemplate());
    print(program.opts().json ? { path: target } : `Brief template written: ${target}`, program.opts().json);
  }));
briefCommand.command('set').description('Validate and install a brief file as brief.md')
  .requiredOption('--file <path>', 'markdown file with YAML frontmatter')
  .option('--force', 'overwrite an existing brief.md')
  .action((opts) => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    if (existsSync(join(workspace, 'brief.md')) && !opts.force) throw new TakesError('BRIEF_INVALID', 'brief.md already exists; pass --force to replace it');
    const stagingDir = dirname(resolve(opts.file));
    void stagingDir;
    const raw = readFileSync(resolve(opts.file), 'utf8');
    writeFileSync(join(workspace, 'brief.md'), raw);
    const brief = readBrief(workspace); // validates; throws (and leaves file for inspection) if invalid
    print(program.opts().json ? { frontmatter: brief.frontmatter } : `Brief set: ${brief.frontmatter.title}`, program.opts().json);
  }));
briefCommand.command('show').description('Print the parsed brief')
  .action(() => takesCliAction(program.opts().json, () => {
    const brief = readBrief(workspaceOption(program.opts().workspace));
    print(program.opts().json ? brief : `# ${brief.frontmatter.title}\naudience: ${brief.frontmatter.audience}\ntone: ${brief.frontmatter.tone ?? '-'}\ntarget: ${brief.frontmatter.targetDurationSec ?? '-'}s\n\n${brief.body}`, program.opts().json);
  }));
```

(`takesCliAction` is defined once here and reused by Tasks 9-11 verbs.)

- [ ] **Step 5: Run + verify**

`npx vitest run packages/core/src/__tests__/brief.test.ts` PASS. `pnpm -r typecheck` clean.
Smoke the CLI from a scratch dir: `cd $(mktemp -d) && node /path/to/repo/packages/etvideo-cli/dist... ` - SKIP dist; instead run through the workspace bin: `pnpm --filter etvideo-cli exec tsx src/index.ts brief init --workspace $(mktemp -d)` if tsx is available, otherwise defer CLI smoke to Task 9's smoke script. Typecheck + unit tests are the gate here.

- [ ] **Step 6: Commit:** `git add -A && git commit -m "feat(core,cli): project brief artifact with schema, io, and CLI verbs"`

---

### Task 4: Word normalization + anchors

**Files:**
- Create: `packages/core/src/takes/normalize.ts`, `packages/core/src/takes/anchors.ts`
- Modify: `packages/core/src/__tests__/takes-fixtures.ts` (add `makeWords`)
- Modify: `packages/core/src/index.ts` (`export * from './takes/normalize'; export * from './takes/anchors';`)
- Test: `packages/core/src/__tests__/take-normalize.test.ts`, `packages/core/src/__tests__/take-anchors.test.ts`

**Interfaces:**
- Produces: `NormalizedWord { text: string; index: number }`, `normalizeWords(words: TranscriptWord[]): NormalizedWord[]`, `Anchor { refIndex: number; takeIndex: number }`, `findAnchors(ref, take): Anchor[]`. Fixture `makeWords(text, opts)` used by Tasks 5-8, 11.

- [ ] **Step 1: Extend fixtures**

Append to `takes-fixtures.ts`:

```ts
import type { TranscriptWord } from '../schemas';

export interface MakeWordsOptions {
  clipId?: string;
  startAt?: number;
  wordSec?: number;              // duration of each word, default 0.3
  gapSec?: number;               // gap after each word, default 0.05
  gapsAfter?: Record<number, number>; // extra gap AFTER word index i (overrides gapSec for that slot)
}

export function makeWords(text: string, opts: MakeWordsOptions = {}): TranscriptWord[] {
  const { clipId = 'clip_take_01', startAt = 0, wordSec = 0.3, gapSec = 0.05, gapsAfter = {} } = opts;
  let t = startAt;
  return text.split(/\s+/).filter(Boolean).map((token, i) => {
    const start = t;
    const end = start + wordSec;
    t = end + (gapsAfter[i] ?? gapSec);
    return {
      id: `${clipId}_w${i}`, text: token, normalized: '', start, end,
      speaker: 'speaker_1', confidence: 1, segmentId: `${clipId}_s1`, clipId
    };
  });
}
```

- [ ] **Step 2: Write failing tests**

`take-normalize.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeWords } from '../takes/normalize';
import { makeWords } from './takes-fixtures';

describe('normalizeWords', () => {
  it('lowercases and strips edge punctuation, keeping internal apostrophes/hyphens', () => {
    const words = makeWords(`Hello, World! don't built-in "quoted"`);
    expect(normalizeWords(words).map((w) => w.text)).toEqual(['hello', 'world', "don't", 'built-in', 'quoted']);
  });

  it('drops words that normalize to empty and preserves original indices', () => {
    const words = makeWords('one ... two');
    const norm = normalizeWords(words);
    expect(norm.map((w) => w.text)).toEqual(['one', 'two']);
    expect(norm.map((w) => w.index)).toEqual([0, 2]);
  });

  it('prefers the transcript-provided normalized field', () => {
    const words = makeWords('Umm');
    words[0] = { ...words[0], normalized: 'um' };
    expect(normalizeWords(words)[0].text).toBe('um');
  });

  it('handles unicode letters', () => {
    expect(normalizeWords(makeWords('¡Héllo! ¿qué?')).map((w) => w.text)).toEqual(['héllo', 'qué']);
  });
});
```

`take-anchors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { findAnchors } from '../takes/anchors';
import { normalizeWords } from '../takes/normalize';
import { makeWords } from './takes-fixtures';

const norm = (text: string) => normalizeWords(makeWords(text));

describe('findAnchors', () => {
  it('finds unique shared 3-word shingles', () => {
    const ref = norm('alpha beta gamma delta epsilon');
    const take = norm('zzz alpha beta gamma delta epsilon');
    const anchors = findAnchors(ref, take);
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors[0]).toEqual({ refIndex: 0, takeIndex: 1 });
  });

  it('ignores shingles that repeat within either sequence', () => {
    const ref = norm('a b c x a b c');
    const take = norm('a b c');
    expect(findAnchors(ref, take)).toEqual([]); // "a b c" occurs twice in ref
  });

  it('drops crossing anchors via LIS', () => {
    // ref: X...Y   take: Y...X -> only one can survive
    const ref = norm('q w e r t y u i o p');
    const take = norm('y u i o p q w e r t');
    const anchors = findAnchors(ref, take);
    for (let i = 1; i < anchors.length; i++) {
      expect(anchors[i].refIndex).toBeGreaterThan(anchors[i - 1].refIndex);
      expect(anchors[i].takeIndex).toBeGreaterThan(anchors[i - 1].takeIndex);
    }
  });

  it('returns [] when nothing is shared', () => {
    expect(findAnchors(norm('a b c d e'), norm('v w x y z'))).toEqual([]);
  });
});
```

- [ ] **Step 3: Run, verify FAIL**, then implement.

`takes/normalize.ts`:

```ts
import type { TranscriptWord } from '../schemas';

export interface NormalizedWord { text: string; index: number }

const EDGE_STRIP = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

export function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(EDGE_STRIP, '');
}

export function normalizeWords(words: TranscriptWord[]): NormalizedWord[] {
  const out: NormalizedWord[] = [];
  words.forEach((word, index) => {
    const text = normalizeToken(word.normalized || word.text);
    if (text) out.push({ text, index });
  });
  return out;
}
```

NOTE: `normalizeToken` keeps internal apostrophes/hyphens automatically (only edges are stripped). U+2019 right single quote is a punctuation edge char but internal `don’t` keeps it; that is fine and deterministic.

`takes/anchors.ts`:

```ts
import type { NormalizedWord } from './normalize';

export interface Anchor { refIndex: number; takeIndex: number }

function uniqueShingles(words: NormalizedWord[]): Map<string, number> {
  const counts = new Map<string, { position: number; count: number }>();
  for (let i = 0; i + 2 < words.length; i++) {
    const key = `${words[i].text} ${words[i + 1].text} ${words[i + 2].text}`;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { position: i, count: 1 });
  }
  const unique = new Map<string, number>();
  for (const [key, { position, count }] of counts) if (count === 1) unique.set(key, position);
  return unique;
}

export function findAnchors(ref: NormalizedWord[], take: NormalizedWord[]): Anchor[] {
  const refShingles = uniqueShingles(ref);
  const takeShingles = uniqueShingles(take);
  const candidates: Anchor[] = [];
  for (const [key, refIndex] of refShingles) {
    const takeIndex = takeShingles.get(key);
    if (takeIndex !== undefined) candidates.push({ refIndex, takeIndex });
  }
  candidates.sort((a, b) => a.refIndex - b.refIndex);

  // Longest strictly-increasing subsequence in takeIndex (O(n log n) patience sorting).
  const tails: number[] = [];        // tails[k] = takeIndex of smallest tail of an increasing subsequence of length k+1
  const tailIdx: number[] = [];      // index into candidates for tails[k]
  const prev: number[] = new Array(candidates.length).fill(-1);
  candidates.forEach((candidate, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < candidate.takeIndex) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = candidate.takeIndex;
    tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  });
  const chain: Anchor[] = [];
  let at = tails.length ? tailIdx[tails.length - 1] : -1;
  while (at !== -1) { chain.push(candidates[at]); at = prev[at]; }
  return chain.reverse();
}
```

- [ ] **Step 4: Run + typecheck:** both test files PASS, `pnpm -r typecheck` clean.

- [ ] **Step 5: Commit:** `git add -A && git commit -m "feat(core): take word normalization and anchor detection"`

---

### Task 5: Banded sequence alignment

**Files:**
- Create: `packages/core/src/takes/align.ts`
- Modify: `packages/core/src/index.ts` (`export * from './takes/align';`)
- Test: `packages/core/src/__tests__/take-align.test.ts`

**Interfaces:**
- Consumes: `NormalizedWord`, `findAnchors`.
- Produces: `ALIGN_SCORES`, `AlignedPair` (union: `{kind:'match'|'substitution', refIndex, takeIndex}` | `{kind:'refGap', refIndex}` | `{kind:'takeGap', takeIndex}`), `alignWordSequences(ref: NormalizedWord[], take: NormalizedWord[]): AlignedPair[]`. Every normalized index of both sequences appears exactly once in the output; pairs are sorted by position.

- [ ] **Step 1: Write failing tests**

`take-align.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { alignWordSequences, type AlignedPair } from '../takes/align';
import { normalizeWords } from '../takes/normalize';
import { makeWords } from './takes-fixtures';

const norm = (text: string) => normalizeWords(makeWords(text));

function kinds(pairs: AlignedPair[]): string[] { return pairs.map((p) => p.kind); }

function coversAll(pairs: AlignedPair[], refLen: number, takeLen: number): void {
  const refSeen = pairs.flatMap((p) => 'refIndex' in p ? [p.refIndex] : []);
  const takeSeen = pairs.flatMap((p) => 'takeIndex' in p ? [p.takeIndex] : []);
  expect([...new Set(refSeen)].sort((a, b) => a - b)).toEqual(Array.from({ length: refLen }, (_, i) => i));
  expect([...new Set(takeSeen)].sort((a, b) => a - b)).toEqual(Array.from({ length: takeLen }, (_, i) => i));
  expect(refSeen.length).toBe(refLen);
  expect(takeSeen.length).toBe(takeLen);
}

describe('alignWordSequences', () => {
  it('aligns identical sequences as all matches', () => {
    const a = norm('the quick brown fox jumps over the lazy dog again today friends');
    const pairs = alignWordSequences(a, a);
    expect(new Set(kinds(pairs))).toEqual(new Set(['match']));
    coversAll(pairs, a.length, a.length);
  });

  it('places a single substitution correctly', () => {
    const ref = norm('one two three four five six seven eight');
    const take = norm('one two three WRONG five six seven eight');
    const pairs = alignWordSequences(ref, take);
    const sub = pairs.find((p) => p.kind === 'substitution');
    expect(sub && 'refIndex' in sub && sub.refIndex).toBe(3);
    coversAll(pairs, ref.length, take.length);
  });

  it('handles insertion (takeGap) and deletion (refGap)', () => {
    const ref = norm('a b c d e f g h');
    const takeIns = norm('a b c EXTRA d e f g h');
    expect(kinds(alignWordSequences(ref, takeIns))).toContain('takeGap');
    const takeDel = norm('a b c e f g h');
    expect(kinds(alignWordSequences(ref, takeDel))).toContain('refGap');
    coversAll(alignWordSequences(ref, takeIns), ref.length, takeIns.length);
    coversAll(alignWordSequences(ref, takeDel), ref.length, takeDel.length);
  });

  it('handles empty sides', () => {
    const a = norm('x y z');
    expect(kinds(alignWordSequences(a, []))).toEqual(['refGap', 'refGap', 'refGap']);
    expect(kinds(alignWordSequences([], a))).toEqual(['takeGap', 'takeGap', 'takeGap']);
  });

  it('is deterministic and fast on 10k words with 1% mutations', () => {
    const vocabulary = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike'];
    // seeded LCG so the fixture is deterministic (no Math.random in tests either)
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const refTokens = Array.from({ length: 10000 }, (_, i) => `${vocabulary[Math.floor(rand() * vocabulary.length)]}${i % 97}`);
    const takeTokens = refTokens.map((t) => rand() < 0.01 ? 'MUTATED' : t);
    const ref = refTokens.map((text, index) => ({ text, index }));
    const take = takeTokens.map((text, index) => ({ text, index }));
    const started = performance.now();
    const pairs = alignWordSequences(ref, take);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2000);
    const matches = pairs.filter((p) => p.kind === 'match').length;
    expect(matches / ref.length).toBeGreaterThan(0.95);
    expect(alignWordSequences(ref, take)).toEqual(pairs); // determinism
  });
});
```

- [ ] **Step 2: Run, verify FAIL**, then implement.

`takes/align.ts` (complete file):

```ts
import { findAnchors } from './anchors';
import type { NormalizedWord } from './normalize';

export const ALIGN_SCORES = { match: 2, mismatch: -1, gap: -1 } as const;

export type AlignedPair =
  | { kind: 'match' | 'substitution'; refIndex: number; takeIndex: number }
  | { kind: 'refGap'; refIndex: number }
  | { kind: 'takeGap'; takeIndex: number };

const WINDOW_SPLIT_THRESHOLD = 5000;

/**
 * Banded Needleman-Wunsch on one anchor-free window.
 * refOff/takeOff translate window-local indices back to sequence indices.
 */
function nwAlign(ref: NormalizedWord[], take: NormalizedWord[], refOff: number, takeOff: number): AlignedPair[] {
  const n = ref.length;
  const m = take.length;
  if (n === 0) return take.map((_, j) => ({ kind: 'takeGap' as const, takeIndex: takeOff + j }));
  if (m === 0) return ref.map((_, i) => ({ kind: 'refGap' as const, refIndex: refOff + i }));
  if (Math.max(n, m) > WINDOW_SPLIT_THRESHOLD) {
    // Degenerate anchor-free window (synthetic input): co-split proportionally at the midpoint.
    const midRef = n >> 1;
    const midTake = Math.round((m * midRef) / n);
    return [
      ...nwAlign(ref.slice(0, midRef), take.slice(0, midTake), refOff, takeOff),
      ...nwAlign(ref.slice(midRef), take.slice(midTake), refOff + midRef, takeOff + midTake)
    ];
  }

  const band = Math.max(32, Math.ceil(0.2 * Math.max(n, m)));
  const width = 2 * band + 1;
  const NEG = -0x3fffffff;
  const center = (i: number) => n === 0 ? 0 : Math.round((i * m) / n);
  const inBand = (i: number, j: number) => i >= 0 && i <= n && j >= 0 && j <= m && Math.abs(j - center(i)) <= band;
  const idx = (i: number, j: number) => i * width + (j - center(i) + band);

  const score = new Int32Array((n + 1) * width).fill(NEG);
  const dir = new Uint8Array((n + 1) * width); // 0=unset, 1=diag, 2=up(refGap), 3=left(takeGap)
  score[idx(0, 0)] = 0;
  for (let j = 1; inBand(0, j); j++) {
    score[idx(0, j)] = j * ALIGN_SCORES.gap;
    dir[idx(0, j)] = 3;
  }
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(0, center(i) - band);
    const hi = Math.min(m, center(i) + band);
    for (let j = lo; j <= hi; j++) {
      let best = NEG;
      let d = 0;
      if (j > 0 && inBand(i - 1, j - 1) && score[idx(i - 1, j - 1)] > NEG) {
        const diagScore = score[idx(i - 1, j - 1)] + (ref[i - 1].text === take[j - 1].text ? ALIGN_SCORES.match : ALIGN_SCORES.mismatch);
        if (diagScore > best) { best = diagScore; d = 1; }
      }
      if (inBand(i - 1, j) && score[idx(i - 1, j)] > NEG) {
        const upScore = score[idx(i - 1, j)] + ALIGN_SCORES.gap;
        if (upScore > best) { best = upScore; d = 2; }
      }
      if (j > 0 && inBand(i, j - 1) && score[idx(i, j - 1)] > NEG) {
        const leftScore = score[idx(i, j - 1)] + ALIGN_SCORES.gap;
        if (leftScore > best) { best = leftScore; d = 3; }
      }
      if (d !== 0) {
        score[idx(i, j)] = best;
        dir[idx(i, j)] = d;
      }
    }
  }

  const out: AlignedPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const d = inBand(i, j) ? dir[idx(i, j)] : 0;
    if (d === 1) {
      i -= 1; j -= 1;
      out.push({ kind: ref[i].text === take[j].text ? 'match' : 'substitution', refIndex: refOff + i, takeIndex: takeOff + j });
    } else if (d === 2 || (d === 0 && i > 0)) {
      i -= 1;
      out.push({ kind: 'refGap', refIndex: refOff + i });
    } else {
      j -= 1;
      out.push({ kind: 'takeGap', takeIndex: takeOff + j });
    }
  }
  return out.reverse();
}

export function alignWordSequences(ref: NormalizedWord[], take: NormalizedWord[]): AlignedPair[] {
  const anchors = findAnchors(ref, take);

  // Merge overlapping/touching same-diagonal anchors into runs of exact matches (each run covers >= 3 words).
  const runs: Array<{ refStart: number; takeStart: number; length: number }> = [];
  for (const anchor of anchors) {
    const last = runs[runs.length - 1];
    const sameDiagonal = last && anchor.takeIndex - anchor.refIndex === last.takeStart - last.refStart;
    if (last && sameDiagonal && anchor.refIndex <= last.refStart + last.length) {
      last.length = Math.max(last.length, anchor.refIndex + 3 - last.refStart);
    } else {
      runs.push({ refStart: anchor.refIndex, takeStart: anchor.takeIndex, length: 3 });
    }
  }

  const pairs: AlignedPair[] = [];
  let refPos = 0;
  let takePos = 0;
  for (const run of [...runs, null]) {
    const refEnd = run ? run.refStart : ref.length;
    const takeEnd = run ? run.takeStart : take.length;
    if (run && (run.refStart < refPos || run.takeStart < takePos)) continue; // overlapping non-mergeable run: skip
    pairs.push(...nwAlign(ref.slice(refPos, refEnd), take.slice(takePos, takeEnd), refPos, takePos));
    if (run) {
      for (let k = 0; k < run.length; k++) {
        pairs.push({ kind: 'match', refIndex: run.refStart + k, takeIndex: run.takeStart + k });
      }
      refPos = run.refStart + run.length;
      takePos = run.takeStart + run.length;
    }
  }
  return pairs;
}
```

- [ ] **Step 3: Run + typecheck:** `npx vitest run packages/core/src/__tests__/take-align.test.ts` PASS (watch the 2s perf budget), `pnpm -r typecheck` clean.

- [ ] **Step 4: Commit:** `git add -A && git commit -m "feat(core): anchor-banded needleman-wunsch word alignment"`

---

### Task 6: Reference spans, projection, orphans

**Files:**
- Create: `packages/core/src/takes/spans.ts`
- Modify: `packages/core/src/index.ts` (`export * from './takes/spans';`)
- Test: `packages/core/src/__tests__/take-spans.test.ts`

**Interfaces:**
- Consumes: `NormalizedWord`, `AlignedPair`, `TAKES_CONSTANTS`, `normalizeToken`.
- Produces:
  - `ReferenceWord { text: string; start?: number; end?: number }`
  - `referenceFromTranscript(words: TranscriptWord[]): ReferenceWord[]`
  - `referenceFromScript(text: string): ReferenceWord[]` (whitespace tokenization, no timings)
  - `normalizeReference(words: ReferenceWord[]): NormalizedWord[]`
  - `ReferenceSpan { spanId: string; ordinal: number; refWordStart: number; refWordEnd: number; text: string }`
  - `segmentReference(words: ReferenceWord[]): ReferenceSpan[]`
  - `RawCandidate { spanId, takeWordStart, takeWordEnd, tStart, tEnd, coverage, matchQuality, truncated }` (no clipId/metrics yet; Task 8 assembles)
  - `projectSpans(spans, refNorm, takeNorm, takeWords, pairs): RawCandidate[]`
  - `RawOrphan { takeWordStart, takeWordEnd, tStart, tEnd, text }`
  - `findOrphans(pairs, takeNorm, takeWords): RawOrphan[]`

- [ ] **Step 1: Write failing tests**

`take-spans.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { alignWordSequences } from '../takes/align';
import { normalizeWords } from '../takes/normalize';
import { findOrphans, projectSpans, referenceFromScript, referenceFromTranscript, normalizeReference, segmentReference } from '../takes/spans';
import { TAKES_CONSTANTS } from '../takes/schema';
import { makeWords } from './takes-fixtures';

describe('segmentReference', () => {
  it('splits on sentence-terminal punctuation', () => {
    const ref = referenceFromTranscript(makeWords('This is one. And here is two! Is this three? Yes indeed here.'));
    const spans = segmentReference(ref);
    expect(spans.map((s) => s.text)).toEqual(['This is one.', 'And here is two!', 'Is this three?', 'Yes indeed here.']);
    expect(spans.map((s) => s.spanId)).toEqual(['s001', 's002', 's003', 's004']);
  });

  it('splits on silence gaps > 0.8s', () => {
    const words = makeWords('alpha beta gamma delta epsilon zeta', { gapsAfter: { 2: 1.0 } });
    const spans = segmentReference(referenceFromTranscript(words));
    expect(spans.map((s) => s.text)).toEqual(['alpha beta gamma', 'delta epsilon zeta']);
  });

  it('splits spans over 40 words at the largest internal gap', () => {
    const text = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ');
    const words = makeWords(text, { gapsAfter: { 24: 0.5 } }); // largest gap after word 24, still < 0.8 so no sentence split
    const spans = segmentReference(referenceFromTranscript(words));
    expect(spans.length).toBe(2);
    expect(spans[0].refWordEnd).toBe(24);
  });

  it('merges spans under 3 words forward (last merges backward)', () => {
    const spans = segmentReference(referenceFromTranscript(makeWords('Ok. Now the real sentence starts here. So.')));
    expect(spans.map((s) => s.text)).toEqual(['Ok. Now the real sentence starts here. So.'].length === 1 ? spans.map((s) => s.text) : spans.map((s) => s.text));
    // Explicit expectation: "Ok." (1 word) merges into the following sentence; trailing "So." (1 word) merges backward.
    expect(spans.length).toBe(1);
    expect(spans[0].text).toBe('Ok. Now the real sentence starts here. So.');
  });

  it('script mode uses punctuation only', () => {
    const spans = segmentReference(referenceFromScript('First sentence here. Second sentence there.'));
    expect(spans.length).toBe(2);
  });
});

describe('projectSpans', () => {
  function project(refText: string, takeText: string) {
    const refWords = makeWords(refText, { clipId: 'ref' });
    const takeWords = makeWords(takeText, { clipId: 'take' });
    const refNorm = normalizeWords(refWords);
    const takeNorm = normalizeWords(takeWords);
    const spans = segmentReference(referenceFromTranscript(refWords));
    const pairs = alignWordSequences(refNorm, takeNorm);
    return { spans, candidates: projectSpans(spans, refNorm, takeNorm, takeWords, pairs), takeWords, pairs, takeNorm };
  }

  it('full match: coverage and matchQuality are 1', () => {
    const { candidates } = project('Alpha beta gamma delta. Epsilon zeta eta theta.', 'Alpha beta gamma delta. Epsilon zeta eta theta.');
    expect(candidates.length).toBe(2);
    for (const c of candidates) {
      expect(c.coverage).toBe(1);
      expect(c.matchQuality).toBe(1);
      expect(c.truncated).toBe(false);
    }
  });

  it('pickup take covers only its span (others get no candidate)', () => {
    const { candidates } = project('One two three four. Five six seven eight.', 'five six seven eight');
    expect(candidates.map((c) => c.spanId)).toEqual(['s002']);
  });

  it('flubbed words lower matchQuality but not coverage', () => {
    const { candidates } = project('alpha beta gamma delta epsilon zeta', 'alpha beta WRONG delta epsilon zeta');
    expect(candidates[0].coverage).toBe(1);
    expect(candidates[0].matchQuality).toBeCloseTo(5 / 6, 5);
  });

  it('drops candidates under MIN_CANDIDATE_COVERAGE', () => {
    const { candidates } = project('one two three four five six seven eight nine ten', 'one two nothing else matches at all here really folks');
    expect(candidates.length === 0 || candidates.every((c) => c.coverage >= TAKES_CONSTANTS.MIN_CANDIDATE_COVERAGE)).toBe(true);
  });

  it('marks truncation when the take ends mid-span', () => {
    const { candidates } = project('alpha beta gamma delta epsilon zeta eta theta', 'alpha beta gamma delta epsilon');
    expect(candidates[0].truncated).toBe(true);
  });
});

describe('findOrphans', () => {
  it('emits runs of >= MIN_ORPHAN_WORDS unmatched take words', () => {
    const refWords = makeWords('start one two three end');
    const extra = 'completely new material appears here with many extra words indeed';
    const takeWords = makeWords(`start one two three ${extra} end`);
    const refNorm = normalizeWords(refWords);
    const takeNorm = normalizeWords(takeWords);
    const pairs = alignWordSequences(refNorm, takeNorm);
    const orphans = findOrphans(pairs, takeNorm, takeWords);
    expect(orphans.length).toBe(1);
    expect(orphans[0].text).toBe(extra);
  });

  it('ignores runs shorter than MIN_ORPHAN_WORDS', () => {
    const refWords = makeWords('start one two three end');
    const takeWords = makeWords('start one two three tiny aside here end');
    const pairs = alignWordSequences(normalizeWords(refWords), normalizeWords(takeWords));
    expect(findOrphans(pairs, normalizeWords(takeWords), takeWords)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**, then implement.

`takes/spans.ts` (complete file):

```ts
import type { TranscriptWord } from '../schemas';
import type { AlignedPair } from './align';
import { normalizeToken, type NormalizedWord } from './normalize';
import { TAKES_CONSTANTS } from './schema';

export interface ReferenceWord { text: string; start?: number; end?: number }

export function referenceFromTranscript(words: TranscriptWord[]): ReferenceWord[] {
  return words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
}

export function referenceFromScript(text: string): ReferenceWord[] {
  return text.split(/\s+/).filter(Boolean).map((token) => ({ text: token }));
}

export function normalizeReference(words: ReferenceWord[]): NormalizedWord[] {
  const out: NormalizedWord[] = [];
  words.forEach((word, index) => {
    const text = normalizeToken(word.text);
    if (text) out.push({ text, index });
  });
  return out;
}

export interface ReferenceSpan {
  spanId: string;
  ordinal: number;
  refWordStart: number;
  refWordEnd: number;
  text: string;
}

const SENTENCE_END = /[.!?…]["')\]]*$/;

export function segmentReference(words: ReferenceWord[]): ReferenceSpan[] {
  if (words.length === 0) return [];
  const hasTimings = words.every((w) => typeof w.start === 'number' && typeof w.end === 'number');

  // 1. initial boundaries
  let ranges: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    const isLast = i === words.length - 1;
    const sentenceEnd = SENTENCE_END.test(words[i].text);
    const gapBreak = hasTimings && !isLast && (words[i + 1].start! - words[i].end!) > TAKES_CONSTANTS.SENTENCE_GAP_SEC;
    if (isLast || sentenceEnd || gapBreak) {
      ranges.push([start, i]);
      start = i + 1;
    }
  }

  // 2. split ranges longer than SPAN_MAX_WORDS at the largest internal gap (midpoint without timings)
  const split: Array<[number, number]> = [];
  const splitRange = (lo: number, hi: number): void => {
    if (hi - lo + 1 <= TAKES_CONSTANTS.SPAN_MAX_WORDS) { split.push([lo, hi]); return; }
    let cut = lo + ((hi - lo) >> 1); // default midpoint; cut = last index of the left part
    if (hasTimings) {
      let bestGap = -1;
      for (let i = lo; i < hi; i++) {
        const gap = words[i + 1].start! - words[i].end!;
        if (gap > bestGap) { bestGap = gap; cut = i; }
      }
    }
    splitRange(lo, cut);
    splitRange(cut + 1, hi);
  };
  for (const [lo, hi] of ranges) splitRange(lo, hi);
  ranges = split;

  // 3. merge ranges shorter than SPAN_MIN_WORDS into the FOLLOWING range (last merges backward)
  const merged: Array<[number, number]> = [];
  for (let i = 0; i < ranges.length; i++) {
    const [lo, hi] = ranges[i];
    if (hi - lo + 1 < TAKES_CONSTANTS.SPAN_MIN_WORDS) {
      if (i + 1 < ranges.length) { ranges[i + 1] = [lo, ranges[i + 1][1]]; continue; }
      if (merged.length > 0) { merged[merged.length - 1] = [merged[merged.length - 1][0], hi]; continue; }
    }
    merged.push([lo, hi]);
  }

  return merged.map(([lo, hi], i) => ({
    spanId: `s${String(i + 1).padStart(3, '0')}`,
    ordinal: i + 1,
    refWordStart: lo,
    refWordEnd: hi,
    text: words.slice(lo, hi + 1).map((w) => w.text).join(' ')
  }));
}

export interface RawCandidate {
  spanId: string;
  takeWordStart: number;
  takeWordEnd: number;
  tStart: number;
  tEnd: number;
  coverage: number;
  matchQuality: number;
  truncated: boolean;
}

export function projectSpans(
  spans: ReferenceSpan[],
  refNorm: NormalizedWord[],
  takeNorm: NormalizedWord[],
  takeWords: TranscriptWord[],
  pairs: AlignedPair[]
): RawCandidate[] {
  // Map normalized ref position -> span index
  const spanOfOriginalRefIndex = new Map<number, number>();
  spans.forEach((span, spanIdx) => {
    for (let i = span.refWordStart; i <= span.refWordEnd; i++) spanOfOriginalRefIndex.set(i, spanIdx);
  });
  const spanRefNormCounts = new Array<number>(spans.length).fill(0);
  const spanOfRefNormIndex = new Map<number, number>();
  refNorm.forEach((word, normIdx) => {
    const spanIdx = spanOfOriginalRefIndex.get(word.index);
    if (spanIdx !== undefined) {
      spanOfRefNormIndex.set(normIdx, spanIdx);
      spanRefNormCounts[spanIdx] += 1;
    }
  });

  const perSpan = spans.map(() => ({ covered: 0, matched: 0, minTake: Infinity, maxTake: -Infinity }));
  for (const pair of pairs) {
    if (pair.kind !== 'match' && pair.kind !== 'substitution') continue;
    const spanIdx = spanOfRefNormIndex.get(pair.refIndex);
    if (spanIdx === undefined) continue;
    const acc = perSpan[spanIdx];
    acc.covered += 1;
    if (pair.kind === 'match') acc.matched += 1;
    acc.minTake = Math.min(acc.minTake, pair.takeIndex);
    acc.maxTake = Math.max(acc.maxTake, pair.takeIndex);
  }

  const out: RawCandidate[] = [];
  spans.forEach((span, spanIdx) => {
    const acc = perSpan[spanIdx];
    const denom = spanRefNormCounts[spanIdx];
    if (denom === 0 || acc.covered === 0) return;
    const coverage = acc.covered / denom;
    if (coverage < TAKES_CONSTANTS.MIN_CANDIDATE_COVERAGE) return;
    const firstTakeWord = takeNorm[acc.minTake];
    const lastTakeWord = takeNorm[acc.maxTake];
    const touchesTakeEdge = acc.minTake === 0 || acc.maxTake === takeNorm.length - 1;
    out.push({
      spanId: span.spanId,
      takeWordStart: firstTakeWord.index,
      takeWordEnd: lastTakeWord.index,
      tStart: takeWords[firstTakeWord.index].start,
      tEnd: takeWords[lastTakeWord.index].end,
      coverage: Number(coverage.toFixed(4)),
      matchQuality: Number((acc.matched / denom).toFixed(4)),
      truncated: touchesTakeEdge && coverage < 1
    });
  });
  return out;
}

export interface RawOrphan {
  takeWordStart: number;
  takeWordEnd: number;
  tStart: number;
  tEnd: number;
  text: string;
}

export function findOrphans(pairs: AlignedPair[], takeNorm: NormalizedWord[], takeWords: TranscriptWord[]): RawOrphan[] {
  const gapTakeIndices = pairs
    .flatMap((p) => p.kind === 'takeGap' ? [p.takeIndex] : [])
    .sort((a, b) => a - b);
  const orphans: RawOrphan[] = [];
  let runStart = -1;
  let prev = -2;
  const flush = (endIdx: number) => {
    if (runStart === -1) return;
    const length = endIdx - runStart + 1;
    if (length >= TAKES_CONSTANTS.MIN_ORPHAN_WORDS) {
      const startWord = takeNorm[runStart].index;
      const endWord = takeNorm[endIdx].index;
      orphans.push({
        takeWordStart: startWord,
        takeWordEnd: endWord,
        tStart: takeWords[startWord].start,
        tEnd: takeWords[endWord].end,
        text: takeWords.slice(startWord, endWord + 1).map((w) => w.text).join(' ')
      });
    }
    runStart = -1;
  };
  for (const takeIdx of gapTakeIndices) {
    if (takeIdx !== prev + 1) { flush(prev); runStart = takeIdx; }
    else if (runStart === -1) runStart = takeIdx;
    prev = takeIdx;
  }
  flush(prev);
  return orphans;
}
```

- [ ] **Step 3: Run + typecheck:** span tests PASS, `pnpm -r typecheck` clean, full core suite green.

- [ ] **Step 4: Commit:** `git add -A && git commit -m "feat(core): reference spans, cross-take projection, orphan detection"`

---

### Task 7: Candidate metrics + boundary scores

**Files:**
- Create: `packages/core/src/takes/metrics.ts`
- Modify: `packages/core/src/index.ts` (`export * from './takes/metrics';`)
- Modify: `skills/find-fillers/index.ts:12` (import the shared lexicon)
- Test: `packages/core/src/__tests__/take-metrics.test.ts`

**Interfaces:**
- Consumes: `TranscriptWord`, `normalizeToken`.
- Produces:
  - `FILLER_LEXICON: readonly string[]` (`['um','uh','erm','uhm','hmm','mmm','mhm','ah','eh','like',"y'know",'yknow']`)
  - `CandidateMetrics { fillerCount; falseStartCount; wordsPerSec; silenceRatio; durationSec; headBoundaryScore; tailBoundaryScore }`
  - `computeCandidateMetrics(takeWords: TranscriptWord[], startIndex: number, endIndex: number): CandidateMetrics` (inclusive indices into the full take word array)
  - `computeBoundaryScore(takeWords: TranscriptWord[], wordIndex: number, edge: 'head' | 'tail'): number`

- [ ] **Step 1: Write failing tests**

`take-metrics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeBoundaryScore, computeCandidateMetrics, FILLER_LEXICON } from '../takes/metrics';
import { makeWords } from './takes-fixtures';

describe('metrics', () => {
  it('counts fillers from the shared lexicon', () => {
    expect(FILLER_LEXICON).toContain('um');
    const words = makeWords('um so uh the thing');
    const metrics = computeCandidateMetrics(words, 0, words.length - 1);
    expect(metrics.fillerCount).toBe(2);
  });

  it('counts false starts (single and bigram repeats)', () => {
    const single = makeWords('the the cat sat');
    expect(computeCandidateMetrics(single, 0, single.length - 1).falseStartCount).toBe(1);
    const bigram = makeWords('i want i want this now');
    expect(computeCandidateMetrics(bigram, 0, bigram.length - 1).falseStartCount).toBe(1);
  });

  it('computes wordsPerSec, durationSec and silenceRatio', () => {
    const words = makeWords('one two three four', { wordSec: 0.3, gapSec: 0.2 }); // 4 words, each 0.3 spoken + 0.2 gap
    const metrics = computeCandidateMetrics(words, 0, words.length - 1);
    expect(metrics.durationSec).toBeCloseTo(words[3].end - words[0].start, 5);
    expect(metrics.wordsPerSec).toBeGreaterThan(0);
    expect(metrics.silenceRatio).toBeGreaterThan(0);
    expect(metrics.silenceRatio).toBeLessThan(1);
  });

  it('boundary score rewards gaps and sentence terminals', () => {
    const words = makeWords('done. next word here', { gapsAfter: { 0: 1.5 } });
    // head at word 1 ("next"): preceding word "done." is terminal AND gap 1.5 > cap
    const head = computeBoundaryScore(words, 1, 'head');
    expect(head).toBeCloseTo(1, 3);
    // head at word 0: i === 0 -> gap Infinity treated as full, no preceding terminal -> 0.6
    expect(computeBoundaryScore(words, 0, 'head')).toBeCloseTo(0.6, 3);
  });

  it('tail score at last word uses Infinity gap', () => {
    const words = makeWords('alpha beta gamma.');
    expect(computeBoundaryScore(words, words.length - 1, 'tail')).toBeCloseTo(1, 3); // terminal + full gap
  });
});
```

- [ ] **Step 2: Run, verify FAIL**, then implement.

`takes/metrics.ts`:

```ts
import type { TranscriptWord } from '../schemas';
import { normalizeToken } from './normalize';

export const FILLER_LEXICON = ['um', 'uh', 'erm', 'uhm', 'hmm', 'mmm', 'mhm', 'ah', 'eh', 'like', "y'know", 'yknow'] as const;
const FILLER_SET = new Set<string>(FILLER_LEXICON);

export interface CandidateMetrics {
  fillerCount: number;
  falseStartCount: number;
  wordsPerSec: number;
  silenceRatio: number;
  durationSec: number;
  headBoundaryScore: number;
  tailBoundaryScore: number;
}

const SENTENCE_END = /[.!?…]["')\]]*$/;
const BOUNDARY_GAP_CAP = 2;
const BOUNDARY_GAP_RAMP = 0.6;

export function computeBoundaryScore(takeWords: TranscriptWord[], wordIndex: number, edge: 'head' | 'tail'): number {
  let gap: number;
  let terminal: boolean;
  if (edge === 'head') {
    gap = wordIndex === 0 ? Infinity : takeWords[wordIndex].start - takeWords[wordIndex - 1].end;
    terminal = wordIndex === 0 || SENTENCE_END.test(takeWords[wordIndex - 1].text);
  } else {
    gap = wordIndex === takeWords.length - 1 ? Infinity : takeWords[wordIndex + 1].start - takeWords[wordIndex].end;
    terminal = SENTENCE_END.test(takeWords[wordIndex].text);
  }
  const gapTerm = Math.min(1, Math.min(gap, BOUNDARY_GAP_CAP) / BOUNDARY_GAP_RAMP) * 0.6;
  const score = gapTerm + (terminal ? 0.4 : 0);
  return Number(score.toFixed(3));
}

export function computeCandidateMetrics(takeWords: TranscriptWord[], startIndex: number, endIndex: number): CandidateMetrics {
  const slice = takeWords.slice(startIndex, endIndex + 1);
  const normalized = slice.map((w) => normalizeToken(w.normalized || w.text));
  const fillerCount = normalized.filter((text) => FILLER_SET.has(text)).length;

  let falseStartCount = 0;
  for (let i = 0; i + 1 < normalized.length; i++) if (normalized[i] && normalized[i] === normalized[i + 1]) falseStartCount += 1;
  for (let i = 0; i + 3 < normalized.length; i++) if (normalized[i] && normalized[i] === normalized[i + 2] && normalized[i + 1] === normalized[i + 3]) falseStartCount += 1;

  const tStart = slice[0].start;
  const tEnd = slice[slice.length - 1].end;
  const durationSec = tEnd - tStart;
  const spoken = slice.reduce((sum, w) => sum + (w.end - w.start), 0);
  const wordsPerSec = durationSec > 0 ? Number((slice.length / durationSec).toFixed(4)) : 0;
  const silenceRatio = durationSec > 0 ? Number(Math.min(1, Math.max(0, 1 - spoken / durationSec)).toFixed(4)) : 0;

  return {
    fillerCount,
    falseStartCount,
    wordsPerSec,
    silenceRatio,
    durationSec: Number(durationSec.toFixed(4)),
    headBoundaryScore: computeBoundaryScore(takeWords, startIndex, 'head'),
    tailBoundaryScore: computeBoundaryScore(takeWords, endIndex, 'tail')
  };
}
```

`skills/find-fillers/index.ts:12` - replace the inline regex with the shared lexicon. Import at top: `import { FILLER_LEXICON } from '@etvideoscript/core';` then:

```ts
    .filter((word) => FILLER_LEXICON.includes((word.normalized || word.text).toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')))
```

- [ ] **Step 3: Run + typecheck:** `npx vitest run packages/core/src/__tests__/take-metrics.test.ts` PASS, `pnpm -r typecheck` clean.

- [ ] **Step 4: Commit:** `git add -A && git commit -m "feat(core): candidate metrics, boundary scores, shared filler lexicon"`

---

### Task 8: Alignment orchestrator + artifact schemas + IO

**Files:**
- Modify: `packages/core/src/takes/schema.ts` (add artifact schemas)
- Create: `packages/core/src/takes/alignment.ts`, `packages/core/src/takes/io.ts`
- Modify: `packages/core/src/index.ts` (`export * from './takes/alignment'; export * from './takes/io';`)
- Test: `packages/core/src/__tests__/take-alignment-artifact.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4-7, `TakeGroup`, `ManifestV3`, `TranscriptWord`.
- Produces:
  - Zod schemas + types: `CandidateMetricsSchema`, `SpanCandidateSchema` (`SpanCandidate`), `OrphanSpanSchema` (`OrphanSpan`), `AlignmentArtifactSchema` (`AlignmentArtifact`), `CompositionFileSchema` (`CompositionFile`), `SelectionSchema` (`Selection`) - EXACTLY as spec §8. (Put composition schemas here too so Task 10 imports them.)
  - `computeAlignment(input: AlignInput): AlignmentArtifact` where `AlignInput { manifest, groupId, transcripts: Map<string, TranscriptWord[]>, scriptText?, generatedAt: string }`. Pure (generatedAt passed in).
  - `readAlignment(workspaceDir): AlignmentArtifact` / `writeAlignment(workspaceDir, artifact)` / `readComposition(workspaceDir, file?)` / `writeComposition(workspaceDir, file)` / `compositionHash(file: CompositionFile): string` (node-only, in io.ts).

- [ ] **Step 1: Add artifact schemas to `takes/schema.ts`** (append; all fields per spec §8.1/§8.2):

```ts
export const CandidateMetricsSchema = z.object({
  fillerCount: z.number().int().nonnegative(),
  falseStartCount: z.number().int().nonnegative(),
  wordsPerSec: z.number().nonnegative(),
  silenceRatio: z.number().min(0).max(1),
  durationSec: z.number().nonnegative(),
  headBoundaryScore: z.number().min(0).max(1),
  tailBoundaryScore: z.number().min(0).max(1)
});

export const SpanCandidateSchema = z.object({
  spanId: z.string().min(1),
  clipId: z.string().min(1),
  takeWordStart: z.number().int().nonnegative(),
  takeWordEnd: z.number().int().nonnegative(),
  tStart: z.number().nonnegative(),
  tEnd: z.number().nonnegative(),
  coverage: z.number().min(0).max(1),
  matchQuality: z.number().min(0).max(1),
  truncated: z.boolean(),
  metrics: CandidateMetricsSchema
});
export type SpanCandidate = z.infer<typeof SpanCandidateSchema>;

export const OrphanSpanSchema = z.object({
  orphanId: z.string().min(1),
  clipId: z.string().min(1),
  takeWordStart: z.number().int().nonnegative(),
  takeWordEnd: z.number().int().nonnegative(),
  tStart: z.number().nonnegative(),
  tEnd: z.number().nonnegative(),
  text: z.string().min(1)
});
export type OrphanSpan = z.infer<typeof OrphanSpanSchema>;

export const AlignmentArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  groupId: z.string().min(1),
  generatedAt: z.string().datetime(),
  reference: z.object({ kind: z.enum(['take', 'file']), clipId: z.string().min(1).optional(), path: z.string().min(1).optional() }),
  takes: z.array(z.object({
    clipId: z.string().min(1), assetId: z.string().min(1), label: z.string().min(1),
    wordCount: z.number().int().nonnegative(), matchedFraction: z.number().min(0).max(1), lowConfidence: z.boolean()
  })),
  spans: z.array(z.object({ spanId: z.string().min(1), ordinal: z.number().int().positive(), text: z.string().min(1) })),
  candidates: z.array(SpanCandidateSchema),
  orphans: z.array(OrphanSpanSchema)
});
export type AlignmentArtifact = z.infer<typeof AlignmentArtifactSchema>;

export const SelectionSchema = z.object({
  order: z.number().int().positive(),
  clipId: z.string().min(1),
  spanIds: z.array(z.string().min(1)).optional(),
  orphanId: z.string().min(1).optional(),
  trim: z.object({ headWords: z.number().int().nonnegative().default(0), tailWords: z.number().int().nonnegative().default(0) }).optional(),
  chapterTitle: z.string().min(1).optional(),
  rationale: z.string().min(1)
}).refine((s) => (s.spanIds !== undefined) !== (s.orphanId !== undefined), { message: 'exactly one of spanIds or orphanId' });
export type Selection = z.infer<typeof SelectionSchema>;

export const CompositionFileSchema = z.object({
  schemaVersion: z.literal(1),
  groupId: z.string().min(1),
  selections: z.array(SelectionSchema).min(1),
  gaps: z.array(z.object({
    spanIds: z.array(z.string().min(1)).min(1),
    action: z.enum(['voice_patch', 'drop']),
    text: z.string().optional(),
    rationale: z.string().min(1)
  })).default([])
});
export type CompositionFile = z.infer<typeof CompositionFileSchema>;
```

- [ ] **Step 2: Write failing tests**

`take-alignment-artifact.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeAlignment } from '../takes/alignment';
import { AlignmentArtifactSchema, TAKES_CONSTANTS } from '../takes/schema';
import { makeManifest, makeTrack, makeClip, makeVideoAsset, makeWords } from './takes-fixtures';

const GEN_AT = '2026-01-01T00:00:00.000Z';

function scenario(clips: Array<{ clipId: string; assetId: string; text: string; dur: number }>, reference?: { kind: 'take'; clipId: string }) {
  const staging = makeTrack({ trackId: 'track_takes', kind: 'video', role: 'staging', clips: clips.map((c) => makeClip(c.clipId, c.assetId, c.dur)) });
  const manifest = makeManifest({
    assets: clips.map((c) => makeVideoAsset(c.assetId, c.dur)),
    tracks: [staging],
    takeGroups: [{ groupId: 'main', label: 'main', clipIds: clips.map((c) => c.clipId), reference }]
  });
  const transcripts = new Map(clips.map((c) => [c.clipId, makeWords(c.text, { clipId: c.clipId })]));
  return computeAlignment({ manifest, groupId: 'main', transcripts, generatedAt: GEN_AT });
}

const SENTENCE = 'Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu.';

describe('computeAlignment', () => {
  it('produces a schema-valid artifact', () => {
    const artifact = scenario([
      { clipId: 'clip_take_01', assetId: 'a1', text: SENTENCE, dur: 30 },
      { clipId: 'clip_take_02', assetId: 'a2', text: SENTENCE, dur: 31 }
    ]);
    expect(AlignmentArtifactSchema.parse(artifact)).toBeTruthy();
    expect(artifact.spans.length).toBe(3);
  });

  it('identical takes -> coverage 1 for every span on every take', () => {
    const artifact = scenario([
      { clipId: 'clip_take_01', assetId: 'a1', text: SENTENCE, dur: 30 },
      { clipId: 'clip_take_02', assetId: 'a2', text: SENTENCE, dur: 31 }
    ]);
    expect(artifact.candidates.length).toBe(6); // 3 spans x 2 takes
    expect(artifact.candidates.every((c) => c.coverage === 1)).toBe(true);
  });

  it('pickup take contributes candidates only for its span', () => {
    const artifact = scenario([
      { clipId: 'clip_take_01', assetId: 'a1', text: SENTENCE, dur: 30 },
      { clipId: 'clip_take_02', assetId: 'a2', text: 'Epsilon zeta eta theta.', dur: 6 }
    ]);
    const take2 = artifact.candidates.filter((c) => c.clipId === 'clip_take_02');
    expect(take2.map((c) => c.spanId)).toEqual(['s002']);
  });

  it('flags low-confidence takes at the 0.3 threshold boundary', () => {
    const artifact = scenario([
      { clipId: 'clip_take_01', assetId: 'a1', text: SENTENCE, dur: 30 },
      { clipId: 'clip_take_02', assetId: 'a2', text: 'totally unrelated words that share nothing at all here folks', dur: 12 }
    ]);
    const take2 = artifact.takes.find((t) => t.clipId === 'clip_take_02')!;
    expect(take2.matchedFraction).toBeLessThan(TAKES_CONSTANTS.LOW_CONFIDENCE_MATCH_FRACTION);
    expect(take2.lowConfidence).toBe(true);
  });

  it('auto-selects the longest transcript as reference, tie-break lowest clipId', () => {
    const artifact = scenario([
      { clipId: 'clip_take_02', assetId: 'a2', text: SENTENCE, dur: 31 },
      { clipId: 'clip_take_01', assetId: 'a1', text: SENTENCE, dur: 30 }
    ]);
    expect(artifact.reference).toEqual({ kind: 'take', clipId: 'clip_take_01' });
  });

  it('is byte-identical across runs', () => {
    const clips = [
      { clipId: 'clip_take_01', assetId: 'a1', text: SENTENCE, dur: 30 },
      { clipId: 'clip_take_02', assetId: 'a2', text: SENTENCE, dur: 31 }
    ];
    expect(JSON.stringify(scenario(clips))).toEqual(JSON.stringify(scenario(clips)));
  });

  it('detects orphan material as a distinct entry', () => {
    const artifact = scenario([
      { clipId: 'clip_take_01', assetId: 'a1', text: SENTENCE, dur: 30 },
      { clipId: 'clip_take_02', assetId: 'a2', text: 'Alpha beta gamma delta. brand new tangent nobody asked for at all here really. Epsilon zeta eta theta. Iota kappa lambda mu.', dur: 40 }
    ]);
    expect(artifact.orphans.length).toBeGreaterThanOrEqual(1);
    expect(artifact.orphans[0].orphanId).toBe('o001');
  });
});
```

- [ ] **Step 3: Run, verify FAIL**, then implement.

`takes/alignment.ts`:

```ts
import type { ManifestV3 } from '../manifest/schema';
import type { TranscriptWord } from '../schemas';
import { alignWordSequences } from './align';
import { computeCandidateMetrics } from './metrics';
import { normalizeWords } from './normalize';
import { TAKES_CONSTANTS, TakesError, type AlignmentArtifact, type OrphanSpan, type SpanCandidate } from './schema';
import { findOrphans, normalizeReference, projectSpans, referenceFromScript, referenceFromTranscript, segmentReference, type ReferenceWord } from './spans';

export interface AlignInput {
  manifest: ManifestV3;
  groupId: string;
  transcripts: Map<string, TranscriptWord[]>;
  scriptText?: string;
  generatedAt: string;
}

export function computeAlignment(input: AlignInput): AlignmentArtifact {
  const group = input.manifest.takeGroups.find((g) => g.groupId === input.groupId);
  if (!group) throw new TakesError('TAKES_UNKNOWN_GROUP', `Unknown take group: ${input.groupId}. Known: ${input.manifest.takeGroups.map((g) => g.groupId).join(', ') || '(none)'}`);
  if (group.clipIds.length < 1) throw new TakesError('TAKES_EMPTY_GROUP', `Take group ${input.groupId} has no takes`);

  const missing = group.clipIds.filter((clipId) => !input.transcripts.has(clipId));
  if (missing.length > 0) {
    throw new TakesError('TAKES_MISSING_TRANSCRIPTS',
      `Transcribe these takes first:\n${missing.map((clipId) => `  ets transcribe --clip ${clipId}`).join('\n')}`, { missing });
  }

  const assetOfClip = new Map<string, string>();
  const labelOfClip = new Map<string, string>();
  for (const track of input.manifest.tracks) {
    for (const clip of track.clips) if (group.clipIds.includes(clip.clipId)) assetOfClip.set(clip.clipId, clip.assetId);
  }
  group.clipIds.forEach((clipId, i) => labelOfClip.set(clipId, `take ${String(i + 1).padStart(2, '0')}`));

  // Reference selection
  let referenceWords: ReferenceWord[];
  let reference: AlignmentArtifact['reference'];
  if (group.reference?.kind === 'file' || input.scriptText !== undefined) {
    const text = input.scriptText ?? '';
    referenceWords = referenceFromScript(text);
    reference = { kind: 'file', path: group.reference?.kind === 'file' ? group.reference.path : 'takes/script.txt' };
  } else if (group.reference?.kind === 'take') {
    referenceWords = referenceFromTranscript(input.transcripts.get(group.reference.clipId)!);
    reference = { kind: 'take', clipId: group.reference.clipId };
  } else {
    const refClip = [...group.clipIds].sort((a, b) => {
      const wc = (input.transcripts.get(b)!.length) - (input.transcripts.get(a)!.length);
      return wc !== 0 ? wc : a.localeCompare(b);
    })[0];
    referenceWords = referenceFromTranscript(input.transcripts.get(refClip)!);
    reference = { kind: 'take', clipId: refClip };
  }

  const refNorm = normalizeReference(referenceWords);
  const spans = segmentReference(referenceWords);

  const takes: AlignmentArtifact['takes'] = [];
  const candidates: SpanCandidate[] = [];
  const orphans: OrphanSpan[] = [];
  let orphanSeq = 0;

  for (const clipId of group.clipIds) {
    const takeWords = input.transcripts.get(clipId)!;
    const takeNorm = normalizeWords(takeWords);
    const pairs = alignWordSequences(refNorm, takeNorm);
    const matched = pairs.filter((p) => p.kind === 'match').length;
    const matchedFraction = takeNorm.length > 0 ? Number((matched / takeNorm.length).toFixed(4)) : 0;
    takes.push({
      clipId, assetId: assetOfClip.get(clipId) ?? '', label: labelOfClip.get(clipId)!,
      wordCount: takeWords.length, matchedFraction,
      lowConfidence: matchedFraction < TAKES_CONSTANTS.LOW_CONFIDENCE_MATCH_FRACTION
    });

    for (const raw of projectSpans(spans, refNorm, takeNorm, takeWords, pairs)) {
      candidates.push({ ...raw, clipId, metrics: computeCandidateMetrics(takeWords, raw.takeWordStart, raw.takeWordEnd) });
    }
    for (const raw of findOrphans(pairs, takeNorm, takeWords)) {
      orphanSeq += 1;
      orphans.push({ orphanId: `o${String(orphanSeq).padStart(3, '0')}`, clipId, ...raw });
    }
  }

  candidates.sort((a, b) => a.spanId.localeCompare(b.spanId) || a.clipId.localeCompare(b.clipId));
  orphans.sort((a, b) => a.clipId.localeCompare(b.clipId) || a.tStart - b.tStart);
  // Re-number orphans after the stable sort so ids are ordered (clipId, tStart)
  orphans.forEach((orphan, i) => { orphan.orphanId = `o${String(i + 1).padStart(3, '0')}`; });

  return {
    schemaVersion: 1, groupId: input.groupId, generatedAt: input.generatedAt, reference,
    takes,
    spans: spans.map((s) => ({ spanId: s.spanId, ordinal: s.ordinal, text: s.text })),
    candidates, orphans
  };
}
```

`takes/io.ts`:

```ts
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertInside, atomicWriteJson } from '../filesystem';
import { AlignmentArtifactSchema, CompositionFileSchema, TakesError, type AlignmentArtifact, type CompositionFile } from './schema';

export function readAlignment(workspaceDir: string): AlignmentArtifact {
  const path = assertInside(resolve(workspaceDir), 'takes/alignment.json');
  if (!existsSync(path)) throw new TakesError('ALIGNMENT_STALE', 'takes/alignment.json not found. Run `ets takes align` first.');
  return AlignmentArtifactSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeAlignment(workspaceDir: string, artifact: AlignmentArtifact): void {
  atomicWriteJson(assertInside(resolve(workspaceDir), 'takes/alignment.json'), AlignmentArtifactSchema.parse(artifact));
}

export function readComposition(workspaceDir: string, relPath = 'takes/composition.json'): CompositionFile {
  const path = assertInside(resolve(workspaceDir), relPath);
  if (!existsSync(path)) throw new TakesError('COMPOSE_VALIDATION', `Composition file not found: ${relPath}`);
  return CompositionFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeComposition(workspaceDir: string, file: CompositionFile, relPath = 'takes/composition.json'): void {
  atomicWriteJson(assertInside(resolve(workspaceDir), relPath), CompositionFileSchema.parse(file));
}

/** Hash of the CANONICAL composition (parsed then re-serialized) so formatting never changes the hash. */
export function compositionHash(file: CompositionFile): string {
  return createHash('sha256').update(JSON.stringify(CompositionFileSchema.parse(file))).digest('hex');
}
```

`index.ts`: add `export * from './takes/alignment';` and `export * from './takes/io';`.

- [ ] **Step 4: Run + typecheck:** artifact tests PASS, `pnpm -r typecheck` clean, `npx vitest run packages/core` green.

- [ ] **Step 5: Commit:** `git add -A && git commit -m "feat(core): alignment orchestrator, artifact schemas, artifact io"`

---

### Task 9: Take import + takes CLI verbs

**Files:**
- Create: `packages/core/src/takes/import.ts`
- Modify: `packages/core/src/index.ts` (`export * from './takes/import';`)
- Modify: `packages/etvideo-cli/src/index.ts` (verbs `takes add|list|align|spans|span`)
- Test: `packages/core/src/__tests__/take-import.test.ts`

**Interfaces:**
- Consumes: `probeRecordingMedia`, `addAssetV3`, `addClipV3`, `addTrackV3`, `loadManifestV3`, `saveManifestV3`, `assertInside`.
- Produces: `ImportTakeResult { assetId; clipId; path; durationSec }`, `importTake(workspaceDir, sourceFilePath, opts: { groupId: string; label?: string }): ImportTakeResult`.

- [ ] **Step 1: Write failing tests**

`take-import.test.ts` (uses real tmp dirs + tiny fixture; if ffprobe is unavailable in CI, mock `probeRecordingMedia` per the existing media test pattern - check `packages/core/src/__tests__/` for how media tests stub ffprobe and follow it):

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../media')>();
  return { ...actual, probeRecordingMedia: vi.fn(() => ({ durationSec: 20, hasVideo: true, hasAudio: true, video: { width: 1920, height: 1080, fps: 30 }, audio: { sampleRate: 48000, channels: 2 } })) };
});

import { importTake } from '../takes/import';
import { loadManifestV3, saveManifestV3 } from '../manifest/io';
import { defaultManifest } from '../filesystem';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function workspace(): string {
  dir = mkdtempSync(join(tmpdir(), 'ets-take-'));
  mkdirSync(join(dir, 'edits'), { recursive: true });
  saveManifestV3(dir, defaultManifest('proj_test'), { revision: false });
  return dir;
}

function fakeVideo(name: string): string { const p = join(dir, name); writeFileSync(p, 'x'); return p; }

describe('importTake', () => {
  it('copies takes with sequential numbering and builds staging track + group', () => {
    const w = workspace();
    const r1 = importTake(w, fakeVideo('a.mp4'), { groupId: 'main' });
    const r2 = importTake(w, fakeVideo('b.mp4'), { groupId: 'main' });
    expect(r1.clipId).toBe('clip_take_01');
    expect(r2.clipId).toBe('clip_take_02');
    expect(existsSync(join(w, 'input/takes/take-01.mp4'))).toBe(true);
    expect(existsSync(join(w, 'input/takes/take-02.mp4'))).toBe(true);
    const manifest = loadManifestV3(w);
    const staging = manifest.tracks.find((t) => t.role === 'staging')!;
    expect(staging.clips.map((c) => c.clipId)).toEqual(['clip_take_01', 'clip_take_02']);
    expect(manifest.takeGroups[0].clipIds).toEqual(['clip_take_01', 'clip_take_02']);
  });

  it('never overwrites input/source.mp4 and keeps the timeline video track empty', () => {
    const w = workspace();
    importTake(w, fakeVideo('a.mp4'), { groupId: 'main' });
    expect(existsSync(join(w, 'input/source.mp4'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**, then implement.

`takes/import.ts`:

```ts
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { assertInside } from '../filesystem';
import { loadManifestV3, saveManifestV3 } from '../manifest/io';
import { probeRecordingMedia } from '../media';
import { addAsset } from '../assets/operations';
import { addClip, addTrack } from '../tracks/operations';
import { TakesError } from './schema';

export interface ImportTakeResult { assetId: string; clipId: string; path: string; durationSec: number }

const STAGING_TRACK_ID = 'track_takes';

function nextTakeIndex(workspaceDir: string): number {
  const takesDir = assertInside(resolve(workspaceDir), 'input/takes');
  if (!existsSync(takesDir)) return 1;
  let max = 0;
  for (const name of readdirSync(takesDir)) {
    const m = /^take-(\d+)\./.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export function importTake(workspaceDir: string, sourceFilePath: string, opts: { groupId: string; label?: string }): ImportTakeResult {
  const source = resolve(sourceFilePath);
  if (!existsSync(source)) throw new TakesError('COMPOSE_VALIDATION', `Take source not found: ${sourceFilePath}`);
  const workspace = resolve(workspaceDir);
  const probe = probeRecordingMedia(source);
  if (!probe.hasVideo || probe.durationSec <= 0) throw new TakesError('COMPOSE_VALIDATION', `Not a usable video take: ${sourceFilePath}`);

  const index = nextTakeIndex(workspace);
  const nn = String(index).padStart(2, '0');
  const ext = extname(source) || '.mp4';
  const relPath = `input/takes/take-${nn}${ext}`;
  const target = assertInside(workspace, relPath);
  mkdirSync(assertInside(workspace, 'input/takes'), { recursive: true });
  if (existsSync(target)) throw new TakesError('COMPOSE_VALIDATION', `Take target already exists (unexpected): ${relPath}`);
  copyFileSync(source, target);

  const assetId = `asset_take_${nn}`;
  const clipId = `clip_take_${nn}`;
  let manifest = loadManifestV3(workspace);
  manifest = addAsset(manifest, {
    assetId, kind: 'video', path: relPath, durationSec: probe.durationSec, provenance: 'imported',
    video: probe.video ? { width: probe.video.width, height: probe.video.height, fps: probe.video.fps, codec: probe.video.codec, pixelFormat: probe.video.pixelFormat } : undefined,
    audio: probe.audio ? { sampleRate: probe.audio.sampleRate, channels: probe.audio.channels, codec: probe.audio.codec } : undefined
  }).manifest;

  if (!manifest.tracks.some((t) => t.role === 'staging')) {
    manifest = addTrack(manifest, { trackId: STAGING_TRACK_ID, kind: 'video', name: 'Takes', order: 1000, role: 'staging', hidden: true, clips: [] } as Parameters<typeof addTrack>[1]).manifest;
  }
  const stagingTrack = manifest.tracks.find((t) => t.role === 'staging')!;
  manifest = addClip(manifest, { trackId: stagingTrack.trackId, clip: { clipId, assetId, sourceStart: 0, sourceEnd: probe.durationSec, timelineStart: 0 } }).manifest;

  const group = manifest.takeGroups.find((g) => g.groupId === opts.groupId);
  if (group) group.clipIds.push(clipId);
  else manifest.takeGroups.push({ groupId: opts.groupId, label: opts.label ?? opts.groupId, clipIds: [clipId] });

  saveManifestV3(workspace, manifest, { revision: true });
  return { assetId, clipId, path: relPath, durationSec: probe.durationSec };
}
```

NOTE: confirm `addTrack`'s input type accepts `role`. If `AddTrackInput` omits `role`, add `role?: 'timeline' | 'staging'` to it in `tracks/operations.ts` and pass it through to the created track (default `'timeline'`). The cast `as Parameters<...>[1]` is a stopgap; prefer widening `AddTrackInput` properly and dropping the cast.

CLI verbs (`packages/etvideo-cli/src/index.ts`) - import `importTake, computeAlignment, readAlignment, writeAlignment, loadManifestV3, saveManifestV3, transcribableClips, loadTranscript, nowIso` and per-clip transcript loading. Since alignment needs a `Map<clipId, TranscriptWord[]>`, load each clip transcript from `transcript/<clipId>/words.json` (that is where `writeTranscript` puts per-clip output; verify the exact path in `transcript.ts:192`). Add a small loader:

```ts
import { readFileSync } from 'node:fs';
import { TranscriptWordsSchema } from '@etvideoscript/core';

function loadClipTranscript(workspace: string, clipId: string) {
  const path = resolve(workspace, `transcript/${clipId}/words.json`);
  if (!existsSync(path)) return null;
  return TranscriptWordsSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).words;
}

const takesCommand = program.command('takes').description('Multi-take import, alignment, and inspection');

takesCommand.command('add').description('Import one or more takes into the staging track')
  .argument('<files...>', 'take video files')
  .option('--group <id>', 'take group id', 'main')
  .option('--label <label>', 'label (single file only)')
  .action((files: string[], opts) => takesCliAction(program.opts().json, () => {
    if (opts.label && files.length > 1) throw new TakesError('COMPOSE_VALIDATION', '--label is only valid with a single file');
    const workspace = workspaceOption(program.opts().workspace);
    const results = files.map((file) => importTake(workspace, resolve(file), { groupId: opts.group, label: opts.label }));
    print(program.opts().json ? results : results.map((r) => `${r.clipId} <- ${r.path} (${r.durationSec.toFixed(1)}s)`).join('\n'), program.opts().json);
  }));

takesCommand.command('list').description('List take groups and their takes')
  .action(() => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    const manifest = loadManifestV3(workspace);
    const rows = manifest.takeGroups.flatMap((g) => g.clipIds.map((clipId) => {
      const words = loadClipTranscript(workspace, clipId);
      return { groupId: g.groupId, clipId, transcribed: words !== null, wordCount: words?.length ?? 0 };
    }));
    print(program.opts().json ? { groups: manifest.takeGroups, takes: rows } : rows.map((r) => `${r.groupId}/${r.clipId} ${r.transcribed ? `${r.wordCount}w` : 'not transcribed'}`).join('\n') || '(no takes)', program.opts().json);
  }));

takesCommand.command('align').description('Align takes against a reference script into takes/alignment.json')
  .option('--group <id>', 'take group id', 'main')
  .option('--reference <clipId>', 'use a specific take as reference')
  .option('--script <file>', 'use a plain-text script file as reference')
  .action((opts) => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    let manifest = loadManifestV3(workspace);
    const group = manifest.takeGroups.find((g) => g.groupId === opts.group);
    if (!group) throw new TakesError('TAKES_UNKNOWN_GROUP', `Unknown take group: ${opts.group}. Known: ${manifest.takeGroups.map((g) => g.groupId).join(', ') || '(none)'}`);
    let scriptText: string | undefined;
    if (opts.script) {
      scriptText = readFileSync(resolve(opts.script), 'utf8');
      writeFileSync(join(workspace, 'takes/script.txt'), scriptText); // ensure takes/ exists first
      group.reference = { kind: 'file', path: 'takes/script.txt' };
      saveManifestV3(workspace, manifest, { revision: true });
    } else if (opts.reference) {
      group.reference = { kind: 'take', clipId: opts.reference };
      saveManifestV3(workspace, manifest, { revision: true });
      manifest = loadManifestV3(workspace);
    }
    const transcripts = new Map<string, ReturnType<typeof loadClipTranscript>>();
    const missing: string[] = [];
    for (const clipId of group.clipIds) {
      const words = loadClipTranscript(workspace, clipId);
      if (!words) missing.push(clipId);
      else transcripts.set(clipId, words);
    }
    if (missing.length) throw new TakesError('TAKES_MISSING_TRANSCRIPTS', `Transcribe these first:\n${missing.map((c) => `  ets transcribe --clip ${c}`).join('\n')}`, { missing });
    const artifact = computeAlignment({ manifest, groupId: opts.group, transcripts: transcripts as Map<string, NonNullable<ReturnType<typeof loadClipTranscript>>>, scriptText, generatedAt: nowIso() });
    mkdirSync(join(workspace, 'takes'), { recursive: true });
    writeAlignment(workspace, artifact);
    print(program.opts().json ? artifact : `Aligned ${artifact.takes.length} takes, ${artifact.spans.length} spans, ${artifact.orphans.length} orphans${artifact.takes.some((t) => t.lowConfidence) ? ' (low-confidence takes present)' : ''}`, program.opts().json);
  }));

takesCommand.command('spans').description('Show the span x take decision table')
  .option('--group <id>', 'take group id', 'main')
  .option('--contested', 'only spans where the top two candidates are close')
  .option('--gaps', 'only spans with zero candidates')
  .action((opts) => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    const artifact = readAlignment(workspace);
    const byspan = new Map<string, typeof artifact.candidates>();
    for (const c of artifact.candidates) { const list = byspan.get(c.spanId) ?? []; list.push(c); byspan.set(c.spanId, list); }
    const composite = (c: (typeof artifact.candidates)[number]) => c.matchQuality - 0.05 * c.metrics.fillerCount - 0.05 * c.metrics.falseStartCount;
    let spans = artifact.spans;
    if (opts.gaps) spans = spans.filter((s) => !byspan.has(s.spanId));
    if (opts.contested) spans = spans.filter((s) => {
      const list = (byspan.get(s.spanId) ?? []).slice().sort((a, b) => composite(b) - composite(a));
      return list.length >= 2 && (composite(list[0]) - composite(list[1])) < 0.15;
    });
    const rows = spans.map((s) => ({ spanId: s.spanId, ordinal: s.ordinal, text: s.text.split(/\s+/).slice(0, 8).join(' '), words: s.text.split(/\s+/).length, candidates: (byspan.get(s.spanId) ?? []).map((c) => ({ clipId: c.clipId, coverage: c.coverage, matchQuality: c.matchQuality, fillerCount: c.metrics.fillerCount, durationSec: c.metrics.durationSec })) }));
    print(program.opts().json ? { spans: rows } : rows.map((r) => `${r.spanId} (${r.ordinal}) "${r.text}..." ${r.candidates.map((c) => `${c.clipId}:cov${c.coverage}/mq${c.matchQuality}/f${c.fillerCount}`).join('  ')}`).join('\n') || '(no spans match filter)', program.opts().json);
  }));

takesCommand.command('span').description('Full detail for one span or orphan')
  .argument('<spanId>', 'span id (s001) or orphan id (o001)')
  .option('--take <clipId>', 'limit to one take')
  .option('--words', 'include word-by-word timings')
  .action((spanId: string, opts) => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    const artifact = readAlignment(workspace);
    if (spanId.startsWith('o')) {
      const orphan = artifact.orphans.find((o) => o.orphanId === spanId);
      if (!orphan) throw new TakesError('ALIGNMENT_STALE', `No orphan ${spanId} in alignment`);
      print(program.opts().json ? orphan : `${orphan.orphanId} [${orphan.clipId}] ${orphan.tStart.toFixed(2)}-${orphan.tEnd.toFixed(2)}s: ${orphan.text}`, program.opts().json);
      return;
    }
    const span = artifact.spans.find((s) => s.spanId === spanId);
    if (!span) throw new TakesError('ALIGNMENT_STALE', `No span ${spanId} in alignment`);
    let candidates = artifact.candidates.filter((c) => c.spanId === spanId);
    if (opts.take) candidates = candidates.filter((c) => c.clipId === opts.take);
    const detail = {
      span,
      candidates: candidates.map((c) => ({ ...c, words: opts.words ? (loadClipTranscript(workspace, c.clipId) ?? []).slice(c.takeWordStart, c.takeWordEnd + 1).map((w) => ({ text: w.text, start: w.start, end: w.end })) : undefined }))
    };
    print(program.opts().json ? detail : `${span.spanId}: ${span.text}\n${candidates.map((c) => `  ${c.clipId} cov${c.coverage} mq${c.matchQuality} fill${c.metrics.fillerCount} head${c.metrics.headBoundaryScore} tail${c.metrics.tailBoundaryScore}`).join('\n')}`, program.opts().json);
  }));
```

- [ ] **Step 3: Run + typecheck:** `npx vitest run packages/core/src/__tests__/take-import.test.ts` PASS, `pnpm -r typecheck` clean.

- [ ] **Step 4: CLI smoke test** (real end-to-end with mock transcripts). Create a scratch script and run it; this proves the verbs wire together:

```bash
node -e "console.log('smoke placeholder - run manual CLI flow in Task 11 e2e')"
```

(Full CLI smoke is covered by the Task 11 e2e test which drives the real verbs. Here just confirm the command tree registers: `pnpm --filter etvideo-cli exec tsx src/index.ts takes --help` prints add/list/align/spans/span.)

- [ ] **Step 5: Commit:** `git add -A && git commit -m "feat(core,cli): take import and takes align/list/spans/span verbs"`

---

### Task 10: Composition validate/materialize + compose apply + chapters

**Files:**
- Create: `packages/core/src/takes/composition.ts`, `packages/core/src/takes/chapters.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/etvideo-cli/src/index.ts` (verbs `compose apply`, `export-chapters`)
- Test: `packages/core/src/__tests__/composition.test.ts`, `packages/core/src/__tests__/chapters.test.ts`

**Interfaces:**
- Consumes: `AlignmentArtifact`, `CompositionFile`, `ManifestV3`, `COMPOSE_PAD`.
- Produces:
  - `MaterializedClipPlan { order; clipId; assetId; sourceStart; sourceEnd; timelineStart; durationSec; spanIds?; orphanId?; chapterTitle? }`
  - `CompositionIssue { rule: string; message: string; spanId?: string; clipId?: string }`
  - `CompositionValidation { errors: CompositionIssue[]; warnings: CompositionIssue[]; plan: MaterializedClipPlan[] }`
  - `validateComposition(manifest, alignment, composition): CompositionValidation`
  - `materializeComposition(manifest, plan): ManifestV3`
  - `Chapter { title; startSec }`, `deriveChapters(composition, alignment, plan): Chapter[]`
  - `COMPOSE_PAD = { headSec: 0.12, tailSec: 0.12 }`

- [ ] **Step 1: Write failing tests** (`composition.test.ts` - one test per V-rule and W-rule, plus materialization):

```ts
import { describe, expect, it } from 'vitest';
import { materializeComposition, validateComposition, COMPOSE_PAD } from '../takes/composition';
import type { AlignmentArtifact, CompositionFile } from '../takes/schema';
import { makeManifest, makeTrack, makeClip, makeVideoAsset } from './takes-fixtures';

function metrics(over: Partial<AlignmentArtifact['candidates'][number]['metrics']> = {}) {
  return { fillerCount: 0, falseStartCount: 0, wordsPerSec: 3, silenceRatio: 0.1, durationSec: 4, headBoundaryScore: 0.9, tailBoundaryScore: 0.9, ...over };
}
function candidate(spanId: string, clipId: string, over: Partial<AlignmentArtifact['candidates'][number]> = {}) {
  return { spanId, clipId, takeWordStart: 0, takeWordEnd: 3, tStart: 1, tEnd: 5, coverage: 1, matchQuality: 1, truncated: false, metrics: metrics(over.metrics), ...over, metrics: metrics(over.metrics) };
}

const alignment: AlignmentArtifact = {
  schemaVersion: 1, groupId: 'main', generatedAt: '2026-01-01T00:00:00.000Z', reference: { kind: 'take', clipId: 'clip_take_01' },
  takes: [
    { clipId: 'clip_take_01', assetId: 'a1', label: 'take 01', wordCount: 12, matchedFraction: 1, lowConfidence: false },
    { clipId: 'clip_take_02', assetId: 'a2', label: 'take 02', wordCount: 12, matchedFraction: 1, lowConfidence: false }
  ],
  spans: [{ spanId: 's001', ordinal: 1, text: 'span one' }, { spanId: 's002', ordinal: 2, text: 'span two' }],
  candidates: [
    candidate('s001', 'clip_take_01', { tStart: 1, tEnd: 5 }),
    candidate('s001', 'clip_take_02', { tStart: 0.5, tEnd: 4 }),
    candidate('s002', 'clip_take_01', { tStart: 6, tEnd: 9 }),
    candidate('s002', 'clip_take_02', { tStart: 5, tEnd: 8 })
  ],
  orphans: [{ orphanId: 'o001', clipId: 'clip_take_02', takeWordStart: 20, takeWordEnd: 30, tStart: 12, tEnd: 16, text: 'aside material here' }]
};

function manifestWithTakes() {
  const staging = makeTrack({ trackId: 'track_takes', kind: 'video', role: 'staging', clips: [makeClip('clip_take_01', 'a1', 30), makeClip('clip_take_02', 'a2', 31)] });
  const timeline = makeTrack({ trackId: 'track_video', kind: 'video', order: 0, clips: [] });
  return makeManifest({ assets: [makeVideoAsset('a1', 30), makeVideoAsset('a2', 31)], tracks: [timeline, staging], takeGroups: [{ groupId: 'main', label: 'main', clipIds: ['clip_take_01', 'clip_take_02'] }] });
}

const valid: CompositionFile = {
  schemaVersion: 1, groupId: 'main',
  selections: [
    { order: 1, clipId: 'clip_take_01', spanIds: ['s001'], rationale: 'best open' },
    { order: 2, clipId: 'clip_take_02', spanIds: ['s002'], rationale: 'cleaner close' }
  ],
  gaps: []
};

describe('validateComposition', () => {
  it('accepts a valid composition and plans clips in order', () => {
    const result = validateComposition(manifestWithTakes(), alignment, valid);
    expect(result.errors).toEqual([]);
    expect(result.plan.map((p) => p.clipId)).toEqual(['clip_comp_001', 'clip_comp_002']);
    expect(result.plan[0].timelineStart).toBe(0);
    expect(result.plan[1].timelineStart).toBeCloseTo(result.plan[0].durationSec, 5);
  });

  it('V1 rejects unknown group', () => {
    const result = validateComposition(manifestWithTakes(), alignment, { ...valid, groupId: 'nope' });
    expect(result.errors.some((e) => e.rule === 'V1')).toBe(true);
  });
  it('V2 rejects unknown spanId', () => {
    const bad = { ...valid, selections: [{ order: 1, clipId: 'clip_take_01', spanIds: ['s999'], rationale: 'x' }] };
    expect(validateComposition(manifestWithTakes(), alignment, bad).errors.some((e) => e.rule === 'V2')).toBe(true);
  });
  it('V3 rejects non-contiguous spans and missing candidate', () => {
    const bad = { ...valid, selections: [{ order: 1, clipId: 'clip_take_01', spanIds: ['s001', 's999'], rationale: 'x' }] };
    expect(validateComposition(manifestWithTakes(), alignment, bad).errors.some((e) => e.rule === 'V2' || e.rule === 'V3')).toBe(true);
  });
  it('V4 rejects non-dense order', () => {
    const bad = { ...valid, selections: [{ order: 1, clipId: 'clip_take_01', spanIds: ['s001'], rationale: 'x' }, { order: 3, clipId: 'clip_take_02', spanIds: ['s002'], rationale: 'y' }] };
    expect(validateComposition(manifestWithTakes(), alignment, bad).errors.some((e) => e.rule === 'V4')).toBe(true);
  });
  it('V5 rejects a span used twice', () => {
    const bad = { ...valid, selections: [{ order: 1, clipId: 'clip_take_01', spanIds: ['s001'], rationale: 'x' }, { order: 2, clipId: 'clip_take_02', spanIds: ['s001'], rationale: 'y' }] };
    expect(validateComposition(manifestWithTakes(), alignment, bad).errors.some((e) => e.rule === 'V5')).toBe(true);
  });
  it('V6 rejects trim that removes all words', () => {
    const bad = { ...valid, selections: [{ order: 1, clipId: 'clip_take_01', spanIds: ['s001'], trim: { headWords: 5, tailWords: 5 }, rationale: 'x' }, valid.selections[1]] };
    expect(validateComposition(manifestWithTakes(), alignment, bad).errors.some((e) => e.rule === 'V6')).toBe(true);
  });

  it('W1 warns on a risky seam', () => {
    const risky: AlignmentArtifact = { ...alignment, candidates: alignment.candidates.map((c) => c.spanId === 's001' && c.clipId === 'clip_take_01' ? { ...c, metrics: { ...c.metrics, tailBoundaryScore: 0.2 } } : c) };
    expect(validateComposition(manifestWithTakes(), risky, valid).warnings.some((w) => w.rule === 'W1')).toBe(true);
  });
  it('W2 warns on a dropped span not declared in gaps', () => {
    const only = { ...valid, selections: [valid.selections[0]] };
    expect(validateComposition(manifestWithTakes(), alignment, only).warnings.some((w) => w.rule === 'W2')).toBe(true);
  });
  it('W4 warns on out-of-order spans', () => {
    const reordered = { ...valid, selections: [{ order: 1, clipId: 'clip_take_02', spanIds: ['s002'], rationale: 'x' }, { order: 2, clipId: 'clip_take_01', spanIds: ['s001'], rationale: 'y' }] };
    expect(validateComposition(manifestWithTakes(), alignment, reordered).warnings.some((w) => w.rule === 'W4')).toBe(true);
  });
});

describe('materializeComposition', () => {
  it('writes clips to the timeline track and leaves staging + groups intact', () => {
    const m = manifestWithTakes();
    const plan = validateComposition(m, alignment, valid).plan;
    const next = materializeComposition(m, plan);
    const timeline = next.tracks.find((t) => t.trackId === 'track_video')!;
    expect(timeline.clips.map((c) => c.clipId)).toEqual(['clip_comp_001', 'clip_comp_002']);
    expect(next.tracks.find((t) => t.role === 'staging')!.clips.length).toBe(2);
    expect(next.takeGroups.length).toBe(1);
    // pad clamps sourceStart >= 0
    expect(timeline.clips[1].sourceStart).toBeGreaterThanOrEqual(0);
  });

  it('is a no-op-safe pure function (does not mutate input manifest)', () => {
    const m = manifestWithTakes();
    const before = JSON.stringify(m);
    materializeComposition(m, validateComposition(m, alignment, valid).plan);
    expect(JSON.stringify(m)).toBe(before);
  });
});
```

`chapters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deriveChapters } from '../takes/chapters';

const plan = [
  { order: 1, clipId: 'clip_comp_001', assetId: 'a1', sourceStart: 1, sourceEnd: 5, timelineStart: 0, durationSec: 4, spanIds: ['s001'], chapterTitle: 'Intro' },
  { order: 2, clipId: 'clip_comp_002', assetId: 'a2', sourceStart: 5, sourceEnd: 9, timelineStart: 4, durationSec: 4, spanIds: ['s002'] }
];

describe('deriveChapters', () => {
  it('one chapter per selection with a chapterTitle', () => {
    expect(deriveChapters({} as never, {} as never, plan as never)).toEqual([{ title: 'Intro', startSec: 0 }]);
  });
  it('empty when no titles set', () => {
    expect(deriveChapters({} as never, {} as never, [{ ...plan[1] }] as never)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**, then implement.

`takes/composition.ts`:

```ts
import type { ManifestV3 } from '../manifest/schema';
import type { AlignmentArtifact, CompositionFile, SpanCandidate } from './schema';

export const COMPOSE_PAD = { headSec: 0.12, tailSec: 0.12 } as const;
const BOUNDARY_WARN_THRESHOLD = 0.5;

export interface MaterializedClipPlan {
  order: number; clipId: string; assetId: string;
  sourceStart: number; sourceEnd: number; timelineStart: number; durationSec: number;
  spanIds?: string[]; orphanId?: string; chapterTitle?: string;
}
export interface CompositionIssue { rule: string; message: string; spanId?: string; clipId?: string }
export interface CompositionValidation { errors: CompositionIssue[]; warnings: CompositionIssue[]; plan: MaterializedClipPlan[] }

export function validateComposition(manifest: ManifestV3, alignment: AlignmentArtifact, composition: CompositionFile): CompositionValidation {
  const errors: CompositionIssue[] = [];
  const warnings: CompositionIssue[] = [];

  const group = manifest.takeGroups.find((g) => g.groupId === composition.groupId);
  if (!group) errors.push({ rule: 'V1', message: `Unknown take group: ${composition.groupId}` });
  if (alignment.groupId !== composition.groupId) errors.push({ rule: 'V1', message: `Alignment groupId ${alignment.groupId} != composition groupId ${composition.groupId}` });
  if (errors.length) return { errors, warnings, plan: [] };

  const spanOrdinal = new Map(alignment.spans.map((s) => [s.spanId, s.ordinal]));
  const candidateOf = new Map<string, SpanCandidate>();
  for (const c of alignment.candidates) candidateOf.set(`${c.spanId}\0${c.clipId}`, c);
  const orphanOf = new Map(alignment.orphans.map((o) => [o.orphanId, o]));
  const assetOfClip = new Map<string, string>();
  const durationOfAsset = new Map(manifest.assets.map((a) => [a.assetId, a.durationSec]));
  for (const track of manifest.tracks) for (const clip of track.clips) assetOfClip.set(clip.clipId, clip.assetId);

  // V4 order dense 1..N
  const orders = composition.selections.map((s) => s.order).sort((a, b) => a - b);
  if (orders.some((o, i) => o !== i + 1)) errors.push({ rule: 'V4', message: `Selection orders must be unique and 1..N dense, got ${orders.join(',')}` });

  // V5 span/orphan used once
  const usedSpans = new Set<string>();
  for (const sel of composition.selections) {
    for (const spanId of sel.spanIds ?? []) { if (usedSpans.has(spanId)) errors.push({ rule: 'V5', message: `span used more than once`, spanId }); usedSpans.add(spanId); }
    if (sel.orphanId) { if (usedSpans.has(sel.orphanId)) errors.push({ rule: 'V5', message: `orphan used more than once`, spanId: sel.orphanId }); usedSpans.add(sel.orphanId); }
  }

  const ordered = [...composition.selections].sort((a, b) => a.order - b.order);
  const plan: MaterializedClipPlan[] = [];
  let timelineStart = 0;
  let prevMaxOrdinal = 0;

  for (const sel of ordered) {
    if (!group!.clipIds.includes(sel.clipId)) { errors.push({ rule: 'V2', message: `clip not in group`, clipId: sel.clipId }); continue; }
    const assetId = assetOfClip.get(sel.clipId);
    if (!assetId) { errors.push({ rule: 'V2', message: `clip has no asset`, clipId: sel.clipId }); continue; }

    let firstCandidate: SpanCandidate | undefined;
    let lastCandidate: SpanCandidate | undefined;
    let selWordStart: number;
    let selWordEnd: number;

    if (sel.orphanId) {
      const orphan = orphanOf.get(sel.orphanId);
      if (!orphan) { errors.push({ rule: 'V2', message: `unknown orphan`, spanId: sel.orphanId }); continue; }
      if (orphan.clipId !== sel.clipId) { errors.push({ rule: 'V2', message: `orphan ${sel.orphanId} belongs to ${orphan.clipId}, not ${sel.clipId}`, clipId: sel.clipId }); continue; }
      selWordStart = orphan.takeWordStart; selWordEnd = orphan.takeWordEnd;
    } else {
      const spanIds = sel.spanIds!;
      const ordinals = spanIds.map((id) => spanOrdinal.get(id));
      if (ordinals.some((o) => o === undefined)) { errors.push({ rule: 'V2', message: `unknown spanId in ${spanIds.join(',')}`, clipId: sel.clipId }); continue; }
      const sorted = (ordinals as number[]).slice().sort((a, b) => a - b);
      if (sorted.some((o, i) => i > 0 && o !== sorted[i - 1] + 1)) { errors.push({ rule: 'V3', message: `spans not contiguous: ${spanIds.join(',')}`, clipId: sel.clipId }); continue; }
      const cands = spanIds.map((id) => candidateOf.get(`${id}\0${sel.clipId}`));
      if (cands.some((c) => !c)) { errors.push({ rule: 'V3', message: `no candidate for one of ${spanIds.join(',')} on ${sel.clipId}`, clipId: sel.clipId }); continue; }
      const present = cands as SpanCandidate[];
      firstCandidate = present.reduce((a, b) => (spanOrdinal.get(a.spanId)! <= spanOrdinal.get(b.spanId)! ? a : b));
      lastCandidate = present.reduce((a, b) => (spanOrdinal.get(a.spanId)! >= spanOrdinal.get(b.spanId)! ? a : b));
      selWordStart = firstCandidate.takeWordStart; selWordEnd = lastCandidate.takeWordEnd;

      // W4 reorder
      const minOrdinal = Math.min(...(ordinals as number[]));
      if (minOrdinal < prevMaxOrdinal) warnings.push({ rule: 'W4', message: `spans ${spanIds.join(',')} appear out of reference order`, clipId: sel.clipId });
      prevMaxOrdinal = Math.max(prevMaxOrdinal, Math.max(...(ordinals as number[])));

      // W1 seam risk (tail of this vs head of next handled after loop via plan metrics)
      // W3 low coverage/truncated
      for (const c of present) if (c.coverage < 0.8 || c.truncated) warnings.push({ rule: 'W3', message: `candidate ${c.spanId}/${c.clipId} coverage ${c.coverage}${c.truncated ? ' truncated' : ''}`, spanId: c.spanId, clipId: c.clipId });
    }

    // V6 trim leaves >= 1 word
    const head = sel.trim?.headWords ?? 0;
    const tail = sel.trim?.tailWords ?? 0;
    const startWord = selWordStart + head;
    const endWord = selWordEnd - tail;
    if (startWord > endWord) { errors.push({ rule: 'V6', message: `trim removes all words for ${sel.clipId}`, clipId: sel.clipId }); continue; }

    // Times: use candidate tStart/tEnd for span selections (already word-accurate); for trims/orphans recompute from candidate word times is not available here, so use candidate tStart/tEnd adjusted only when no trim. When trim>0 we approximate by candidate boundaries; exact per-word retrim is a follow-up. Guard V7 with asset duration.
    const baseStart = sel.orphanId ? orphanOf.get(sel.orphanId)!.tStart : firstCandidate!.tStart;
    const baseEnd = sel.orphanId ? orphanOf.get(sel.orphanId)!.tEnd : lastCandidate!.tEnd;
    const assetDur = durationOfAsset.get(assetId) ?? Infinity;
    const sourceStart = Math.max(0, baseStart - COMPOSE_PAD.headSec);
    const sourceEnd = Math.min(assetDur, baseEnd + COMPOSE_PAD.tailSec);
    if (!(sourceStart < sourceEnd)) { errors.push({ rule: 'V7', message: `empty source range for ${sel.clipId}`, clipId: sel.clipId }); continue; }

    const durationSec = sourceEnd - sourceStart;
    plan.push({ order: plan.length + 1, clipId: `clip_comp_${String(plan.length + 1).padStart(3, '0')}`, assetId, sourceStart, sourceEnd, timelineStart, durationSec, spanIds: sel.spanIds, orphanId: sel.orphanId, chapterTitle: sel.chapterTitle });
    timelineStart += durationSec;
  }

  // W1 seams: between consecutive plan entries, look up tail/head boundary scores from candidates
  for (let i = 0; i + 1 < ordered.length; i++) {
    const cur = ordered[i];
    const next = ordered[i + 1];
    const curTail = cur.spanIds ? candidateOf.get(`${cur.spanIds[cur.spanIds.length - 1]}\0${cur.clipId}`)?.metrics.tailBoundaryScore : undefined;
    const nextHead = next.spanIds ? candidateOf.get(`${next.spanIds[0]}\0${next.clipId}`)?.metrics.headBoundaryScore : undefined;
    if ((curTail !== undefined && curTail < BOUNDARY_WARN_THRESHOLD) || (nextHead !== undefined && nextHead < BOUNDARY_WARN_THRESHOLD)) {
      warnings.push({ rule: 'W1', message: `risky seam between selection ${cur.order} and ${next.order} (tail ${curTail ?? 'na'}, head ${nextHead ?? 'na'})` });
    }
  }

  // W2 dropped spans
  const declaredGapSpans = new Set(composition.gaps.flatMap((g) => g.spanIds));
  for (const span of alignment.spans) {
    if (!usedSpans.has(span.spanId) && !declaredGapSpans.has(span.spanId)) warnings.push({ rule: 'W2', message: `span ${span.spanId} dropped and not declared in gaps`, spanId: span.spanId });
  }

  return { errors, warnings, plan: errors.length ? [] : plan };
}

export function materializeComposition(manifest: ManifestV3, plan: MaterializedClipPlan[]): ManifestV3 {
  const clone: ManifestV3 = JSON.parse(JSON.stringify(manifest));
  const timeline = clone.tracks.find((t) => t.kind === 'video' && t.role !== 'staging') ?? clone.tracks.find((t) => t.role !== 'staging');
  if (!timeline) throw new Error('No timeline video track to materialize into');
  const newClipIds = new Set(plan.map((p) => p.clipId));
  const replacedClipIds = new Set(timeline.clips.map((c) => c.clipId));
  timeline.clips = plan.map((p) => ({ clipId: p.clipId, assetId: p.assetId, sourceStart: p.sourceStart, sourceEnd: p.sourceEnd, timelineStart: p.timelineStart }));
  // Disable operations that targeted the previously-composed clips (never delete).
  for (const op of clone.operations) {
    const target = op.target as { clipId?: string };
    if (target.clipId && replacedClipIds.has(target.clipId) && !newClipIds.has(target.clipId) && op.status !== 'disabled') op.status = 'disabled';
  }
  return clone;
}
```

NOTE for the implementer: the trim/time-accuracy caveat in `validateComposition` (comment near `baseStart`) is intentional per spec §10 - `trim.headWords/tailWords` currently shift the word RANGE for V6 validation but the source times use the candidate span boundaries. If exact per-word trim times are needed, load the take transcript and index `takeWords[startWord].start`. Keep the simpler candidate-boundary behavior unless a test in this task requires per-word trim times (none do). Do NOT silently expand scope.

`takes/chapters.ts`:

```ts
import type { AlignmentArtifact, CompositionFile } from './schema';
import type { MaterializedClipPlan } from './composition';

export interface Chapter { title: string; startSec: number }

export function deriveChapters(_composition: CompositionFile, _alignment: AlignmentArtifact, plan: MaterializedClipPlan[]): Chapter[] {
  return plan.filter((p) => p.chapterTitle).map((p) => ({ title: p.chapterTitle as string, startSec: p.timelineStart }));
}
```

`index.ts`: add `export * from './takes/composition';` and `export * from './takes/chapters';`.

CLI verbs:

```ts
program.command('compose').description('Materialize a take composition into the timeline')
  .command('apply').description('Validate and apply takes/composition.json')
  .option('--file <path>', 'composition file', 'takes/composition.json')
  .option('--dry-run', 'validate and print the plan without writing')
  .action((opts) => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    const manifest = loadManifestV3(workspace);
    const alignment = readAlignment(workspace);
    const composition = readComposition(workspace, opts.file);
    const validation = validateComposition(manifest, alignment, composition);
    if (validation.errors.length) throw new TakesError('COMPOSE_VALIDATION', validation.errors.map((e) => `[${e.rule}] ${e.message}${e.spanId ? ` (${e.spanId})` : ''}${e.clipId ? ` (${e.clipId})` : ''}`).join('\n'), validation.errors);
    if (opts.dryRun) {
      const total = validation.plan.reduce((s, p) => s + p.durationSec, 0);
      print(program.opts().json ? { plan: validation.plan, warnings: validation.warnings, totalSec: total, rationales: composition.selections.map((s) => ({ order: s.order, rationale: s.rationale })) } : `PLAN (${validation.plan.length} clips, ${total.toFixed(1)}s)\n${validation.plan.map((p) => `  ${p.clipId} ${p.assetId} ${p.sourceStart.toFixed(2)}-${p.sourceEnd.toFixed(2)}s`).join('\n')}\n${validation.warnings.map((w) => `  WARN [${w.rule}] ${w.message}`).join('\n')}`, program.opts().json);
      return;
    }
    let next = materializeComposition(manifest, validation.plan);
    next = { ...next, composeState: { appliedAt: nowIso(), compositionHash: compositionHash(composition) } };
    saveManifestV3(workspace, next, { revision: true });
    print(program.opts().json ? { applied: validation.plan.length, warnings: validation.warnings } : `Applied ${validation.plan.length} clips${validation.warnings.length ? ` (${validation.warnings.length} warnings)` : ''}`, program.opts().json);
  }));

program.command('export-chapters').description('Export chapter markers from the applied composition')
  .option('--format <format>', 'json or youtube', 'json')
  .action((opts) => takesCliAction(program.opts().json, () => {
    const workspace = workspaceOption(program.opts().workspace);
    const manifest = loadManifestV3(workspace);
    const composition = readComposition(workspace);
    if (!manifest.composeState || manifest.composeState.compositionHash !== compositionHash(composition)) {
      throw new TakesError('CHAPTERS_STALE', 'Composition has not been applied (or changed since). Run `ets compose apply` first.');
    }
    const alignment = readAlignment(workspace);
    const plan = validateComposition(manifest, alignment, composition).plan;
    const chapters = deriveChapters(composition, alignment, plan);
    if (opts.format === 'youtube') {
      const lines = chapters.map((c) => { const m = Math.floor(c.startSec / 60); const s = Math.floor(c.startSec % 60); return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${c.title}`; });
      print(program.opts().json ? { chapters, youtube: lines } : lines.join('\n') || '(no chapters set)', program.opts().json);
    } else {
      print(program.opts().json ? { chapters } : chapters.map((c) => `${c.startSec.toFixed(1)}s ${c.title}`).join('\n') || '(no chapters set)', program.opts().json);
    }
  }));
```

Add imports: `validateComposition, materializeComposition, deriveChapters, readComposition, compositionHash` from `@etvideoscript/core`.

- [ ] **Step 3: Run + typecheck:** `npx vitest run packages/core/src/__tests__/composition.test.ts packages/core/src/__tests__/chapters.test.ts` PASS, `pnpm -r typecheck` clean, full core suite green.

- [ ] **Step 4: Commit:** `git add -A && git commit -m "feat(core,cli): composition validation, materialization, chapters, compose apply"`

---

### Task 11: Agent tools, compose-from-takes skill, e2e, docs

**Files:**
- Modify: `packages/core/src/agent-tools/index.ts` (7 handlers)
- Create: `skills/compose-from-takes/index.ts`
- Create: `apps/local-api/src/compose-from-takes.test.ts`
- Modify: `docs/skills-cookbook.md`, `CLAUDE.md`
- Test: `packages/core/src/__tests__/agent-tools-takes.test.ts`

**Interfaces:**
- Consumes: everything above; `AgentToolContext`, `runAgentTool`.
- Produces: agent tool names `takes_list`, `takes_align`, `takes_spans`, `takes_span_detail`, `compose_validate`, `compose_apply`, `brief_show`.

- [ ] **Step 1: Write failing agent-tools test**

`packages/core/src/__tests__/agent-tools-takes.test.ts`:

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgentTool } from '../agent-tools';
import { saveManifestV3 } from '../manifest/io';
import { writeTranscript } from '../transcript';
import { defaultManifest } from '../filesystem';
import { makeManifest, makeTrack, makeClip, makeVideoAsset, makeWords } from './takes-fixtures';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function setup(): string {
  dir = mkdtempSync(join(tmpdir(), 'ets-at-'));
  mkdirSync(join(dir, 'edits'), { recursive: true });
  const staging = makeTrack({ trackId: 'track_takes', kind: 'video', role: 'staging', clips: [makeClip('clip_take_01', 'a1', 30), makeClip('clip_take_02', 'a2', 31)] });
  const timeline = makeTrack({ trackId: 'track_video', kind: 'video', order: 0, clips: [] });
  const manifest = makeManifest({ assets: [makeVideoAsset('a1', 30), makeVideoAsset('a2', 31)], tracks: [timeline, staging], takeGroups: [{ groupId: 'main', label: 'main', clipIds: ['clip_take_01', 'clip_take_02'] }] });
  saveManifestV3(dir, manifest, { revision: false });
  const text = 'Alpha beta gamma delta. Epsilon zeta eta theta.';
  for (const clipId of ['clip_take_01', 'clip_take_02']) {
    // writeTranscript expects a TranscriptWords doc; build from makeWords
    const words = makeWords(text, { clipId });
    writeTranscript(dir, { schemaVersion: 1, source: clipId, provider: { name: 'mock', model: 'mock', requestId: null, timing: 'mock' }, language: 'en', durationSec: 30, words, segments: [] }, { clipId });
  }
  return dir;
}

describe('takes agent tools', () => {
  it('aligns and lists via agent tools', () => {
    const ctx = { workspacePath: setup() };
    const align = runAgentTool(ctx, 'takes_align', { groupId: 'main' });
    expect((align.result as { spans: unknown[] }).spans.length).toBe(2);
    const list = runAgentTool(ctx, 'takes_list', {});
    expect((list.result as { takes: unknown[] }).takes.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**, then implement the handlers in `agent-tools/index.ts` (add to the `agentToolHandlers` object; import the take functions and a per-clip transcript loader). Each is a thin wrapper:

```ts
  brief_show(ctx: AgentToolContext) {
    return { result: readBrief(ctx.workspacePath), changedOperationIds: [] };
  },
  takes_list(ctx: AgentToolContext) {
    const manifest = load(ctx);
    const takes = manifest.takeGroups.flatMap((g) => g.clipIds.map((clipId) => ({ groupId: g.groupId, clipId })));
    return { result: { groups: manifest.takeGroups, takes }, changedOperationIds: [] };
  },
  takes_align(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ groupId: z.string().default('main'), reference: z.string().optional(), scriptText: z.string().optional() }).parse(params);
    const manifest = load(ctx);
    const group = manifest.takeGroups.find((g) => g.groupId === parsed.groupId);
    if (!group) throw new TakesError('TAKES_UNKNOWN_GROUP', `Unknown take group: ${parsed.groupId}`);
    if (parsed.reference) group.reference = { kind: 'take', clipId: parsed.reference };
    const transcripts = new Map<string, TranscriptWord[]>();
    for (const clipId of group.clipIds) {
      const path = join(ctx.workspacePath, `transcript/${clipId}/words.json`);
      transcripts.set(clipId, TranscriptWordsSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).words);
    }
    const artifact = computeAlignment({ manifest, groupId: parsed.groupId, transcripts, scriptText: parsed.scriptText, generatedAt: new Date().toISOString() });
    writeAlignment(ctx.workspacePath, artifact);
    return { result: artifact, changedOperationIds: [] };
  },
  takes_spans(ctx: AgentToolContext) {
    return { result: readAlignment(ctx.workspacePath), changedOperationIds: [] };
  },
  takes_span_detail(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ spanId: z.string().min(1) }).parse(params);
    const artifact = readAlignment(ctx.workspacePath);
    return { result: { span: artifact.spans.find((s) => s.spanId === parsed.spanId), candidates: artifact.candidates.filter((c) => c.spanId === parsed.spanId), orphan: artifact.orphans.find((o) => o.orphanId === parsed.spanId) }, changedOperationIds: [] };
  },
  compose_validate(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ composition: z.unknown() }).parse(params);
    const manifest = load(ctx);
    const composition = CompositionFileSchema.parse(parsed.composition);
    return { result: validateComposition(manifest, readAlignment(ctx.workspacePath), composition), changedOperationIds: [] };
  },
  compose_apply(ctx: AgentToolContext, params: unknown) {
    const parsed = z.object({ composition: z.unknown() }).parse(params);
    const manifest = load(ctx);
    const composition = CompositionFileSchema.parse(parsed.composition);
    const validation = validateComposition(manifest, readAlignment(ctx.workspacePath), composition);
    if (validation.errors.length) throw new TakesError('COMPOSE_VALIDATION', validation.errors.map((e) => `[${e.rule}] ${e.message}`).join('\n'), validation.errors);
    const next = { ...materializeComposition(manifest, validation.plan), composeState: { appliedAt: new Date().toISOString(), compositionHash: compositionHash(composition) } };
    save(ctx, next);
    return { result: { applied: validation.plan.length, warnings: validation.warnings }, changedOperationIds: [] };
  },
```

Imports to add at the top of `agent-tools/index.ts`: `computeAlignment, writeAlignment, readAlignment, validateComposition, materializeComposition, compositionHash, CompositionFileSchema, TakesError` from their modules, `readBrief` from `../brief/io`, and `type TranscriptWord` from `../schemas`.

- [ ] **Step 3: Run agent-tools test:** PASS. `pnpm -r typecheck` clean.

- [ ] **Step 4: Create the compose-from-takes skill** (`skills/compose-from-takes/index.ts`). Mirror `skills/assemble-from-clips/index.ts` structure exactly (WebSocket hello/tool_call plumbing copied verbatim), but drive the take workflow. Since composition requires human/agent judgment, the reference skill implements the DETERMINISTIC baseline the spec §13 describes: brief_show -> takes_align -> takes_spans -> for each span pick the highest-composite candidate -> compose_apply. It is the executable starting point an agent then refines.

```ts
#!/usr/bin/env node
import { WebSocket } from 'ws';
import type { ServerMessage } from '@etvideoscript/agent-protocol';

function arg(name: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }

function callFactory(ws: WebSocket, pending: Map<string, (m: ServerMessage) => void>) {
  return (tool: string, params: unknown) => new Promise<ServerMessage>((resolveCall) => {
    const id = `${tool}-${Date.now()}-${Math.floor(performance.now())}`;
    pending.set(id, resolveCall);
    ws.send(JSON.stringify({ kind: 'tool_call', id, protocolVersion: 3, tool, params }));
  });
}

export async function main() {
  const wsUrl = arg('--ws-url'); const token = arg('--token'); const group = arg('--group') || 'main';
  if (!wsUrl) throw new Error('Missing --ws-url');
  const url = token ? `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : wsUrl;
  const ws = new WebSocket(url, { headers: { origin: 'http://127.0.0.1:4318' } });
  const pending = new Map<string, (m: ServerMessage) => void>();
  ws.on('message', (data) => { const m = JSON.parse(String(data)) as ServerMessage; if (m.kind === 'tool_result' || m.kind === 'tool_error') pending.get(m.callId || m.id)?.(m); });
  const call = callFactory(ws, pending);
  await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const ready = new Promise<void>((res) => ws.once('message', () => res()));
  ws.send(JSON.stringify({ kind: 'hello', id: 'hello-compose-from-takes', protocolVersion: 3, agent: { name: 'ets-skill', skill: 'compose-from-takes' } }));
  await ready;

  const brief = await call('brief_show', {});
  if (brief.kind === 'tool_error') { console.error(`compose-from-takes: no brief - run 'ets brief init' first. ${brief.error.message}`); ws.close(); return { skill: 'compose-from-takes', status: 'no-brief' }; }

  const align = await call('takes_align', { groupId: group });
  if (align.kind !== 'tool_result') throw new Error(align.kind === 'tool_error' ? align.error.message : 'align failed');
  const alignment = align.result.result as { spans: Array<{ spanId: string }>; candidates: Array<{ spanId: string; clipId: string; coverage: number; matchQuality: number; metrics: { fillerCount: number; falseStartCount: number } }> };

  const composite = (c: { matchQuality: number; metrics: { fillerCount: number; falseStartCount: number } }) => c.matchQuality - 0.05 * c.metrics.fillerCount - 0.05 * c.metrics.falseStartCount;
  const selections = alignment.spans.map((span, i) => {
    const best = alignment.candidates.filter((c) => c.spanId === span.spanId).sort((a, b) => composite(b) - composite(a))[0];
    return best ? { order: i + 1, clipId: best.clipId, spanIds: [span.spanId], rationale: `Highest composite delivery of span ${span.spanId}` } : null;
  }).filter(Boolean).map((sel, i) => ({ ...sel!, order: i + 1 }));

  const composition = { schemaVersion: 1 as const, groupId: group, selections, gaps: [] };
  const apply = await call('compose_apply', { composition });
  if (apply.kind === 'tool_error') throw new Error(apply.error.message);
  const summary = { skill: 'compose-from-takes', status: 'applied', selections: selections.length };
  console.log(JSON.stringify(summary));
  ws.close();
  return summary;
}

if (process.argv[1]?.endsWith('skills/compose-from-takes/index.ts') || process.argv[1]?.endsWith('skills/compose-from-takes/index.js')) void main();
```

- [ ] **Step 5: Create the e2e test** (`apps/local-api/src/compose-from-takes.test.ts`) mirroring `apps/local-api/src/assemble-from-clips.test.ts`. Drive the CORE functions directly (no ffmpeg, no real media) for a 3-take scenario, then assert the render plan builds with 3 distinct inputs. Read the sibling test first to copy its harness style, then:

```ts
import { describe, expect, it } from 'vitest';
import { computeAlignment, validateComposition, materializeComposition, buildRenderPlanV3 } from '@etvideoscript/core';
// build a manifest with 3 staging takes + empty timeline, transcripts:
//   take 1: full script; take 2: full script but flubbed middle sentence; take 3: pickup of the middle sentence + an orphan aside
// compose: s001 from take1, s002 from take3 (pickup), s003 from take1; drop orphan with a gaps entry
// assert: materialized timeline has 3 clips drawn from >=2 distinct assets; buildRenderPlanV3 succeeds
```

Fill in the fixture using the same `makeWords`-style word arrays (copy the helper into the test or import from a shared location). Assert: `validateComposition(...).errors` is empty; the materialized manifest's timeline track has 3 clips; the set of `assetId`s across those clips has size >= 2; `buildRenderPlanV3(manifest)` (or the exact exported render-plan entry - verify the name) returns a plan whose distinct input paths number >= 2.

- [ ] **Step 6: Docs**

`docs/skills-cookbook.md` - add a `compose-from-takes` entry mirroring the existing skill entries (invocation line with `--ws-url --token --group`, one-paragraph description of the brief -> align -> spans -> compose loop).

`CLAUDE.md` - under the CLI quickstart line, add the multi-take flow:

```
Multi-take: `ets init` -> `ets brief init` (fill it in) -> `ets takes add a.mp4 b.mp4 c.mp4` -> `ets extract-audio` -> `ets transcribe --clip <each>` -> `ets takes align` -> agent reads `ets takes spans`, writes `takes/composition.json` -> `ets compose apply` -> cleanup (find-fillers) -> `ets render` -> `ets export-captions` + `ets export-chapters --format youtube`.
```

- [ ] **Step 7: Full verification**

Run: `npx vitest run packages/core apps/local-api/src/compose-from-takes.test.ts` - all new tests PASS.
Run: `pnpm -r typecheck` - clean.
Run: `npx vitest run` - only the 10 known `apps/local-api/src/server.test.ts` failures remain; everything else green.
Run: `pnpm build` - succeeds (guards the browser.ts/node:fs boundary).

- [ ] **Step 8: Commit:** `git add -A && git commit -m "feat(core,skills): take agent tools, compose-from-takes skill, e2e, docs"`

---

## Self-Review

Run after all tasks: confirm each spec section maps to a task.

- §6.1 staging role -> Task 1. §6.2 takeGroups/composeState/superRefine -> Task 2. §6.3 brief -> Task 3. §6.4 artifacts/paths -> Tasks 3/8/9.
- §7.1 normalize -> Task 4. §7.2 anchors -> Task 4. §7.3 align -> Task 5. §7.4 spans -> Task 6. §7.5 metrics -> Task 7. §7.6 orchestrator -> Task 8. §7.7 composition -> Task 10. §7.8 chapters -> Task 10. §7.9 import -> Task 9.
- §8 artifact schemas -> Task 8. §9 CLI verbs: brief (Task 3), takes add/list/align/spans/span (Task 9), compose apply + export-chapters (Task 10). §10 compose semantics -> Task 10. §11 agent tools -> Task 11. §12 audio-channel-fix interaction -> documented, no code here (deferred until that branch merges; call it out in the PR). §13 skill -> Task 11. §14 errors -> Tasks 2/3/8/9/10 (TakesError codes). §15 testing -> every task's tests + Task 11 e2e. §16 file inventory -> covered. §17 order -> matches task order.

Gap deliberately deferred (not a plan defect): §12 audio-channel-fix per-asset migration is not implemented because that branch is unmerged on `main`; the PR description must flag it for whichever branch merges second.
