import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    getProject: vi.fn(),
    getProjectDiagnostics: vi.fn(),
    getProjectJob: vi.fn(),
    getProviderRequestSummary: vi.fn(),
    getVoiceStatus: vi.fn(),
    disableOperation: vi.fn(),
    prepareVoice: vi.fn(),
    runStudioCleanup: vi.fn(),
    createCloneChainVoicePatch: vi.fn()
  };
});

import { ApiError, createCloneChainVoicePatch, disableOperation, getProject, getProjectDiagnostics, getProviderRequestSummary, getVoiceStatus, prepareVoice, runStudioCleanup, type VoiceStatus } from '../lib/api';
import { useEditorStore } from './editorStore';

function mockProjectRefresh(manifest: any = { assets: [], tracks: [], operations: [] }) {
  vi.mocked(getProject).mockResolvedValue({ project: { projectId: 'episode-001', title: 'Episode 001' }, manifest, transcript: null, jobs: [] } as any);
  vi.mocked(getProjectDiagnostics).mockResolvedValue({ diagnostics: null } as any);
  vi.mocked(getProviderRequestSummary).mockResolvedValue({ providerRequests: [], costSummary: { rows: [], totalsByProvider: [] } } as any);
}

function resetStore() {
  useEditorStore.setState({
    projectId: 'episode-001', jobs: [], notice: null, error: null, manifest: null, transcript: null, project: null,
    voice: { state: 'none' }, voicePrepareDisclosure: null, voicePreparing: false, autoRenderEnabled: false,
    lastAutoEditAt: null
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVoiceStatus).mockResolvedValue({ state: 'none' } as VoiceStatus);
  resetStore();
});

describe('prepareVoice', () => {
  it('records the queued job and the cost disclosure (D7)', async () => {
    vi.mocked(prepareVoice).mockResolvedValue({
      job: { jobId: 'job_prepare-voice_1', type: 'prepare-voice', status: 'queued', createdAt: '2026-08-01T00:00:00.000Z' },
      costDisclosure: 'ElevenLabs instant voice clone — 1 clone call (billed by plan tier, not per call)'
    });

    const result = await useEditorStore.getState().prepareVoice();

    expect(result?.costDisclosure).toContain('1 clone call');
    const state = useEditorStore.getState();
    expect(state.voice).toEqual({ state: 'preparing', jobId: 'job_prepare-voice_1' });
    expect(state.voicePreparing).toBe(true);
    expect(state.voicePrepareDisclosure).toContain('ElevenLabs');
  });

  it('accepts the 200 cache-hit shape without claiming a job is running', async () => {
    vi.mocked(prepareVoice).mockResolvedValue({ status: { state: 'ready', voiceId: 'v-abc' }, cached: true });

    const result = await useEditorStore.getState().prepareVoice();

    expect(result).toEqual({ cached: true });
    expect(useEditorStore.getState().voice).toEqual({ state: 'ready', voiceId: 'v-abc' });
    expect(useEditorStore.getState().voicePreparing).toBe(false);
  });

  it('joins a deduped job even though its payload carries no createdAt', async () => {
    vi.mocked(prepareVoice).mockResolvedValue({ job: { jobId: 'job_prepare-voice_live', type: 'prepare-voice', status: 'running' }, deduped: true });

    await useEditorStore.getState().prepareVoice();

    expect(useEditorStore.getState().voice).toEqual({ state: 'preparing', jobId: 'job_prepare-voice_live' });
  });

  it('surfaces a 409 preflight failure through the voice state, not the error banner', async () => {
    vi.mocked(prepareVoice).mockRejectedValue(new ApiError('Studio Sound is not run yet.', 409, 'cleaned-source-unavailable'));
    vi.mocked(getVoiceStatus).mockResolvedValue({ state: 'none', errorCode: 'cleaned-source-unavailable', message: 'Studio Sound is not run yet.' });

    await useEditorStore.getState().prepareVoice();

    const state = useEditorStore.getState();
    expect(state.error).toBeNull();
    expect(state.voice.errorCode).toBe('cleaned-source-unavailable');
    expect(state.voicePreparing).toBe(false);
  });

  it.each([
    ['an auth failure', new ApiError('Provider authentication failed.', 401, 'provider_auth_failed')],
    ['a gateway failure', new ApiError('Bad gateway', 502)],
    ['an unrecognized 409 code', new ApiError('something else entirely', 409, 'weird-new-code')],
    ['a network failure', new TypeError('Failed to fetch')]
  ])('does not let %s vanish behind an unchanged chip', async (_label, failure) => {
    vi.mocked(prepareVoice).mockRejectedValue(failure);
    // The follow-up status GET succeeding is exactly the case that used to swallow the error.
    vi.mocked(getVoiceStatus).mockResolvedValue({ state: 'none' });

    await useEditorStore.getState().prepareVoice();

    expect(useEditorStore.getState().error).toBe((failure as Error).message);
  });
});

