# Multi-Take Editing: Brief-Driven Composition from Multiple Takes

- **Status**: Approved design, pending implementation plan
- **Date**: 2026-07-06
- **Base**: `main` (ad30586). See §12 for interaction with the unmerged `spec/audio-channel-fix` branch.
- **Audience**: implementing engineers/models with no prior context. Everything needed to implement is in this document plus the referenced source files. When this spec and existing code conflict on a detail not covered here, follow existing code conventions and flag the conflict in the PR description.

## 1. Summary

ETVideo Studio gains the ability to import several takes of the same content into one project, align them against a shared reference script, and let a CLI-driven agent (Claude Code) compose a coherent final video by selecting the best delivery of each section across takes, guided by a user-written brief.

The agent is the editor. All new code is deterministic: alignment, metrics, validation, and materialization are pure functions over transcripts and word timings. No LLM calls anywhere in the toolchain. The CLI emits compact JSON the agent reads to make editorial judgments; the agent writes its decisions to a composition file; a single verb materializes that file into ordinary timeline clips. The existing render pipeline executes the result unchanged (multi-input concat already works, see `packages/core/src/render/pipeline.ts` `buildFfmpegCommand`: distinct asset paths become distinct ffmpeg inputs, segments are trimmed per-input and concatenated).

## 2. Requirements (from user Q&A, 2026-07-06)

| # | Requirement |
|---|---|
| R1 | Support both take shapes: full re-runs of the same content AND a main take plus partial pickups. Shape varies per project and must not require configuration - alignment coverage reveals it. |
| R2 | Draft + review loop: agent assembles a full draft cut automatically, renders a preview, user reviews and iterates. |
| R3 | Visual continuity: switch takes only at natural boundaries (sentence ends, silence gaps). Hard cuts, no transitions. Cut points are scored for safety; unsafe seams produce warnings, not hard failures. |
| R4 | The agent is the editor. CLI verbs are deterministic tools emitting compact JSON. No LLM calls inside `@etvideo/core`, the CLI, or the API. |
| R5 | All formats (short to long form). The user states expected scale up front in the brief. Verbs must offer windowed/summary views so an agent never needs all transcripts in context at once. |
| R6 | Brief-driven: the user explains theme, audience, tone, and goal at project start. Every editorial decision is grounded in the brief. The brief is a first-class workspace artifact. |
| R7 | Full production scope: take selection, filler/mistake cleanup, narrative reordering (including using material that appears in only one take), voice patches to bridge gaps, captions and chapters. Cleanup/patches/captions reuse existing ops and verbs. |

## 3. Glossary

- **Take**: one recording attempt of (roughly) the same content. Stored as an asset plus a clip on the staging track.
- **Take group**: the set of staging clips that are alternative attempts at the same content. Almost always one group per project, id `main`.
- **Reference script**: the word sequence all takes are aligned against. Derived from the best-coverage take by default, or supplied by the user.
- **Span**: a sentence-level slice of the reference script. The atomic unit of editorial selection.
- **Candidate**: a (span, take) pair - one take's delivery of one span, with metrics.
- **Orphan span**: a run of take words that matches nothing in the reference script (new material improvised in one take).
- **Brief**: user-authored `brief.md` describing what the video is about, for whom, and what good looks like.
- **Composition**: the agent-authored `takes/composition.json` - an ordered list of selections that `ets compose apply` materializes into timeline clips.
- **Staging track**: a track with `role: 'staging'`; its clips are transcribable and inspectable but never rendered.

## 4. Non-goals

- No studio-web UI for takes in this slice. The data model supports it (take groups and staging tracks are first-class), but all UI work is a later slice.
- No LLM/judge calls inside the toolchain (R4).
- No camera-footage jump-cut conventions (punch-ins, zooms). Screen recordings only.
- No cross-project references; all takes live inside one project workspace.
- No automatic voice-patch creation by `compose apply` - gaps are reported, the agent acts through the existing `voice_patch` flow.
- No studio-cleanup (`studioCleanup`) support for multi-take projects in this slice (see §12).

## 5. Architecture overview

```
brief.md ----------------------------+
                                     v
takes add  -->  staging clips  -->  transcribe --clip  -->  per-take words
                                     |
                                     v
                            ets takes align          (deterministic core)
                                     |
                                     v
                          takes/alignment.json       (spans x takes + metrics)
                                     |
              agent reads brief + span table, judges contested spans
                                     |
                                     v
                          takes/composition.json     (agent-authored)
                                     |
                                     v
                            ets compose apply        (validate + materialize)
                                     |
                                     v
                     timeline clips on the primary video track
                                     |
                cleanup pass (find-fillers, cut/mute, voice_patch)
                                     |
                                     v
                    render draft -> user review -> iterate -> final
```

Layering follows the house rule: primitives in `@etvideo/core`, the CLI is thin wrappers, agent tools mirror the same core functions.

## 6. Data model

### 6.1 `Track.role` (modified: `packages/core/src/tracks/schema.ts`)

Add to `TrackSchema` (currently trackId/kind/subtype/name/order/locked/muted/solo/hidden/fx/clips):

```ts
role: z.enum(['timeline', 'staging']).default('timeline'),
```

Rules, enforced in `superRefine` on the manifest (see 6.2) and respected by consumers:

