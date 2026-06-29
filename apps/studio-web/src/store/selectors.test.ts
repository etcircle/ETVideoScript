import { describe, expect, it } from 'vitest';
import type { ManifestV3, OperationV3 } from '@etvideoscript/core/browser';
import { decidePanelState, designOps, renderProgressLabel, latestFailedRenderJob, operationTimelineRange, projectDuration, transcriptModeLabel, wordTimelineRange } from './selectors';
import type { Diagnostics, Job, TranscriptWord } from '../lib/api';

const importedDiagnostics: Diagnostics = {
  projectId: 'p1', workspacePath: '/tmp/p1', doctor: { ffmpeg: true, ffprobe: true, node: 'ok' }, validation: { valid: true, errors: [], warnings: [] }, files: { source: { path: 'source.mp4', exists: true, size: 1 } }, status: { imported: true }, transcript: { words: 1, segments: 1, timing: 'word', provider: 'mock' }, manifest: { operations: 0 }, providerRequests: [], jobs: { recent: [] }, errors: {}
};

const timelineManifest: ManifestV3 = {
  manifestVersion: 3,
  projectId: 'p1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  assets: [],
  operations: [],
  outputs: [],
  renderPresets: { draft: { resolution: '720p', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: '1080p', videoBitrate: '8000k', audioBitrate: '192k' } },
  tracks: [{ trackId: 'v1', kind: 'video', name: 'V1', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [
    { clipId: 'c1', assetId: 'a1', sourceStart: 10, sourceEnd: 20, timelineStart: 0 },
    { clipId: 'c2', assetId: 'a1', sourceStart: 40, sourceEnd: 55, timelineStart: 10 }
  ] }]
};

function cutOp(id: string, clipId: string, start: number, end: number): OperationV3 {
  return { id, type: 'cut', status: 'approved', target: { kind: 'clip-span', trackId: 'v1', clipId, start, end }, createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'agent', proposedBy: 'agent' };
}

