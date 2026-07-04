# ADR-0001: `channelFixScope.ts` stays dependency-free

## Status

Accepted (2026-07-04)

## Context

An architecture review of the audio-channel-fix feature flagged `packages/core/src/channelFixScope.ts` as a candidate for deepening: its exported interface (`resolveChannelFixForAsset`, `channelFixFingerprint`, `channelFixMonoPan`, `channelFixStereoPan`, `sourceChannelFixFingerprint`) is nearly as small as its implementation — a classic shallow-module signal.

The obvious "fix" is to merge it into `channelBalance.ts` (channel-balance detection and `applyChannelFix`) or `channelFixSidecar.ts` (fingerprint sidecar I/O), both of which own more of the actual channel-fix behavior.

Both of those modules import `node:fs` (and `channelBalance.ts` also spawns `ffmpeg`/`ffprobe`). `channelFixScope.ts` deliberately imports nothing beyond a type from `manifest/schema`. `browser.ts` — the entry point bundled into `studio-web` — re-exports `render/plan.ts`, which imports `resolveChannelFixForAsset` and `sourceChannelFixFingerprint` from `channelFixScope.ts`. If those pan/fingerprint helpers lived in `channelBalance.ts` or `channelFixSidecar.ts` instead, `render/plan.ts` would transitively pull `node:fs` into the client bundle.

This is exactly the trap this repo's own `CLAUDE.md` calls out: "Importing anything that touches `node:fs` from a module reachable via `browser.ts` ... passes `pnpm -r typecheck` but breaks the studio-web Turbopack client build." `pnpm -r typecheck` would not catch a regression here; only `pnpm --filter @etvideoscript/studio-web build` would.

## Decision

`channelFixScope.ts` stays a small, dependency-free module by design. It owns exactly the parts of the channel-fix concept that must be callable from browser-bundled code: resolving whether a fix applies to a given asset, computing its value fingerprint, and building the pure ffmpeg pan-filter strings. Everything that touches `node:fs`, spawns a process, or does I/O (sidecar reads/writes, `ffprobe`/`ffmpeg` invocations, manifest load/save) stays in `channelFixSidecar.ts` or `channelBalance.ts`, which are never imported by `browser.ts`.

Do not merge `channelFixScope.ts` into either of those modules to "deepen" it. Its narrow interface is the seam that keeps `render/plan.ts` — and therefore `browser.ts` and the `studio-web` bundle — free of Node-only dependencies.

## Consequences

- A future addition to `channelFixScope.ts` must not import `node:fs`, `node:child_process`, or anything that transitively does. `pnpm --filter @etvideoscript/studio-web build` is the check that would actually catch a violation (typecheck alone will not).
- Future architecture reviews should not re-flag this module's shallowness as a deepening opportunity without first reading this ADR.
