import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertInside, estimateAudioEnhanceCostUsd, extractAudio, extractClipAudio, ffprobeDurationSec, readSecrets, sourceChannelFixFingerprint, type ManifestV3 } from '@etvideoscript/core';
import type { LocalApiRouteContext } from './routeContext';

/**
 * Compute a cache key for a studio-cleanup run.
 * The key is a SHA-256 over the source audio bytes so that:
 *  - same source + same provider → reuse the existing cleaned asset (no redundant paid call)
 *  - different source (re-imported) → different key → fresh call
 */
function computeSourceHash(sourceAudioPath: string): string {
  const bytes = readFileSync(sourceAudioPath);
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Workspace-relative path for the studio-clean asset.
 * Format: assets/studio-clean/<cacheKey>.wav
 * Each cache key is unique per (source audio, provider) — never overwritten.
 */
function cleanedAssetRel(cacheKey: string): string {
  return `assets/studio-clean/${cacheKey}.wav`;
}

/**
 * Return the workspace-relative path of the project's primary audio file.
 * For a normal ETVideo project this is media/extracted-audio.wav.
 */
function primaryAudioRel(ws: string, manifest: ManifestV3): string {
  // Prefer the legacy top-level extracted audio (processed once, stable).
  const extracted = 'media/extracted-audio.wav';
  if (existsSync(assertInside(ws, extracted))) return extracted;

  // Per-clip layout (current real projects): media/<clipId>/extracted-audio.wav.
  // Pick the clip whose extracted audio is largest (the base/primary recording).
  // Restricted to LIVE clip ids: removing a clip never deletes its media/<clipId>/
  // dir, so an orphaned dir must not be picked as primary — it can no longer be
  // refreshed or re-derived from a manifest clip that no longer exists.
  const liveClipIds = new Set(manifest.tracks.flatMap((track) => track.clips.map((clip) => clip.clipId)));
  const mediaDir = assertInside(ws, 'media');
  if (existsSync(mediaDir)) {
    let best: { rel: string; size: number } | null = null;
    for (const entry of readdirSync(mediaDir)) {
      if (!liveClipIds.has(entry)) continue;
      const candidate = join(mediaDir, entry, 'extracted-audio.wav');
      if (existsSync(candidate)) {
        const size = statSync(candidate).size;
        if (!best || size > best.size) best = { rel: `media/${entry}/extracted-audio.wav`, size };
      }
    }
    if (best) return best.rel;
  }
  throw new Error('Primary audio not found. Run extract-audio first.');
}

export function registerStudioCleanupRoutes(ctx: LocalApiRouteContext) {
  const { app, workspace, loadManifest, saveManifest, validateWorkspaceManifest } = ctx;

  /**
   * POST /api/projects/:projectId/manifest/studio-cleanup
   *
   * Runs ElevenLabs Voice Isolator over the project's base audio and writes the
   * result as `manifest.studioCleanup`.  Content-hash caching: if the same source
   * audio has already been cleaned, the existing asset is reused — no paid call.
   *
   * Body (JSON):
   *   requestId?  string   — client-generated UUID for idempotency
   *
   * Response:
   *   { studioCleanup, manifest, validation, costDisclosure, cached }
   *
   * Paid-services policy (AGENTS.md): configuring ElevenLabs is consent.
   * Disclose estimated cost in every response. No per-call modal.
   *
   * GUARD: if ETVS_PAID_PROVIDER_TEST_MODE=1, the real HTTP call is skipped and
   * a mock WAV is written. This is the gate that prevents paid calls in tests.
   */
  app.post<{ Params: { projectId: string }; Body: { requestId?: string } }>(
    '/api/projects/:projectId/manifest/studio-cleanup',
    async (req, reply) => {
      const { projectId } = req.params;
      const ws = workspace(projectId);

      // Resolve ElevenLabs secret first — fail fast before any I/O.
      const settingsPaths = { homeDir: ctx.config.settingsHome };
      const secret = readSecrets(settingsPaths).secrets.elevenlabs;
      // Fail CLOSED on paid calls: explicit test-mode flag OR any Vitest run forces
      // the mock path, so a test that happens to have an EL secret configured but
      // forgets ETVS_PAID_PROVIDER_TEST_MODE can never burn a real paid call (hermes P1).
      const testMode = process.env.ETVS_PAID_PROVIDER_TEST_MODE === '1' || !!process.env.VITEST;
      if (!secret && !testMode) {
        return reply.code(400).send({ error: 'No ElevenLabs API key configured. Set it in Settings > Providers.' });
      }

      // Identify source audio.
      let primaryAudio: string;
      try {
        primaryAudio = primaryAudioRel(ws, loadManifest(ws));
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }

      const sourceAudioAbs = assertInside(ws, primaryAudio);

      // Content-hash cache check (inside the manifest mutex so the cache check +
      // asset write + manifest update are atomic with respect to other mutations).
      return ctx.withProjectManifestMutex(projectId, async () => {
        // Refresh the source audio in place FIRST if it's stale relative to the current
        // channel-fix state (issue #3) — otherwise this hashes (and potentially pays for
        // cleaning) bytes mixed for a fix state that's no longer current. extractAudio/
        // extractClipAudio are self-freshening (channelFixSidecarFresh) and cheap/local/
        // non-paid, so this is always safe to run before every studio-cleanup call.
        const clipAudioMatch = /^media\/([^/]+)\/extracted-audio\.wav$/.exec(primaryAudio);
        try {
          if (primaryAudio === 'media/extracted-audio.wav') {
            await extractAudio(ws, { overwrite: false, logJob: false });
          } else if (clipAudioMatch) {
            await extractClipAudio(ws, clipAudioMatch[1]!, { overwrite: false, logJob: false });
          }
        } catch {
          // Refresh is best-effort: primaryAudioRel already confirmed audio bytes exist
          // on disk, so a missing input/source.mp4 or a clip removed since extraction
          // just means cleanup proceeds against the bytes already there.
        }

        // Duration/cost must be probed AFTER the refresh above — the refresh can rewrite
        // sourceAudioAbs's bytes, so probing before would let cost disclosure and the
        // response duration-deviation check (below) validate a paid call's result against
        // stale pre-refresh bytes, risking a false 502 after money was already spent.
        const durationSec = (() => {
          try { return ffprobeDurationSec(sourceAudioAbs); }
          catch { return 0; }
        })();
        const costUsd = estimateAudioEnhanceCostUsd('elevenlabs-isolation', durationSec);
        const costDisclosure = `ElevenLabs Voice Isolator — ~$${costUsd.toFixed(2)} for ${Math.round(durationSec)}s of audio`;

        const cacheKey = computeSourceHash(sourceAudioAbs);
        const assetRel = cleanedAssetRel(cacheKey);
        const assetAbs = assertInside(ws, assetRel);

        const current = loadManifest(ws);
        const existing = current.studioCleanup;

        // Value fingerprint of the channel-mix state baked into sourceAudioAbs right now
        // (post-refresh above) — recorded on the cleanup so buildRenderPlan can detect a
        // LATER fix change without relying on timestamp ordering (issue #3/#9/#11). Computed
        // BEFORE the idempotency check below so a byte-identical fix transition (e.g.
        // disabling a forced fix that had no effect on duplicated-channel audio) still
        // restamps the changed fingerprint via the cache-hit branch, instead of an
        // unconditional cacheKey match returning the stale fingerprint forever.
        const audioChannelFixFingerprint = sourceChannelFixFingerprint(current);

        // Idempotency: if the manifest already has an approved/pending cleanup with this
        // cache key AND fingerprint, return immediately without re-running the isolator.
        if (existing && existing.cacheKey === cacheKey && existing.audioChannelFixFingerprint === audioChannelFixFingerprint && (existing.status === 'approved' || existing.status === 'pending')) {
          return { studioCleanup: existing, manifest: current, validation: validateWorkspaceManifest(ws), costDisclosure, cached: true };
        }

        // Cache hit: asset already on disk from a prior run.
        if (existsSync(assetAbs)) {
          const cleanup = { status: 'approved' as const, assetPath: assetRel, cacheKey, provider: 'studio-sound.elevenlabs-isolation', createdAt: new Date().toISOString(), costUsd, audioChannelFixFingerprint };
          const next = { ...current, studioCleanup: cleanup };
          saveManifest(ws, next);
          return { studioCleanup: cleanup, manifest: loadManifest(ws), validation: validateWorkspaceManifest(ws), costDisclosure, cached: true };
        }

        // Paid call — guarded by ETVS_PAID_PROVIDER_TEST_MODE in tests.
        let cleanedBytes: Buffer;
        let providerId: string | undefined;
        if (testMode) {
          // Test mode: write a minimal valid WAV without calling EL.
          cleanedBytes = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x40\x1f\x00\x00\x80\x3e\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00', 'binary');
          providerId = 'test-mode';
        } else {
          // Real ElevenLabs Voice Isolator call.
          // POST https://api.elevenlabs.io/v1/audio-isolation
          // multipart/form-data, field "audio", header "xi-api-key".
          const sourceBytes = readFileSync(sourceAudioAbs);
          const form = new FormData();
          form.append('audio', new Blob([sourceBytes as unknown as BlobPart], { type: 'audio/wav' }), 'source.wav');
          const response = await fetch('https://api.elevenlabs.io/v1/audio-isolation', {
            method: 'POST',
            headers: { 'xi-api-key': secret! },
            body: form
          });
          if (!response.ok) {
            const body = await response.text();
            return reply.code(502).send({ error: `ElevenLabs Voice Isolator failed (HTTP ${response.status}): ${body.slice(0, 400)}` });
          }
          const raw = Buffer.from(await response.arrayBuffer());

          // Degraded-payload defense: probe duration, transcode if needed.
          // EL returns audio/mpeg or audio/wav depending on the source format.
          // Always normalize to 48k mono WAV for downstream compatibility.
          if (raw.byteLength < 44) {
            return reply.code(502).send({ error: `ElevenLabs Voice Isolator returned implausibly small response (${raw.byteLength} bytes).` });
          }
          // Transcode to WAV if response is not already RIFF/WAVE.
          if (raw.subarray(0, 4).toString('binary') === 'RIFF' && raw.subarray(8, 12).toString('binary') === 'WAVE') {
            cleanedBytes = raw;
          } else {
            // Transcode mp3/other → 48 kHz mono pcm_s16le WAV via ffmpeg.
            const { spawnSync } = await import('node:child_process');
            const os = await import('node:os');
            const path = await import('node:path');
            const tmpDir = os.tmpdir();
            const tmpIn = path.join(tmpDir, `el-iso-in-${Date.now()}.bin`);
            const tmpOut = path.join(tmpDir, `el-iso-out-${Date.now()}.wav`);
            writeFileSync(tmpIn, raw);
            const result = spawnSync('ffmpeg', ['-y', '-i', tmpIn, '-ar', '48000', '-ac', '1', '-acodec', 'pcm_s16le', tmpOut], { encoding: 'utf8' });
            if (result.status !== 0) {
              return reply.code(502).send({ error: `Transcode of EL isolation response failed: ${(result.stderr ?? '').slice(0, 300)}` });
            }
            cleanedBytes = readFileSync(tmpOut);
          }

          // Probe cleaned duration — must be within 10 % of source to be usable.
          // ESM-safe: this package is `type: module`, so `require` is undefined at
          // runtime — use dynamic import like the transcode block above (codex P1).
          let cleanedDuration: number;
          try {
            const { spawnSync } = await import('node:child_process');
            const os = await import('node:os');
            const path = await import('node:path');
            const tmpProbe = path.join(os.tmpdir(), `probe-${Date.now()}.wav`);
            writeFileSync(tmpProbe, cleanedBytes);
            const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', tmpProbe], { encoding: 'utf8' });
            cleanedDuration = Number((r.stdout ?? '').trim());
          } catch { cleanedDuration = 0; }
          if (!Number.isFinite(cleanedDuration) || cleanedDuration < 0.1) {
            return reply.code(502).send({ error: `ElevenLabs Voice Isolator returned implausibly short audio (${(cleanedDuration * 1000).toFixed(0)} ms). Rejected.` });
          }
          // Length-preservation check (hermes P1): the Isolator returns a same-duration
          // file. A cleaned WAV that deviates >10% from the source is truncated/corrupt —
          // approving it would make the render swap long source ranges against a short WAV
          // (silence / wrong audio / ffmpeg failure). Reject before writing approved state.
          if (durationSec > 0 && Math.abs(cleanedDuration - durationSec) / durationSec > 0.1) {
            return reply.code(502).send({ error: `ElevenLabs Voice Isolator returned ${cleanedDuration.toFixed(2)}s for a ${durationSec.toFixed(2)}s source (>10% deviation). Rejected as truncated/corrupt.` });
          }

          providerId = `el-iso-${Date.now()}`;
        }

        // Write asset — never overwrite (fresh id per generation via cacheKey).
        mkdirSync(dirname(assetAbs), { recursive: true });
        writeFileSync(assetAbs, cleanedBytes);

        const cleanup = {
          status: 'approved' as const,
          assetPath: assetRel,
          cacheKey,
          provider: 'studio-sound.elevenlabs-isolation',
          ...(providerId ? { providerId } : {}),
          createdAt: new Date().toISOString(),
          costUsd: testMode ? 0 : costUsd,
          audioChannelFixFingerprint
        };
        const next = { ...current, studioCleanup: cleanup };
        saveManifest(ws, next);
        return {
          studioCleanup: cleanup,
          manifest: loadManifest(ws),
          validation: validateWorkspaceManifest(ws),
          costDisclosure,
          cached: false
        };
      });
    }
  );

  /**
   * DELETE /api/projects/:projectId/manifest/studio-cleanup
   *
   * Sets studioCleanup.status to 'disabled'. The cleaned asset is retained on
   * disk — the change is fully reversible by re-POSTing (cache hit = free).
   */
  app.delete<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/manifest/studio-cleanup',
    async (req) => {
      const { projectId } = req.params;
      const ws = workspace(projectId);
      return ctx.withProjectManifestMutex(projectId, async () => {
        const current = loadManifest(ws);
        if (!current.studioCleanup) {
          return { studioCleanup: null, manifest: current, validation: validateWorkspaceManifest(ws) };
        }
        const cleanup = { ...current.studioCleanup, status: 'disabled' as const };
        const next = { ...current, studioCleanup: cleanup };
        saveManifest(ws, next);
        return { studioCleanup: cleanup, manifest: loadManifest(ws), validation: validateWorkspaceManifest(ws) };
      });
    }
  );
}
