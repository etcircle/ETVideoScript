# Spec: self-hosted inference stack on the Mac Mini (ElevenLabs replacement)

Status: draft, not yet implemented.
Owner: Nikola.
Last updated: 2026-06-30.

## Goal

Stop depending on ElevenLabs for TTS/voice-cloning, STT (Scribe), and studio-sound
isolation. Replace each with an open-source model running on hardware we control,
optimized for Apple Silicon rather than a like-for-like swap.

## Why the Mac Mini, not the MacBook

The MacBook (`MacBookPro18,2`, M1 Max, 32GB) is where recording and editing actually
happens, and it runs essentially no free memory under normal load (~193MB free,
~12GB already in the compressor, heavy historical swap activity — Firefox with a
dozen+ tab processes, 3 concurrent `claude` sessions, Antigravity IDE, iTerm all
resident). Loading model weights into that same pool risks swap/latency spikes
during the exact moment they're needed: a live recording or processing session.

The Mac Mini (8GB, on the LAN at `mac-mini.local` / `192.168.178.153`, separate
macOS account, currently runs no services — Remote Login/SSH is off) has no such
contention. A dedicated, idle, single-purpose 8GB box beats a contended 32GB one,
provided the servers don't try to keep every model resident simultaneously — see
"Memory budget" below.

## Target architecture

Three small local HTTP servers on the Mac Mini, each a thin wrapper around an
open-source model, reachable from the MacBook over the LAN at `http://mac-mini.local:<port>`.
`@etvideoscript/core`'s provider registry already supports this shape — local-tier
HTTP adapters with a configurable `baseUrl` — this is the same pattern
`stt.homelab-whisper` already uses today.

| Capability | Model | Port | Repo provider id | Code change needed |
|---|---|---|---|---|
| STT | `whisperx-mlx` (Whisper-large-v3-turbo + wav2vec2 forced alignment, MLX backend) | 8789 | `stt.homelab-whisper` (unchanged) | **None** — if the new server implements the same OpenAI-compatible `POST /v1/audio/transcriptions` contract (`response_format=verbose_json`, `timestamp_granularities[]=word`), the existing adapter (`packages/core/src/providers/stt/homelabWhisper.ts`) works as-is. Just point `ETVS_WHISPER_BASE_URL=http://mac-mini.local:8789/v1/audio/transcriptions` instead of `127.0.0.1`. |
| TTS / voice cloning | Chatterbox-Turbo via `mlx-audio` (Blaizzy/mlx-audio) | 8791 | `tts.mlx-chatterbox` (new) | New adapter file `providers/tts/mlxChatterbox.ts`, registry import, conformance test. |
| Studio-sound (denoise) | DeepFilterNet3 via CoreML | 8792 | `studio-sound.deepfilternet` (new) | New adapter file `providers/studio-sound/deepfilternet.ts`, registry import, conformance test. |
| Music-gen | — | — | stays `music-gen.mock` | Out of scope — low-value feature, not worth chasing yet. |

### Why STT needs zero adapter code

`stt.homelab-whisper` already speaks an OpenAI-compatible multipart contract over
HTTP to a configurable `baseUrl` (see `packages/core/src/providers/stt/homelabWhisper.ts:78`
and `ETVS_WHISPER_BASE_URL` in `packages/core/src/providerSettings.ts:450`). The
Mac Mini's `whisperx-mlx` server just needs to expose the same endpoint shape. This
is the cheapest part of the migration.

### Memory budget on the Mac Mini (8GB)

STT and TTS are not used concurrently in the actual editing workflow — STT runs at
transcription time, TTS at voice-patch time, denoise at studio-sound-enhance time.
Each server should lazy-load its model on first request and unload after an idle
timeout (a few minutes), rather than holding all three models resident permanently.
DeepFilterNet3 is tiny enough (~10MB, CoreML/Neural Engine, not GPU) to stay
resident without meaningfully affecting the budget.

If lazy-load/unload turns out to be too slow in practice (model load latency on
first request after idle), the fallback is to split further: keep denoise + STT
resident on the Mac Mini, and decide later whether TTS needs to move elsewhere.

