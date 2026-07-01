# ETVideoScript

Local-first transcript-driven video editor for ETCircle screen recordings.

The transcript **is** the timeline. A workspace holds the source video, its
extracted audio, a word-level transcript, and an `edits/manifest.json` of
reversible operations (`cut`, `mute`, `voice_patch`, …). The CLI, the local API,
and the web editor all read and write that manifest; every render is a
deterministic FFmpeg projection of it. The project is developed local-first and
driven primarily through an AI coding agent.

## Status & roadmap

This is an active, experimental personal project — not a supported product.

**Working today**
- Transcript-driven editing: word-level transcript as the timeline; reversible
  cut / mute / voice-patch operations in `edits/manifest.json` (revisions saved
  before every write).
- Deterministic FFmpeg draft/final renders as a pure projection of the manifest.
- Studio web editor: transcript pane, video preview with draft/source switching,
  a real waveform timeline with word labels, a command palette (⌘K), keyboard
  shortcuts, and a one-pass "clean up" sweep for fillers and dead air.
- Pluggable providers: mock + self-hosted Whisper transcription; speech-synthesis
  / voice adapters behind a consent-gated paid-provider policy (no silent paid
  calls).

**In progress**
- Replacement-speech quality: voice-clone identity plus seam/loudness matching,
  beyond generic TTS.
- Preview UX polish: auto-refresh after render, fast seek, transport speed.

**Planned / not yet wired**
- "Skip silences" during playback (the toggle is present today as an affordance).
- Per-word timestamp accuracy improvements in the transcription pipeline.
- A broader accessibility pass before any wider use.

## What exists in this MVP foundation

- pnpm TypeScript monorepo
- shared `@etvideoscript/core` schemas and workspace helpers
- deterministic `ets` CLI
- local Fastify API bound to localhost by default
- Next.js web shell matching the target structure:
  - transcript pane on the left
  - video preview on the right
  - manifest + terminal/agent panel
  - bottom timeline/waveform strip
- mock transcription provider
- homelab Whisper transcription adapter (default `http://127.0.0.1:8789/v1/audio/transcriptions`, OpenAI-compatible — pointed at a self-hosted WhisperX in user setups)
- cut/mute manifest operations
- deterministic draft render via FFmpeg trim/atrim filters
- tests for schemas, path safety, workspace creation, manifest validation, time mapping, and API health/project routes

## Setup

```bash
pnpm install
pnpm test
pnpm -r typecheck
pnpm build
```

## Run locally

Terminal 1:

```bash
ETVIDEO_WORKSPACE_ROOT="$PWD/workspaces" pnpm dev:api
```

Terminal access is disabled by default. For the trusted local admin terminal panel only:

```bash
ETVIDEO_ENABLE_TERMINAL=1 ETVIDEO_WORKSPACE_ROOT="$PWD/workspaces" pnpm dev:api
```

Terminal 2:

```bash
NEXT_PUBLIC_ETVIDEO_API_URL=http://127.0.0.1:4317 pnpm dev:web
```

Open:

```text
http://127.0.0.1:4318/projects
```

## CLI quickstart

```bash
pnpm --filter @etvideoscript/cli ets --workspace "$PWD/workspaces/demo" init --project-id demo --title "Demo"
pnpm --filter @etvideoscript/cli ets --workspace "$PWD/workspaces/demo" import /path/to/source.mp4
pnpm --filter @etvideoscript/cli ets --workspace "$PWD/workspaces/demo" extract-audio --yes
pnpm --filter @etvideoscript/cli ets --workspace "$PWD/workspaces/demo" transcribe --provider mock
pnpm --filter @etvideoscript/cli ets --workspace "$PWD/workspaces/demo" apply-edit cut --start 1 --end 2 --reason "false start"
pnpm --filter @etvideoscript/cli ets --workspace "$PWD/workspaces/demo" validate-manifest
pnpm --filter @etvideoscript/cli ets --workspace "$PWD/workspaces/demo" render --preset draft --output renders/draft.mp4 --yes
```

## Homelab Whisper

After `extract-audio`, run:

```bash
pnpm --filter @etvideoscript/cli ets --workspace "$PWD/workspaces/demo" transcribe --provider homelab-whisper
```

The adapter prefers `ETVS_WHISPER_LAN_URL` / `ETVS_WHISPER_URL` and falls back to `ETVIDEO_WHISPER_LAN_URL` / `ETVIDEO_WHISPER_URL`, then defaults to:

```text
http://127.0.0.1:8789/v1/audio/transcriptions
```

This is the OpenAI-compatible `/v1/audio/transcriptions` shape, pointed at WhisperX (transformers Whisper-large-v3-turbo + wav2vec2 forced alignment) in the canonical homelab deployment. Returns `segments[].words[]` with `start`/`end`/`probability` per word — ~30ms word-boundary accuracy on EN, no leading-silence drift.

## Homelab TTS (voice cloning) and denoise

Two more local-tier adapters point at the same Mac Mini inference stack: `tts.mlx-chatterbox`
(Chatterbox voice cloning via `mlx-audio`) and `studio-sound.deepfilternet` (DeepFilterNet3
denoise). Both default to `127.0.0.1` and can be pointed at a Tailscale address via env:

```text
ETVS_CHATTERBOX_BASE_URL=http://127.0.0.1:8791/v1/tts
ETVS_DEEPFILTERNET_BASE_URL=http://127.0.0.1:8792/v1/enhance
```

`ETVIDEO_CHATTERBOX_BASE_URL` / `ETVIDEO_DEEPFILTERNET_BASE_URL` are supported as legacy aliases.
`*_BASIC_AUTH` variants (`ETVS_CHATTERBOX_BASIC_AUTH`, `ETVS_DEEPFILTERNET_BASIC_AUTH`, and their
`ETVIDEO_*` aliases) carry a raw `Authorization` header value — see
`docs/specs/local-inference-stack.md` for the bearer-token convention used by all three servers.

## Safety rules

- `temp/` and local `workspaces/*` are gitignored.
- Source media is copied to `input/source.mp4` and never overwritten by render commands.
- `edits/manifest.json` is the timeline source of truth.
- Manifest writes save revisions first.
- `renders/final.mp4` is not overwritten without `--yes`.
- No paid provider or lip-sync call is implemented in this slice.
