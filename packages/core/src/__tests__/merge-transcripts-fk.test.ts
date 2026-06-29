/**
 * FIX 3 — mergeTranscripts word.segmentId FK preservation.
 *
 * Before FIX 3, `mergeTranscripts` applied `clip${docIndex+1}_` prefixes to segment.id
 * but left word.segmentId unprefixed.  The FK `word.segmentId → segment.id` was therefore
 * broken for any segment lookup in SENTENCE mode, causing `snapSpanToBoundaries` to
 * degrade to the "sentence-no-segment:word-fallback" path even on valid data.
 *
 * These tests use a real temporary workspace so we exercise the exact code path the
 * production server uses (including the `writeTranscript` write and `loadTranscript` read).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeTranscripts, loadTranscript, snapSpanToBoundaries, saveManifestV3 } from '../index';
import type { TranscriptWords } from '../schemas';
import type { ManifestV3 } from '../manifest/schema';

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = '2026-05-30T00:00:00.000Z';

function makeClipDoc(clipId: string, offset: number): TranscriptWords {
  return {
    schemaVersion: 1,
    source: `media/${clipId}/extracted-audio.wav`,
    provider: { name: 'homelab-whisper', model: 'mock-v1', requestId: `req_${clipId}`, timing: 'exact' },
    language: 'en',
    durationSec: 2.0,
    words: [
      { id: `${clipId}_w1`, text: 'hello', normalized: 'hello', start: offset + 0.0, end: offset + 0.4, speaker: 'speaker_1', confidence: 0.9, segmentId: 'segA', clipId },
      { id: `${clipId}_w2`, text: 'world', normalized: 'world', start: offset + 0.5, end: offset + 1.0, speaker: 'speaker_1', confidence: 0.9, segmentId: 'segA', clipId }
    ],
    segments: [
      { id: 'segA', speaker: 'speaker_1', start: offset + 0.0, end: offset + 1.0, text: 'hello world' }
    ]
  };
}

function makeManifest(): ManifestV3 {
  return {
    manifestVersion: 3,
    projectId: 'fk-test',
    createdAt: NOW,
    updatedAt: NOW,
    assets: [
      { assetId: 'asset_clip1', kind: 'video', path: 'input/clip1.mp4', durationSec: 2, provenance: 'imported', video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000 } },
      { assetId: 'asset_clip2', kind: 'video', path: 'input/clip2.mp4', durationSec: 2, provenance: 'imported', video: { width: 1280, height: 720, fps: 30 }, audio: { sampleRate: 48000 } }
    ],
    tracks: [
      {
        trackId: 'track_video_001',
        kind: 'video',
        name: 'Video 1',
        order: 0,
        locked: false,
        muted: false,
        solo: false,
        hidden: false,
        clips: [
          { clipId: 'clip_001', assetId: 'asset_clip1', sourceStart: 0, sourceEnd: 2, timelineStart: 0 },
          { clipId: 'clip_002', assetId: 'asset_clip2', sourceStart: 0, sourceEnd: 2, timelineStart: 2 }
        ]
      }
    ],
    operations: [],
    outputs: [{ outputId: 'output_full_001', kind: 'full', aspects: ['16:9'], status: 'manual' }],
    renderPresets: { draft: { resolution: '1280x720', videoBitrate: '2500k', audioBitrate: '128k' }, youtube: { resolution: '1920x1080', videoBitrate: '6000k', audioBitrate: '192k' } }
  };
}

function setupWorkspace(): { ws: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'etvideo-fk-'));
  const ws = join(root, 'proj');
  mkdirSync(ws);
  mkdirSync(join(ws, 'edits'), { recursive: true });

  saveManifestV3(ws, makeManifest());

  // Write a minimal project.json so loadProject() works inside mergeTranscripts.
  const projectData = {
    schemaVersion: 1,
    manifestVersion: 3,
    projectId: 'fk-test',
    title: 'FK Test',
    createdAt: NOW,
    updatedAt: NOW,
    workspacePath: ws,
    status: { imported: true, audioExtracted: false, transcribed: false, manifestValid: false, lastRender: null },
    clipSources: [
      { clipId: 'clip_001', path: 'input/clip1.mp4', originalFilename: 'clip1.mp4', sha256: 'abc', durationSec: 2, width: 1280, height: 720, fps: 30, audioSampleRate: 48000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' },
      { clipId: 'clip_002', path: 'input/clip2.mp4', originalFilename: 'clip2.mp4', sha256: 'def', durationSec: 2, width: 1280, height: 720, fps: 30, audioSampleRate: 48000, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' }
    ]
  };
  writeFileSync(join(ws, 'project.json'), JSON.stringify(projectData));

  // Per-clip transcript docs with the SAME raw segmentId ('segA') so FIX 3 is exercised.
  const clip1Doc = makeClipDoc('clip_001', 0);
  const clip2Doc = makeClipDoc('clip_002', 5); // offset 5 keeps timestamps distinct

  mkdirSync(join(ws, 'transcript', 'clip_001'), { recursive: true });
  mkdirSync(join(ws, 'transcript', 'clip_002'), { recursive: true });
  writeFileSync(join(ws, 'transcript', 'clip_001', 'words.json'), JSON.stringify(clip1Doc));
  writeFileSync(join(ws, 'transcript', 'clip_002', 'words.json'), JSON.stringify(clip2Doc));

  return { ws, root };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('mergeTranscripts — word.segmentId FK after prefix (FIX 3)', () => {
  it('every word.segmentId after merge resolves to an existing segment.id', async () => {
    const { ws, root } = setupWorkspace();
    try {
      const merged = await mergeTranscripts(ws);
      const segIds = new Set(merged.segments.map((s) => s.id));
      for (const word of merged.words) {
        expect(segIds.has(word.segmentId), `word ${word.id} segmentId=${word.segmentId} not in segments`).toBe(true);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('segment IDs carry clip prefix (clip1_ and clip2_)', async () => {
    const { ws, root } = setupWorkspace();
    try {
      const merged = await mergeTranscripts(ws);
      const segIds = merged.segments.map((s) => s.id);
      expect(segIds.some((id) => id.startsWith('clip1_'))).toBe(true);
      expect(segIds.some((id) => id.startsWith('clip2_'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('SENTENCE mode on merged transcript resolves segment span (FK intact)', async () => {
    const { ws, root } = setupWorkspace();
    try {
      await mergeTranscripts(ws);
      // The written merged transcript must be readable back (it's what the route reads).
      const loaded = loadTranscript(ws);
      expect(loaded).not.toBeNull();

      // Snap a selection that overlaps a clip_001 word (0.0–0.4 range, offset=0).
      // With FK broken: snapSentence returns word-fallback (downgraded: true, reason ends in ':word-fallback').
      // With FK intact: snapSentence returns the full segment [0.0, 1.0] (downgraded: false).
      const result = snapSpanToBoundaries(loaded!, { start: 0.1, end: 0.3, clipId: 'clip_001' }, 'sentence');
      expect(result.downgraded).toBe(false);
      expect(result.reason).toBe('sentence-segment');
      // Segment span for clip_001 (offset=0) is [0.0, 1.0].
      expect(result.start).toBe(0.0);
      expect(result.end).toBe(1.0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