## Network and auth

- Use the mDNS hostname `mac-mini.local`, not a static LAN IP — already resolves
  correctly from the MacBook, avoids DHCP-lease churn.
- These servers are now reachable beyond loopback, unlike the implicit
  `127.0.0.1:8789` assumption in the current homelab-whisper default. Each server
  must require a shared-secret bearer/basic-auth token, following the existing
  `WHISPER_BASIC_AUTH` / `ETVS_WHISPER_BASIC_AUTH` pattern already supported end to
  end (`packages/core/src/providers/stt/homelabWhisper.ts`,
  `packages/core/src/providerSettings.ts:470`). Add equivalent secret support for
  the two new servers/adapters.
- macOS firewall on the Mac Mini needs an explicit allow rule for ports 8789/8791/8792
  from the LAN.

## Process management on the Mac Mini

Use `launchd` **LaunchDaemons**, not LaunchAgents — the Mac Mini's account won't
necessarily have an interactive session logged in, and a LaunchDaemon runs
regardless of login state and restarts on crash via `KeepAlive`. Three plists,
one per server, each invoking the server's start command and binding to
`0.0.0.0:<port>` (LAN-only firewall rule + auth token is the actual security
boundary, not bind address).

## Repo-side work (this branch / follow-up PRs)

1. STT: no adapter change. Update local docs/env example to show
   `ETVS_WHISPER_BASE_URL=http://mac-mini.local:8789/v1/audio/transcriptions`.
2. Add `tts.mlx-chatterbox` adapter (`packages/core/src/providers/tts/mlxChatterbox.ts`)
   — HTTP, tier `local`, same shape as `tts/xai.ts` but no per-character cost.
3. Add `studio-sound.deepfilternet` adapter
   (`packages/core/src/providers/studio-sound/deepfilternet.ts`) — HTTP, tier
   `local`, matching the `enhanceAudio` `Buffer`/`mimeType` output contract
   described in `packages/core/src/providers/CONTRACT.md`.
4. Conformance tests for both new adapters
   (`pnpm --filter @etvideoscript/core test -- mediaProviderFramework`).
5. Decide and execute removal/retirement of the four ElevenLabs adapters
   (`tts/elevenlabs.ts`, `stt/elevenlabsScribe.ts`,
   `studio-sound/elevenlabsIsolation.ts`, `music-gen/elevenlabs.ts`) plus their
   tests and Settings UI references — **explicitly held back from this spec**,
   should be a separate confirmed step once the replacements are verified working.

## Mac Mini setup steps (run under the Mac Mini's own account)

1. Install a Python toolchain (`uv` recommended) or the native runtime each server
   needs (`whisperx-mlx`, `mlx-audio`, a DeepFilterNet3 CoreML wrapper).
2. Download model weights: Whisper-large-v3-turbo (MLX), Chatterbox-Turbo
   checkpoint, DeepFilterNet3 CoreML model.
3. Write/vendor three small HTTP server wrappers exposing the contracts above.
4. Create and load three `launchd` `LaunchDaemon` plists (`/Library/LaunchDaemons/`,
   needs `sudo` to install) with `KeepAlive: true`.
5. Add firewall allow rules for 8789/8791/8792 from the LAN.
6. From the MacBook, verify each server: `curl http://mac-mini.local:<port>/health`
   (or equivalent) before pointing the repo's provider settings at them.

## Open questions

- Exact `mlx-audio` Chatterbox-Turbo wrapper: vendor an existing project or write a
  thin FastAPI/Python wrapper ourselves — needs a look at what `mlx-audio` exposes
  out of the box vs. what the `tts.mlx-chatterbox` adapter needs (raw WAV bytes in,
  `audio: Buffer, mimeType` out).
- DeepFilterNet3 CoreML wrapper: same question — `MetalVoice`/`soniqo/speech-swift`
  are reference implementations, not necessarily drop-in servers.
- Final call on deleting vs. disabling-but-keeping the ElevenLabs adapters as a
  fallback path, once the replacements are proven in daily use.
