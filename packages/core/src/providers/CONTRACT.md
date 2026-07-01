# Media Provider Contract

Provider support lives in `@etvideoscript/core/src/providers`. Adapters are deliberately small: they call a provider and return typed output. Per-kind public APIs own all domain writes.

## Layout

- `contract.ts` — `HttpMediaProvider`, `LocalMediaProvider`, `ProviderRunEnvelope`, cost/error types, optional `ledgerOutput`.
- `registry.ts` — adapter registration and lookup keyed by full provider id, e.g. `tts.xai`, `stt.homelab-whisper`, `studio-sound.ffmpeg-local`.
- `engine.ts` — internal `runProvider` orchestration, settings/secret resolution, ledger rows, timeout/error mapping.
- `localCommand.ts` — shared async local-exec helper for Local adapters that need binaries.
- `tts/`, `stt/`, `studio-sound/`, `image-gen/`, `video-gen/`, `music-gen/` — same-kind adapter directories.
  - `tts.mlx-chatterbox` / `studio-sound.deepfilternet` — local-tier HTTP adapters for the
    self-hosted Mac Mini inference stack (see `docs/specs/local-inference-stack.md`); same
    shape as `stt.homelab-whisper` below.
- `generationTypes.ts` — shared generated-media input/output types (`Buffer` + MIME + optional duration).
- `../network/guardedFetch.ts` — node-only `undici` fetch wrapper with DNS pinning, redirect validation, timeout, and SSRF checks.

## Provider ids and registration

Provider ids are stable `<kind>.<name>` slugs. The id prefix must match `kind`. Add the adapter import to `providers/index.ts` so registration happens at module load.

Same-kind provider = 1 adapter file + 1 registry/import line + 1 conformance test. New provider kind = kind schema/settings support + adapter type + per-kind public API + registry import + tests/docs.

## HTTP vs Local adapters

`HttpMediaProvider` receives `provider`, `requestId`, `signal`, `guardedFetch`, and `secret` resolved from `provider.secretRef`.

`LocalMediaProvider` receives `provider`, `requestId`, `signal`, `spawn`, `workspacePath`, and an engine-owned `tempDir`.

Adapters must never write transcript, manifest, project state, or final asset files. They return provider output only. Local adapters that write scratch files must write under `context.tempDir` and return a `Buffer`; the engine deletes `tempDir` before the public function returns.

Adapters may expose `availableModels?: readonly string[]` for Settings defaults; this is a static UI list, not runtime model resolution.

## Ledger lifecycle and `ledgerOutput`

`runProvider` is internal. It writes generic provider-request ledger rows only:

1. `started` before adapter execution.
2. `succeeded` with redacted/summarized output and actual cost when the adapter returns.
3. `failed` with redacted error metadata when the adapter throws.

Adapters may define `ledgerOutput(output, input)` to prevent large or sensitive typed output from entering `logs/provider-requests.jsonl`. The engine also applies a bounded serializer fallback (~8KB) and redacts `Bearer ...`, `Basic ...`, URL credentials, query secrets, and secret-looking keys.

STT adapters must summarize transcript output: `{ wordCount, segmentCount, durationSec, timing }`, not raw Whisper JSON or word arrays.

## Error envelope

Provider failures map to `ProviderErrorEnvelope` fields: `code`, `message`, `problem`, `cause`, `fix`, `providerId`, `requestId`, optional `statusCode`, optional `details`. Public per-kind APIs throw `ProviderEnvelopeError` for failed provider envelopes so callers can keep structured data; human output may print `problem/cause/fix`.

Codes: `provider_auth_failed`, `ssrf_blocked`, `provider_timeout`, `provider_bad_request`, `provider_unavailable`, `model_missing`, `provider_not_found`, `provider_disabled`, `invalid_settings`.

## TTS public API

`synthesizeSpeech(workspacePath, input)` calls `runProvider`, writes returned audio into `assets/voice/...`, and returns the asset path/request id. `synthesizeReplacementSpeech` remains the voice-patch compatibility wrapper.

## STT public API

`transcribeAudio(workspacePath, input)` is the STT public API. Inputs:

- `provider?: 'mock' | 'homelab-whisper' | 'whisper' | 'stt.<name>'`
- `clipId?` for per-clip transcription
- `mockText?`
- `env?`, `homeDir?`, `etvsDir?`, `requestId?`, `projectId?`

It normalizes bare provider ids at the `runProvider` boundary only, calls `runProvider({ kind: 'stt' })`, parses Whisper JSON into `TranscriptWords`, then writes `transcript/words.json` and `transcript/transcript.md` (or `transcript/<clipId>/...`). `transcribeMock`, `transcribeHomelabWhisper`, `transcribeClip`, and `transcribeAllClips` are thin wrappers.