describe('editor selectors', () => {
  it('formats the Render button as progress with per-clip phase text', () => {
    expect(renderProgressLabel({ stages: [{ name: 'render', status: 'running', clipId: 'clip_002', phase: 'Reprocessing clip 2/3', percent: 67 }] })).toBe('67% · Reprocessing clip 2/3');
  });

  it('decides state-matrix states in priority order', () => {
    expect(decidePanelState({ loading: true, diagnostics: null, transcript: null })).toBe('loading');
    expect(decidePanelState({ loading: false, diagnostics: { ...importedDiagnostics, files: {}, status: { imported: false } }, transcript: null })).toBe('cold-start');
    expect(decidePanelState({ loading: false, panel: 'transcript', diagnostics: { ...importedDiagnostics, transcript: null }, transcript: null })).toBe('no-transcript');
    expect(decidePanelState({ loading: false, panel: 'preview', diagnostics: { ...importedDiagnostics, renderFreshness: { draft: { state: 'error', reason: 'boom' } } }, transcript: { words: [], durationSec: 1 } })).toBe('render-failed');
    expect(decidePanelState({ loading: false, panel: 'ai', diagnostics: importedDiagnostics, transcript: { words: [], durationSec: 1 }, providerRequests: [{ status: 'op_update_failed' }] })).toBe('provider-failed');
    expect(decidePanelState({ loading: false, panel: 'media', diagnostics: importedDiagnostics, transcript: { words: [], durationSec: 1 }, empty: true })).toBe('empty');
  });

  it('finds latest failed render draft job and computes duration from manifest tracks', () => {
    const jobs: Job[] = [{ jobId: 'j1', type: 'render-draft', status: 'failed', error: 'boom', createdAt: '2026-05-25T07:00:00.000Z' }];
    expect(latestFailedRenderJob(jobs)?.error).toBe('boom');
    expect(projectDuration({ manifestVersion: 3, projectId: 'p1', createdAt: '', updatedAt: '', assets: [], operations: [], outputs: [], renderPresets: { draft: { resolution: '720p', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: '1080p', videoBitrate: '8000k', audioBitrate: '192k' } }, tracks: [{ trackId: 'v1', kind: 'video', name: 'V1', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [{ clipId: 'c1', assetId: 'a1', sourceStart: 0, sourceEnd: 10, timelineStart: 5 }] }] })).toBe(15);
  });

  it('ignores a failed render once a more recent succeeded render exists', () => {
    // Regression: one stale failure used to pin the preview into render-failed
    // permanently. The newer succeeded render must supersede it.
    const jobs: Job[] = [
      { jobId: 'j_new', type: 'render-draft', status: 'succeeded', createdAt: '2026-05-25T08:00:00.000Z' },
      { jobId: 'j_old', type: 'render-draft', status: 'failed', error: 'boom', createdAt: '2026-05-25T07:00:00.000Z' }
    ];
    expect(latestFailedRenderJob(jobs)).toBeUndefined();
  });

  it('ignores a failed render when a queued render came after it', () => {
    const jobs: Job[] = [
      { jobId: 'j_queued', type: 'render-draft', status: 'queued', createdAt: '2026-05-25T08:00:00.000Z' },
      { jobId: 'j_old', type: 'render-draft', status: 'failed', error: 'boom', createdAt: '2026-05-25T07:00:00.000Z' }
    ];
    expect(latestFailedRenderJob(jobs)).toBeUndefined();
  });

  it('surfaces a failed render when it IS the latest render', () => {
    const jobs: Job[] = [
      { jobId: 'j_new_failed', type: 'render-draft', status: 'failed', error: 'fresh boom', createdAt: '2026-05-25T08:00:00.000Z' },
      { jobId: 'j_old_ok', type: 'render-draft', status: 'succeeded', createdAt: '2026-05-25T07:00:00.000Z' }
    ];
    expect(latestFailedRenderJob(jobs)?.error).toBe('fresh boom');
  });

  it('does not get poisoned by an invalid createdAt — valid timestamps still win', () => {
    // Defensive: a malformed createdAt (e.g. 'now', '', undefined) on one job
    // must not trap the comparison and stick a stale failure forever.
    const jobs: Job[] = [
      { jobId: 'j_bad_old_failed', type: 'render-draft', status: 'failed', error: 'stuck', createdAt: 'not-a-date' },
      { jobId: 'j_good_new_ok', type: 'render-draft', status: 'succeeded', createdAt: '2026-05-25T08:00:00.000Z' }
    ];
    expect(latestFailedRenderJob(jobs)).toBeUndefined();
  });

  it('converts clip-local operation spans to timeline ranges', () => {
    expect(operationTimelineRange(timelineManifest, cutOp('op1', 'c1', 2, 4))).toEqual({ start: 2, end: 4 });
    expect(operationTimelineRange(timelineManifest, cutOp('op2', 'c2', 2, 4))).toEqual({ start: 12, end: 14 });
  });

  it('resolves clip-boundary operations to the clip end marker', () => {
    expect(operationTimelineRange(timelineManifest, { id: 'tr1', type: 'transition', status: 'approved', target: { kind: 'clip-boundary', trackId: 'v1', clipId: 'c2' }, transitionType: 'crossfade', durationMs: 500, createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'agent', proposedBy: 'agent' })).toEqual({ start: 25, end: 25 });
  });

  it('uses the full project timeline range for track-target operations, including empty tracks', () => {
    const withCaptionTrack: ManifestV3 = {
      ...timelineManifest,
      tracks: [...timelineManifest.tracks, { trackId: 'cap1', kind: 'caption', name: 'Captions', order: 1, locked: false, muted: false, solo: false, hidden: false, clips: [] }]
    };
    expect(operationTimelineRange(withCaptionTrack, { id: 'cs1', type: 'caption_style', status: 'approved', target: { kind: 'track', trackId: 'cap1' }, styleId: 'minimal', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'agent', proposedBy: 'agent' })).toEqual({ start: 0, end: 25 });
  });

  it('returns null when the target clip is missing', () => {
    expect(operationTimelineRange(timelineManifest, cutOp('missing', 'nope', 1, 2))).toBeNull();
  });

  it('converts clip-local transcript word times to timeline ranges', () => {
    expect(wordTimelineRange(timelineManifest, { start: 2, end: 4, clipId: 'c2' })).toEqual({ start: 12, end: 14 });
  });

  it('keeps untagged transcript word times unchanged', () => {
    expect(wordTimelineRange(timelineManifest, { start: 2, end: 4 })).toEqual({ start: 2, end: 4 });
  });

  it('keeps transcript word times unchanged when the clip is missing', () => {
    expect(wordTimelineRange(timelineManifest, { start: 2, end: 4, clipId: 'nope' })).toEqual({ start: 2, end: 4 });
  });
});

