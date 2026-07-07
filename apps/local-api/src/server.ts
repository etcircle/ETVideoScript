import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { basename, extname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  appendProviderRequestEvent,
  appendJobStatus,
  assertInside,
  assertSpeechProviderSupported,
  addAssetV3,
  addClipV3,
  addOperation,
  addTrackV3,
  buildRenderPlanV3,
  captionsToSrtV3,
  captionsToVttV3,
  createWorkspace,
  doctor,
  extractAllClipAudio,
  extractAllClipWaveformPeaks,
  extractClipAudio,
  ffprobe,
  importSource,
  jobEvents,
  latestJob,
  latestJobs,
  listProjects,
  extractSurroundingTranscriptText,
  loadManifestV3,
  loadProject,
  loadTranscript,
  latestProviderRequest,
  makeJobId,
  projectCaptionsV3,
  renderPlanV3,
  safeProjectPath,
  saveManifestV3,
  saveProject,
  ffprobeDurationSec,
  STUDIO_CLEANUP_STALE_WARNING,
  ProviderRequestIdSchema,
  readProviderRegistry,
  readProviderRequests,
  summarizeProviderRequestsForWorkspace,
  synthesizeReplacementSpeech,
  VoiceReferenceSchema,
  mergeTranscripts,
  transcribeAllClips,
  transcribeClip,
  transcribableClips,
  updateOperation,
  validateManifestV3Document,
  runAgentToolV3,
  agentToolHandlersV3,
  type AgentToolName,
  type ManifestV3
} from '@etvideoscript/core';
import {
  ClientMessageSchema,
  ToolParamsSchemaByName,
  type ToolCallMessage,
  type ToolError,
  type ToolName,
  type ToolResponse
} from '@etvideoscript/agent-protocol';
import { loadConfig, ApiConfig, isLocalHost } from './config';
import { registerSettingsRoutes } from './settingsRoutes';
import { registerProjectRoutes } from './projectRoutes';
import { registerAssetRoutes } from './assetRoutes';
import { registerManifestRoutes } from './manifestRoutes';
import { registerStructureRoutes } from './structureRoutes';
import { registerJobRoutes } from './jobRoutes';
import { registerStudioCleanupRoutes } from './studioCleanupRoutes';
import type { LocalApiRouteContext } from './routeContext';
import { createInFlightProviderCalls } from './inFlightProviderCalls';

function contentType(path: string) {
  const ext = extname(path).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.json') return 'application/json';
  if (ext === '.md') return 'text/markdown; charset=utf-8';
  return 'application/octet-stream';
}

function fileInfo(workspacePath: string, rel: string) {
  const path = assertInside(workspacePath, rel);
  if (!existsSync(path)) return { path: rel, exists: false, size: 0 };
  const stat = statSync(path);
  return { path: rel, exists: true, size: stat.size, updatedAt: stat.mtime.toISOString() };
}

function parseRange(rangeHeader: string | undefined, size: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) start = Math.max(size - end, 0);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

type RenderFreshnessState = 'missing' | 'rendering' | 'fresh' | 'stale' | 'error';

type ManifestFingerprint = { updatedAt: string; sha256: string };

type PeaksFreshnessState = 'missing_audio' | 'missing' | 'fresh' | 'stale';

function peaksFreshness(files: { audio: ReturnType<typeof fileInfo>; peaks: ReturnType<typeof fileInfo> }): { state: PeaksFreshnessState; reason: string; output: string; updatedAt?: string; audioUpdatedAt?: string } {
  if (!files.audio.exists) return { state: 'missing_audio', reason: 'audio has not been extracted yet', output: files.peaks.path };
  if (!files.peaks.exists) return { state: 'missing', reason: `${files.peaks.path} does not exist yet`, output: files.peaks.path, audioUpdatedAt: files.audio.updatedAt };
  const audioMs = files.audio.updatedAt ? new Date(files.audio.updatedAt).getTime() : 0;
  const peaksMs = files.peaks.updatedAt ? new Date(files.peaks.updatedAt).getTime() : 0;
  if (Number.isFinite(audioMs) && Number.isFinite(peaksMs) && audioMs > peaksMs) return { state: 'stale', reason: 'audio is newer than waveform peaks', output: files.peaks.path, updatedAt: files.peaks.updatedAt, audioUpdatedAt: files.audio.updatedAt };
  return { state: 'fresh', reason: 'waveform peaks are at least as new as extracted audio', output: files.peaks.path, updatedAt: files.peaks.updatedAt, audioUpdatedAt: files.audio.updatedAt };
}

function manifestFingerprint(ws: string, updatedAt: string): ManifestFingerprint {
  const raw = readFileSync(assertInside(ws, 'edits/manifest.json'));
  return { updatedAt, sha256: createHash('sha256').update(raw).digest('hex') };
}

function readDraftRenderMetadata(ws: string): null | { manifest?: ManifestFingerprint } {
  const path = assertInside(ws, 'renders/render-logs/draft.mp4.metadata.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { manifest?: ManifestFingerprint };
    if (!parsed.manifest?.sha256) return null;
    return parsed;
  } catch {
    return null;
  }
}

