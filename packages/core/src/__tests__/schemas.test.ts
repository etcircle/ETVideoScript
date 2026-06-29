import { describe, expect, it } from 'vitest';
import { ManifestSchemaV1, ManifestV3Schema, ProjectSchema, ProviderRequestIdSchema, ProviderRequestSchema, TranscriptWordsSchema, validateManifestV3Document } from '../index';

const presets = { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: 'source', videoBitrate: 'source-or-auto', audioBitrate: '192k' } };

function baseManifest(now = new Date().toISOString()) {
  return {
    manifestVersion: 3 as const,
    projectId: 'episode-001',
    createdAt: now,
    updatedAt: now,
    assets: [{ assetId: 'asset_video_001', kind: 'video' as const, path: 'input/source.mp4', durationSec: 10, provenance: 'imported' as const, video: { width: 640, height: 360, fps: 30 }, audio: { sampleRate: 48000 } }],
    tracks: [{ trackId: 'track_video_001', kind: 'video' as const, name: 'Video 1', order: 0, locked: false, muted: false, solo: false, hidden: false, clips: [{ clipId: 'clip_001', assetId: 'asset_video_001', sourceStart: 0, sourceEnd: 10, timelineStart: 0 }] }],
    operations: [],
    outputs: [],
    renderPresets: presets
  };
}

describe('core schemas', () => {
  it('accepts valid empty project, transcript, legacy v1 manifest, and v3 manifest schemas', () => {
    const now = new Date().toISOString();
    expect(ProjectSchema.parse({ schemaVersion: 1, manifestVersion: 3, projectId: 'episode-001', title: 'Episode 001', createdAt: now, updatedAt: now, workspacePath: '/tmp/episode-001', clipSources: [], status: { imported: false, audioExtracted: false, transcribed: false, manifestValid: true, lastRender: null } }).projectId).toBe('episode-001');
    expect(ManifestSchemaV1.parse({ schemaVersion: 1, projectId: 'episode-001', source: 'input/source.mp4', createdAt: now, updatedAt: now, timelineBase: 'source-time', operations: [], renderPresets: presets }).timelineBase).toBe('source-time');
    expect(ManifestV3Schema.parse(baseManifest(now)).manifestVersion).toBe(3);
    expect(TranscriptWordsSchema.parse({ schemaVersion: 1, source: 'media/extracted-audio.wav', provider: { name: 'mock', model: 'mock-word-timestamps', requestId: null, timing: 'mock' }, language: 'en', durationSec: 1, words: [], segments: [] }).provider.timing).toBe('mock');
  });

  it('rejects invalid operation ranges at v3 schema level', () => {
    const now = new Date().toISOString();
    const manifest = { ...baseManifest(now), operations: [
      { id: 'op_mute_0001', type: 'mute' as const, status: 'approved' as const, target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 7, end: 6 }, reason: 'bad', proposedBy: 'user' as const, createdBy: 'user' as const, createdAt: now }
    ] };
    const result = validateManifestV3Document(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('operation start must be < end');
  });

  it('round-trips mute draftText as informational type-over draft metadata', () => {
    const now = new Date().toISOString();
    const parsed = ManifestV3Schema.parse({ ...baseManifest(now), operations: [
      { id: 'op_mute_draft_0001', type: 'mute' as const, status: 'approved' as const, target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 1, end: 3 }, reason: 'Type-over draft', draftText: 'hi there', proposedBy: 'user' as const, createdBy: 'user' as const, createdAt: now }
    ] });
    const op = parsed.operations[0];
    expect(op.type).toBe('mute');
    expect(op.draftText).toBe('hi there');
    expect(validateManifestV3Document(parsed).valid).toBe(true);
  });

  it('rejects overlapping same-precedence cuts and operations beyond clip duration', () => {
    const now = new Date().toISOString();
    const manifest = { ...baseManifest(now), operations: [
      { id: 'op_cut_0001', type: 'cut' as const, status: 'approved' as const, target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 1, end: 4 }, reason: 'a', proposedBy: 'user' as const, createdBy: 'user' as const, createdAt: now },
      { id: 'op_cut_0002', type: 'cut' as const, status: 'approved' as const, target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 3, end: 5 }, reason: 'b', proposedBy: 'user' as const, createdBy: 'user' as const, createdAt: now },
      { id: 'op_mute_0001', type: 'mute' as const, status: 'approved' as const, target: { kind: 'clip-span' as const, trackId: 'track_video_001', clipId: 'clip_001', start: 9, end: 11 }, reason: 'too long', proposedBy: 'user' as const, createdBy: 'user' as const, createdAt: now }
    ] };
    const result = validateManifestV3Document(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('cut/cut ranges overlap at the same precedence');
    expect(result.errors.join('\n')).toContain('after clip clip_001 duration');
  });

  it('bounds provider request IDs to simple URL/log-safe client tokens', () => {
    const now = new Date().toISOString();
    expect(ProviderRequestIdSchema.safeParse('req_safe-123').success).toBe(true);
    expect(ProviderRequestIdSchema.safeParse('req.with.dot').success).toBe(false);
    expect(ProviderRequestIdSchema.safeParse('req:with:colon').success).toBe(false);
    expect(ProviderRequestSchema.parse({
      requestId: 'req_safe-123',
      projectId: 'episode-001',
      provider: 'xai',
      voice: 'eve',
      language: 'en',
      textHash: 'text-hash',
      bodyHash: 'body-hash',
      operationId: 'op_voice_patch_0001',
      status: 'pending',
      createdAt: now
    }).requestId).toBe('req_safe-123');
  });
});
