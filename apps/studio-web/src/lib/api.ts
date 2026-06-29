import type { AssetV3, ClipV3, ManifestV3, OperationTargetV3, OperationV3, OutputV3, ProviderRequestCostSummary, ProviderRequestCostSummaryRow, StudioCleanup, TrackV3 } from '@etvideoscript/core/browser';

// When NEXT_PUBLIC_ETVS_API_URL (or legacy NEXT_PUBLIC_ETVIDEO_API_URL) is
// set, treat it as the absolute API origin (split-host mode). When empty,
// fall back to the page's own origin so a TLS reverse proxy (Caddy etc.)
// can route /api/* without rebuilding the web bundle. SSR falls back to
// loopback.
const envApi = process.env.NEXT_PUBLIC_ETVS_API_URL || process.env.NEXT_PUBLIC_ETVIDEO_API_URL;
export const API = envApi || (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:4317');
const TOKEN = process.env.NEXT_PUBLIC_ETVS_TERMINAL_TOKEN || process.env.NEXT_PUBLIC_ETVIDEO_TERMINAL_TOKEN;

function authHeader(): Record<string, string> {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: string | { code?: string; message?: string } };
    const error = parsed.error;
    if (typeof error === 'string') return error;
    if (error?.code || error?.message) return `${error.code || 'error'}: ${error.message || text}`;
  } catch {}
  return text;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // Use the Headers API so case-insensitive lookups work and callers can pass
  // a Headers instance or tuple array (HeadersInit) without losing entries.
  // Fastify rejects requests with Content-Type: application/json and an empty
  // body (FST_ERR_CTP_EMPTY_JSON_BODY), so only declare the JSON content-type
  // when we're actually sending a body.
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(authHeader())) headers.set(k, v);
  if (init?.body != null && !headers.has('content-type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${API}${path}`, { ...init, headers, cache: 'no-store' });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { ...authHeader(), ...(init?.headers || {}) },
    cache: 'no-store'
  });
}

export type ProviderKind = 'stt' | 'tts' | 'studio-sound' | 'image-gen' | 'video-gen' | 'music-gen';
export type ProviderTier = 'local' | 'paid';
export type ProviderRecord = {
  schemaVersion?: number;
  id: string;
  kind: ProviderKind;
  name: string;
  tier: ProviderTier;
  baseUrl?: string;
  secretRef?: string;
  model?: string;
  default?: boolean;
  enabled?: boolean;
  costPerUnit?: { currency: string; unit: string; amount: number };
  source?: 'manual' | 'env-import';
  createdAt?: string;
  updatedAt?: string;
};
export type SettingsSnapshot = { updatedAt: string | null; mtimeMs: number | null; hash: string | null };
export type SettingsState = {
  registry: { providers: ProviderRecord[]; updatedAt: string };
  snapshot: SettingsSnapshot;
  secrets: { path: string; displayPath: string; chmod: string | null; plaintext: boolean; keys: string[] };
};
export type VoiceReference = { providerId: string; voiceId: string };
export type TaskOptions = { tts: { defaultVoice?: VoiceReference }; fillerWords?: string[] };
export type WorkspaceSettings = { schemaVersion: 1; defaults: Partial<Record<ProviderKind, string>>; paidCaps: Record<string, number>; taskOptions: TaskOptions; updatedAt: string };
export type VoiceRecord = { schemaVersion: 1; id: string; name: string; provider: 'elevenlabs'; voiceId: string; sampleAssetPath?: string; originProjectId?: string; createdAt: string; updatedAt: string };
export type VoicesFile = { schemaVersion: 1; voices: VoiceRecord[]; updatedAt: string };
export type ProjectSummary = { projectId: string; title: string; workspacePath: string };
export type CostSummaryRow = ProviderRequestCostSummaryRow;
export type CostSummary = ProviderRequestCostSummary;