describe('prepareVoice({ auto: true }) — the eager kick', () => {
  it('never auto-retries an unknown paid outcome (⟨F2⟩)', async () => {
    vi.mocked(getVoiceStatus).mockResolvedValue({ state: 'unknown-outcome', errorCode: 'unknown-outcome' });

    const result = await useEditorStore.getState().prepareVoice({ auto: true });

    expect(result).toBeNull();
    expect(prepareVoice).not.toHaveBeenCalled();
  });

  it.each(['ready', 'preparing'] as const)('does not re-post when a clone is already %s', async (state) => {
    vi.mocked(getVoiceStatus).mockResolvedValue({ state });

    await useEditorStore.getState().prepareVoice({ auto: true });

    expect(prepareVoice).not.toHaveBeenCalled();
  });

  it('fails closed when the authoritative status cannot be read', async () => {
    // Right after hydration the local value is 'none'; falling back to it here would bill a
    // clone for a project whose durable state might be 'unknown-outcome'.
    useEditorStore.setState({ voice: { state: 'none' } });
    vi.mocked(getVoiceStatus).mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await useEditorStore.getState().prepareVoice({ auto: true });

    expect(result).toBeNull();
    expect(prepareVoice).not.toHaveBeenCalled();
  });

  it('does prepare when the clone is stale — a new cleanup needs a new clone', async () => {
    vi.mocked(getVoiceStatus).mockResolvedValue({ state: 'stale', voiceId: 'v-old' });
    vi.mocked(prepareVoice).mockResolvedValue({ job: { jobId: 'job_prepare-voice_2' } });

    await useEditorStore.getState().prepareVoice({ auto: true });

    expect(prepareVoice).toHaveBeenCalledWith('episode-001');
  });
});

describe('runStudioSound eager auto-kick', () => {
  it('kicks off voice preparation after a successful cleanup', async () => {
    mockProjectRefresh();
    vi.mocked(runStudioCleanup).mockResolvedValue({ manifest: { assets: [], tracks: [], operations: [] }, studioCleanup: { status: 'approved' }, costDisclosure: 'iso', cached: false } as any);
    vi.mocked(getVoiceStatus).mockResolvedValue({ state: 'none' });
    vi.mocked(prepareVoice).mockResolvedValue({ job: { jobId: 'job_prepare-voice_3' }, costDisclosure: 'clone call' });

    await useEditorStore.getState().runStudioSound();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(prepareVoice).toHaveBeenCalledWith('episode-001');
  });

  it('does not kick when the cleanup call itself failed', async () => {
    vi.mocked(runStudioCleanup).mockRejectedValue(new ApiError('nope', 502, 'provider-failed'));

    await useEditorStore.getState().runStudioSound();

    expect(prepareVoice).not.toHaveBeenCalled();
    expect(useEditorStore.getState().studioSoundStatus).toBe('error');
  });
});