function draftRenderFreshness(ws: string, manifestUpdatedAt: string, draft: ReturnType<typeof fileInfo>, recentJobs: ReturnType<typeof latestJobs>): { state: RenderFreshnessState; reason: string; output: string; updatedAt?: string; manifestUpdatedAt: string; jobId?: string } {
  const currentManifest = manifestFingerprint(ws, manifestUpdatedAt);
  const latestRender = recentJobs.find((job) => job.type === 'render-draft');
  if (latestRender && ['queued', 'running', 'waiting_for_approval'].includes(latestRender.status)) {
    return { state: 'rendering', reason: `${latestRender.status} render job ${latestRender.jobId}`, output: draft.path, updatedAt: draft.updatedAt, manifestUpdatedAt, jobId: latestRender.jobId };
  }
  if (!draft.exists) {
    if (latestRender?.status === 'failed') return { state: 'error', reason: latestRender.error || 'latest render failed', output: draft.path, manifestUpdatedAt, jobId: latestRender.jobId };
    return { state: 'missing', reason: 'no draft render exists yet', output: draft.path, manifestUpdatedAt };
  }
  const metadata = readDraftRenderMetadata(ws);
  if (metadata?.manifest && metadata.manifest.sha256 !== currentManifest.sha256) {
    return { state: 'stale', reason: 'manifest content differs from draft render input', output: draft.path, updatedAt: draft.updatedAt, manifestUpdatedAt, jobId: latestRender?.jobId };
  }
  const draftMs = draft.updatedAt ? new Date(draft.updatedAt).getTime() : 0;
  const manifestMs = new Date(manifestUpdatedAt).getTime();
  if (Number.isFinite(manifestMs) && Number.isFinite(draftMs) && manifestMs > draftMs) {
    return { state: 'stale', reason: 'manifest is newer than draft render', output: draft.path, updatedAt: draft.updatedAt, manifestUpdatedAt, jobId: latestRender?.jobId };
  }
  if (latestRender?.status === 'failed') {
    return { state: 'error', reason: latestRender.error || 'latest render failed after this draft', output: draft.path, updatedAt: draft.updatedAt, manifestUpdatedAt, jobId: latestRender.jobId };
  }
  return { state: 'fresh', reason: 'draft render is at least as new as manifest', output: draft.path, updatedAt: draft.updatedAt, manifestUpdatedAt, jobId: latestRender?.jobId };
}

function voicePatchDurationWarning(generated: number, requested: number) {
  const deltaSec = generated - requested;
  const threshold = Math.max(0.25, requested * 0.15);
  return Math.abs(deltaSec) > threshold ? { generated, requested, deltaSec } : undefined;
}

function providerBodyHash(input: { text: string; start: number; end: number; provider: string; voice: string; language: string; model?: string; granularity?: string; cloneScope?: string; referenceRange?: { clipId: string; start: number; end: number } }): string {
  return createHash('sha256').update(JSON.stringify({
    text: input.text.trim(),
    start: input.start,
    end: input.end,
    provider: input.provider,
    voice: input.voice,
    language: input.language,
    ...(input.model ? { model: input.model } : {}),
    ...(input.granularity ? { granularity: input.granularity } : {}),
    ...(input.cloneScope ? { cloneScope: input.cloneScope } : {}),
    ...(input.referenceRange ? { referenceRange: { clipId: input.referenceRange.clipId, start: input.referenceRange.start, end: input.referenceRange.end } } : {})
  })).digest('hex');
}

function baseProviderEvent(input: { requestId: string; projectId: string; provider: string; voice: string; language: string; text: string; operationId: string; status: 'pending' | 'approved' | 'called' | 'succeeded' | 'failed' | 'rejected' | 'op_update_failed'; createdAt?: string; completedAt?: string; error?: string; durationGeneratedSec?: number; durationRequestedSec?: number; durationWarning?: { generated: number; requested: number; deltaSec: number }; start?: number; end?: number; bodyHash?: string; type?: string; cost?: { currency: string; estimated?: number | null; actual?: number | null }; providerStatus?: number }) {
  return {
    requestId: input.requestId,
    type: input.type || 'voice_patch',
    projectId: input.projectId,
    provider: input.provider,
    voice: input.voice,
    language: input.language,
    bodyHash: input.bodyHash || providerBodyHash({ text: input.text, start: input.start ?? 0, end: input.end ?? input.durationRequestedSec ?? 0, provider: input.provider, voice: input.voice, language: input.language }),
    operationId: input.operationId,
    status: input.status,
    cost: input.cost || { currency: 'USD', estimated: 0, actual: 0 },
    createdAt: input.createdAt || new Date().toISOString(),
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.providerStatus != null ? { providerStatus: input.providerStatus } : {}),
    ...(input.durationGeneratedSec != null ? { durationGeneratedSec: input.durationGeneratedSec } : {}),
    ...(input.durationRequestedSec != null ? { durationRequestedSec: input.durationRequestedSec } : {}),
    ...(input.durationWarning ? { durationWarning: input.durationWarning } : {})
  };
}

function providerExecutionShape(event: unknown): { type?: string; cost?: { currency: string; estimated?: number | null; actual?: number | null }; providerStatus?: number } {
  if (!event || typeof event !== 'object' || !('type' in event) || !('cost' in event)) return {};
  const generic = event as { type?: string; cost?: { currency: string; estimated?: number | null; actual?: number | null }; providerStatus?: number };
  return {
    ...(generic.type ? { type: generic.type } : {}),
    ...(generic.cost ? { cost: generic.cost } : {}),
    ...(generic.providerStatus != null ? { providerStatus: generic.providerStatus } : {})
  };
}

type JobType = 'extract-audio' | 'peaks' | 'transcribe' | 'validate-manifest' | 'render-draft' | 'export-captions';
type UploadStage = { name: string; status: 'queued' | 'waiting_for_approval' | 'running' | 'succeeded' | 'failed' | 'cancelled'; startedAt?: string; completedAt?: string; error?: string; clipId?: string; phase?: string; percent?: number };
type AgentSocket = { send: (data: string) => void; readyState?: number; protocolVersion?: 2 | 3 };
type AgentIdempotencyRecord = { tool: ToolName; bodyHash: string; response: ToolResponse };
const coreAgentToolNames = new Set<AgentToolName>(Object.keys(agentToolHandlersV3) as AgentToolName[]);
const readOnlyAgentTools = new Set<ToolName>(['get_transcript', 'list_operations', 'get_render_state', 'propose_outputs', 'brief_show', 'takes_list', 'takes_spans', 'takes_span_detail', 'compose_validate']);
const apiWrappedAgentTools = new Set<ToolName>(['render_draft']);