export type TranscriptWord = { id: string; text: string; start: number; end: number; segmentId: string; speaker: string; confidence?: number; clipId?: string };
export type TranscriptSegment = { id?: string; segmentId?: string; speaker?: string; start?: number; end?: number; text?: string };
export type TranscriptDoc = { words: TranscriptWord[]; segments?: TranscriptSegment[]; provider?: { name?: string; timing?: string }; durationSec?: number };
export type JobStage = { name: string; status: string; clipId?: string; phase?: string; percent?: number; error?: string; completedAt?: string };
export type Job = { jobId: string; type: string; status: 'queued' | 'running' | 'waiting_for_approval' | 'succeeded' | 'failed' | 'cancelled'; stages?: JobStage[]; outputs?: string[]; error?: string; createdAt: string; completedAt?: string };
export type FileState = { path: string; exists: boolean; size: number; updatedAt?: string };
export type RenderFreshness = { state: 'missing' | 'rendering' | 'fresh' | 'stale' | 'error'; reason: string; output?: string; updatedAt?: string; manifestUpdatedAt?: string; jobId?: string };
export type Diagnostics = {
  projectId: string;
  title?: string;
  workspacePath: string;
  doctor: { ffmpeg: boolean; ffprobe: boolean; node: string };
  validation: { valid: boolean; errors: string[]; warnings: string[] };
  files: Record<string, FileState>;
  renderFreshness?: { draft: RenderFreshness };
  peaksFreshness?: { state: string; reason: string; output?: string; updatedAt?: string; audioUpdatedAt?: string };
  status?: Record<string, unknown>;
  transcript: null | { words: number; segments: number; timing: string; provider: string };
  manifest: { operations: number };
  providerRequests: null | Array<Record<string, unknown>>;
  jobs: null | { recent: Job[] };
  liveOverdubDisabled?: boolean;
  errors: Record<string, string>;
};
export type ProjectDetail = { project: { projectId: string; title: string; workspacePath?: string; status?: Record<string, unknown>; source?: { durationSec?: number } }; manifest: ManifestV3; validation: unknown; transcript: TranscriptDoc | null; jobs: Job[] };
export type ProviderRequestsResponse = { providerRequests: Array<Record<string, unknown>>; costSummary: CostSummary };
export type StructureResponse<T = Record<string, unknown>> = T & { manifest: ManifestV3; validation: unknown };
export type AddTrackInput = Omit<TrackV3, 'clips'> & { clips?: ClipV3[] };
export type OperationResponse<T = OperationV3> = { operation: T; manifest: ManifestV3; validation: unknown; providerRequestId?: string; request?: Record<string, unknown> };
export type CreateOperationInput = { type: Exclude<OperationV3['type'], 'voice_patch'>; target: OperationTargetV3; reason?: string; status?: OperationV3['status']; [key: string]: unknown };
export type UpdateOperationInput = { status?: OperationV3['status']; start?: number; end?: number; reason?: string; text?: string; draftText?: string };
export type CreateVoicePatchInput = { clipId?: string; start: number; end: number; text: string; provider?: string; voice?: string; model?: string; voiceRef?: VoiceReference; language?: string; reason?: string; requestId?: string };
export type GenerationKind = 'image-gen' | 'video-gen' | 'music-gen';
export type CreateGenerationInput = { kind: GenerationKind; prompt: string; provider?: string; requestId?: string; count?: number; aspectRatio?: string; resolution?: string; durationSec?: number; durationMs?: number; model?: string };
export type GenerationResponse = StructureResponse<{ asset?: Record<string, unknown>; providerRequestId: string; request?: Record<string, unknown>; jobId?: string }>;
export type GenerationEstimate = {
  providerId: string;
  providerName: string;
  tier: 'local' | 'paid';
  configured: boolean;
  cost: { currency: string; estimated: number | null; actual: number | null } | null;
  defaults: { count: number; durationSec: number; durationMs: number };
};

