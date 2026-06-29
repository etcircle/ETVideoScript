# CLAUDE.md — ETVideo Studio

ETVideo Studio is a **local-first Descript clone** for ETCircle screen recordings, driven primarily by Claude Code via the `etvideo` CLI. Read [`AGENTS.md`](./AGENTS.md) first for the hard rules — this file adds Claude-specific orientation on top.

## Mental model in one paragraph

The transcript IS the timeline. A workspace holds the source MP4, the extracted audio, a word-level transcript, and an `edits/manifest.json` of operations (`cut`, `mute`, `voice_patch`). The CLI / API / web UI all read and write that manifest; renders are a deterministic projection of it through ffmpeg. The agent (you) orchestrates the workflow; deterministic code in `@etvideo/core` is the source of truth.

## Layout

- `packages/core` (`@etvideo/core`) — schemas, manifest ops, render planning, transcript I/O, TTS adapters, captions, time-mapping. **Add new primitives here so CLI/API/UI all share them.**
- `packages/etvideo-cli` (`bin: etvideo`) — Commander CLI. Adding a CLI verb usually means a 5-line wrapper around a core function.
- `apps/local-api` — Fastify server (`src/server.ts`). Localhost-bound. Routes under `/api/projects/:projectId/...`. WebSocket terminal is gated behind `ETVIDEO_ENABLE_TERMINAL=1` + token.
- `apps/studio-web` — Next.js shell. Editor UI currently lives in one client file: `src/app/projects/[projectId]/project-client.tsx`.
- `workspaces/` and `temp/` are gitignored project data.

## Workspace files (per project, all gitignored)

```
input/source.mp4             ← preserved original; never overwritten
media/extracted-audio.wav    ← mono audio for transcription
media/proxy-video.mp4
transcript/words.json        ← word-level transcript (the "script")
transcript/transcript.md
edits/manifest.json          ← timeline source of truth; revisions saved before writes
assets/voice/<...>.wav       ← generated replacement-speech clips
renders/draft.mp4            ← preview render
renders/final.mp4            ← never overwritten without --yes
logs/                        ← job + terminal logs
```

## Commands you'll run

```bash
pnpm install
pnpm test                    # vitest run
pnpm -r typecheck
pnpm build
pnpm doctor                  # ffmpeg/ffprobe sanity

# Dev servers (two terminals)
ETVS_WORKSPACE_ROOT="$PWD/workspaces" ETVS_ENABLE_AGENT=1 ETVS_TERMINAL_TOKEN=change-me-local-token pnpm dev:api
NEXT_PUBLIC_ETVS_API_URL=http://127.0.0.1:4317 NEXT_PUBLIC_ETVS_TERMINAL_TOKEN=change-me-local-token pnpm dev:web
# UI: http://127.0.0.1:4318/projects
```

## LAN access (optional)

To reach the API from another device on your LAN (e.g., Mac mini testing):

```bash
ETVS_BIND=0.0.0.0 \
ETVS_LAN_ORIGINS=http://<lan-ip>:4318 \
ETVS_TERMINAL_TOKEN=change-me-local-token \
pnpm dev:api
```

- `ETVS_BIND` defaults to `127.0.0.1` — set to `0.0.0.0` (all interfaces) or a specific IP to expose.
- `ETVS_LAN_ORIGINS` is an explicit comma-separated origin list (no CIDR).
- Token gate is mandatory in LAN mode. Server refuses to start without `ETVS_TERMINAL_TOKEN` if `ETVS_BIND !== 127.0.0.1`.
- HTTP routes require `Authorization: Bearer <token>` header — query-string token rejected for security. WebSocket continues to accept `?token=` for browser handshake (browsers can't set headers on WS).

(Legacy `ETVIDEO_*` and `NEXT_PUBLIC_ETVIDEO_API_URL` env vars are still aliased for back-compat after the C8 rename.)

CLI quickstart (per-project): `ets init` → `import` → `extract-audio` → `transcribe` → `apply-edit` → `validate-manifest` → `render`. To run the new reference skills: `ets skill find-fillers --ws-url ws://127.0.0.1:4317/ws/projects/<id>/agent/<session> --token <token> --workspace ... --project-id <id>`.

## Browser QA — use the prod build

**For automated/headless browser QA (Hermes, agent-browser, CDP), build production first.** Next.js 16 + Turbopack dev mode has hydration timing quirks under headless CDP — useEffect hooks and event handlers can fail to attach, even though SSR markup is correct. Three QA runs on 2026-05-14 reproduced this. The prod build hydrates cleanly under the same headless harness.

```bash
pnpm build
ETVS_WORKSPACE_ROOT="$PWD/workspaces" ETVS_ENABLE_AGENT=1 ETVS_TERMINAL_TOKEN=change-me-local-token pnpm --filter @etvideoscript/local-api start &
NEXT_PUBLIC_ETVS_API_URL=http://127.0.0.1:4317 NEXT_PUBLIC_ETVS_TERMINAL_TOKEN=change-me-local-token pnpm --filter @etvideoscript/studio-web start &
```

Manual `pnpm dev:web` in a normal browser works fine — the issue is dev-mode + CDP automation only.

## Active focus (2026-05-13)

These are the slices the user has called out as next; pick from here unless asked otherwise.

1. **Timeline overhaul** — the bottom strip in `project-client.tsx` is placeholder. Target: real waveform, zoom in/out, and at sufficient zoom render the word text over the corresponding waveform region so the user can scrub by word.
2. **Draft preview** — render-draft exists, but the preview-switcher UX should feel like a real NLE preview (auto-refresh after render, in-flight indication, fast seek).
3. **Voice cloning** — `voice_patch` ops + `synthesizeReplacementSpeech` (mock + xAI) are stubbed. Direction is real voice cloning, not generic TTS. **xAI calls cost money — get user approval before invoking.**
4. **CLI/tool richness for Claude** — keep verbs deterministic, JSON-printable (`--json`), and reversible so an agent can chain them safely.

## Hard rules (see also `AGENTS.md`)

- Never overwrite `input/source.mp4` or `renders/final.mp4` without explicit `--yes` / user approval.
- Paid providers: configuring a provider is consent (see AGENTS.md "Paid services policy"). Disclose estimated cost and show activity on every call — no per-call modal. One-time confirmation only to set a paid provider as default.
- Manifest edits are reversible — set `status: 'disabled'` rather than deleting history.
- Add tests for new schemas, path-safety, manifest validation, render planning. Pattern: `packages/core/src/__tests__/*.test.ts`.
- Don't expand into a generic professional NLE. Transcript-first.
- Don't expose the terminal WebSocket beyond localhost.

## Claude Code sub-agents available in this repo

Defined in `.claude/agents/`. Use them with the Agent tool when the task fits.

- **etvideo-core-engineer** — schemas, manifest, render planning, time-mapping, captions. Pure-TypeScript work in `@etvideo/core` with vitest.
- **etvideo-timeline-ui** — the bottom-timeline overhaul (waveform, zoom, word labels) and other UI in `apps/studio-web`.
- **etvideo-voice** — TTS/voice-cloning adapters and the `voice_patch` flow. Knows xAI is paid.
- **etvideo-transcript** — Whisper/transcription adapters; especially the homelab Whisper word-timing gap.

When in doubt about scope, drop down a level: prefer adding a `@etvideo/core` primitive over a one-off in the API or UI.

## Memory

Auto memory is on. Project context lives at `~/.claude/projects/<encoded-project-path>/memory/`. The vision / architecture / rules / external-service notes there are kept in sync with what's in this file; update them when project direction changes.
