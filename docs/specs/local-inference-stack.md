# Spec: self-hosted inference stack on the Mac Mini (ElevenLabs replacement)

Status: implemented on the reference deployment — all three servers built,
launchd-managed, and reachable over Tailscale; repo-side adapters merged. See
"Status" below for what's left (optional integrations, ElevenLabs retirement).
Owner: whoever runs the homelab inference box for their own ETVideoScript setup.
Last updated: 2026-07-01.

> **Setup note:** this spec describes a pattern, not one fixed machine/account.
> Replace `<host-user>` (the macOS account running the servers), `<mac-mini-host>`
> / `<macbook-host>` (Tailscale device names), and `<tailnet>` (your Tailscale
> account/tailnet name) with your own values throughout as you configure your own
> box. **Delete this note once you've done that** — it's setup guidance, not a
> permanent part of the spec.

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

**Correction (2026-07-01):** the reference box this was built against actually
has **16GB RAM**, not 8GB as originally assumed (check with `sysctl hw.memsize`
on yours), and the work was run directly on it under the host's own account
rather than over SSH to a separate one. At 16GB all three models can stay
resident permanently — no lazy-load/unload scheme is needed (see "Memory budget"
below, superseded). If your box is closer to 8GB, revisit that section.

## Target architecture

Three small local HTTP servers on the Mac Mini, each a thin wrapper around an
open-source model, reachable from the MacBook over **Tailscale** (not plain LAN —
see "Network and auth" below). `@etvideoscript/core`'s provider registry already
supports this shape — local-tier HTTP adapters with a configurable `baseUrl` —
this is the same pattern `stt.homelab-whisper` already uses today.

| Capability | Model | Port | Repo provider id | Code change needed | Status |
|---|---|---|---|---|---|
| STT | mlx-whisper (`whisper-large-v3-turbo`) + whisperx wav2vec2 forced alignment | 8789 | `stt.homelab-whisper` (unchanged) | **None** — server implements the existing OpenAI-compatible `POST /v1/audio/transcriptions` contract (`response_format=verbose_json`, `timestamp_granularities[]=word`), so the existing adapter (`packages/core/src/providers/stt/homelabWhisper.ts`) works as-is. Point `ETVS_WHISPER_BASE_URL` at the Tailscale address (see "Using the servers"). | **Built + verified.** Real word-level timestamps confirmed; non-English audio falls back to segment-level `"timing":"approximate"`; a silence-hallucination bug in mlx-whisper ("Thank you." on pure digital silence) found and fixed with an RMS energy pre-check. |
| TTS / voice cloning | Chatterbox via `mlx-audio` (Blaizzy/mlx-audio) | 8791 | `tts.mlx-chatterbox` (new) | New adapter file `providers/tts/mlxChatterbox.ts`, registry import, conformance test. | **Built + verified.** Voice cloning confirmed genuine (different reference clips produce measurably different output) from the reference *audio* alone — Chatterbox's actual `generate()` API has **no `ref_text` parameter**, contrary to the original assumption below. |
| Studio-sound (denoise) | DeepFilterNet3 (plain PyTorch, not CoreML — see below) | 8792 | `studio-sound.deepfilternet` (new) | New adapter file `providers/studio-sound/deepfilternet.ts`, registry import, conformance test. | **Built + verified.** Clean install once pinned to Python 3.11 + `torch`/`torchaudio` 2.1.2 (newer torchaudio dropped a module `df/io.py` needs) — no Rust toolchain build required. |
| Music-gen | — | — | stays `music-gen.mock` | Out of scope — low-value feature, not worth chasing yet. | Not started. |

### Why STT needs zero adapter code

`stt.homelab-whisper` already speaks an OpenAI-compatible multipart contract over
HTTP to a configurable `baseUrl` (see `packages/core/src/providers/stt/homelabWhisper.ts:78`
and `ETVS_WHISPER_BASE_URL` in `packages/core/src/providerSettings.ts:450`). The
Mac Mini's `whisperx-mlx` server just needs to expose the same endpoint shape. This
is the cheapest part of the migration.

### Memory budget on the Mac Mini (16GB, corrected)

STT and TTS are not used concurrently in the actual editing workflow — STT runs at
transcription time, TTS at voice-patch time, denoise at studio-sound-enhance time.
At the corrected 16GB figure, **all three models stay resident permanently** (no
lazy-load/unload) — affordable on an otherwise-idle, single-purpose box, and it
eliminates first-request cold-load latency entirely. Revisit only if Activity
Monitor shows real swap/memory-pressure under daily use.