export function getProjects() { return api<{ projects: ProjectSummary[] }>('/api/projects'); }
export function getProject(projectId: string) { return api<ProjectDetail>(`/api/projects/${encodeURIComponent(projectId)}`); }
export function getProjectDiagnostics(projectId: string) { return api<{ diagnostics: Diagnostics }>(`/api/projects/${encodeURIComponent(projectId)}/diagnostics`); }
export function getProjectJobs(projectId: string) { return api<{ jobs: Job[] }>(`/api/projects/${encodeURIComponent(projectId)}/jobs`); }
export function getProjectJob(projectId: string, jobId: string) { return api<{ job: Job; events?: unknown[] }>(`/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`); }
export function getProjectManifest(projectId: string) { return api<{ manifest: ManifestV3; validation: unknown }>(`/api/projects/${encodeURIComponent(projectId)}/manifest`); }
export function triggerRenderDraft(projectId: string) { return api<{ job: Job }>(`/api/projects/${encodeURIComponent(projectId)}/jobs`, { method: 'POST', body: JSON.stringify({ type: 'render-draft' }) }); }
export function triggerTranscribe(projectId: string) { return api<{ job: Job }>(`/api/projects/${encodeURIComponent(projectId)}/jobs`, { method: 'POST', body: JSON.stringify({ type: 'transcribe' }) }); }
export function cancelJob(projectId: string, jobId: string) { return api<{ job: Job }>(`/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }); }
export function getProviderRequestSummary(projectId: string) { return api<ProviderRequestsResponse>(`/api/projects/${encodeURIComponent(projectId)}/provider-requests`); }

const projectPath = (projectId: string, suffix: string) => `/api/projects/${encodeURIComponent(projectId)}${suffix}`;
export function addTrack(projectId: string, track: AddTrackInput) { return api<StructureResponse<{ track: TrackV3 }>>(projectPath(projectId, '/tracks'), { method: 'POST', body: JSON.stringify(track) }); }
export function removeTrack(projectId: string, trackId: string) { return api<StructureResponse<{ track: TrackV3 }>>(projectPath(projectId, `/tracks/${encodeURIComponent(trackId)}`), { method: 'DELETE' }); }
export function patchTrack(projectId: string, trackId: string, patch: Partial<Pick<TrackV3, 'name' | 'locked' | 'muted' | 'solo' | 'hidden' | 'fx'>>) { return api<StructureResponse<{ track: TrackV3 }>>(projectPath(projectId, `/tracks/${encodeURIComponent(trackId)}`), { method: 'PATCH', body: JSON.stringify(patch) }); }
export function reorderTracks(projectId: string, order: { trackId: string; order: number }[]) { return api<StructureResponse<{ tracks: TrackV3[] }>>(projectPath(projectId, '/tracks/reorder'), { method: 'POST', body: JSON.stringify({ order }) }); }
export function addClip(projectId: string, trackId: string, clip: ClipV3) { return api<StructureResponse<{ clip: ClipV3 }>>(projectPath(projectId, '/clips'), { method: 'POST', body: JSON.stringify({ trackId, clip }) }); }
export function patchClip(projectId: string, clipId: string, patch: Partial<Pick<ClipV3, 'timelineStart' | 'sourceStart' | 'sourceEnd'>>) { return api<StructureResponse<{ clip: ClipV3 }>>(projectPath(projectId, `/clips/${encodeURIComponent(clipId)}`), { method: 'PATCH', body: JSON.stringify(patch) }); }
export function removeClip(projectId: string, clipId: string) { return api<StructureResponse<{ clip: ClipV3 }>>(projectPath(projectId, `/clips/${encodeURIComponent(clipId)}`), { method: 'DELETE' }); }
export function detachAudio(projectId: string, clipId: string, detachedClipId?: string) { return api<StructureResponse<{ videoClip: ClipV3; audioClip: ClipV3; audioTrack: TrackV3; asset: AssetV3 }>>(projectPath(projectId, `/clips/${encodeURIComponent(clipId)}/detach-audio`), { method: 'POST', body: JSON.stringify({ detachedClipId }) }); }
export function addAsset(projectId: string, asset: AssetV3) { return api<StructureResponse<{ asset: AssetV3 }>>(projectPath(projectId, '/assets'), { method: 'POST', body: JSON.stringify(asset) }); }
export function patchAsset(projectId: string, assetId: string, patch: Partial<Omit<AssetV3, 'assetId'>>) { return api<StructureResponse<{ asset: AssetV3 }>>(projectPath(projectId, `/assets/${encodeURIComponent(assetId)}`), { method: 'PATCH', body: JSON.stringify(patch) }); }
export function removeAsset(projectId: string, assetId: string) { return api<StructureResponse<{ asset: AssetV3 }>>(projectPath(projectId, `/assets/${encodeURIComponent(assetId)}`), { method: 'DELETE' }); }
export function setBrandPack(projectId: string, brandPackId: string | null) { return api<StructureResponse<{ brandPackId: string | null }>>(projectPath(projectId, '/brand-pack'), { method: 'PUT', body: JSON.stringify({ brandPackId }) }); }
export function getOutputs(projectId: string) { return api<StructureResponse<{ outputs: OutputV3[] }>>(projectPath(projectId, '/outputs')); }
export function addOutput(projectId: string, output: OutputV3) { return api<StructureResponse<{ output: OutputV3; outputs: OutputV3[] }>>(projectPath(projectId, '/outputs'), { method: 'POST', body: JSON.stringify(output) }); }
export function patchOutput(projectId: string, outputId: string, patch: Partial<Omit<OutputV3, 'outputId'>>) { return api<StructureResponse<{ output: OutputV3; outputs: OutputV3[] }>>(projectPath(projectId, `/outputs/${encodeURIComponent(outputId)}`), { method: 'PATCH', body: JSON.stringify(patch) }); }
export function removeOutput(projectId: string, outputId: string) { return api<StructureResponse<{ output: OutputV3; outputs: OutputV3[] }>>(projectPath(projectId, `/outputs/${encodeURIComponent(outputId)}`), { method: 'DELETE' }); }
export function proposeOutputs(projectId: string) { return api<StructureResponse<{ outputs: OutputV3[] }>>(projectPath(projectId, '/outputs/propose'), { method: 'POST' }); }
export function createOperation(projectId: string, operation: CreateOperationInput) { return api<OperationResponse>(projectPath(projectId, '/manifest/operations'), { method: 'POST', body: JSON.stringify(operation) }); }
export function createVoicePatch(projectId: string, input: CreateVoicePatchInput) { return api<OperationResponse>(projectPath(projectId, '/manifest/voice-patches'), { method: 'POST', body: JSON.stringify(input) }); }
export async function speechToSpeechVoicePatch(projectId: string, formData: FormData): Promise<OperationResponse> {
  const res = await apiFetch(projectPath(projectId, '/manifest/voice-patches/speech-to-speech'), { method: 'POST', body: formData });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json() as Promise<OperationResponse>;
}
export function createGeneration(projectId: string, input: CreateGenerationInput) { return api<GenerationResponse>(projectPath(projectId, '/assets/generations'), { method: 'POST', body: JSON.stringify(input) }); }
export function getGenerationEstimate(projectId: string, kind: GenerationKind, params: { provider?: string; count?: number; durationSec?: number; durationMs?: number } = {}) {
  const qs = new URLSearchParams({ kind });
  if (params.provider) qs.set('provider', params.provider);
  if (params.count != null) qs.set('count', String(params.count));
  if (params.durationSec != null) qs.set('durationSec', String(params.durationSec));
  if (params.durationMs != null) qs.set('durationMs', String(params.durationMs));
  return api<GenerationEstimate>(projectPath(projectId, `/assets/generations/estimate?${qs.toString()}`));
}
export function patchOperation(projectId: string, operationId: string, patch: UpdateOperationInput) { return api<OperationResponse>(projectPath(projectId, `/manifest/operations/${encodeURIComponent(operationId)}`), { method: 'PATCH', body: JSON.stringify(patch) }); }
export function disableOperation(projectId: string, operationId: string, reason?: string) { return api<OperationResponse>(projectPath(projectId, `/manifest/operations/${encodeURIComponent(operationId)}`), { method: 'DELETE', body: JSON.stringify({ reason }) }); }
export async function uploadVideoAsset(projectId: string, file: File) {
  const form = new FormData();
  form.append('file', file);
  const res = await apiFetch(projectPath(projectId, '/assets/video'), { method: 'POST', body: form });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json() as Promise<{ clipId: string; jobId: string }>;
}

export async function uploadRecordingAsset(projectId: string, blob: Blob, source: 'screen' | 'cam' | 'voice', durationSec: number) {
  const form = new FormData();
  form.append('source', source);
  form.append('durationSec', String(durationSec));
  form.append('file', blob, `recording-${source}.${blob.type.includes('webm') ? 'webm' : blob.type.includes('ogg') ? 'ogg' : blob.type.includes('wav') ? 'wav' : 'mp4'}`);
  const res = await apiFetch(projectPath(projectId, '/assets/recordings'), { method: 'POST', body: form });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json() as Promise<{ clipId: string; jobId: string }>;
}

export function getSettingsProviders() { return api<SettingsState>('/api/settings/providers'); }
export function saveProvider(provider: ProviderRecord) {
  const method = provider.createdAt ? 'PUT' : 'POST';
  const path = method === 'PUT' ? `/api/settings/providers/${encodeURIComponent(provider.id)}` : '/api/settings/providers';
  return api<{ provider: ProviderRecord }>(path, { method, body: JSON.stringify(provider) });
}
export function removeProvider(id: string) { return api<{ provider: ProviderRecord }>(`/api/settings/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
export function setProviderDefault(provider: ProviderRecord, acknowledgePaid: boolean) { return api<{ provider: ProviderRecord }>(`/api/settings/providers/${encodeURIComponent(provider.id)}/default`, { method: 'POST', body: JSON.stringify({ kind: provider.kind, acknowledgePaid }) }); }
export function testProvider(id: string) { return api<{ providerId: string; result: { ok: boolean; status: number; checkedAt: string } }>(`/api/settings/providers/${encodeURIComponent(id)}/test`, { method: 'POST' }); }
export function setSecret(ref: string, value: string) { return api<Pick<SettingsState, 'secrets'>>(`/api/settings/secrets/${encodeURIComponent(ref)}`, { method: 'PUT', body: JSON.stringify({ value }) }); }
export function deleteSecret(ref: string) { return api<Pick<SettingsState, 'secrets'>>(`/api/settings/secrets/${encodeURIComponent(ref)}`, { method: 'DELETE' }); }
export function getVoices(): Promise<{ voices: VoiceRecord[] }> { return api<{ voices: VoiceRecord[] }>('/api/settings/voices'); }
export function addVoice(voice: Omit<VoiceRecord, 'schemaVersion' | 'createdAt' | 'updatedAt'>): Promise<{ voice: VoiceRecord }> { return api<{ voice: VoiceRecord }>('/api/settings/voices', { method: 'POST', body: JSON.stringify(voice) }); }
export async function cloneVoice(formData: FormData): Promise<{ voice: VoiceRecord }> {
  const res = await apiFetch('/api/settings/voices/clone', { method: 'POST', body: formData });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json() as Promise<{ voice: VoiceRecord }>;
}
export async function enrollVoice(formData: FormData): Promise<{ voice: VoiceRecord; sampleCount: number }> {
  const res = await apiFetch('/api/settings/voices/enroll', { method: 'POST', body: formData });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json() as Promise<{ voice: VoiceRecord; sampleCount: number }>;
}
export function renameVoice(id: string, name: string): Promise<{ voice: VoiceRecord }> { return api<{ voice: VoiceRecord }>(`/api/settings/voices/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }); }
export function deleteVoice(id: string): Promise<{ voice: VoiceRecord }> { return api<{ voice: VoiceRecord }>(`/api/settings/voices/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
export function getWorkspaceSettings(projectId: string) { return api<{ settings: WorkspaceSettings; snapshot: SettingsSnapshot }>(`/api/settings/workspace/${encodeURIComponent(projectId)}`); }
export function putWorkspaceSettings(projectId: string, settings: WorkspaceSettings, expected?: SettingsSnapshot) { return api<{ settings: WorkspaceSettings; snapshot: SettingsSnapshot }>(`/api/settings/workspace/${encodeURIComponent(projectId)}`, { method: 'PUT', body: JSON.stringify({ settings, expected }) }); }

// Re-export for callers that need the type without importing core directly.
export type { StudioCleanup };

export type StudioCleanupResponse = {
  studioCleanup: StudioCleanup;
  manifest: ManifestV3;
  validation: unknown;
  /** Human-readable cost disclosure, e.g. "ElevenLabs Voice Isolator — ~$0.14 for 85s of audio" */
  costDisclosure: string;
  /** true if the cleaned asset already existed and no paid call was made */
  cached: boolean;
};

export type StudioCleanupDisableResponse = {
  studioCleanup: StudioCleanup | null;
  manifest: ManifestV3;
  validation: unknown;
};

/**
 * Run (or reuse cached) ElevenLabs Voice Isolator over the project's base
 * audio and set manifest.studioCleanup. Returns the updated manifest.
 *
 * Paid-services policy: configuring ElevenLabs is consent; estimated cost is
 * in the `costDisclosure` field of the response. No per-call modal required.
 */
export function runStudioCleanup(projectId: string, requestId?: string): Promise<StudioCleanupResponse> {
  return api<StudioCleanupResponse>(
    projectPath(projectId, '/manifest/studio-cleanup'),
    { method: 'POST', body: JSON.stringify({ ...(requestId ? { requestId } : {}) }) }
  );
}

/**
 * Disable (revert) the project's studio cleanup. Sets studioCleanup.status to
 * 'disabled' — the cleaned asset is retained; re-POSTing is free (cache hit).
 */
export function disableStudioCleanup(projectId: string): Promise<StudioCleanupDisableResponse> {
  return api<StudioCleanupDisableResponse>(projectPath(projectId, '/manifest/studio-cleanup'), { method: 'DELETE' });
}
