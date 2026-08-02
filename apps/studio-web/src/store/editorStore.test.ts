import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    getProject: vi.fn(),
    getProjectDiagnostics: vi.fn(),
    getProjectJob: vi.fn(),
    getProviderRequestSummary: vi.fn(),
    createVoicePatch: vi.fn(),
    createGeneration: vi.fn(),
    uploadRecordingAsset: vi.fn(),
    // refresh() re-derives the voice status; stub it so these tests never touch the network.
    getVoiceStatus: vi.fn(async () => ({ state: 'none' as const }))
  };
});

import { createGeneration, createVoicePatch, getProject, getProjectDiagnostics, getProjectJob, getProviderRequestSummary, uploadRecordingAsset } from '../lib/api';
import { isTerminalJobStatus, upsertJob, useEditorStore } from './editorStore';

function job(jobId: string, status: Job['status'] = 'queued'): Job {
  return { jobId, type: 'upload-video', status, createdAt: `2026-01-01T00:00:0${jobId}.000Z` };
}

function mockProjectRefresh(manifest: any = { assets: [], tracks: [], operations: [] }, jobs: Job[] = []) {
  vi.mocked(getProject).mockResolvedValue({ project: { projectId: 'episode-001', title: 'Episode 001' }, manifest, transcript: null, jobs } as any);
  vi.mocked(getProjectDiagnostics).mockResolvedValue({ diagnostics: null } as any);
  vi.mocked(getProviderRequestSummary).mockResolvedValue({ providerRequests: [], costSummary: { rows: [], totalsByProvider: [] } } as any);
}

describe('editor store pure job helpers', () => {
  it('recognizes only terminal job statuses', () => {
    expect(isTerminalJobStatus('queued')).toBe(false);
    expect(isTerminalJobStatus('running')).toBe(false);
    expect(isTerminalJobStatus('waiting_for_approval')).toBe(false);
    expect(isTerminalJobStatus('succeeded')).toBe(true);
    expect(isTerminalJobStatus('failed')).toBe(true);
    expect(isTerminalJobStatus('cancelled')).toBe(true);
  });

  it('upserts the newest job at the front without duplicating ids', () => {
    const existing = [job('a'), job('b', 'running')];
    const updated = job('b', 'succeeded');

    expect(upsertJob(existing, updated)).toEqual([updated, existing[0]]);
  });
});

describe('editor store recording upload', () => {
  beforeEach(() => {
    vi.mocked(uploadRecordingAsset).mockReset();
    vi.mocked(getProjectJob).mockReset();
    vi.mocked(getProject).mockReset();
    vi.mocked(getProjectDiagnostics).mockReset();
    vi.mocked(getProviderRequestSummary).mockReset();
    useEditorStore.setState({ projectId: 'episode-001', jobs: [], notice: null, error: null, manifest: null, transcript: null, project: null });
  });

  it('posts the recording, seeds a record-clip job, polls, and refreshes on success', async () => {
    const queued: Job = { jobId: 'job_record-clip_1', type: 'record-clip', status: 'running', createdAt: '2026-01-01T00:00:00.000Z' };
    const done: Job = { ...queued, status: 'succeeded', completedAt: '2026-01-01T00:00:01.000Z' };
    vi.mocked(uploadRecordingAsset).mockResolvedValue({ clipId: 'clip_002', jobId: queued.jobId });
    vi.mocked(getProjectJob).mockResolvedValueOnce({ job: queued }).mockResolvedValueOnce({ job: done });
    vi.mocked(getProject).mockResolvedValue({ project: { projectId: 'episode-001', title: 'Episode 001' }, manifest: { assets: [], tracks: [], operations: [] }, transcript: null, jobs: [done] } as any);
    vi.mocked(getProjectDiagnostics).mockResolvedValue({ diagnostics: null } as any);
    vi.mocked(getProviderRequestSummary).mockResolvedValue({ providerRequests: [], costSummary: null } as any);

    const blob = new Blob(['recording'], { type: 'audio/webm' });
    await useEditorStore.getState().uploadRecording(blob, 'voice', 1.2);

    expect(uploadRecordingAsset).toHaveBeenCalledWith('episode-001', blob, 'voice', 1.2);
    expect(useEditorStore.getState().jobs[0]).toMatchObject({ jobId: queued.jobId, type: 'record-clip' });
    await vi.waitFor(() => expect(useEditorStore.getState().notice).toBe('Recording saved.'));
  });
});

describe('editor store generation actions', () => {
  const manifest = { assets: [], tracks: [], operations: [] } as any;

  beforeEach(() => {
    vi.mocked(createGeneration).mockReset();
    vi.mocked(getProjectJob).mockReset();
    vi.mocked(getProject).mockReset();
    vi.mocked(getProjectDiagnostics).mockReset();
    vi.mocked(getProviderRequestSummary).mockReset();
    useEditorStore.setState({ projectId: 'episode-001', jobs: [], notice: null, error: null, manifest: null, transcript: null, project: null, providerRequests: [], costSummary: null });
    mockProjectRefresh(manifest);
  });

  it('applies a generated asset manifest immediately', async () => {
    const generatedManifest = { assets: [{ assetId: 'asset_gen_1', kind: 'image', path: 'assets/generated/image-gen/a.jpg', provenance: 'generated' }], tracks: [], operations: [] } as any;
    vi.mocked(createGeneration).mockResolvedValue({ providerRequestId: 'provider_generated', asset: { asset: 'assets/generated/image-gen/a.jpg', estimatedCostUsd: 0.12 }, manifest: generatedManifest, validation: {} } as any);
    await useEditorStore.getState().createGeneration('image-gen', 'gray square', { provider: 'mock' });
    expect(createGeneration).toHaveBeenCalledWith('episode-001', { kind: 'image-gen', prompt: 'gray square', provider: 'mock' });
    expect(useEditorStore.getState().manifest).toBe(generatedManifest);
    expect(useEditorStore.getState().notice).toBe('Generated.');
  });
});

describe('editor store voice patch actions', () => {
  beforeEach(() => {
    vi.mocked(createVoicePatch).mockReset();
    vi.mocked(getProjectDiagnostics).mockReset();
    vi.mocked(getProviderRequestSummary).mockReset();
    useEditorStore.setState({ projectId: 'episode-001', manifest: null, notice: null, error: null, providerRequests: [], costSummary: null });
    vi.mocked(getProjectDiagnostics).mockResolvedValue({ diagnostics: null } as any);
    vi.mocked(getProviderRequestSummary).mockResolvedValue({ providerRequests: [], costSummary: { rows: [], totalsByProvider: [] } } as any);
  });

  it('passes voiceRef through when creating voice patches', async () => {
    const manifest = { assets: [], tracks: [], operations: [{ id: 'op_voice_patch_1', type: 'voice_patch' }] } as any;
    vi.mocked(createVoicePatch).mockResolvedValue({ operation: manifest.operations[0], manifest, validation: {} } as any);
    const input = { clipId: 'clip_001', start: 1, end: 2, text: 'fixed words', provider: 'xai', voice: 'eve', voiceRef: { providerId: 'tts.xai', voiceId: 'eve' } };

    await useEditorStore.getState().createVoicePatch(input);

    expect(createVoicePatch).toHaveBeenCalledWith('episode-001', input);
    expect(useEditorStore.getState().manifest).toBe(manifest);
  });
});