1. At most ONE track may have `role: 'staging'`. Its `kind` must be `'video'`.
2. Staging clips are exempt from any timeline-overlap validation; all staging clips have `timelineStart: 0`.
3. `composeTimeMap` (`packages/core/src/timeMap/compose.ts`) MUST skip tracks with `role === 'staging'` when building the base timeline. This is the single change that keeps takes out of renders. Implementation: filter the tracks array at the top of `composeTimeMap` before existing logic runs.
4. Transcription enumeration (`transcribableClips` / `primaryVideoClips` in `packages/core/src/transcript.ts`) MUST include staging clips - takes need transcripts. Audit both functions; `transcribableClips` includes staging clips, `primaryVideoClips` (used to pick the main narration clip for single-source flows) excludes them.
5. The staging track is created on first `ets takes add` as: `{ trackId: 'track_takes', kind: 'video', role: 'staging', name: 'Takes', order: 1000, hidden: true, locked: false, muted: false, solo: false, clips: [] }` (order 1000 keeps it visually last if a UI ever lists it).

Backward compatibility: `default('timeline')` means every existing manifest parses unchanged. No migration needed; `migrate-manifest` untouched.

### 6.2 `takeGroups` (modified: `packages/core/src/manifest/schema.ts`)

New schema in a new file `packages/core/src/takes/schema.ts`, referenced from `ManifestV3Schema`:

```ts
export const TakeGroupReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('take'), clipId: z.string().min(1) }),
  z.object({ kind: z.literal('file'), path: z.string().min(1) }) // workspace-relative, e.g. "takes/script.txt"
]);

export const TakeGroupSchema = z.object({
  groupId: z.string().min(1),
  label: z.string().min(1),
  /** Staging-track clipIds that are alternative attempts at the same content. */
  clipIds: z.array(z.string().min(1)).min(1),
  /** How the reference script is chosen. Absent = auto (best transcript coverage). */
  reference: TakeGroupReferenceSchema.optional()
});
export type TakeGroup = z.infer<typeof TakeGroupSchema>;
```

`ManifestV3Schema` gains:

```ts
takeGroups: z.array(TakeGroupSchema).default([]),
```

