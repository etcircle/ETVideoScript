# Contributing

## How to contribute

ETVideoScript is a local-first transcript video editor, so contributions should keep deterministic project files as the source of truth, preserve source media, and prefer small vertical slices with tests over broad rewrites. Before changing behavior, inspect the relevant workspace files and schemas; after changing behavior, run validation, tests, and a draft render path when media logic is touched.

## Writing a skill

Start with `docs/skills-cookbook.md`. The four reference skills are:

- `skills/find-fillers`
- `skills/polish-narration`
- `skills/tighten-section`
- `skills/assemble-from-clips`

Skills should read state through the agent protocol, emit reversible manifest operations, and treat `edits/manifest.json` as the contract. Multi-clip skills must carry `clipId` from transcript words into any proposed clip-local operation.

## Workspace structure

A project workspace lives under `workspaces/<id>/` and is intentionally file-based:

- `project.json` stores project metadata, status, and `clipSources[]`.
- `assets/video/<clipId>/source.mp4` stores canonical copied source media for each clip.
- `input/source.mp4` remains the legacy/single-clip compatibility source.
- `media/<clipId>/extracted-audio.wav` stores per-clip transcription audio.
- `media/<clipId>/peaks.json` stores per-clip waveform peaks.
- `transcript/<clipId>/words.json` stores per-clip word timing with `clipId` on words.
- `transcript/words.json` stores the merged transcript used by UI/agent reads.
- `edits/manifest.json` is the current timeline source of truth.
- `edits/manifest.v1.json` is the snapshot created before v1 manifests are migrated/overwritten.
- `edits/revisions/` stores manifest revisions before edits.
- `renders/` stores rendered outputs and render logs.
- `logs/provider-requests.jsonl` stores auditable provider calls.

Do not overwrite source media, commit secrets, or hide important state in chat history.

## Running tests

Use the root scripts:

```bash
pnpm test
pnpm -r typecheck
pnpm build
```

Add new unit tests near the code they protect. Core tests live in `packages/core/src/__tests__/` and use Vitest (`*.test.ts`) with focused fixtures for schemas, path safety, manifest validation, migration, transcript, caption, time-map, and render-plan behavior. CLI wiring tests live under `packages/etvideo-cli/src/__tests__/`; UI tests live beside the relevant Studio components.

## Migration policy

Manifest schema-version handling must be explicit. The canonical migration entrypoint is `loadManifest(workspacePath)`: it detects v1, writes `edits/manifest.v1.json` before overwriting, migrates project metadata, and returns the v2 manifest. Preserve the snapshot-before-overwrite invariant; never add a second ad hoc migration path that bypasses `loadManifest`.

## Architecture at a glance

- `packages/core`: schemas, workspace filesystem helpers, manifest validation/migration, transcript/caption projection, render planning, and FFmpeg render logic.
- `apps/local-api`: localhost-first Fastify API plus the guarded WebSocket/terminal/agent surface.
- `apps/studio-web`: Next.js shell for projects, transcript editing, preview, agent chat, and the tracks timeline.