// ─── transcriptModeLabel ─────────────────────────────────────────────────────

describe('transcriptModeLabel', () => {
  it('maps preview → Draft / draft view', () => {
    expect(transcriptModeLabel('preview')).toEqual({ label: 'Draft', view: 'draft' });
  });
  it('maps edited → Audit trail / audit view', () => {
    expect(transcriptModeLabel('edited')).toEqual({ label: 'Audit trail', view: 'audit' });
  });
  it('maps original → Original / original view', () => {
    expect(transcriptModeLabel('original')).toEqual({ label: 'Original', view: 'original' });
  });
});

// ─── designOps ───────────────────────────────────────────────────────────────

// Manifest with two clips (reuses timelineManifest from above):
//   c1: timelineStart=0, sourceStart=10, sourceEnd=20 → timeline 0..10
//   c2: timelineStart=10, sourceStart=40, sourceEnd=55 → timeline 10..25

function speedOp(id: string, clipId: string, start: number, end: number): OperationV3 {
  return {
    id,
    type: 'speed',
    status: 'approved',
    target: { kind: 'clip-span', trackId: 'v1', clipId, start, end },
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'agent',
    proposedBy: 'agent',
    rate: 4 as any,
    bed: 'music' as any,
  } as unknown as OperationV3;
}

function voicePatchOp(id: string, clipId: string, start: number, end: number): OperationV3 {
  return {
    id,
    type: 'voice_patch',
    status: 'proposed',
    target: { kind: 'clip-span', trackId: 'v1', clipId, start, end },
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'agent',
    proposedBy: 'agent',
    confidence: 0.78,
    text: 'orchestrates',
    voiceRef: { providerId: 'tts.elevenlabs', voiceId: 'v-abc' },
  } as unknown as OperationV3;
}

function userCutOp(id: string, clipId: string, start: number, end: number): OperationV3 {
  return {
    id,
    type: 'cut',
    status: 'approved',
    target: { kind: 'clip-span', trackId: 'v1', clipId, start, end },
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'user',
    proposedBy: 'user',
    reason: 'User selection cut',
  } as OperationV3;
}

const transcriptWords: TranscriptWord[] = [
  { id: 'w1', text: 'the', start: 2.0, end: 2.3, segmentId: 'seg-00', speaker: 'A', clipId: 'c1', confidence: 0.95 },
  { id: 'w2', text: 'agent', start: 2.4, end: 2.9, segmentId: 'seg-00', speaker: 'A', clipId: 'c1', confidence: 0.88 },
  { id: 'w3', text: 'orchestrates', start: 3.0, end: 3.8, segmentId: 'seg-00', speaker: 'A', clipId: 'c1', confidence: 0.44 },
];