Whisper no-word-timestamps is a domain decision: the provider call succeeded, so the engine writes `started` + `succeeded`; `transcribeAudio` then throws unless `ALLOW_APPROXIMATE_TRANSCRIPT`, `ETVS_ALLOW_APPROXIMATE_TRANSCRIPT`, or `ETVIDEO_ALLOW_APPROXIMATE_TRANSCRIPT` is `1`.

`WHISPER_BASIC_AUTH` / `ETVS_WHISPER_BASIC_AUTH` is raw env, not a `secretRef`; `transcribeAudio` passes it through typed input and the adapter sets `Authorization: Basic ...`.

## Studio-sound public API

`enhanceAudio(workspacePath, input)` is the studio-sound public API. Inputs include `inputPath`, `op`, `clipSourceSha256`, `durationSec`, plus optional settings/env/test transport fields.

Manifest/cache/render surfaces stay bare (`ffmpeg-local`, `adobe-enhance`, `elevenlabs-isolation`, `deepfilternet`). The public function normalizes to full ids only at the engine boundary (`studio-sound.<name>`), checks `assets/enhanced/<cacheKey>.wav` before any provider call, discloses paid cost to stderr before paid calls, calls `runProvider({ kind: 'studio-sound' })`, then writes the returned `Buffer` to `assets/enhanced/<cacheKey>.wav`.

`materializeAudioEnhance` is a compatibility wrapper. It validates the requested output path stays inside the workspace and delegates to `enhanceAudio`.

`studio-sound-default.json` is legacy read-through only. Defaults now live in the provider registry via `resolveProviderForKind('studio-sound')`; if the old file exists and the registry has no default, `readStudioSoundDefaultProvider` migrates it into the registry and stops writing the old file.

## Generation public API

`generateMedia(workspacePath, input)` supports `kind: 'image-gen' | 'video-gen' | 'music-gen'`. It calls `runProvider`, writes exactly one generated file under `assets/generated/<kind>/`, probes duration/stream metadata for video/audio outputs, and returns an Asset-ready result. It does not mutate the manifest.

The v3 generation gate is ledger-backed, not operation-backed: paid create routes append one `pending` row to `logs/provider-requests.jsonl` and do not call the provider. The approve route appends `approved`, starts a background `generate-media` job, and that job runs the paid adapter; `runProvider` then appends `started` and `succeeded`/`failed`. On success the route adds a `provenance:'generated'` Asset to the media bin. Reject appends `rejected` and creates no Asset.

Adapters shipped in this slice:

- `image-gen.mock` — local ffmpeg JPEG.
- `image-gen.xai` — `POST https://api.x.ai/v1/images/generations`, `grok-imagine-image`, `response_format:'b64_json'`.
- `video-gen.mock` — local ffmpeg MP4.
- `video-gen.xai` — `POST https://api.x.ai/v1/videos/generations`, then `GET /v1/videos/{request_id}` polling and final MP4 download.
- `music-gen.mock` — local WAV tone.
- `music-gen.elevenlabs` — `POST https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128`, `model_id:'music_v1'`, auth via `xi-api-key`.

ElevenLabs credential reuse: `music-gen.elevenlabs` uses the same provider registry/secretRef mechanism as `studio-sound.elevenlabs-isolation`. Users may point both provider records at the same `secretRef`; there is no separate env var or parallel credential path.

## Worked Local adapter example: `studio-sound.ffmpeg-local`

```ts
export const studioSoundFfmpegLocalProvider = registerProvider({
  id: 'studio-sound.ffmpeg-local',
  kind: 'studio-sound',
  tier: 'local',
  mode: 'local',
  displayName: 'FFmpeg Local',
  estimateCost: () => ({ currency: 'USD', estimated: 0, actual: 0 }),
  ledgerOutput: (output) => ({ audio: { type: 'Buffer', bytes: output.audio.byteLength }, mimeType: output.mimeType }),
  async run(input, context) {
    const outputPath = join(context.tempDir, 'enhanced.wav');
    await runLocalCommand(context, 'ffmpeg', ['-y', '-i', input.inputPath, '-af', '...', outputPath]);
    return { audio: readFileSync(outputPath), mimeType: 'audio/wav' as const };
  }
});
```

The adapter writes only to `context.tempDir`; `enhanceAudio` writes the final `assets/enhanced/...` file.

## Conformance tests

Run:

```bash
pnpm --filter @etvideoscript/core test -- mediaProviderFramework
pnpm --filter @etvideoscript/core test -- guardedFetch
```

Conformance checks: full id/kind match, adapter mode is `http` or `local`, cost estimation accepts a per-kind sample input, `runProvider` writes generic ledger rows with cost, errors map to actionable redacted envelopes, SSRF blocks paid private/rebinding/cross-host redirects while local-tier loopback remains usable.
