import { addAssetV3, addClipV3, addTrackV3, appendJobStatus, appendProviderRequestEvent, assertInside, canonicalProviderId, extractClipAudio, ffprobe, generateMedia, getProvider, latestProviderRequest, loadProject, loadTranscript, mergeTranscripts, probeRecordingMedia, ProviderRequestIdSchema, readProviderRequests, resolveProviderForKind, saveProject, sha256File, transcribeClip, type GenerateMediaKind, type GenerateMediaResult, type ProviderCost, type ProviderRecord, type RecordingProbe } from '@etvideoscript/core';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { basename, resolve } from 'node:path';
import type { LocalApiRouteContext } from './routeContext';

type UploadStage = { name: string; status: 'queued' | 'waiting_for_approval' | 'running' | 'succeeded' | 'failed' | 'cancelled'; startedAt?: string; completedAt?: string; error?: string; clipId?: string; phase?: string; percent?: number };

export function registerAssetRoutes(ctx: LocalApiRouteContext) {
  const { app, workspace, maxUploadBytes, withProjectManifestMutex, withInFlightProviderCall, updateStage, loadManifest, saveManifest, validateWorkspaceManifest, contentType, parseRange, errorMessage } = ctx;

  function nextClipId(ws: string): string {
    const roots = ['assets/video', 'assets/recordings'].map((rel) => assertInside(ws, rel));
    const max = roots.flatMap((root) => existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []).flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      const match = /^clip_(\d+)$/.exec(entry.name);
      return match ? [Number(match[1])] : [];
    }).reduce((highest, value) => Math.max(highest, value), 0);
    return `clip_${String(max + 1).padStart(3, '0')}`;
  }

  function extForMime(mime: string): string {
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('wav')) return 'wav';
    if (mime.includes('mpeg')) return 'mp3';
    if (mime.includes('matroska')) return 'mkv';
    return 'mp4';
  }

  function remuxRecording(raw: string, output: string) {
    const result = spawnSync('ffmpeg', ['-y', '-i', raw, '-c', 'copy', output], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`ffmpeg remux failed: ${result.stderr || result.stdout}`);
  }

  function asUnprocessableMediaError(err: unknown) {
    return Object.assign(err instanceof Error ? err : new Error(String(err)), { statusCode: 422 });
  }

  const generationKinds = new Set<GenerateMediaKind>(['image-gen', 'video-gen', 'music-gen']);

  function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    return JSON.stringify(value);
  }

  function generationBodyHash(input: Record<string, unknown>): string {
    return createHash('sha256').update(canonicalJson(input)).digest('hex');
  }

  function providerRequestBodyHash(ws: string, requestId: string): string | undefined {
    return (readProviderRequests(ws).find((event: any) => event.requestId === requestId && typeof event.bodyHash === 'string') as { bodyHash?: string } | undefined)?.bodyHash;
  }

  /** STRICT variant, for the pre-call replay gate — see its call site. */
  function providerRequestBodyHashStrict(ws: string, requestId: string): string | undefined {
    return (readProviderRequests(ws, { strict: true }).find((event: any) => event.requestId === requestId && typeof event.bodyHash === 'string') as { bodyHash?: string } | undefined)?.bodyHash;
  }


  function parseGenerationBody(body: any): { kind: GenerateMediaKind; prompt: string; provider?: string; requestId?: string; count?: number; aspectRatio?: string; resolution?: string; durationSec?: number; durationMs?: number; model?: string } | { error: string } {
    const kind = String(body?.kind ?? '') as GenerateMediaKind;
    if (!generationKinds.has(kind)) return { error: 'kind must be image-gen, video-gen, or music-gen' };
    const prompt = String(body?.prompt ?? '').trim();
    if (!prompt) return { error: 'prompt is required' };
    // The provider is VALIDATED here, not coerced. `String(body.provider)` turned
    // `{"provider":["xai"]}` into the real, PAID id 'xai' and ran the generation — the free GET
    // /estimate failed closed while the POST that spends money did not. canonicalProviderId
    // owns both the absent rule and the non-string rejection; the raw shorthand is what we keep,
    // because generationBodyHash feeds idempotency and canonicalising it here would change the
    // hash of every previously-recorded request.
    //
    // VALIDATE, then assign the ORIGINAL nullish/raw value — do not fold `''` into `undefined`.
    // The stored body is hashed for idempotency, and canonicalJson omits `undefined` while
    // keeping `""`, so collapsing an explicit empty-string provider would change the hash of
    // every already-recorded request that carried one: its retry would 409 on a body-mismatch
    // instead of replaying the result it is entitled to. Validation is what changed here; the
    // hashed shape is byte-for-byte what it was.
    try { canonicalProviderId(kind, body?.provider); }
    catch (err) { return { error: err instanceof Error ? err.message : 'invalid provider' }; }
    const provider: string | undefined = body?.provider == null ? undefined : (body.provider as string);
    return {
      kind,
      prompt,
      provider,
      requestId: body?.requestId == null ? undefined : String(body.requestId),
      count: body?.count == null ? undefined : Number(body.count),
      aspectRatio: body?.aspectRatio == null ? undefined : String(body.aspectRatio),
      resolution: body?.resolution == null ? undefined : String(body.resolution),
      durationSec: body?.durationSec == null ? undefined : Number(body.durationSec),
      durationMs: body?.durationMs == null ? undefined : Number(body.durationMs),
      model: body?.model == null ? undefined : String(body.model)
    };
  }

  function appendGeneratedAsset(manifest: any, result: GenerateMediaResult) {
    const assetId = `asset_gen_${result.providerRequestId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    if (manifest.assets.some((asset: any) => asset.assetId === assetId)) return manifest;
    return addAssetV3(manifest, {
      assetId,
      kind: result.assetKind,
      path: result.asset,
      durationSec: result.durationSec,
      provenance: 'generated',
      providerRequestId: result.providerRequestId,
      video: result.video,
      audio: result.audio
    }).manifest;
  }

  function appendGenerationRequestEvent(input: { requestId: string; type: GenerateMediaKind; projectId: string; provider: string; status: 'approved' | 'failed'; bodyHash: string; generationInput: Record<string, unknown>; error?: string }) {
    return appendProviderRequestEvent(workspace(input.projectId), {
      requestId: input.requestId,
      type: input.type,
      projectId: input.projectId,
      provider: input.provider,
      status: input.status,
      bodyHash: input.bodyHash,
      input: input.generationInput,
      cost: { currency: 'USD', estimated: null, actual: null },
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      ...(input.error ? { error: input.error } : {})
    } as any);
  }

  async function appendUploadedClipToManifest(projectId: string, clipId: string, sourceRel: string) {
    const ws = workspace(projectId);
    await withProjectManifestMutex(projectId, async () => {
      const metadata = { ...ffprobe(assertInside(ws, sourceRel)), clipId, path: sourceRel, originalFilename: basename(sourceRel) };
      const project = loadProject(ws);
      const existingClipSources = project.clipSources || [];
      project.clipSources = [...existingClipSources.filter((source) => source.clipId !== clipId), metadata];
      project.status.imported = true;
      project.updatedAt = new Date().toISOString();
      saveProject(project);
      let manifest = loadManifest(ws);
      const assetId = `asset_video_${clipId}`;
      if (!manifest.assets.some((asset: any) => asset.assetId === assetId)) manifest = addAssetV3(manifest, { assetId, kind: 'video', path: sourceRel, durationSec: metadata.durationSec, provenance: 'imported', video: { width: metadata.width, height: metadata.height, fps: metadata.fps, codec: metadata.videoCodec || undefined, pixelFormat: metadata.pixelFormat || undefined }, audio: metadata.audioSampleRate ? { sampleRate: metadata.audioSampleRate, codec: metadata.audioCodec || undefined } : undefined }).manifest;
      let videoTrack = manifest.tracks.find((track: any) => track.kind === 'video') ?? manifest.tracks[0];
      if (!videoTrack) {
        const added = addTrackV3(manifest, { trackId: 'track_video_001', kind: 'video', name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false });
        manifest = added.manifest;
        videoTrack = added.track;
      }
      if (!manifest.tracks.some((track: any) => track.clips.some((clip: any) => clip.clipId === clipId))) {
        const timelineStart = Math.max(0, ...videoTrack.clips.map((clip: any) => clip.timelineStart + (clip.sourceEnd - clip.sourceStart)));
        manifest = addClipV3(manifest, { trackId: videoTrack.trackId, clip: { clipId, assetId, sourceStart: 0, sourceEnd: metadata.durationSec, timelineStart } }).manifest;
      }
      saveManifest(ws, manifest, false);
    });
  }

  async function appendRecordedClipToManifest(projectId: string, input: { clipId: string; sourceRel: string; source: 'screen' | 'cam' | 'voice'; durationSec: number; probe: RecordingProbe }) {
    const ws = workspace(projectId);
    await withProjectManifestMutex(projectId, async () => {
      const project = loadProject(ws);
      project.clipSources = [...(project.clipSources || []).filter((source: any) => source.clipId !== input.clipId), {
        clipId: input.clipId,
        path: input.sourceRel,
        originalFilename: basename(input.sourceRel),
        sha256: sha256File(assertInside(ws, input.sourceRel)),
        durationSec: input.durationSec,
        width: input.probe.video?.width || 1,
        height: input.probe.video?.height || 1,
        fps: input.probe.video?.fps || 1,
        audioSampleRate: input.probe.audio?.sampleRate || 0,
        videoCodec: input.probe.video?.codec || '',
        audioCodec: input.probe.audio?.codec || '',
        pixelFormat: input.probe.video?.pixelFormat || ''
      }];
      project.status.imported = true;
      project.updatedAt = new Date().toISOString();
      saveProject(project);
      let manifest = loadManifest(ws);
      const assetId = `asset_rec_${input.clipId}`;
      const kind = input.source === 'voice' ? 'audio' : 'video';
      if (!manifest.assets.some((asset: any) => asset.assetId === assetId)) {
        manifest = addAssetV3(manifest, { assetId, kind, path: input.sourceRel, durationSec: input.durationSec, provenance: 'recorded', video: input.probe.video, audio: input.probe.audio }).manifest;
      }
      let targetTrack = kind === 'video'
        ? manifest.tracks.find((track: any) => track.kind === 'video')
        : manifest.tracks.find((track: any) => track.kind === 'audio' && track.subtype === 'voiceover');
      if (!targetTrack) {
        const order = Math.max(-1, ...manifest.tracks.map((track: any) => Number(track.order || 0))) + 1;
        const added = kind === 'video'
          ? addTrackV3(manifest, { trackId: 'track_video_001', kind: 'video', name: 'Video 1', order, locked: false, muted: false, solo: false, hidden: false })
          : addTrackV3(manifest, { trackId: 'track_audio_voiceover_001', kind: 'audio', subtype: 'voiceover', name: 'Voiceover', order, locked: false, muted: false, solo: false, hidden: false });
        manifest = added.manifest;
        targetTrack = added.track;
      }
      if (!manifest.tracks.some((track: any) => track.clips.some((clip: any) => clip.clipId === input.clipId))) {
        const timelineStart = Math.max(0, ...targetTrack.clips.map((clip: any) => clip.timelineStart + (clip.sourceEnd - clip.sourceStart)));
        manifest = addClipV3(manifest, { trackId: targetTrack.trackId, clip: { clipId: input.clipId, assetId, sourceStart: 0, sourceEnd: input.durationSec, timelineStart } }).manifest;
      }
      saveManifest(ws, manifest, false);
    });
  }

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/assets/video', async (req, reply) => {
    const ws = workspace(req.params.projectId);
    loadProject(ws);
    const part = await (req as any).file();
    if (!part) return reply.code(400).send({ error: 'multipart file is required' });
    const contentLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > maxUploadBytes) { part.file.resume(); return reply.code(413).send({ error: 'Uploaded file exceeds ETVS_MAX_UPLOAD_BYTES' }); }
    const allowed = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
    if (!allowed.has(part.mimetype)) { part.file.resume(); return reply.code(415).send({ error: `Unsupported video MIME: ${part.mimetype}` }); }
    const clipId = await withProjectManifestMutex(req.params.projectId, async () => {
      const assigned = nextClipId(ws);
      mkdirSync(assertInside(ws, `assets/video/${assigned}`), { recursive: true });
      return assigned;
    });
    const clipDirRel = `assets/video/${clipId}`;
    const clipDir = assertInside(ws, clipDirRel);
    const sourceRel = `${clipDirRel}/source.mp4`;
    try { await pipeline(part.file, createWriteStream(assertInside(ws, sourceRel))); }
    catch (err) {
      rmSync(clipDir, { recursive: true, force: true });
      const message = errorMessage(err);
      if (/file.*too.*large|limit/i.test(message)) return reply.code(413).send({ error: 'Uploaded file exceeds ETVS_MAX_UPLOAD_BYTES' });
      return reply.code(507).send({ error: message });
    }
    const jobId = `job_upload-video_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();
    let stages: UploadStage[] = [{ name: 'upload', status: 'succeeded', completedAt: createdAt }, { name: 'extract-audio', status: 'queued', clipId }, { name: 'transcribe', status: 'queued', clipId }, { name: 'manifest-write', status: 'queued', clipId }];
    appendJobStatus(ws, { jobId, projectId: req.params.projectId, type: 'upload-video', status: 'running', createdAt, startedAt: createdAt, input: { clipId, filename: part.filename, mimetype: part.mimetype }, stages });
    setImmediate(async () => {
      try {
        stages = updateStage(stages, 'manifest-write', { status: 'running', startedAt: new Date().toISOString() });
        appendJobStatus(ws, { jobId, projectId: req.params.projectId, type: 'upload-video', status: 'running', createdAt, stages });
        await appendUploadedClipToManifest(req.params.projectId, clipId, sourceRel);
        stages = updateStage(stages, 'manifest-write', { status: 'succeeded', completedAt: new Date().toISOString() });
        stages = updateStage(stages, 'extract-audio', { status: 'running', startedAt: new Date().toISOString() });
        appendJobStatus(ws, { jobId, projectId: req.params.projectId, type: 'upload-video', status: 'running', createdAt, stages });
        const audio = await extractClipAudio(ws, clipId, { overwrite: true, logJob: false });
        stages = updateStage(stages, 'extract-audio', { status: 'succeeded', completedAt: new Date().toISOString() });
        stages = updateStage(stages, 'transcribe', { status: 'running', startedAt: new Date().toISOString() });
        appendJobStatus(ws, { jobId, projectId: req.params.projectId, type: 'upload-video', status: 'running', createdAt, stages });
        await transcribeClip(ws, clipId, { provider: 'mock' });
        await mergeTranscripts(ws);
        stages = updateStage(stages, 'transcribe', { status: 'succeeded', completedAt: new Date().toISOString() });
        appendJobStatus(ws, { jobId, projectId: req.params.projectId, type: 'upload-video', status: 'succeeded', createdAt, completedAt: new Date().toISOString(), outputs: [sourceRel, audio, `transcript/${clipId}/words.json`, 'transcript/words.json'], stages });
      } catch (err) {
        const running = stages.find((stage) => stage.status === 'running')?.name || 'upload';
        stages = updateStage(stages, running, { status: 'failed', completedAt: new Date().toISOString(), error: errorMessage(err) });
        appendJobStatus(ws, { jobId, projectId: req.params.projectId, type: 'upload-video', status: 'failed', createdAt, completedAt: new Date().toISOString(), error: errorMessage(err), stages });
      }
    });
    return reply.code(202).send({ clipId, jobId });
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/assets/recordings', async (req, reply) => {
    const projectId = req.params.projectId;
    const ws = workspace(projectId);
    loadProject(ws);
    const contentLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > maxUploadBytes) return reply.code(413).send({ error: 'Uploaded file exceeds ETVS_MAX_UPLOAD_BYTES' });

    const filePart = await (req as any).file();
    if (!filePart) return reply.code(400).send({ error: 'multipart file is required' });
    const source = String(filePart.fields?.source?.value || '') as 'screen' | 'cam' | 'voice';
    const clientDurationSec = Number(filePart.fields?.durationSec?.value || 0);
    if (!['screen', 'cam', 'voice'].includes(source)) { filePart.file.resume(); return reply.code(400).send({ error: 'source must be screen, cam, or voice' }); }
    const allowedVideo = new Set(['video/webm', 'video/mp4', 'video/x-matroska']);
    const allowedAudio = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg']);
    const allowed = source === 'voice' ? allowedAudio : allowedVideo;
    if (!allowed.has(filePart.mimetype)) { filePart.file?.resume?.(); return reply.code(415).send({ error: `Unsupported recording MIME for ${source}: ${filePart.mimetype}` }); }

    const clipId = await withProjectManifestMutex(projectId, async () => {
      const assigned = nextClipId(ws);
      mkdirSync(assertInside(ws, `assets/recordings/${assigned}`), { recursive: true });
      return assigned;
    });
    const ext = extForMime(filePart.mimetype);
    const clipDirRel = `assets/recordings/${clipId}`;
    const clipDir = assertInside(ws, clipDirRel);
    const rawRel = `${clipDirRel}/raw-input.${ext}`;
    const sourceRel = `${clipDirRel}/source.${ext}`;
    const rawPath = assertInside(ws, rawRel);
    const sourcePath = assertInside(ws, sourceRel);
    let probe: RecordingProbe;
    let durationSec: number;
    try {
      await pipeline(filePart.file, createWriteStream(rawPath));
      try { remuxRecording(rawPath, sourcePath); } catch (err) { throw asUnprocessableMediaError(err); }
      rmSync(rawPath, { force: true });
      try { probe = probeRecordingMedia(sourcePath); } catch (err) { throw asUnprocessableMediaError(err); }
      durationSec = probe.durationSec > 0 ? probe.durationSec : (Number.isFinite(clientDurationSec) && clientDurationSec > 0 ? clientDurationSec : 0);
      if (!durationSec) throw Object.assign(new Error('Could not determine recording duration'), { statusCode: 422 });
      if (source !== 'voice' && !probe.hasVideo) throw Object.assign(new Error('Recording does not contain a video stream'), { statusCode: 422 });
      if (source === 'voice' && !probe.hasAudio) throw Object.assign(new Error('Voice recording contains no audio stream'), { statusCode: 422 });
    } catch (err) {
      rmSync(clipDir, { recursive: true, force: true });
      const message = errorMessage(err);
      if (/file.*too.*large|limit/i.test(message)) return reply.code(413).send({ error: 'Uploaded file exceeds ETVS_MAX_UPLOAD_BYTES' });
      const statusCode = (err as any)?.statusCode;
      return reply.code(statusCode === 422 ? 422 : 507).send({ error: message });
    }

    const jobId = `job_record-clip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();
    let stages: UploadStage[] = [{ name: 'upload', status: 'succeeded', completedAt: createdAt }, { name: 'manifest-write', status: 'queued', clipId }, { name: 'extract-audio', status: 'queued', clipId }, { name: 'transcribe', status: 'queued', clipId }];
    appendJobStatus(ws, { jobId, projectId, type: 'record-clip', status: 'running', createdAt, startedAt: createdAt, input: { clipId, source, mimetype: filePart.mimetype }, stages });
    setImmediate(async () => {
      try {
        stages = updateStage(stages, 'manifest-write', { status: 'running', startedAt: new Date().toISOString() });
        appendJobStatus(ws, { jobId, projectId, type: 'record-clip', status: 'running', createdAt, stages });
        await appendRecordedClipToManifest(projectId, { clipId, source, sourceRel, durationSec, probe });
        stages = updateStage(stages, 'manifest-write', { status: 'succeeded', completedAt: new Date().toISOString() });
        const outputs = [sourceRel];
        if (probe.hasAudio) {
          stages = updateStage(stages, 'extract-audio', { status: 'running', startedAt: new Date().toISOString() });
          appendJobStatus(ws, { jobId, projectId, type: 'record-clip', status: 'running', createdAt, stages });
          const audio = await extractClipAudio(ws, clipId, { overwrite: true, logJob: false });
          outputs.push(audio);
          stages = updateStage(stages, 'extract-audio', { status: 'succeeded', completedAt: new Date().toISOString() });
          stages = updateStage(stages, 'transcribe', { status: 'running', startedAt: new Date().toISOString() });
          appendJobStatus(ws, { jobId, projectId, type: 'record-clip', status: 'running', createdAt, stages });
          await transcribeClip(ws, clipId, { provider: 'mock' });
          await mergeTranscripts(ws);
          outputs.push(`transcript/${clipId}/words.json`, 'transcript/words.json');
          stages = updateStage(stages, 'transcribe', { status: 'succeeded', completedAt: new Date().toISOString() });
        } else {
          const skippedAt = new Date().toISOString();
          stages = updateStage(stages, 'extract-audio', { status: 'cancelled', completedAt: skippedAt, phase: 'skipped' });
          stages = updateStage(stages, 'transcribe', { status: 'cancelled', completedAt: skippedAt, phase: 'skipped' });
        }
        appendJobStatus(ws, { jobId, projectId, type: 'record-clip', status: 'succeeded', createdAt, completedAt: new Date().toISOString(), outputs, stages });
      } catch (err) {
        const running = stages.find((stage) => stage.status === 'running')?.name || 'upload';
        stages = updateStage(stages, running, { status: 'failed', completedAt: new Date().toISOString(), error: errorMessage(err) });
        appendJobStatus(ws, { jobId, projectId, type: 'record-clip', status: 'failed', createdAt, completedAt: new Date().toISOString(), error: errorMessage(err), stages });
      }
    });
    return reply.code(202).send({ clipId, jobId });
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/assets/generations', async (req, reply) => {
    const projectId = req.params.projectId;
    const ws = workspace(projectId);
    loadProject(ws);
    const parsed = parseGenerationBody(req.body);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const requestId = parsed.requestId ?? `provider_${randomUUID().replace(/-/g, '_')}`;
    const requestIdResult = ProviderRequestIdSchema.safeParse(requestId);
    if (!requestIdResult.success) return reply.code(400).send({ error: 'invalid requestId' });
    const generationInput = { kind: parsed.kind, prompt: parsed.prompt, provider: parsed.provider, count: parsed.count, aspectRatio: parsed.aspectRatio, resolution: parsed.resolution, durationSec: parsed.durationSec, durationMs: parsed.durationMs, model: parsed.model };
    const bodyHash = generationBodyHash(generationInput);
    const providerId = canonicalProviderId(parsed.kind, parsed.provider);
    const resolvedProvider = resolveProviderForKind({ kind: parsed.kind, flagProviderId: providerId, workspacePath: ws, env: process.env });
    const provider = resolvedProvider?.id ?? providerId ?? `${parsed.kind}.mock`;
    // P4-1c: dedup concurrent same-requestId POSTs onto one provider call, and release the
    // project manifest mutex during the paid call so unrelated edits (a clip rename, an undo)
    // aren't blocked by a 30s xAI video generation. Phases:
    //   Phase 1 (locked): idempotency check, optional disabled-provider rejection, append 'approved' event.
    //   Phase 2 (unlocked): generateMedia. Paid provider call + ledger started/succeeded rows.
    //   Phase 3 (locked): append the generated asset to the manifest and save.
    // On failure during Phase 2: a short locked block appends a 'failed' event (only if no terminal
    // ledger row was already written by the provider engine).
    //
    // bodyHash is part of the dedup key so concurrent SAME-requestId DIFFERENT-body POSTs each
    // run their own Phase 1; the second one will see the existing ledger row from the first,
    // detect the bodyHash mismatch, and surface the 409 the API contract promises. The 'gen:'
    // prefix keeps the namespace separate from the voice-patch route so cross-route requestId
    // collisions can't share a dedup slot.
    const result = await withInFlightProviderCall(`gen:${projectId}:${requestId}:${bodyHash}`, async () => {
      const phase1 = await withProjectManifestMutex(projectId, async () => {
        // STRICT: the pre-call replay gate for a PAID media generation. A skipped ledger row
        // reads as "never requested" and re-executes the provider; legacy rows are migrated by
        // the strict union rather than dropped.
        const existing = latestProviderRequest(ws, requestId, { strict: true });
        if (existing) {
          const existingHash = providerRequestBodyHashStrict(ws, requestId);
          // UNCONDITIONAL equality. Guarding on `existingHash &&` meant a record with no stored
          // hash — which is exactly what a migrated historical row normalizes to — replayed
          // against ANY body: a different prompt would return the previous generation's asset.
          // A record we cannot compare is incomplete history, not a licence to match everything.
          if (existingHash !== bodyHash) throw Object.assign(new Error(existingHash ? 'requestId already exists with different bodyHash' : 'requestId has incomplete history (no recorded body) and cannot be replayed'), { statusCode: 409 });
          const manifest = loadManifest(ws);
          const asset = manifest.assets.find((candidate: any) => candidate.providerRequestId === requestId);
          return { kind: 'early' as const, payload: { existing, asset, manifest, validation: validateWorkspaceManifest(ws) } };
        }
        if (resolvedProvider?.enabled === false) {
          const message = `Provider is disabled: ${resolvedProvider.id}`;
          const failed = appendGenerationRequestEvent({ requestId, type: parsed.kind, projectId, provider, status: 'failed', bodyHash, generationInput, error: message });
          throw Object.assign(new Error(message), { statusCode: 500, request: failed });
        }
        appendGenerationRequestEvent({ requestId, type: parsed.kind, projectId, provider, status: 'approved', bodyHash, generationInput });
        return { kind: 'continue' as const };
      });
      if (phase1.kind === 'early') return phase1.payload;
      try {
        const media = await generateMedia(ws, { ...parsed, requestId, projectId, env: process.env });
        return await withProjectManifestMutex(projectId, async () => {
          let manifest = loadManifest(ws);
          manifest = appendGeneratedAsset(manifest, media);
          saveManifest(ws, manifest, false);
          return { media, manifest, validation: validateWorkspaceManifest(ws) };
        });
      } catch (err) {
        await withProjectManifestMutex(projectId, async () => {
          const latest = latestProviderRequest(ws, requestId) as any;
          if (!latest || latest.status === 'approved') appendGenerationRequestEvent({ requestId, type: parsed.kind, projectId, provider, status: 'failed', bodyHash, generationInput, error: errorMessage(err) });
        });
        throw err;
      }
    }).catch((err) => err);
    if (result instanceof Error) return reply.code((result as any).statusCode ?? 500).send({ providerRequestId: requestId, request: (result as any).request, error: errorMessage(result) });
    if ('existing' in result) return reply.code(200).send({ asset: result.asset, providerRequestId: requestId, request: result.existing, manifest: result.manifest, validation: result.validation });
    return reply.code(200).send({ asset: result.media, providerRequestId: requestId, manifest: result.manifest, validation: result.validation });
  });

  app.get<{ Params: { projectId: string }; Querystring: { kind?: string; count?: string; durationSec?: string; durationMs?: string; provider?: string } }>('/api/projects/:projectId/assets/generations/estimate', async (req, reply) => {
    const ws = workspace(req.params.projectId);
    try { loadProject(ws); } catch { return reply.code(404).send({ error: 'project not found' }); }
    const kind = String(req.query.kind ?? '') as GenerateMediaKind;
    if (!generationKinds.has(kind)) return reply.code(400).send({ error: 'kind must be image-gen, video-gen, or music-gen' });
    // Fastify hands back an ARRAY for a repeated `?provider=` query param, and the old
    // `.includes('.')` expression coerced it into a plausible-looking id (`image-gen.a,b`).
    // canonicalProviderId fails closed on it, so a malformed query is answered as a 400.
    let providerHint: string | undefined;
    try { providerHint = canonicalProviderId(kind, req.query.provider); }
    catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : 'invalid provider' }); }
    const resolved = resolveProviderForKind({ kind, flagProviderId: providerHint, workspacePath: ws, env: process.env });
    const providerId = resolved?.id ?? providerHint ?? `${kind}.mock`;
    const adapter = getProvider(providerId);
    const fallbackName = providerId.split('.').slice(1).join('.') || providerId;
    if (!adapter || adapter.kind !== kind) {
      return reply.send({ providerId, providerName: resolved?.name ?? fallbackName, tier: 'local' as const, configured: false, cost: null, defaults: { count: 1, durationSec: 5, durationMs: 30000 } });
    }
    const count = req.query.count != null ? Math.max(1, Math.floor(Number(req.query.count))) : 1;
    const durationSec = req.query.durationSec != null ? Math.max(1, Math.floor(Number(req.query.durationSec))) : 8;
    const durationMs = req.query.durationMs != null ? Math.max(1000, Math.floor(Number(req.query.durationMs))) : 30000;
    const providerInput: any = kind === 'image-gen'
      ? { prompt: 'estimate', count }
      : kind === 'video-gen'
      ? { prompt: 'estimate', durationSec }
      : { prompt: 'estimate', durationMs };
    const providerRecord: ProviderRecord = resolved ?? { schemaVersion: 1, id: providerId, kind, name: fallbackName, tier: adapter.tier, enabled: true, default: false, source: 'manual', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    let cost: ProviderCost | null = null;
    try { cost = adapter.estimateCost(providerInput, providerRecord); } catch { cost = null; }
    return reply.send({ providerId, providerName: resolved?.name ?? fallbackName, tier: adapter.tier, configured: !!resolved, cost, defaults: { count, durationSec, durationMs } });
  });

  app.get<{ Params: { projectId: string; kind: string } }>('/api/projects/:projectId/media/:kind', async (req, reply) => {
    const ws = workspace(req.params.projectId);
    // For SOURCE preview, v3 projects keep the original media under
    // assets/video/<clipId>/source.mp4 (per project.clipSources[*].path). The
    // legacy input/source.mp4 location is checked first for back-compat with
    // older workspaces (which the import path used to populate), then we fall
    // through to the first clipSource's path. Without this fallback every v3
    // project hits "file not found" on SOURCE preview, which the user just
    // hit on Test-Emo-fresh.
    const candidatesByKind: Record<string, string[]> = {
      source: ['input/source.mp4'],
      proxy: ['media/proxy-video.mp4'],
      draft: ['renders/draft.mp4'],
      final: ['renders/final.mp4']
    };
    let candidates = candidatesByKind[req.params.kind];
    if (!candidates) return reply.code(404).send({ error: 'unknown media kind' });
    if (req.params.kind === 'source') {
      try {
        const project = loadProject(ws);
        const fromProject = (project?.clipSources ?? []).map((cs: any) => cs.path).filter((p: any) => typeof p === 'string' && p.length > 0);
        candidates = [...candidates, ...fromProject];
      } catch { /* missing/invalid project.json — fall through to legacy candidate */ }
    }
    let path: string | null = null;
    for (const rel of candidates) {
      const resolved = assertInside(ws, rel);
      if (existsSync(resolved)) { path = resolved; break; }
    }
    if (!path) return reply.code(404).send({ error: 'file not found' });
    const stat = statSync(path);
    const range = parseRange(req.headers.range, stat.size);
    reply.header('Content-Type', contentType(path));
    reply.header('Accept-Ranges', 'bytes');
    if (range) { reply.code(206); reply.header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`); reply.header('Content-Length', String(range.end - range.start + 1)); return reply.send(createReadStream(path, { start: range.start, end: range.end })); }
    reply.header('Content-Length', String(stat.size));
    return reply.send(createReadStream(path));
  });

  app.get<{ Params: { projectId: string; clipId: string } }>('/api/projects/:projectId/peaks/:clipId', async (req, reply) => {
    if (!req.params.projectId.trim()) return reply.code(400).send({ error: 'invalid projectId' });
    if (!/^clip_[A-Za-z0-9_-]{1,128}$/.test(req.params.clipId)) return reply.code(400).send({ error: 'invalid clipId' });
    let path: string;
    try {
      path = assertInside(workspace(req.params.projectId), `media/${req.params.clipId}/peaks.json`);
    } catch (err) {
      return reply.code(400).send({ error: errorMessage(err) });
    }
    if (!existsSync(path)) return reply.code(404).send({ error: 'clip peaks not found' });
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return JSON.parse(readFileSync(path, 'utf8'));
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/transcript', async (req, reply) => {
    const path = assertInside(workspace(req.params.projectId), 'transcript/transcript.md');
    if (!existsSync(path)) return reply.code(404).send({ error: 'transcript not found' });
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    return readFileSync(path, 'utf8');
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/transcript/words', async (req, reply) => {
    const doc = loadTranscript(workspace(req.params.projectId));
    if (!doc) return reply.code(404).send({ error: 'words not found' });
    return { transcript: doc };
  });

  app.get<{ Params: { projectId: string; '*': string } }>('/api/projects/:projectId/assets/*', async (req, reply) => {
    const ws = workspace(req.params.projectId);
    const path = assertInside(ws, req.params['*']);
    const voiceRoot = resolve(ws, 'assets/voice');
    const generatedRoot = resolve(ws, 'assets/generated');
    if (!path.startsWith(`${voiceRoot}/`) && !path.startsWith(`${generatedRoot}/`)) return reply.code(404).send({ error: 'unknown asset' });
    if (!existsSync(path)) return reply.code(404).send({ error: 'asset not found' });
    reply.header('Content-Type', contentType(path));
    return reply.send(createReadStream(path));
  });
}
