# AGENTS.md — ETVideoScript

You are working on ETVideoScript, a local transcript-based video editor with CLI and agent orchestration.

Core rule: the agent orchestrates; deterministic code and project files are the source of truth.

Do:
- build small vertical slices;
- keep state in workspace files;
- use `edits/manifest.json` as the timeline source of truth;
- preserve source media;
- make AI-generated edits reversible;
- add tests for schema, path safety, manifest validation, and render logic;
- report changed files and commands run.

Do not:
- build v3 track/timeline UI ahead of the v3 manifest schema + operation registry it rests on;
- call paid providers without disclosing cost to the user;
- commit secrets;
- expose terminal publicly;
- overwrite source media;
- hide important state in chat history.

## Editor model (v3, locked 2026-05-17)

ETVideoScript v3 is a **multi-track editor**. The manifest holds tracks of kind video / audio (dialog · music · sfx · voiceover) / caption; clips live on tracks; edit operations target a `{trackId, clipId}`. This is the substrate for the required capability set: speed-ramp, audio recording, adding tracks, and **detaching a clip's audio from its video** to edit them on separate lines.

Multi-track is the **document** model. Transcript-first stays the **interaction** model — you edit speech by selecting words in the transcript; the timeline is the surface for structural arrangement (placing, trimming, ordering clips and tracks). This is the Descript shape. It supersedes the earlier "not a professional timeline / transcript-first" caution — that constrained the *document* model; v3 keeps transcript-first as the *interaction* model only.

Architecture and migration plan: `temp/plans/2026-05-17-etvideoscript-v3-architecture.md`.

### voice_patch semantics (phase-1, locked 2026-05-25)

A `voice_patch` is a **replacement** operation, not a timing op.

- Shorter generated audio does **not** shrink the timeline. The original slot duration is preserved; unused slack is rendered as silence unless a later room-tone/fill operation explicitly replaces it.
- Longer generated audio extends the timeline by the overflow. For visible patched video, the patched (anchor) track's last source frame freezes for the overflow duration; base audio is muted across the full asset playback window. Phase-1 anchor-track freeze landed 2026-05-25; lip-sync / mouth re-animation remains a separate phase-2 concern. Hidden anchor tracks intentionally fall through to the gap-filler if no visible overlay covers the overflow — hidden video cannot be a visual source.
- Timing tightening is a separate explicit op (`cut`, ripple-trim, trim-silence). It must not be a side effect of a shorter TTS asset.

This rule supersedes any earlier "shorter patch shrinks the timeline" assumption (codified in pre-2026-05-25 tests; corrected this slice). Implementation references: `packages/core/src/operations/voice-patch.ts` (`projectTimeMap` + `renderContribution`), `packages/core/src/render/pipeline.ts` (audio-insert mute window).

## Paid services policy (locked 2026-05-15)

ETVideoScript is free and OSS. Users plug in their OWN API keys for external paid services (ElevenLabs, xAI, Anthropic, OpenAI, Adobe Enhance, etc.) as opt-in upgrades.

**Configuring a paid provider IS the consent.** Once the user has added their API key in Settings and set a provider as default (or invoked it explicitly), individual calls do NOT require a Y/N approval dialog. It's the user's money and their choice — gating every render with a modal is friction, not safety.

What IS required on every paid call:
- **Cost disclosure** — show estimated cost before the call runs (UI label, CLI line, log entry). Format: "ElevenLabs Isolation — ~$0.05 for 30s of audio".
- **Visible activity indicator** — the call is happening, it's not silent.
- **Failure surfacing** — if the paid call fails (auth, rate limit, billing), surface the actual error and provider response code.

What still requires explicit approval (one-time confirmation, NOT per-call):
- Setting a paid provider as DEFAULT for an action (so the user is making the "paid is my default" choice consciously).
- Switching the default from local to paid.
- Destructive operations (final render overwrite, credential deletion, project deletion).
- Lip-sync or long-running voice generation jobs that exceed N minutes of audio (cap configurable in Settings).

In short: configure once with intent, then run freely with cost transparency. No prompt fatigue.

Primary CLI: `ets init`, `ets import`, `ets extract-audio`, `ets transcribe`, `ets validate-manifest`, `ets render`.

## Orchestration model (locked 2026-05-15)

ETVideoScript ships **tools and skills, not a brain.** The AI orchestration boundary is explicit and immovable:

**What ETVideoScript provides:**
- A rich, machine-friendly `ets` CLI. Every verb has `--json`, every state lives in workspace files on disk, every operation is deterministic and reversible via the manifest.
- The agent-protocol-v2 WebSocket surface at `apps/local-api` (gated by `ETVS_ENABLE_AGENT` + `ETVS_TERMINAL_TOKEN`).
- A library of **portable skills** at `skills/<name>/` (e.g. `find-fillers`, `assemble-from-clips`, `polish-narration`, `tighten-section`). Each skill is a `README.md` + small `index.ts` runner that an external agent can read to learn how to accomplish a specific editing outcome by driving `ets` + the WS protocol.

**What ETVideoScript does NOT provide:**
- An in-process LLM client. No `openai`, `anthropic`, or `xai` SDK imported into `@etvideoscript/core`, `apps/local-api`, or `apps/studio-web` for direct chat-completion calls.
- A built-in agent harness, reasoning loop, or prompt-builder. We do not implement "agent orchestration" as a product feature.
- A bundled "easy-mode" AI that hides which CLI is in use.

**Who is the brain:**
- The user's existing CLI agent — Claude Code, Hermes, Codex, OpenClaw, or any future CLI that can read markdown + invoke shell commands. They bring their own model, their own auth (subscription or API key), and their own reasoning loop.
- Skills are written so any of those agents can follow them. SKILL.md frontmatter + the `ets` CLI + the WebSocket protocol are the contract.
- The deferred Slice F "Agents" registry stores `{ name, kind: cli|http, command_or_url, auth_ref, enabled }` — that's the entirety of agent integration. No transport-adapter abstraction zoo.

**Why this rule:**
- Single-user, local-first, free-and-OSS positioning means the LLM cost belongs on the user's own subscription, not ETVideoScript.
- Building a brain is a different product. The market for "open-source agent harnesses" is already crowded (Claude Code, Hermes, Codex, OpenClaw). Adding a fourth competes with our own users' tools.
- Skills + a great CLI are the durable contribution to the community. The brain is fungible; the editing primitives are not.

**When in doubt:** if a new feature would require ETVideoScript to import an LLM SDK or maintain its own prompt templates against a model, the feature needs to be reframed as a skill the user's CLI agent runs.