## Network and auth (superseded — Tailscale-only, no LAN-plaintext path)

An earlier draft of this section planned LAN reachability at `mac-mini.local` with
a firewall allow-rule as the perimeter and basic-auth as the only secret. **That
plan was revised before implementation** after a two-model review (Opus + Codex)
both independently flagged it as the standout security problem: HTTP basic-auth
over plain LAN traffic on a `0.0.0.0` bind is crackable by anything on the same
network — Tailscale's encryption only covers its own interface, not the LAN one.

**What's actually running instead:**
- All three servers bind to **`127.0.0.1` only** — never reachable except through
  a deliberate proxy.
- **Tailscale** (WireGuard mesh, MagicDNS) is up between the Mac Mini
  (`<mac-mini-host>`) and the MacBook (`<macbook-host>`), both on the same
  tailnet — confirmed connected via `tailscale ping` (direct LAN path when on the
  same network, automatically falls back to relay/DERP when traveling, no config
  change needed either way).
- **Tailnet ACL locked down** (pasted into the admin console at
  `https://login.tailscale.com/admin/acls/file`, replacing the default allow-all):
  only a device tagged `tag:etvs-client` (the MacBook) can reach a device tagged
  `tag:etvs-server` (this Mac Mini), and only on ports 8789/8791/8792. Nothing else
  — no SSH, no Taildrop, no other port, no other device gets default access. Apple's
  own AirDrop is unaffected (Bluetooth/AWDL, not IP-routed, so untouched by this).
- Each server requires `Authorization: Bearer <token>` (a single shared static
  token, generated once, kept in a chmod-600 file) on every route except `/health`
  — this travels the existing `basicAuth`-named field on the homelab-whisper
  adapter and the same convention on the two new adapters; the field name is
  legacy, the value is a raw `Bearer ...` header, not actual HTTP Basic encoding.
- Once the launchd daemons (below) are running, `tailscale serve` exposes each
  loopback-bound port onto the tailnet with a real MagicDNS TLS cert, so even the
  bearer token travels encrypted end-to-end — no separate plaintext fallback to
  misconfigure.

## Process management