plus a `superRefine` that validates: (a) at most one staging track, staging track kind is video; (b) every `takeGroups[].clipIds` entry exists on the staging track; (c) `groupId` values are unique; (d) no clipId appears in two groups. Keep `ManifestV3Schema` a `z.object` and wrap with `.superRefine` at the manifest level (follow the pattern of `TrackSchema`'s superRefine).

`default([])` keeps every existing manifest valid with no migration.

### 6.3 Brief (new: `packages/core/src/brief/schema.ts`, `packages/core/src/brief/io.ts`)

`brief.md` lives at the workspace root. YAML frontmatter + free markdown body:

```markdown
---
title: "Setting up ETCircle webhooks"
audience: "ETCircle admins, non-developers"
tone: "friendly, concise"
targetDurationSec: 480
structure:
  - "hook: show the finished webhook firing"
  - "steps 1-4 in the dashboard"
  - "troubleshooting the two common errors"
---
This video shows admins how to ... (free text, as long as the user wants)
```

```ts
// brief/schema.ts
export const BriefFrontmatterSchema = z.object({
  title: z.string().min(1),
  audience: z.string().min(1),
  tone: z.string().min(1).optional(),
  targetDurationSec: z.number().int().positive().optional(),
  structure: z.array(z.string().min(1)).optional()
});
export const BriefSchema = z.object({
  frontmatter: BriefFrontmatterSchema,
  body: z.string() // markdown after the closing ---, may be ''
});
export type Brief = z.infer<typeof BriefSchema>;
```

```ts
// brief/io.ts  (node-only: uses node:fs - do NOT import from any browser-reachable entry;
// follow the placement pattern of packages/core/src/transcript.ts. See the known gotcha:
// node:fs reachable from browser.ts silently breaks the studio-web build.)
export function readBrief(workspaceDir: string): Brief;            // throws BriefNotFoundError | BriefParseError
export function writeBrief(workspaceDir: string, brief: Brief): void;
export function briefTemplate(): string;                            // returns a commented template document
```

Frontmatter parsing: add dependency `yaml@^2` to `@etvideo/core` (`parse` only). Split the document on the first two `---` lines (document must start with `---` on line 1); everything after the second is `body`.

The brief is advisory to the tooling (alignment and composition work without it) but mandatory in the agent workflow (§13): the reference skill refuses to compose without a brief, because R6 says cuts must be educated by it.

### 6.4 Artifacts and workspace layout additions

```
brief.md                      user-authored brief (6.3)
input/takes/take-01.mp4       take originals; same never-overwrite rule as input/source.mp4
input/takes/take-02.mp4
takes/alignment.json          derived by `ets takes align` (§8.1); regenerable, never hand-edited
takes/composition.json        agent-authored (§8.2); THE editorial artifact; survives re-align
takes/script.txt              optional user-provided reference script (plain text)
```

Path safety: all new file writes go through the existing workspace path-join/validation helpers used by `media.ts` and `transcript.ts` (never raw `path.join` with user input). `input/takes/` filenames are always generated (`take-NN.<ext>`), never taken from user input.

## 7. Core primitives (new directory `packages/core/src/takes/`)

Module layout. Every function is pure unless stated; node-only I/O confined to `io.ts` and `import.ts`.

```
takes/schema.ts       TakeGroupSchema + artifact schemas (§8) + shared types
takes/normalize.ts    word normalization
takes/anchors.ts      shared-shingle anchor selection
takes/align.ts        banded Needleman-Wunsch between two word sequences
takes/spans.ts        reference segmentation + span projection onto takes
takes/metrics.ts      per-candidate metrics + boundary scores
takes/alignment.ts    orchestrator: transcripts -> AlignmentArtifact
takes/composition.ts  validateComposition + materializeComposition
takes/chapters.ts     deriveChapters
takes/import.ts       importTake (node-only: copies file, probes, mutates manifest)
takes/io.ts           read/write alignment.json + composition.json (node-only)
```

### 7.1 Normalization (`normalize.ts`)

```ts
export interface NormalizedWord { text: string; index: number } // index into original words[]
export function normalizeWords(words: TranscriptWord[]): NormalizedWord[];
```

Rules, applied per word, in order:

0. Input text = `word.normalized ?? word.text` (`TranscriptWord` already carries an optional `normalized` field; prefer it, as `skills/find-fillers` does).
1. Lowercase.
2. Strip leading/trailing non-alphanumeric characters (Unicode-aware: `/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu`).
3. Keep internal apostrophes and hyphens (`don't`, `built-in`).
4. Words that become empty after stripping are dropped (their original index simply does not appear).

No stemming, no number-word mapping. Determinism over cleverness.

### 7.2 Anchors (`anchors.ts`)

```ts
export interface Anchor { refIndex: number; takeIndex: number } // positions in the NORMALIZED sequences
export function findAnchors(ref: NormalizedWord[], take: NormalizedWord[]): Anchor[];
```

1. Build all 3-word shingles (joined with ` `) of each normalized sequence.
2. Candidate anchors = shingles that occur EXACTLY once in `ref` and EXACTLY once in `take`.
3. Sort candidates by `refIndex`; take the longest strictly-increasing subsequence in `takeIndex` (standard O(n log n) LIS). This drops crossing anchors and guarantees a monotonic chain.
4. Return the chain. Empty result is valid (falls back to one full-width alignment window).

### 7.3 Banded alignment (`align.ts`)

```ts
export const ALIGN_SCORES = { match: 2, mismatch: -1, gap: -1 } as const;
export type AlignedPair =
  | { kind: 'match' | 'substitution'; refIndex: number; takeIndex: number }
  | { kind: 'refGap'; refIndex: number }    // ref word has no take counterpart
  | { kind: 'takeGap'; takeIndex: number }; // take word has no ref counterpart (extra material)
export function alignWordSequences(ref: NormalizedWord[], take: NormalizedWord[]): AlignedPair[];
```

1. Compute anchors (7.2). Each anchor covers 3 word positions (its shingle). Merge anchors whose covered ranges overlap or touch into runs; emit each run's word positions as `match` pairs exactly once (they are exact matches by construction).
2. Between consecutive anchors (and before the first / after the last), run Needleman-Wunsch on the two sub-sequences with `ALIGN_SCORES`. `match` when normalized texts are equal; `substitution` when aligned but unequal.
3. Band constraint inside each window: only fill cells where `|i - j * (lenRef/lenTake)| <= max(32, ceil(0.2 * max(lenRef, lenTake)))`. Cells outside the band are treated as -Infinity. This bounds memory/time to O(n * band); a 10k-word take aligns in well under a second.
4. Windows longer than 5000 words on either side with NO internal anchors: split at the midpoint of the longer side recursively (degenerate-input guard; synthetic only, real speech always anchors).
5. Concatenate window results in order. The output covers every index of both sequences exactly once.

### 7.4 Spans (`spans.ts`)

```ts
export interface ReferenceSpan {
  spanId: string;          // 's001', 's002', ... ordinal, zero-padded to 3
  ordinal: number;         // 1-based
  refWordStart: number;    // inclusive, ORIGINAL word indices of the reference take/script
  refWordEnd: number;      // inclusive
  text: string;            // original (non-normalized) words joined with spaces
}
export function segmentReference(words: TranscriptWord[]): ReferenceSpan[];
export function projectSpans(
  spans: ReferenceSpan[],
  refNorm: NormalizedWord[],
  takeNorm: NormalizedWord[],
  takeWords: TranscriptWord[],
  pairs: AlignedPair[]
): SpanCandidate[];   // SpanCandidate defined in §8.1
```

`segmentReference` boundary rules (a span ends after word `w` when any of):

1. `w.text` ends with `.`, `!`, `?`, or `…` (before normalization), OR
2. gap to the next word (`next.start - w.end`) > 0.8 seconds.

Post-processing: spans longer than 40 words are split at their largest internal inter-word gap (repeat until all <= 40); spans shorter than 3 words are merged into the FOLLOWING span (the last span merges backward). When the reference is a user-provided script file (no timings), only rule 1 applies and no gap-splitting happens; the script is tokenized on whitespace.

`projectSpans`, for each span x take: collect the aligned pairs whose `refIndex` falls inside the span's normalized range. If zero pairs are `match`/`substitution`, there is no candidate (coverage 0 - the pickup-take case). Otherwise:

- `takeWordStart/End` = min/max `takeIndex` mapped back to ORIGINAL take word indices; `tStart/tEnd` = those words' `start`/`end` times.
- `coverage` = (count of span ref words with a `match` or `substitution` pair) / (span ref word count), in [0,1].
- `matchQuality` = (count of `match` pairs) / (span ref word count), in [0,1].
- A candidate is emitted only when `coverage >= 0.5` (constant `MIN_CANDIDATE_COVERAGE = 0.5` in `takes/schema.ts`).
- `truncated` = true when the take's first or last word participates in this candidate and coverage < 1 (delivery ran into the take boundary).

Orphan detection (per take): maximal runs of >= 8 consecutive `takeGap` pairs become orphan spans `o001, o002, ...` (ordered by first take, then time), with `clipId`, `tStart/tEnd`, `text` (original take words). Constant `MIN_ORPHAN_WORDS = 8`.

Low-confidence take: if a take's overall matched-word fraction (`match` pairs / take word count) < 0.3, the take is flagged `lowConfidence: true` in the artifact; its candidates are still emitted. Constant `LOW_CONFIDENCE_MATCH_FRACTION = 0.3`.

### 7.5 Metrics (`metrics.ts`)

```ts
export const FILLER_LEXICON = ['um', 'uh', 'erm', 'uhm', 'hmm', 'mmm', 'mhm', 'ah', 'eh', 'like', "y'know", 'yknow'] as const;
export function computeCandidateMetrics(candidate, takeWords: TranscriptWord[]): CandidateMetrics;
export function computeBoundaryScore(takeWords: TranscriptWord[], wordIndex: number, edge: 'head' | 'tail'): number;
```

This is the union of `skills/find-fillers/index.ts:12`'s inline regex (`um|uh|like|y'?know`) and common hesitation sounds. Refactor the skill to import `FILLER_LEXICON` from core so there is exactly one lexicon. (`like` stays because the existing skill treats it as a filler; agents judging candidates should weight `fillerCount` accordingly for speakers who use "like" legitimately.)

Per candidate (all computed over the candidate's original take words `takeWordStart..takeWordEnd`):

- `fillerCount`: words whose normalized text is in `FILLER_LEXICON`.
- `falseStartCount`: positions where normalized word[i] === word[i+1], plus positions where bigram (word[i], word[i+1]) === (word[i+2], word[i+3]). Overlapping occurrences count once per starting position.
- `wordsPerSec`: wordCount / (tEnd - tStart). If tEnd === tStart, 0.
- `silenceRatio`: 1 - (sum of word durations) / (tEnd - tStart), clamped to [0,1].
- `durationSec`: tEnd - tStart.
- `headBoundaryScore` / `tailBoundaryScore`: see below, computed at the candidate's first/last word.

`computeBoundaryScore(words, i, edge)`:

- `gap` = for `head`: `words[i].start - words[i-1].end` (Infinity if i === 0); for `tail`: `words[i+1].start - words[i].end` (Infinity if last word).
- `terminal` = for `head`: `words[i-1]` ends with sentence-terminal punctuation (or i === 0); for `tail`: `words[i]` ends with sentence-terminal punctuation.
- `score = min(1, min(gap, 2) / 0.6) * 0.6 + (terminal ? 0.4 : 0)`, rounded to 3 decimals. Range [0,1]. `BOUNDARY_WARN_THRESHOLD = 0.5`.

### 7.6 Orchestrator (`alignment.ts`)

```ts
export interface AlignInput {
  manifest: ManifestV3;
  groupId: string;
  transcripts: Map<string, TranscriptWord[]>; // clipId -> words, caller loads via existing transcript I/O
  scriptText?: string;                        // when reference kind is 'file'
}
export function computeAlignment(input: AlignInput): AlignmentArtifact; // pure; throws TakesError (§14)
```

Reference selection: explicit `reference` on the group wins; otherwise the take whose transcript has the most words (tie: lowest clipId lexicographically). The chosen reference take is ALSO aligned like any other take (its candidates are trivially coverage 1, matchQuality 1) so the agent compares it symmetrically.

Determinism requirement: `computeAlignment` output must be byte-identical for identical inputs (stable ordering everywhere: spans by ordinal, candidates by (spanId, clipId), orphans by (clipId, tStart)). No timestamps inside the artifact except `generatedAt`, which is injected by the CLI layer, not the pure function.

### 7.7 Composition (`composition.ts`)

```ts
export interface CompositionValidation {
  errors: CompositionIssue[];    // fatal (§10 rules V1-V7)
  warnings: CompositionIssue[];  // non-fatal (§10 rules W1-W4)
  plan: MaterializedClipPlan[];  // what apply would write (empty when errors.length > 0)
}
export function validateComposition(
  manifest: ManifestV3, alignment: AlignmentArtifact, composition: CompositionFile
): CompositionValidation;                                              // pure
export function materializeComposition(
  manifest: ManifestV3, plan: MaterializedClipPlan[]
): ManifestV3;                                                         // pure; returns new manifest
export const COMPOSE_PAD = { headSec: 0.12, tailSec: 0.12 } as const;
```

Semantics are fully specified in §10.

### 7.8 Chapters (`chapters.ts`)

```ts
export interface Chapter { title: string; startSec: number }
export function deriveChapters(
  composition: CompositionFile, alignment: AlignmentArtifact, plan: MaterializedClipPlan[]
): Chapter[];
```

One chapter per selection that has `chapterTitle` set (§8.2); `startSec` = that selection's clip `timelineStart`. When no selection sets `chapterTitle`, returns `[]`. The agent decides chapter titles from the brief's `structure` and span texts - the tooling does not guess.

### 7.9 Import (`import.ts`, node-only)

```ts
export interface ImportTakeResult { assetId: string; clipId: string; path: string; durationSec: number }
export function importTake(workspaceDir: string, sourceFilePath: string, opts: { groupId: string; label?: string }): ImportTakeResult;
```

1. Validate source file exists and probe with the existing ffprobe helper in `packages/core/src/media.ts` (reuse; do not duplicate probing).
2. Next index NN = 1 + highest existing `input/takes/take-(\d+)\.` file (01, 02, ...). Copy (never move) to `input/takes/take-NN.<original ext>`. Never overwrite; if the target exists, that is a bug - fail.
3. Add asset `{ assetId: 'asset_take_NN', kind: 'video', path: 'input/takes/take-NN.<ext>', durationSec, provenance: 'imported', video, audio }` via `addAssetV3`.
4. Ensure staging track `track_takes` exists (create per 6.1 rule 5). Add clip `{ clipId: 'clip_take_NN', assetId, sourceStart: 0, sourceEnd: durationSec, timelineStart: 0 }`.
5. Ensure take group `groupId` exists (create `{ groupId, label: groupId, clipIds: [] }` if absent); append clipId.
6. Save manifest through the existing revision-preserving write path.

`ets import` (single-source flow) is untouched. A project may mix both: `input/source.mp4` as take one via `ets takes adopt-source` - NOT in this slice; instead, document that multi-take projects should import ALL takes via `takes add` and skip `ets import` entirely. `quickstart` docs updated accordingly.

## 8. Artifact schemas (in `takes/schema.ts`, exported from `@etvideo/core`)

### 8.1 `takes/alignment.json`

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

export const OrphanSpanSchema = z.object({
  orphanId: z.string().min(1),          // 'o001', ...
  clipId: z.string().min(1),
  takeWordStart: z.number().int().nonnegative(),
  takeWordEnd: z.number().int().nonnegative(),
  tStart: z.number().nonnegative(),
  tEnd: z.number().nonnegative(),
  text: z.string().min(1)
});

export const AlignmentArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  groupId: z.string().min(1),
  generatedAt: z.string().datetime(),
  reference: z.object({
    kind: z.enum(['take', 'file']),
    clipId: z.string().min(1).optional(),
    path: z.string().min(1).optional()
  }),
  takes: z.array(z.object({
    clipId: z.string().min(1),
    assetId: z.string().min(1),
    label: z.string().min(1),
    wordCount: z.number().int().nonnegative(),
    matchedFraction: z.number().min(0).max(1),
    lowConfidence: z.boolean()
  })),
  spans: z.array(z.object({
    spanId: z.string().min(1),
    ordinal: z.number().int().positive(),
    text: z.string().min(1)
  })),
  candidates: z.array(SpanCandidateSchema),
  orphans: z.array(OrphanSpanSchema)
});
export type AlignmentArtifact = z.infer<typeof AlignmentArtifactSchema>;
```

### 8.2 `takes/composition.json`

```ts
export const SelectionSchema = z.object({
  order: z.number().int().positive(),                 // unique, defines output sequence
  clipId: z.string().min(1),                          // which take
  spanIds: z.array(z.string().min(1)).optional(),     // contiguous reference spans, XOR orphanId
  orphanId: z.string().min(1).optional(),
  trim: z.object({
    headWords: z.number().int().nonnegative().default(0),
    tailWords: z.number().int().nonnegative().default(0)
  }).optional(),
  chapterTitle: z.string().min(1).optional(),
  rationale: z.string().min(1)                        // REQUIRED: the brief-grounded reason (R6)
}).refine(s => (s.spanIds !== undefined) !== (s.orphanId !== undefined),
  { message: 'exactly one of spanIds or orphanId' });

export const CompositionFileSchema = z.object({
  schemaVersion: z.literal(1),
  groupId: z.string().min(1),
  selections: z.array(SelectionSchema).min(1),
  gaps: z.array(z.object({                            // advisory only; compose never acts on these
    spanIds: z.array(z.string().min(1)).min(1),
    action: z.enum(['voice_patch', 'drop']),
    text: z.string().optional(),                      // proposed patch text
    rationale: z.string().min(1)
  })).default([])
});
export type CompositionFile = z.infer<typeof CompositionFileSchema>;
```

`rationale` is required on every selection deliberately: it forces the composing agent to justify each cut against the brief, and gives the user an audit trail (`ets compose apply --dry-run` prints them).

## 9. CLI surface (modified: `packages/etvideo-cli/src/index.ts`)

Follow every existing CLI convention in that file: Commander subcommands, `--json` flag emitting a single JSON object to stdout, non-zero exit on error, workspace resolved the same way existing verbs resolve it. All new verbs support `--json`; the human-readable default output is a compact table/summary. New verbs:

| Verb | Behavior |
|---|---|
| `ets brief set --file <path>` | Validate the file against BriefSchema, copy to `brief.md`. Errors list every frontmatter issue. `--force` required to overwrite an existing brief.md. |
| `ets brief init` | Write `briefTemplate()` to `brief.md` (error if exists) so the user can fill it in. |
| `ets brief show [--json]` | Print parsed brief (frontmatter + body). |
| `ets takes add <files...> [--group main] [--label <l>]` | `importTake` per file, in argument order. `--label` only valid with a single file. JSON output: array of ImportTakeResult. |
| `ets takes list [--json]` | Take groups with per-take: clipId, label, durationSec, wordCount (if transcribed), transcribed yes/no. |
| `ets takes align [--group main] [--reference <clipId>] [--script <file>]` | Load transcripts for every clip in the group (error listing missing ones with the exact `ets transcribe --clip <id>` command to run, §14 E1). `--script` copies the file to `takes/script.txt` and sets the group reference; `--reference` sets reference kind 'take'. Run `computeAlignment`, write `takes/alignment.json`. Prints summary: N takes, M spans, K orphans, low-confidence warnings. |
| `ets takes spans [--group main] [--contested] [--gaps] [--json]` | Read alignment.json. Default: one row per span: spanId, ordinal, first 8 words of text + word count, and per take: coverage/matchQuality/fillerCount/durationSec (compact). `--contested`: only spans where the top two candidates' composite gap is < 15% (composite = matchQuality - 0.05*fillerCount - 0.05*falseStartCount, an ORDERING heuristic for filtering only - the agent judges, the tool never auto-picks). `--gaps`: only spans with zero candidates. |
| `ets takes span <spanId> [--take <clipId>] [--words] [--json]` | Full detail for one span: reference text, every candidate with all metrics, and with `--words` the original word-by-word text + timings per candidate (windowed context view for contested judgments, R5). Accepts orphan ids (`o001`) too. |
| `ets compose apply --file takes/composition.json [--dry-run] [--json]` | §10. Default path is `takes/composition.json`; `--file` overrides. |
| `ets export-chapters [--format json\|youtube] [--json]` | `deriveChapters` over the last applied composition (§10 stores the plan hash in the manifest; error E6 if composition was never applied or is stale). `youtube` format: `MM:SS Title` lines. |

## 10. `compose apply` semantics

### Validation (fatal errors, V-rules)

- **V1** composition parses against `CompositionFileSchema`; `groupId` exists in manifest; `takes/alignment.json` exists, parses, and its `groupId` matches.
- **V2** every `clipId` referenced is in the group; every `spanId`/`orphanId` exists in the alignment artifact.
- **V3** for each selection with `spanIds`: the spans are consecutive ordinals (contiguity - one clip per selection), and a candidate exists for (each spanId, clipId) - a merged multi-span selection uses the first span's candidate head and last span's candidate tail on the same take, and every span in between must also have a candidate on that take.
- **V4** `order` values are unique and 1..N dense.
- **V5** no spanId/orphanId appears in more than one selection.
- **V6** `trim.headWords`/`tailWords` leave at least 1 word (trim is applied to the selection's take word range BEFORE times are computed).
- **V7** computed source ranges (below) satisfy `sourceStart < sourceEnd` and lie within the take asset duration.

### Warnings (W-rules, shown in dry-run and apply, never blocking)

- **W1** seam risk: at each junction between consecutive selections, outgoing `tailBoundaryScore` or incoming `headBoundaryScore` < 0.5 (R3).
- **W2** dropped content: reference spans absent from all selections and not covered by a `gaps` entry (dropping is legal - the brief may demand it - but must be visible).
- **W3** any selected candidate has `coverage < 0.8` or `truncated: true`.
- **W4** selections out of reference order (legal - narrative reordering is in scope, R7 - but flagged so it is always intentional).

### Materialization (after zero V-errors)

1. For each selection (by `order`): take word range = candidate span (first span head .. last span tail), minus `trim` words. `sourceStart` = firstWord.start - `COMPOSE_PAD.headSec`, clamped to [previous word's end, and >= 0]. `sourceEnd` = lastWord.end + `COMPOSE_PAD.tailSec`, clamped to [next word's start, and <= asset durationSec].
2. Build clips `{ clipId: 'clip_comp_NNN', assetId: <take asset>, sourceStart, sourceEnd, timelineStart: running sum of previous clip durations }`. NNN restarts at 001 on every apply.
3. Replace the clips of the primary timeline video track (the track existing single-source flow targets - resolve it the same way `assemble-from-clips` does). All other tracks, the staging track, `takeGroups`, assets, and operations on OTHER tracks are untouched. Operations targeting the replaced clips (from a previous apply's cleanup pass) are set to `status: 'disabled'` (operations carry `status` per `packages/core/src/operations/base.ts:34`, enum includes `'disabled'`) - never deleted, per the manifest reversibility rule.
4. Store `compose: { appliedAt, compositionHash }` (sha256 of the composition file bytes) as a new optional manifest field `composeState` so `export-chapters` can detect staleness.
5. Save through the existing revision-preserving manifest write path. Re-running apply with an edited composition is the ONLY supported way to change take selection (never hand-edit `clip_comp_*` clips; the revision history plus regenerable artifacts make every step reversible).

`--dry-run`: print (or `--json`-emit) the full `CompositionValidation` - the plan table (order, clipId, spans, source range, duration), every warning with span text excerpts, all rationales, and the total duration vs `brief.targetDurationSec` when set. Writes nothing.

## 11. Agent tools (modified: `packages/core/src/agent-tools/index.ts`)

Mirror the new capabilities for WebSocket agent sessions, same thin-wrapper style as the existing add-asset/add-clip tools: `takes_list`, `takes_align`, `takes_spans`, `takes_span_detail`, `compose_validate` (dry-run), `compose_apply`, `brief_show`. Input/output schemas are exactly the core function inputs/outputs from §7-§10; no logic in the tool layer.

## 12. Interaction with `spec/audio-channel-fix` (RESOLVED - merged first)

This spec's branch is now rebased onto `spec/audio-channel-fix` (tip `68dd10a8`), which merged first. That branch shipped a cleaner design than this section originally assumed, so the interaction is a non-issue and requires no channel-fix code changes in this slice. What it actually shipped:

- `audioChannelFix` stays a single **project-level** record (`AudioChannelFixSchema` in `manifest/schema.ts`), describing ONLY `input/source.mp4`.
- `channelFixScope.ts` `resolveChannelFixForAsset(manifest, assetPath)` returns the fix only when `assetPath === 'input/source.mp4'`, and its doc comment explicitly tolerates any number of other video assets ("never an unrelated import ... regardless of how many other video assets exist").
- `render/plan.ts` does NOT bail on multiple video sources. It computes `videoSourceIds`; when `size > 1` (or the base asset path is not `input/source.mp4`) it simply leaves `studioCleanupAudioPath`/`audioSourceChannel` undefined, so both fixes go inert and the render proceeds normally via ordinary multi-input concat.

Consequences for multi-take (all favorable):

1. Multi-take takes live at `input/takes/take-NN.mp4`, never `input/source.mp4`, so `resolveChannelFixForAsset` returns undefined for them - takes are treated as normal stereo, correctly. No per-asset migration, no `--asset` flag, no `migrate-manifest` change. The original §12 plan for a per-asset conversion is DROPPED as unnecessary.
2. After `compose apply` the timeline draws from multiple take assets, so `videoSourceIds.size > 1` makes channel-fix and studio-cleanup inert automatically - which is exactly the "no studio cleanup for multi-take this slice" behavior §4 requires. No new guard message needed; the existing graceful-skip covers it.
3. One required integration change, folded into Task 1: `videoSourceIds` (plan.ts:213-217) counts clips from every video track INCLUDING the staging track, but staging clips are never rendered (6.1 rule 3 excludes them from `buildBaseTimeline`). Excluding staging tracks from the timeline but letting them count as "video sources" that suppress a legitimate single-source fix is inconsistent. Task 1 must filter `t.role !== 'staging'` into the `videoSourceIds` computation, with a test that a single-source project keeps its channel fix active after takes are staged.

## 13. Agent workflow: `skills/compose-from-takes/`

A reference skill in the exact structure of `skills/assemble-from-clips/` (registered the same way, runnable via `ets skill compose-from-takes --ws-url ... --token ... --workspace ... --project-id ...`). It encodes the canonical loop; Claude Code may also drive the CLI directly - the skill is the executable documentation of the workflow:

1. **Brief**: `brief_show`. If missing: stop and instruct the user to run `ets brief init` and fill it in. Never compose without a brief (R6).
2. **Align**: `takes_align` (transcribe errors list the exact commands to run first).
3. **Survey**: `takes_spans` - the whole decision surface in one table (R5: for long-form, this stays compact; never load all transcripts).
4. **Judge**: for spans from `--contested`, fetch `takes_span_detail --words` and judge the actual language against the brief (audience, tone, structure). Metrics rank; the agent decides. Include orphans: check each orphan against the brief - new material that serves the audience gets selected; tangents get dropped.
5. **Compose**: write `takes/composition.json` with a rationale per selection referencing the brief. Declare unfixable spans in `gaps`.
6. **Validate**: `compose_validate`; resolve every warning deliberately (move a seam to a higher-boundary-score word via `trim`, or accept and say why in the rationale). Apply.
7. **Cleanup**: run find-fillers over the composed clips; apply cut/mute ops. For `gaps` entries with `action: 'voice_patch'`: propose the patch text to the user, then use the existing voice_patch flow (paid-provider policy applies - user approval per AGENTS.md).
8. **Draft loop**: `ets render` draft, hand the user the path, iterate on feedback by editing `composition.json` and re-applying (never hand-edit clips).
9. **Finish**: on approval - final render (`--yes` rule applies), `ets export-captions`, `ets export-chapters --format youtube`.

Add a `docs/skills-cookbook.md` entry mirroring the other skills' entries, plus a "Multi-take quickstart" section in the README/CLAUDE.md command list: `ets init` -> `brief init` (user fills) -> `takes add a.mp4 b.mp4 c.mp4` -> `extract-audio`/`transcribe --clip` per take -> `takes align` -> agent composes -> `compose apply` -> cleanup -> `render`.

## 14. Error handling

All new errors are a `TakesError` class (in `takes/schema.ts`) with a stable `code`; the CLI maps them to `--json` error envelopes and human messages:

| Code | Condition | Message must include |
|---|---|---|
| E1 `TAKES_MISSING_TRANSCRIPTS` | `takes align` with untranscribed clips | each missing clipId AND the exact command: `ets transcribe --clip <id>` |
| E2 `TAKES_UNKNOWN_GROUP` | groupId not in manifest | known groupIds |
| E3 `TAKES_EMPTY_GROUP` | group has < 1 takes at align time (1 take is VALID - spans + metrics still useful for single-take cleanup) | - |
| E4 `COMPOSE_VALIDATION` | any V-rule failed | every violation with rule id, spanId/clipId, and human explanation |
| E5 `ALIGNMENT_STALE` | composition references spanIds/orphanIds not in current alignment.json | hint: re-run `ets takes align`, then re-check composition |
| E6 `CHAPTERS_STALE` | `export-chapters` when `composeState.compositionHash` missing or != current file hash | hint: run `ets compose apply` |
| E7 `BRIEF_INVALID` | brief.md missing/unparseable when explicitly read | per-field frontmatter issues |

Edge cases (behavior, not errors):

- Single take + pickups (R1): falls out of coverage - main take becomes reference, pickups cover only some spans. No special casing anywhere.
- Take added after composing: staging is independent; re-run `align`, edit composition, re-apply. `ALIGNMENT_STALE`/`CHAPTERS_STALE` catch forgotten re-runs.
- Divergent take: `lowConfidence` flag + orphans; agent decides whether it is an alternative or different content. Never force-fitted.
- Zero-candidate span in every take: appears under `takes spans --gaps`; agent handles via `gaps` (voice_patch or drop).

## 15. Testing plan

All pure-function tests need NO media files - alignment and composition are functions over word arrays. Fixture builders live in a shared `packages/core/src/__tests__/takes-fixtures.ts` (word-array literals with timings).

`packages/core/src/__tests__/` (vitest, run via `npx vitest run` from repo root):

- `take-normalize.test.ts`: casing, punctuation stripping, apostrophes/hyphens kept, empty-word dropping, unicode.
- `take-anchors.test.ts`: unique-shingle detection, LIS monotonicity (crossing anchors dropped), empty result on no shared shingles.
- `take-align.test.ts`: identical sequences -> all matches; single substitution/insertion/deletion placed correctly; banded path equals unbanded on small inputs; synthetic 10k-word pair with 1% mutations completes < 2s and matches > 95%; determinism (two runs, deep-equal).
- `take-spans.test.ts`: punctuation and gap segmentation; 40-word split; < 3-word merge; script-file mode (punctuation only); projection coverage/matchQuality math on hand-computed examples; MIN_CANDIDATE_COVERAGE cutoff; truncation at take boundary; orphan run detection (7 gap words -> no orphan, 8 -> orphan).
- `take-metrics.test.ts`: filler counting; false-start single and bigram repeats; silenceRatio clamping; boundary score - each formula term (gap only, terminal only, both, i=0 head).
- `take-alignment-artifact.test.ts`: full `computeAlignment` - identical takes -> coverage 1 everywhere; pickup take -> coverage 0 outside its window; flubbed sentence -> matchQuality drop on that span only; low-confidence flag at 0.29 vs 0.31 matched fraction; byte-identical output across runs; reference auto-selection tie-break.
- `composition.test.ts`: every V-rule triggered individually (V1-V7, one test each); every W-rule (W1-W4); materialization - pad clamping against neighbor words and asset bounds, timelineStart accumulation, clip_comp numbering reset, other tracks/staging/ops untouched, prior comp ops disabled-not-deleted; multi-span contiguity (V3); trim (V6) interaction with padding.
- `brief.test.ts`: template round-trip, each frontmatter field validation, body preservation, missing file error.
- `take-import.test.ts`: index numbering, staging-track creation, group append, never-overwrite failure (mock fs per existing media tests' pattern).
- `chapters.test.ts`: chapterTitle-driven derivation, empty when none set, staleness hash behavior.
- Manifest: extend the existing manifest schema test file: `role` default, staging-track superRefine rules a-d (§6.2), `takeGroups` default, back-compat parse of a pre-existing fixture manifest.
- `timeMap` test: staging track excluded from `composeTimeMap` output.

End-to-end (pattern of `apps/local-api/src/assemble-from-clips.test.ts`): `compose-from-takes.test.ts` drives a 3-take fixture project (take 1 full, take 2 full with a flubbed middle, take 3 a pickup of the flubbed section plus one orphan aside): brief -> takes add x3 -> mock transcribe -> align -> a scripted composition (take 1 open, take 3 pickup middle, take 2 close, orphan dropped with rationale) -> apply -> assert final clips/times -> render plan builds with 3 distinct inputs.

CI budget: the 10k-word alignment perf test is the only slow one; keep total suite addition < 10s.

## 16. File inventory

New files:

```
packages/core/src/brief/schema.ts            packages/core/src/takes/composition.ts
packages/core/src/brief/io.ts                packages/core/src/takes/chapters.ts
packages/core/src/takes/schema.ts            packages/core/src/takes/import.ts
packages/core/src/takes/normalize.ts         packages/core/src/takes/io.ts
packages/core/src/takes/anchors.ts           skills/compose-from-takes/index.ts
packages/core/src/takes/align.ts             apps/local-api/src/compose-from-takes.test.ts
packages/core/src/takes/spans.ts             packages/core/src/__tests__/takes-fixtures.ts
packages/core/src/takes/metrics.ts           packages/core/src/__tests__/<the 10 test files in §15>
packages/core/src/takes/alignment.ts
```

Modified files:

```
packages/core/src/tracks/schema.ts        role field (6.1)
packages/core/src/manifest/schema.ts      takeGroups + composeState + superRefine (6.2, §10.4)
packages/core/src/timeMap/compose.ts      skip staging tracks (6.1 rule 3)
packages/core/src/transcript.ts           transcribableClips includes staging; primaryVideoClips excludes (6.1 rule 4)
packages/core/src/index.ts                export new modules
packages/core/src/agent-tools/index.ts    seven new tools (§11)
packages/core/package.json                yaml@^2 dependency
packages/etvideo-cli/src/index.ts         ten new verbs (§9)
skills/find-fillers/index.ts              import FILLER_LEXICON from core (§7.5)
docs/skills-cookbook.md                   compose-from-takes entry
CLAUDE.md / README                        multi-take quickstart (§13)
```

## 17. Suggested implementation order

Each phase lands green (typecheck + tests) before the next; this is input to the implementation plan, not a replacement for it.

1. Schemas + manifest changes + timeMap/transcript staging behavior (6.1, 6.2) with tests.
2. Brief module + CLI verbs (6.3, §9 brief rows).
3. Alignment stack bottom-up: normalize -> anchors -> align -> spans -> metrics -> orchestrator, test file per module (7.1-7.6, §8.1).
4. Import + `takes add/list/align/spans/span` verbs (7.9, §9).
5. Composition validate/materialize + `compose apply` + chapters (7.7, 7.8, §10).
6. Agent tools + compose-from-takes skill + e2e test + docs (§11, §13).