describe('designOps', () => {
  it('returns empty array for null manifest', () => {
    expect(designOps(null, null)).toEqual([]);
  });

  it('returns empty array when manifest has no operations', () => {
    const m: ManifestV3 = { ...timelineManifest, operations: [] };
    expect(designOps(m, null)).toEqual([]);
  });

  it('flattens clip-local coordinates to timeline axis', () => {
    // c1: timelineStart=0; op start=2,end=4 in clip-local → timeline 2,4
    // c2: timelineStart=10; op start=2,end=4 → timeline 12,14
    const m: ManifestV3 = { ...timelineManifest, operations: [cutOp('op1', 'c1', 2, 4), cutOp('op2', 'c2', 2, 4)] };
    const ops = designOps(m, null);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ id: 'op1', start: 2, end: 4 });
    expect(ops[1]).toMatchObject({ id: 'op2', start: 12, end: 14 });
  });

  it('omits ops whose target clip is missing from the manifest', () => {
    const m: ManifestV3 = { ...timelineManifest, operations: [cutOp('missing', 'nope', 1, 2)] };
    expect(designOps(m, null)).toEqual([]);
  });

  it('maps speed op rate→factor and bed→audioBed', () => {
    const m: ManifestV3 = { ...timelineManifest, operations: [speedOp('s1', 'c1', 0, 5)] };
    const ops = designOps(m, null);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'speed', factor: 4, audioBed: 'music' });
  });

  it('maps voice_patch text through and sets provider from voiceRef.providerId', () => {
    const m: ManifestV3 = { ...timelineManifest, operations: [voicePatchOp('vp1', 'c1', 2, 4)] };
    const ops = designOps(m, null);
    expect(ops[0]).toMatchObject({ type: 'voice_patch', text: 'orchestrates', provider: 'tts.elevenlabs' });
  });

  it('reconstructs originalText from transcript words within the op span', () => {
    // op covers c1 start=2.0..end=4.0 (clip-local); word "orchestrates" is at 3.0-3.8 within that span
    const m: ManifestV3 = { ...timelineManifest, operations: [voicePatchOp('vp1', 'c1', 2.0, 4.0)] };
    const transcript = { words: transcriptWords, durationSec: 10 };
    const ops = designOps(m, transcript);
    expect(ops[0]?.originalText).toContain('orchestrates');
  });

  it('originalText is undefined when transcript is null', () => {
    const m: ManifestV3 = { ...timelineManifest, operations: [voicePatchOp('vp1', 'c1', 2, 4)] };
    const ops = designOps(m, null);
    expect(ops[0]?.originalText).toBeUndefined();
  });

  it('derives source=you for user-created ops', () => {
    const m: ManifestV3 = { ...timelineManifest, operations: [userCutOp('uc1', 'c1', 1, 3)] };
    const ops = designOps(m, null);
    expect(ops[0]?.source).toBe('you');
    expect(ops[0]?.proposedBy).toBe('user');
  });

  it('derives source=agent for agent-created ops', () => {
    const m: ManifestV3 = { ...timelineManifest, operations: [cutOp('ac1', 'c1', 1, 3)] };
    const ops = designOps(m, null);
    expect(ops[0]?.source).toBe('agent');
  });

  it('preserves status verbatim including proposed and disabled', () => {
    const proposed = voicePatchOp('vp-proposed', 'c1', 1, 3);
    const disabled = { ...cutOp('cut-disabled', 'c1', 4, 6), status: 'disabled' as const };
    const m: ManifestV3 = { ...timelineManifest, operations: [proposed, disabled] };
    const ops = designOps(m, null);
    expect(ops.find((o) => o.id === 'vp-proposed')?.status).toBe('proposed');
    expect(ops.find((o) => o.id === 'cut-disabled')?.status).toBe('disabled');
  });

  it('passes confidence through when present', () => {
    const m: ManifestV3 = { ...timelineManifest, operations: [voicePatchOp('vp1', 'c1', 2, 4)] };
    const ops = designOps(m, null);
    expect(ops[0]?.confidence).toBe(0.78);
  });

  it('preserves clipId and reason on base ops', () => {
    const m: ManifestV3 = { ...timelineManifest, operations: [userCutOp('uc1', 'c1', 1, 3)] };
    const ops = designOps(m, null);
    expect(ops[0]?.clipId).toBe('c1');
    expect(ops[0]?.reason).toBe('User selection cut');
  });
});