Use `launchd` **LaunchAgents** (user-level, `~/Library/LaunchAgents/`), not
LaunchDaemons — a lighter-touch call made once the servers were actually working:
LaunchDaemons need root to install (`/Library/LaunchDaemons/` + `launchctl
bootstrap system`) in exchange for one property — surviving a reboot without a
logged-in session — that only matters if the box doesn't auto-login and isn't
normally left logged in anyway. Check both before choosing:
```bash
last -1 reboot                                              # how long since last reboot
defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>&1   # auto-login configured?
```
If the box is effectively always logged in in practice (the common case for a
dedicated homelab machine that isn't rebooted often), a LaunchAgent gets the same
practical reliability with zero `sudo` needed for install — just `launchctl
bootstrap gui/<uid> <plist>` under the host's own account, no root, no privilege
escalation for a process that only needs to bind loopback anyway. If your box
really does sit at the login screen after a reboot, use a LaunchDaemon instead
(same plist shape, plus `UserName`/`GroupName` set to the host's account so root
doesn't own the ML processes, installed under `/Library/LaunchDaemons/`).

Either way: three plists, one per server, binding `127.0.0.1` only (see "Network
and auth" above — there's nothing to firewall on the LAN interface since these
never bind to it), `KeepAlive`/`RunAtLoad` true, `HOME`/`PATH` set explicitly in
`EnvironmentVariables`.

## Repo-side work (this branch / follow-up PRs)

1. STT: no adapter change. Update local docs/env example to show
   `ETVS_WHISPER_BASE_URL=https://<mac-mini-host>.<tailnet>.ts.net:8789/v1/audio/transcriptions`
   (or `http://127.0.0.1:8789/...` for same-machine testing).
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

## Status (2026-07-01)

Done:
- Tailscale installed and connected between the Mac Mini and the MacBook, ACL
  locked to the three model ports only (see "Network and auth").
- All three servers built, dependency-pinned, and curl-verified end to end
  (health-readiness, auth success/failure, malformed-input rejection, oversized-
  input rejection) under `~/etvs-inference/{stt,tts,denoise}-server/`.
- The two new repo-side adapters (`tts/mlxChatterbox.ts`,
  `studio-sound/deepfilternet.ts`) and their conformance tests, per the table above.
- Installed the three servers as `launchd` LaunchAgents (see "Process management")
  so they survive terminal/session churn without needing `sudo`.

Remaining:
- `tailscale serve` exposure — requires a one-time, account-level "Serve/HTTPS"
  toggle in the Tailscale admin console before `tailscale serve --bg --https=<port>
  http://127.0.0.1:<port>` will work (it errors with "Serve is not enabled on your
  tailnet" until that's flipped). Do this once per tailnet, then run the three
  `tailscale serve` commands and verify from the client device.
- ElevenLabs adapter retirement (still explicitly out of scope for this pass).
- Optional integrations (voice-message handling, local dictation — see below),
  not yet built.

## Using the servers

**Manual start (current state, until the launchd daemons land):**
```bash
cd ~/etvs-inference/stt-server     && ETVS_STT_TOKEN=<token>     .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8789 &
cd ~/etvs-inference/tts-server     && ETVS_TTS_TOKEN=<token>     .venv/bin/uvicorn server:app --host 127.0.0.1 --port 8791 &
cd ~/etvs-inference/denoise-server && ETVS_DENOISE_TOKEN=<token> .venv/bin/python server.py &
```
Each prints a random token at startup if the env var is unset — useful for ad hoc
testing, but use a real generated token (`openssl rand -hex 32`) for anything
persistent.

**Contracts (all require `Authorization: Bearer <token>` except `/health`):**
```bash
# STT — word-level transcript
curl -F file=@clip.wav -F response_format=verbose_json -F "timestamp_granularities[]=word" \
  -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8789/v1/audio/transcriptions

# TTS — voice cloning from a reference clip dropped at ~/models/voices/<voice>.wav
# (voice slug must match ^[a-z0-9][a-z0-9-]{0,63}$ — no ref_text file needed, see table above)
curl -F text="hello world" -F voice=default -F language=en \
  -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8791/v1/tts -o out.wav

# Denoise
curl -F file=@noisy.wav -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8792/v1/enhance -o clean.wav
```

**From the MacBook**, once `tailscale serve` is live, swap `127.0.0.1` for the
Tailscale MagicDNS name (`https://<mac-mini-host>.<tailnet>.ts.net:<port>`) —
this works identically whether on the home LAN or traveling, since both routes go
through Tailscale and the ACL only allows the tagged client device through anyway.

## Integration ideas (not yet built, optional, environment-specific)

These are ideas for a particular operator's own setup, not something every user
of this stack needs — include only if relevant to your own environment.

**Chat-bot / agent-gateway voice handling.** If you run a local Telegram bot or
agent gateway on the same box (e.g. something bridging chat messages to a local
Claude Code session), wiring it to call `127.0.0.1:8789`/`8791` directly for
voice-message transcription/replies adds no new network exposure — it's one
local process calling another. Before wiring anything like this up: confirm
whatever bot/gateway you're using only accepts messages from your own chat
ID/account — if it's reachable by anyone who finds it, that's an independent
exposure question worth closing first, separate from anything in this spec.

**Local dictation into Claude Code.** Lowest-friction path: macOS Shortcuts.app's
built-in global-hotkey support (no extra app install) bound to a small script
that records a few seconds via `ffmpeg`'s `avfoundation` mic input, POSTs to
`127.0.0.1:8789/v1/audio/transcriptions`, and pastes the transcript into the
focused window (clipboard + simulated paste). Not yet built.

## Resolved questions

- ~~Exact `mlx-audio` Chatterbox wrapper~~ — resolved: `mlx_audio.tts.utils.load_model("mlx-community/chatterbox-fp16")`
  + `model.generate(text=..., audio_prompt=<mx.array>, audio_prompt_sr=..., lang_code=...)`,
  a generator yielding `GenerationResult(audio, sample_rate)`. No `ref_text` param exists.
  MLX binds its GPU command stream to the thread that first touches it, so all
  model load + generation calls must run on a single dedicated worker thread, not
  the default async thread pool (`asyncio.to_thread` throws otherwise).
- ~~DeepFilterNet3 CoreML wrapper~~ — resolved by **not** doing a CoreML
  conversion: the referenced projects (`MetalVoice`/`soniqo/speech-swift`) are
  reference implementations, not installable packages, and a real PyTorch→CoreML
  conversion is multi-day work with real conversion-fidelity risk. Plain
  `deepfilternet` (PyTorch-backed) ships a working server today and runs
  comfortably faster than realtime on the M4; CoreML conversion is a possible
  later optimization, not a blocker.
- Still open: final call on deleting vs. disabling-but-keeping the ElevenLabs
  adapters as a fallback path, once the replacements are proven in daily use.