function isCoreAgentTool(tool: ToolName): tool is AgentToolName {
  return coreAgentToolNames.has(tool as AgentToolName);
}

function isMutatingAgentTool(tool: ToolName): boolean {
  return apiWrappedAgentTools.has(tool) || (isCoreAgentTool(tool) && !readOnlyAgentTools.has(tool));
}

function manifestContentVersion(ws: string): string {
  return createHash('sha256').update(readFileSync(assertInside(ws, 'edits/manifest.json'))).digest('hex').slice(0, 16);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestBodyHash(tool: ToolName, params: unknown): string {
  return createHash('sha256').update(canonicalJson({ tool, params })).digest('hex');
}

function idempotencyPath(ws: string) { return assertInside(ws, 'logs/agent-request-idempotency.json'); }
function readAgentIdempotency(ws: string): Record<string, AgentIdempotencyRecord> {
  const path = idempotencyPath(ws);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, AgentIdempotencyRecord>;
}
function writeAgentIdempotency(ws: string, records: Record<string, AgentIdempotencyRecord>) {
  writeFileSync(idempotencyPath(ws), `${JSON.stringify(records, null, 2)}\n`);
}
function toolError(code: ToolError['code'], message: string, status = 400, manifestVersion?: string, details?: unknown): ToolError {
  return { code, message, status, ...(manifestVersion ? { manifestVersion } : {}), ...(details ? { details } : {}) };
}
function originAllowed(origin: string | string[] | undefined, allowedOrigins: string[]): boolean {
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (!value || value === 'null') return true;
  if (allowedOrigins.includes(value)) return true;
  try { return isLocalHost(new URL(value).hostname); } catch { return false; }
}

// Browser-headerless GETs that must be reachable via a TLS reverse proxy
// without an Authorization header: <video src>, <audio src>, and waveform
// peaks fetched without an auth-attaching client. Exempt from the bearer
// gate. Mutations through these prefixes remain gated.
const HEADERLESS_READ_PATHS: RegExp[] = [
  /^\/api\/projects\/[^/]+\/media\//,
  /^\/api\/projects\/[^/]+\/peaks\//
];
function isHeaderlessRead(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return HEADERLESS_READ_PATHS.some((re) => re.test(pathname));
}

function remoteHost(ip: string | undefined): string {
  if (!ip) return '127.0.0.1';
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

function bearerToken(authorization: string | string[] | undefined): string | null {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = /^Bearer\s+(.+)$/i.exec(value || '');
  return match?.[1] || null;
}

function loadManifest(ws: string): ManifestV3 { return loadManifestV3(ws); }
function saveManifest(ws: string, manifest: ManifestV3, revision = true): void { saveManifestV3(ws, manifest, { revision }); }
function validateWorkspaceManifest(ws: string) { return validateManifestV3Document(loadManifestV3(ws)); }
function validateManifestDocument(manifest: ManifestV3) { return validateManifestV3Document(manifest); }
function isManifestV2(_manifest: unknown): boolean { return false; }

function clipTarget(manifest: ManifestV3, clipId?: string, start = 0, end = 0) {
  const clip = clipId
    ? manifest.tracks.flatMap((track) => track.clips.map((candidate) => ({ track, clip: candidate }))).find((entry) => entry.clip.clipId === clipId)
    : manifest.tracks.flatMap((track) => track.clips.map((candidate) => ({ track, clip: candidate }))).at(0);
  if (!clip) throw new Error('Operation requires at least one timeline clip');
  return { kind: 'clip-span' as const, trackId: clip.track.trackId, clipId: clip.clip.clipId, start, end };
}

function addManifestOperation(ws: string, input: any) {
  const manifest = loadManifestV3(ws);
  const { manifest: next, operation } = addOperation(manifest, {
    ...input,
    id: input.id ?? `op_${input.type}_${Date.now()}`,
    target: input.target ?? clipTarget(manifest, input.clipId, input.start, input.end),
    status: input.status ?? 'approved',
    proposedBy: input.createdBy === 'agent' ? 'agent' : 'user',
    createdBy: input.createdBy ?? 'user',
    createdAt: input.createdAt ?? new Date().toISOString()
  });
  saveManifestV3(ws, next);
  return operation;
}

function addVoicePatchOperation(ws: string, input: any) {
  return addManifestOperation(ws, { ...input, type: 'voice_patch' });
}

function updateManifestOperation(ws: string, operationId: string, patch: any) {
  let manifest = loadManifestV3(ws);
  const current = manifest.operations.find((op) => op.id === operationId);
  if (!current) throw new Error(`Manifest operation not found: ${operationId}`);
  const nextPatch = { ...patch };
  let compatibilityAsset: string | undefined;
  if ((patch.start != null || patch.end != null) && current.target.kind === 'clip-span') {
    nextPatch.target = { ...current.target, start: patch.start ?? current.target.start, end: patch.end ?? current.target.end };
    delete nextPatch.start;
    delete nextPatch.end;
  }
  if (nextPatch.asset && !nextPatch.assetId) {
    const rel = String(nextPatch.asset);
    compatibilityAsset = rel;
    const assetId = `asset_voice_${operationId}`;
    if (!manifest.assets.some((asset) => asset.assetId === assetId)) {
      manifest = addAssetV3(manifest, { assetId, kind: 'audio', path: rel, durationSec: nextPatch.durationGeneratedSec ?? nextPatch.durationRequestedSec ?? 0, provenance: 'generated', providerRequestId: nextPatch.providerRequestId, audio: {} }).manifest;
    }
    nextPatch.assetId = assetId;
    delete nextPatch.asset;
  }
  const { manifest: next, operation } = updateOperation(manifest, operationId, nextPatch);
  saveManifestV3(ws, next);
  return compatibilityAsset ? { ...operation, asset: compatibilityAsset } : operation;
}

function exportCaptions(ws: string, options: { format?: 'srt' | 'vtt' } = {}) {
  const manifest = loadManifestV3(ws);
  const transcript = loadTranscript(ws);
  if (!transcript) throw new Error('transcript/words.json not found');
  const cues = projectCaptionsV3(manifest, transcript, buildRenderPlanV3(manifest).timeMap);
  const output = `captions/edited.${options.format === 'vtt' ? 'vtt' : 'srt'}`;
  mkdirSync(assertInside(ws, 'captions'), { recursive: true });
  writeFileSync(assertInside(ws, output), options.format === 'vtt' ? captionsToVttV3(cues) : captionsToSrtV3(cues));
  return output;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createApp(config: ApiConfig = loadConfig()) {
  const app = Fastify({ logger: true });
  const runningByProjectAndType = new Set<string>();
  const cancelledJobs = new Set<string>();
  const projectManifestMutex = new Map<string, Promise<unknown>>();
  const maxUploadBytes = Number.parseInt((process.env.ETVS_MAX_UPLOAD_BYTES || '2_147_483_648').replace(/_/g, ''), 10);

  app.register(multipart, {
    limits: {
      fileSize: maxUploadBytes,
      files: 1
    }
  });

  async function withProjectManifestMutex<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = projectManifestMutex.get(projectId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const chained = previous.then(() => current, () => current);
    projectManifestMutex.set(projectId, chained);
    await previous.catch(() => undefined);
    try { return await task(); }
    finally {
      release();
      if (projectManifestMutex.get(projectId) === chained) projectManifestMutex.delete(projectId);
    }
  }

  // P4-1c: paid-provider routes call `withInFlightProviderCall` so concurrent same-requestId
  // POSTs collapse onto one provider call, while the manifest mutex is released during the
  // actual paid call. Map lifetime is the app lifetime; per-app keeps test isolation clean.
  const { withInFlightProviderCall } = createInFlightProviderCalls();

  function updateStage(stages: UploadStage[], name: string, patch: Partial<UploadStage>): UploadStage[] {
    return stages.map((stage) => stage.name === name ? { ...stage, ...patch } : stage);
  }

  app.register(cors, {
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    origin(origin, cb) {
      if (!origin || originAllowed(origin, config.allowedOrigins)) cb(null, true);
      else {
        const err = new Error(`Origin not allowed: ${origin}`) as Error & { statusCode?: number };
        err.statusCode = 403;
        cb(err, false);
      }
    }
  });
  mkdirSync(config.workspaceRoot, { recursive: true });

  app.addHook('onRequest', async (req, reply) => {
    const url = new URL(req.raw.url || req.url, 'http://localhost');
    if (req.method === 'OPTIONS' || url.pathname.startsWith('/ws/')) return;
    // Auth model: a TCP connection arriving on loopback with NO X-Forwarded-*
    // headers is a local process — trusted, no bearer required. Anything
    // proxied by a reverse proxy in front of us (Caddy/nginx) carries
    // X-Forwarded-For and must authenticate, except for headerless-read
    // endpoints (video / peaks) the browser can't attach auth headers to.
    const remote = remoteHost(req.ip);
    const viaProxy = Boolean(req.headers['x-forwarded-for']);
    if (!viaProxy && isLocalHost(remote)) return;
    if (isHeaderlessRead(req.method, url.pathname)) return;
    if (url.searchParams.has('token')) {
      return reply.code(401).send({ error: 'Token must be in Authorization header on non-localhost; query parameter rejected for security.' });
    }
    if (!config.terminalToken || bearerToken(req.headers.authorization) !== config.terminalToken) {
      return reply.code(401).send({ error: 'Missing or invalid bearer token.' });
    }
  });

  function workspace(projectId: string) { return safeProjectPath(config.workspaceRoot, projectId); }
  void registerSettingsRoutes(app, config, workspace);
  const agentSessionsByProject = new Map<string, Set<AgentSocket>>();
  let statePushSeq = 0;

  function sendJson(socket: AgentSocket, value: unknown) { socket.send(JSON.stringify(value)); }
  function fanoutManifestChanged(projectId: string, operationIds: string[]) {
    const ws = workspace(projectId);
    const event = { type: 'manifest_changed' as const, manifestVersion: manifestContentVersion(ws), operationIds };
    for (const socket of Array.from(agentSessionsByProject.get(projectId) || [])) sendJson(socket, { kind: 'state_push', id: `state-${++statePushSeq}`, protocolVersion: socket.protocolVersion ?? 3, event });
  }

  function queueJob(projectId: string, type: JobType, body: any = {}) {
    const ws = workspace(projectId);
    const project = loadProject(ws);
    const exclusiveKey = ['render-draft', 'transcribe'].includes(type) ? `${projectId}:${type}` : null;
    if (exclusiveKey && runningByProjectAndType.has(exclusiveKey)) {
      const err = new Error(`${type} is already running for ${projectId}`) as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }
    const jobId = makeJobId(type);
    const createdAt = new Date().toISOString();
    const initialStages: UploadStage[] | undefined = type === 'render-draft' ? [{ name: 'render', status: 'queued' }] : undefined;
    appendJobStatus(ws, { jobId, projectId, type, status: 'queued', createdAt, input: { ...body }, ...(initialStages ? { stages: initialStages } : {}) });

    setImmediate(async () => {
      if (exclusiveKey) runningByProjectAndType.add(exclusiveKey);
      let stages = initialStages;
      if (stages) stages = updateStage(stages, 'render', { status: 'running', startedAt: new Date().toISOString(), phase: 'Queued', percent: 0 });
      appendJobStatus(ws, { jobId, projectId, type, status: 'running', createdAt, startedAt: new Date().toISOString(), input: { ...body }, ...(stages ? { stages } : {}) });
      try {
        let outputs: string[] = [];
        let warning: string | undefined;
        if (type === 'extract-audio') {
          const audioOutputs = await extractAllClipAudio(ws, { overwrite: Boolean(body.overwrite), logJob: false });
          outputs = audioOutputs.flatMap((output) => output.endsWith('.wav') ? [output, output.replace(/extracted-audio\.wav$/, 'peaks.json')] : [output]);
        }
        else if (type === 'peaks') {
          const results = extractAllClipWaveformPeaks(ws, { resolutionHz: Number(body.resolutionHz) || 100 });
          outputs = results.map((result) => `media/${result.clipId}/peaks.json`);
        }
        else if (type === 'transcribe') {
          // Honor the registry default STT provider when the request doesn't pin one —
          // otherwise jobs queued from the UI silently fall to mock and lose word-level
          // timing, leaving the transcript drifted vs. audio.
          let resolvedProvider = body.provider;
          if (!resolvedProvider) {
            const registry = readProviderRegistry().value;
            const sttDefault = registry.providers.find((p) => p.kind === 'stt' && p.enabled !== false && p.default);
            resolvedProvider = sttDefault?.id ?? 'mock';
          }
          const doc = await transcribeAllClips(ws, { provider: resolvedProvider });
          const clips = transcribableClips(loadManifestV3(ws));
          outputs = [
            ...clips.flatMap((clip) => [`transcript/${clip.clipId}/words.json`, `transcript/${clip.clipId}/transcript.md`]),
            'transcript/words.json',
            'transcript/transcript.md'
          ];
          appendJobStatus(ws, { jobId, projectId, type, status: 'running', createdAt, input: { provider: doc.provider } });
        } else if (type === 'validate-manifest') {
          const validation = validateWorkspaceManifest(ws);
          if (!validation.valid) throw new Error(validation.errors.join('\n'));
        } else if (type === 'render-draft') {
          let lastPercent = -1;
          outputs = [String(await withProjectManifestMutex(projectId, async () => {
            const manifest = loadManifestV3(ws);
            const fingerprint = manifestFingerprint(ws, manifest.updatedAt);
            const plan = buildRenderPlanV3(manifest, loadTranscript(ws) ?? undefined);
            if (plan.studioCleanupStale) {
              warning = STUDIO_CLEANUP_STALE_WARNING;
            }
            const result = await renderPlanV3(ws, plan, { output: 'renders/draft.mp4', overwrite: true, onProgress: (event: any) => {
              if (cancelledJobs.has(jobId)) throw new Error('Render cancelled by user');
              const percent = Math.round(event.percent);
              if (percent === lastPercent) return;
              lastPercent = percent;
              const inner = loadManifest(ws);
              const clips = inner.tracks.flatMap((track) => track.clips).map((clip) => clip.clipId);
              const index = Math.max(0, clips.indexOf(event.clipId || '')) + 1;
              const total = Math.max(clips.length, 1);
              stages = updateStage(stages || [], 'render', { status: 'running', clipId: event.clipId, phase: `Reprocessing clip ${index}/${total}`, percent });
              appendJobStatus(ws, { jobId, projectId, type, status: 'running', createdAt, input: { ...body }, stages });
            } });
            // Record the manifest fingerprint that was used as input so the freshness check
            // can converge after the user edits and re-renders. Without this, every refresh
            // saw the prior session's metadata sha256 and reported 'stale' forever — which
            // made the new auto-rerender loop launch render jobs in a tight cycle. The mutex
            // around this block guarantees the on-disk manifest matches what the renderer
            // just read (manifestFingerprint reads the same bytes), so the recorded hash
            // accurately describes the just-finished render's input.
            if (!cancelledJobs.has(jobId)) {
              const metadataPath = assertInside(ws, 'renders/render-logs/draft.mp4.metadata.json');
              mkdirSync(assertInside(ws, 'renders/render-logs'), { recursive: true });
              writeFileSync(metadataPath, JSON.stringify({
                schemaVersion: 1,
                output: 'renders/draft.mp4',
                renderedAt: new Date().toISOString(),
                manifest: fingerprint
              }, null, 2));
            }
            return result;
          }))];
        }
        else if (type === 'export-captions') outputs = [exportCaptions(ws, { format: body.format === 'vtt' ? 'vtt' : 'srt' })];
        if (cancelledJobs.has(jobId)) appendJobStatus(ws, { jobId, projectId, type, status: 'cancelled', createdAt, completedAt: new Date().toISOString(), ...(stages ? { stages: updateStage(stages, 'render', { status: 'cancelled', completedAt: new Date().toISOString() }) } : {}) });
        else appendJobStatus(ws, { jobId, projectId, type, status: 'succeeded', createdAt, completedAt: new Date().toISOString(), outputs, ...(warning ? { warning } : {}), ...(stages ? { stages: updateStage(stages, 'render', { status: 'succeeded', completedAt: new Date().toISOString(), percent: 100 }) } : {}) });
      } catch (err) {
        const cancelled = cancelledJobs.has(jobId) || errorMessage(err).toLowerCase().includes('cancelled');
        appendJobStatus(ws, { jobId, projectId, type, status: cancelled ? 'cancelled' : 'failed', createdAt, completedAt: new Date().toISOString(), error: cancelled ? undefined : errorMessage(err), ...(stages ? { stages: updateStage(stages, 'render', { status: cancelled ? 'cancelled' : 'failed', completedAt: new Date().toISOString(), error: cancelled ? undefined : errorMessage(err) }) } : {}) });
      } finally {
        if (exclusiveKey) runningByProjectAndType.delete(exclusiveKey);
        cancelledJobs.delete(jobId);
      }
    });

    return latestJob(ws, jobId)!;
  }

  function agentSessions(projectId: string) {
    const existing = agentSessionsByProject.get(projectId);
    if (existing) return existing;
    const next = new Set<AgentSocket>();
    agentSessionsByProject.set(projectId, next);
    return next;
  }

  async function runAgentTool(projectId: string, call: ToolCallMessage): Promise<{ response: ToolResponse; changedOperationIds: string[]; manifestChanged: boolean }> {
    const ws = workspace(projectId);
    const tool = call.tool;
    const schema = ToolParamsSchemaByName[tool];
    const parsed = schema.safeParse(call.params);
    if (!parsed.success) throw toolError('invalid_range', 'Invalid tool params', 400, manifestContentVersion(ws), parsed.error.issues);
    const params = parsed.data as any;
    if (!isCoreAgentTool(tool) && !apiWrappedAgentTools.has(tool)) throw toolError('internal_error', `Unsupported agent tool on v3 API surface: ${tool}`, 400, manifestContentVersion(ws));
    const mutating = isMutatingAgentTool(tool);
    if (mutating && typeof params.requestId !== 'string') throw toolError('internal_error', 'Mutating tools require requestId', 400, manifestContentVersion(ws));
    if (mutating) {
      const records = readAgentIdempotency(ws);
      const bodyHash = requestBodyHash(tool, params);
      const existing = records[params.requestId];
      if (existing) {
        if (existing.tool !== tool || existing.bodyHash !== bodyHash) throw toolError('request_id_conflict', 'requestId already used with a different body', 409, manifestContentVersion(ws));
        return { response: existing.response, changedOperationIds: [], manifestChanged: false };
      }
      const currentVersion = manifestContentVersion(ws);
      if (params.expectedManifestVersion && params.expectedManifestVersion !== currentVersion) throw toolError('stale_manifest', 'expectedManifestVersion does not match current manifest', 409, currentVersion);
      const result = await executeAgentTool(projectId, tool, params);
      records[params.requestId] = { tool, bodyHash, response: result.response };
      writeAgentIdempotency(ws, records);
      return { ...result, manifestChanged: manifestContentVersion(ws) !== currentVersion };
    }
    return { ...(await executeAgentTool(projectId, tool, params)), manifestChanged: false };
  }

  async function executeAgentTool(projectId: string, tool: ToolName, params: any): Promise<{ response: ToolResponse; changedOperationIds: string[] }> {
    const ws = workspace(projectId);
    const version = () => manifestContentVersion(ws);
    const coreContext = {
      workspacePath: ws,
      loadManifest: () => loadManifest(ws),
      saveManifest: (manifest: ManifestV3, options?: { revision?: boolean }) => saveManifest(ws, manifest, options?.revision ?? true)
    };
    if (tool === 'propose_operation' && params.type === 'voice_patch') {
      if (typeof params.text !== 'string' || !params.text.trim()) throw toolError('invalid_range', 'voice_patch requires text', 400, version());
      if (typeof params.provider !== 'string' || typeof params.voice !== 'string') throw toolError('unsupported_provider', 'voice_patch requires provider and voice', 400, version());
      try { assertSpeechProviderSupported(params.provider); }
      catch (err) { throw toolError('unsupported_provider', err instanceof Error ? err.message : `Unsupported speech provider: ${params.provider}`, 400, version()); }
      const requestId = params.requestId;
      const text = params.text.trim();
      const language = params.language || 'en';
      const start = params.target?.kind === 'clip-span' ? params.target.start : 0;
      const end = params.target?.kind === 'clip-span' ? params.target.end : start;
      // Compute the canonical voiceRef from the agent's bare provider/voice transport so the
      // op persists with the same { providerId, voiceId } shape browser-created ops do. The
      // schema rejects e.g. providerId starting with 'image-gen.', protecting against agent
      // payloads that route a non-TTS provider through this tool.
      const agentProviderId = params.provider.includes('.') ? params.provider : `tts.${params.provider}`;
      let agentVoiceRef: { providerId: string; voiceId: string } | undefined;
      try { agentVoiceRef = VoiceReferenceSchema.parse({ providerId: agentProviderId, voiceId: params.voice }); }
      catch { throw toolError('unsupported_provider', `voice_patch voiceRef invalid for ${params.provider}/${params.voice}`, 400, version()); }
      const agentModel = typeof params.model === 'string' && params.model.trim() ? params.model.trim() : undefined;
      const { result, changedOperationIds } = runAgentToolV3(coreContext, tool, { ...params, text, status: 'proposed', providerRequestId: requestId, voiceRef: agentVoiceRef, reason: params.reason || `Replacement speech via ${params.provider}/${params.voice}` });
      const operation = (result as any).operation;
      appendProviderRequestEvent(ws, baseProviderEvent({ requestId, projectId, provider: params.provider, voice: params.voice, language, text, operationId: operation.id, status: 'approved', start, end }));
      try {
        // Parity with the browser path (manifestRoutes): pass surrounding transcript text so the
        // agent's voice_patch gets the same TTS context. Previously omitted — agent-created patches
        // synthesized with no previous/next text and read worse than browser-created ones.
        const clipId = params.target?.kind === 'clip-span' ? params.target.clipId : '';
        const transcriptWords = loadTranscript(ws)?.words ?? [];
        const { previousText, nextText } = extractSurroundingTranscriptText(transcriptWords, clipId ?? '', start, end);
        const granularity = params.granularity === 'word' || params.granularity === 'phrase' || params.granularity === 'sentence' ? params.granularity : undefined;
        const speech = await synthesizeReplacementSpeech(ws, { text, provider: params.provider, voice: params.voice, language, requestId, projectId, operationId: operation.id, ...(agentModel ? { model: agentModel } : {}), ...(previousText ? { previousText } : {}), ...(nextText ? { nextText } : {}), ...(granularity ? { granularity } : {}) });
        const generated = ffprobeDurationSec(assertInside(ws, speech.asset));
        const requested = end - start;
        const durationWarning = voicePatchDurationWarning(generated, requested);
        const updated = updateManifestOperation(ws, operation.id, { status: 'approved', asset: speech.asset, providerRequestId: requestId, durationGeneratedSec: generated, durationRequestedSec: requested, ...(durationWarning ? { durationWarning } : {}), ...(speech.seamBaked ? { seamBaked: true } : {}) });
        return { response: { result: { operation: updated, providerRequestId: requestId, asset: speech.asset }, manifestVersion: version() }, changedOperationIds };
      } catch (err) {
        updateManifestOperation(ws, operation.id, { status: 'rejected', reason: err instanceof Error ? err.message : String(err) });
        const request = latestProviderRequest(ws, requestId);
        throw toolError('paid_provider_failed', request?.error || (err instanceof Error ? err.message : String(err)), 500, version());
      }
    }
    if (tool === 'approve_operation') {
      const operation = loadManifest(ws).operations.find((op) => op.id === params.operationId);
      if (!operation) throw toolError('operation_not_found', 'Operation not found', 404, version());
      let result: any;
      if (operation.status === 'proposed') result = runAgentToolV3(coreContext, tool, params).result;
      else throw toolError('operation_not_approvable', 'Operation is not approvable', 409, version());
      return { response: { result, manifestVersion: version() }, changedOperationIds: [operation.id] };
    }
    if (tool === 'render_draft') {
      const project = loadProject(ws);
      if (!project.status.imported) throw toolError('source_missing', 'Source media missing', 409, version());
      const job = queueJob(projectId, 'render-draft', { type: 'render-draft' });
      return { response: { result: { job }, manifestVersion: version() }, changedOperationIds: [] };
    }
    if (isCoreAgentTool(tool)) {
      const { result, changedOperationIds } = runAgentToolV3(coreContext, tool, params);
      return { response: { result: result as ToolResponse['result'], manifestVersion: version() }, changedOperationIds };
    }
    throw toolError('internal_error', `Unhandled tool ${tool}`, 500, version());
  }

  const routeContext: LocalApiRouteContext = {
    app,
    config,
    workspace,
    maxUploadBytes,
    withProjectManifestMutex,
    withInFlightProviderCall,
    updateStage,
    queueJob,
    addManifestOperation,
    addVoicePatchOperation,
    updateManifestOperation,
    loadManifest,
    saveManifest,
    validateWorkspaceManifest,
    validateManifestDocument,
    clipTarget,
    fileInfo,
    parseRange,
    contentType,
    draftRenderFreshness,
    peaksFreshness,
    baseProviderEvent,
    providerBodyHash,
    providerExecutionShape,
    voicePatchDurationWarning,
    errorMessage
  };
  registerProjectRoutes(routeContext);
  registerAssetRoutes(routeContext);
  registerManifestRoutes(routeContext);
  registerStructureRoutes(routeContext);
  registerJobRoutes(routeContext, cancelledJobs);
  registerStudioCleanupRoutes(routeContext);

  app.register(async (wsApp) => {
    await wsApp.register(websocket);
    wsApp.get('/ws/projects/:projectId/agent/:sessionId', { websocket: true }, (socket: any, req: any) => {
    const peer = (() => {
      const candidates = [socket, (socket as any).ws, (socket as any).socket, (socket as any).connection];
      const found = candidates.find((candidate) => candidate && typeof candidate.send === 'function');
      if (found) return found;
      throw new TypeError(`Agent WebSocket handler received unsupported socket shape: ${Object.keys(socket || {}).join(',')}`);
    })() as AgentSocket & { on: (event: string, cb: (...args: any[]) => void) => void; close: () => void };
    const headers = req.raw?.headers || req.headers || {};
    const origin = headers.origin === 'null' ? undefined : headers.origin;
    const host = String(headers.host || '127.0.0.1').split(':')[0];
    const url = new URL(req.raw?.url || req.url, `http://${headers.host || '127.0.0.1'}`);
    if (!config.enableAgent && !config.enableTerminal) {
      peer.send(JSON.stringify({ kind: 'tool_error', id: 'agent-disabled', protocolVersion: 2, ok: false, error: toolError('internal_error', 'Agent WebSocket disabled. Restart API with ETVS_ENABLE_AGENT=1 or ETVIDEO_ENABLE_TERMINAL=1 and a terminal token.', 403) }));
      peer.close();
      return;
    }
    const viaProxy = Boolean(headers['x-forwarded-for']);
    const hostAcceptable = isLocalHost(host) || viaProxy;
    if ((isLocalHost(config.host) && !hostAcceptable) || !originAllowed(origin, config.allowedOrigins)) {
      peer.send(JSON.stringify({ kind: 'tool_error', id: 'agent-refused', protocolVersion: 2, ok: false, error: toolError('internal_error', 'Agent refused: non-local host or origin not allowed.', 403) }));
      peer.close();
      return;
    }
    if (!config.terminalToken || String(req.query?.token || url.searchParams.get('token') || '') !== config.terminalToken) {
      peer.send(JSON.stringify({ kind: 'tool_error', id: 'agent-token', protocolVersion: 2, ok: false, error: toolError('internal_error', 'Agent refused: missing or invalid local admin token.', 403) }));
      peer.close();
      return;
    }
    const projectId = req.params.projectId;
    const ws = workspace(projectId);
    try { loadProject(ws); } catch (err) {
      peer.send(JSON.stringify({ kind: 'tool_error', id: 'agent-project', protocolVersion: 2, ok: false, error: toolError('project_not_found', err instanceof Error ? err.message : String(err), 404) }));
      peer.close();
      return;
    }
    agentSessions(projectId).add(peer);
    peer.on('message', async (message: any) => {
      let parsed;
      try { parsed = ClientMessageSchema.parse(JSON.parse(message.toString())); }
      catch (err) {
        sendJson(peer, { kind: 'tool_error', id: `error-${Date.now()}`, protocolVersion: 2, ok: false, error: toolError('internal_error', 'Invalid agent protocol message', 400, manifestContentVersion(ws), err instanceof Error ? err.message : String(err)) });
        return;
      }
      if (parsed.kind === 'hello') {
        peer.protocolVersion = parsed.protocolVersion;
        sendJson(peer, { kind: 'ready', id: parsed.id, protocolVersion: parsed.protocolVersion, sessionId: req.params.sessionId, projectId, manifestVersion: manifestContentVersion(ws) });
        return;
      }
      if (parsed.kind === 'cancel') {
        sendJson(peer, { kind: 'tool_error', id: parsed.id, protocolVersion: parsed.protocolVersion, callId: parsed.callId, ok: false, error: toolError('internal_error', `Cancel is not implemented in protocol v${parsed.protocolVersion}`, 400, manifestContentVersion(ws)) });
        return;
      }
      try {
        const { response, changedOperationIds, manifestChanged } = await runAgentTool(projectId, parsed);
        sendJson(peer, { kind: 'tool_result', id: parsed.id, protocolVersion: parsed.protocolVersion, callId: parsed.id, ok: true, result: response });
        if (manifestChanged) fanoutManifestChanged(projectId, changedOperationIds);
      } catch (err) {
        const error = typeof err === 'object' && err && 'code' in err ? err as ToolError : toolError('internal_error', err instanceof Error ? err.message : String(err), 500, manifestContentVersion(ws));
        sendJson(peer, { kind: 'tool_error', id: parsed.id, protocolVersion: parsed.protocolVersion, callId: parsed.id, ok: false, error });
      }
    });
    peer.on('close', () => agentSessionsByProject.get(projectId)?.delete(peer));
   });

  wsApp.get('/ws/projects/:projectId/terminal/:sessionId', { websocket: true }, (socket, req: any) => {
    const headers = req.raw?.headers || req.headers || {};
    const origin = headers.origin === 'null' ? undefined : headers.origin;
    const host = String(headers.host || '127.0.0.1').split(':')[0];
    const url = new URL(req.raw?.url || req.url, `http://${headers.host || '127.0.0.1'}`);
    if (!config.enableTerminal) {
      socket.send('Terminal disabled. Restart API with ETVIDEO_ENABLE_TERMINAL=1, ETVIDEO_TERMINAL_TOKEN, while bound to localhost.');
      socket.close();
      return;
    }
    const viaProxy = Boolean(headers['x-forwarded-for']);
    if ((!isLocalHost(host) && !viaProxy) || !originAllowed(origin, config.allowedOrigins)) {
      socket.send('Terminal refused: non-local host or origin not allowed.');
      socket.close();
      return;
    }
    if (!config.terminalToken || String(req.query?.token || url.searchParams.get('token') || '') !== config.terminalToken) {
      socket.send('Terminal refused: missing or invalid local admin token.');
      socket.close();
      return;
    }
    const ws = workspace(req.params.projectId);
    loadProject(ws); // verifies the project exists before shell spawn.
    mkdirSync(join(ws, 'logs'), { recursive: true });
    const shell = process.env.SHELL || '/bin/bash';
    const child = spawn(shell, ['-l'], { cwd: ws, env: { ...process.env, ETVIDEO_WORKSPACE: ws } });
    const started = `terminal ${req.params.sessionId} started ${new Date().toISOString()} cwd=${ws}\n`;
    appendFileSync(join(ws, 'logs/terminal.log'), started);
    socket.send(`Connected to ${basename(ws)} (${ws})\n$ `);
    child.stdout.on('data', (chunk) => { const text = chunk.toString(); appendFileSync(join(ws, 'logs/terminal.log'), text); socket.send(text); });
    child.stderr.on('data', (chunk) => { const text = chunk.toString(); appendFileSync(join(ws, 'logs/terminal.log'), text); socket.send(text); });
    socket.on('message', (message: any) => child.stdin.write(message.toString()));
    socket.on('close', () => { appendFileSync(join(ws, 'logs/terminal.log'), `\nterminal ${req.params.sessionId} closed ${new Date().toISOString()}\n`); child.kill(); });
  });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = createApp(config);
  app.listen({ host: config.host, port: config.port }).then(() => {
    if (config.host !== '127.0.0.1') {
      app.log.warn(`[ETVS LAN MODE] Binding ${config.host}:${config.port} — token gate mandatory. Allowed origins: ${config.lanOrigins.length ? config.lanOrigins.join(', ') : '(none)'}. Other devices on your LAN can now reach this API.`);
    }
    app.log.info(`ETVideo API on http://${config.host}:${config.port}`);
  });
}