describe('createCloneChainVoicePatch', () => {
  it('reloads the manifest, because the clone-chain response deliberately omits it (⟨Q1⟩)', async () => {
    const manifest = { assets: [], tracks: [], operations: [{ id: 'op-1', type: 'voice_patch' }] };
    mockProjectRefresh(manifest);
    vi.mocked(createCloneChainVoicePatch).mockResolvedValue({
      providerRequestId: 'vp-1', voiceId: 'v-abc',
      operation: { id: 'op-1', status: 'approved', clipId: 'clip-1', start: 1, end: 2, text: 'hi', asset: 'assets/voice/patch-vp-1.wav', durationGeneratedSec: 1.2, durationRequestedSec: 1, seamBaked: true },
      steps: { tts: { durationSec: 1.1, replayed: false }, sts: { durationSec: 1.2, replayed: false } }
    } as any);

    const result = await useEditorStore.getState().createCloneChainVoicePatch({ requestId: 'vp-1', clipId: 'clip-1', start: 1, end: 2, text: 'hi' });

    expect(result.status).toBe('applied');
    expect(result.response.operation.seamBaked).toBe(true);
    expect(getProject).toHaveBeenCalled();
    expect(useEditorStore.getState().manifest).toEqual(manifest);
    expect(useEditorStore.getState().lastAutoEditAt).not.toBeNull();
  });

  it('reports stale (not success) when the user left the project, and touches nothing', async () => {
    mockProjectRefresh();
    vi.mocked(createCloneChainVoicePatch).mockImplementation(async () => {
      // The user navigates away while the paid chain is running.
      useEditorStore.setState({ projectId: 'episode-002' });
      return { providerRequestId: 'vp-3', voiceId: 'v', operation: { durationGeneratedSec: 1 }, steps: {} } as any;
    });

    const result = await useEditorStore.getState().createCloneChainVoicePatch({ requestId: 'vp-3', start: 1, end: 2, text: 'hi' });

    // A plain success here let the caller run its cleanup against the NEW project.
    expect(result.status).toBe('stale');
    expect(result.projectId).toBe('episode-001');
    expect(getProject).not.toHaveBeenCalled();
    expect(useEditorStore.getState().lastAutoEditAt).toBeNull();
  });

  it('still disables the superseded mute ops — against the project the POST was issued for', async () => {
    mockProjectRefresh();
    vi.mocked(disableOperation).mockResolvedValue({ manifest: {}, operation: {} } as any);
    vi.mocked(createCloneChainVoicePatch).mockImplementation(async () => {
      useEditorStore.setState({ projectId: 'episode-002' });
      return { providerRequestId: 'vp-4', voiceId: 'v', operation: { durationGeneratedSec: 1 }, steps: {} } as any;
    });

    await useEditorStore.getState().createCloneChainVoicePatch({ requestId: 'vp-4', start: 1, end: 2, text: 'hi', supersedeOperationIds: ['op-mute-1'] });

    expect(disableOperation).toHaveBeenCalledWith('episode-001', 'op-mute-1', 'Replaced by generated voice patch');
  });

  it('does not fail the generation when the supersede cleanup fails', async () => {
    mockProjectRefresh();
    vi.mocked(disableOperation).mockRejectedValue(new Error('gone'));
    vi.mocked(createCloneChainVoicePatch).mockResolvedValue({ providerRequestId: 'vp-5', voiceId: 'v', operation: { durationGeneratedSec: 1 }, steps: {} } as any);

    const result = await useEditorStore.getState().createCloneChainVoicePatch({ requestId: 'vp-5', start: 1, end: 2, text: 'hi', supersedeOperationIds: ['op-mute-1'] });

    expect(result.status).toBe('applied');
  });
});

describe('refresh() project guard', () => {
  it('never writes project A\'s data into project B\'s store', async () => {
    vi.mocked(getProject).mockImplementation(async () => {
      // The user navigates while the three refresh requests are in flight.
      useEditorStore.setState({ projectId: 'episode-002' });
      return { project: { projectId: 'episode-001', title: 'A' }, manifest: { assets: [], tracks: [], operations: [] }, transcript: null, jobs: [{ jobId: 'a' }] } as any;
    });
    vi.mocked(getProjectDiagnostics).mockResolvedValue({ diagnostics: null } as any);
    vi.mocked(getProviderRequestSummary).mockResolvedValue({ providerRequests: [], costSummary: null } as any);

    await useEditorStore.getState().refresh();

    const state = useEditorStore.getState();
    expect(state.project).toBeNull();
    expect(state.manifest).toBeNull();
    expect(state.jobs).toEqual([]);
  });

  it('does not paint project A\'s error onto project B', async () => {
    vi.mocked(getProject).mockImplementation(async () => {
      useEditorStore.setState({ projectId: 'episode-002' });
      throw new Error('workspace missing');
    });
    vi.mocked(getProjectDiagnostics).mockResolvedValue({ diagnostics: null } as any);
    vi.mocked(getProviderRequestSummary).mockResolvedValue({ providerRequests: [], costSummary: null } as any);

    await useEditorStore.getState().refresh();

    expect(useEditorStore.getState().error).toBeNull();
  });

  it('propagates the typed 409 instead of swallowing it into the store error string', async () => {
    vi.mocked(createCloneChainVoicePatch).mockRejectedValue(new ApiError('No prepared voice for this recording yet.', 409, 'clone-not-ready'));

    await expect(useEditorStore.getState().createCloneChainVoicePatch({ requestId: 'vp-2', start: 1, end: 2, text: 'hi' }))
      .rejects.toMatchObject({ errorCode: 'clone-not-ready', status: 409 });
  });
});
