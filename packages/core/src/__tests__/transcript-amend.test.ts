import { describe, expect, it } from 'vitest';
import { transcriptAmendOperationKind, TranscriptAmendOperationSchema } from '../operations/transcript-amend';
import { deriveEditedScriptFromTimeMap } from '../transcript/edited-script';
import { projectCaptions } from '../captions/project';
import { composeTimeMap } from '../timeMap/compose';
import type { V3EditedScriptToken } from '../transcript/edited-script';

const now = '2026-05-23T00:00:00.000Z';

function makeManifest(operations: unknown[] = []) {
  return {
    manifestVersion: 3 as const,
    projectId: 'test-amend',
    createdAt: now,
    updatedAt: now,
    assets: [{ assetId: 'asset_v001', kind: 'video' as const, path: 'assets/video/source.mp4', durationSec: 10, provenance: 'imported' as const, video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000 } }],
    tracks: [{ trackId: 'track_001', kind: 'video' as const, name: 'Video 1', order: 0, clips: [{ clipId: 'clip_001', assetId: 'asset_v001', sourceStart: 0, sourceEnd: 10, timelineStart: 0 }] }],
    operations: operations as any[],
    outputs: [],
    renderPresets: { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' } }
  };
}

function makeAmendOp(start: number, end: number, amendedText: string, status: 'approved' | 'proposed' = 'approved') {
  return {
    id: `op_amend_${start}`,
    type: 'transcript_amend' as const,
    status,
    target: { kind: 'clip-span' as const, trackId: 'track_001', clipId: 'clip_001', start, end },
    amendedText,
    proposedBy: 'user' as const,
    createdBy: 'user' as const,
    createdAt: now
  };
}

const transcript = {
  durationSec: 10, schemaVersion: 1 as const, source: 'mock', provider: { name: 'mock', model: 'mock', requestId: null, timing: 'mock' as const }, language: 'en', segments: [],
  words: [
    { id: 'w1', text: 'Hello', start: 1, end: 1.4, clipId: 'clip_001' },
    { id: 'w2', text: 'world', start: 1.5, end: 1.9, clipId: 'clip_001' },
    { id: 'w3', text: 'foo', start: 2.0, end: 2.3, clipId: 'clip_001' }
  ] as any[]
};

describe('transcript_amend operation', () => {
  it('schema parses a valid amend op', () => {
    const result = TranscriptAmendOperationSchema.safeParse(makeAmendOp(1, 2, 'Hi there'));
    expect(result.success).toBe(true);
  });

  it('transcriptView returns amended text in details', () => {
    const op = makeAmendOp(1, 1.9, 'Hi there');
    const view = transcriptAmendOperationKind.transcriptView(op as any);
    expect(view).not.toBeNull();
    expect(view!.details?.text).toBe('Hi there');
    expect(view!.kind).toBe('transcript_amend');
    expect(view!.tone).toBe('neutral');
  });

  it('affectsTimeline is false — no audio or render changes', () => {
    expect(transcriptAmendOperationKind.affectsTimeline).toBe(false);
    expect(transcriptAmendOperationKind.renderContribution).toBeUndefined();
  });

  it('conflictsWith cut — amend over a cut range would resurrect deleted words in edited script', () => {
    expect(transcriptAmendOperationKind.conflictsWith).toContain('cut');
  });

  it('precedence is 5 — lower than voice_patch (10) and cut (20)', () => {
    expect(transcriptAmendOperationKind.precedence).toBe(5);
  });

  it('edited script shows amended text and hides original words in range', () => {
    const manifest = makeManifest([makeAmendOp(1, 1.9, 'Hi there')]);
    const timeMap = composeTimeMap(manifest.tracks as any, manifest.operations as any);
    const script = deriveEditedScriptFromTimeMap(transcript, manifest as any, timeMap);
    const marker = script.tokens.find((t: V3EditedScriptToken) => t.type === 'operation_marker');
    expect(marker).toBeDefined();
    expect((marker as any).view.details.text).toBe('Hi there');
    // Original words "Hello" and "world" are hidden
    expect(script.hiddenWordIds).toContain('w1');
    expect(script.hiddenWordIds).toContain('w2');
    // "foo" is outside the range and still shows
    const fooToken = script.tokens.find((t: V3EditedScriptToken) => t.type === 'word' && (t as any).word.id === 'w3');
    expect(fooToken).toBeDefined();
  });

  it('proposed amend op does not appear in edited script (only approved ops are projected)', () => {
    const manifest = makeManifest([makeAmendOp(1, 1.9, 'Hi there', 'proposed')]);
    const timeMap = composeTimeMap(manifest.tracks as any, manifest.operations as any);
    const script = deriveEditedScriptFromTimeMap(transcript, manifest as any, timeMap);
    // No marker for proposed op — original words show normally
    expect(script.tokens.filter((t: V3EditedScriptToken) => t.type === 'operation_marker')).toHaveLength(0);
    const helloToken = script.tokens.find((t: V3EditedScriptToken) => t.type === 'word' && (t as any).word.text === 'Hello');
    expect(helloToken).toBeDefined();
  });

  it('transcript_amend does not inject extra caption cues — display-only op excluded from caption projection', () => {
    const manifest = makeManifest([makeAmendOp(1, 1.9, 'Hi there')]);
    const timeMap = composeTimeMap(manifest.tracks as any, manifest.operations as any);
    const cues = projectCaptions(manifest as any, transcript as any, timeMap);
    // Should have 3 cues (one per word), not 4 — amend must not add a second cue for the range
    expect(cues.some((c) => c.text === 'Hi there')).toBe(false);
    // Original words must still appear
    expect(cues.some((c) => c.text.includes('Hello') || c.text.includes('world'))).toBe(true);
  });

  it('validateLocal rejects op end exceeding clip duration', () => {
    const op = makeAmendOp(1, 15, 'Too long');
    const errors = transcriptAmendOperationKind.validateLocal(op as any, { manifest: makeManifest() as any, track: {} as any, clip: { sourceStart: 0, sourceEnd: 10 } as any });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/ends after clip/);
  });
});
