import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgentTool } from '../agent-tools';
import { saveManifestV3 } from '../manifest/io';
import { writeTranscript } from '../transcript';
import { makeManifest, makeTrack, makeClip, makeVideoAsset, makeWords } from './takes-fixtures';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function setup(): string {
  dir = mkdtempSync(join(tmpdir(), 'ets-at-'));
  mkdirSync(join(dir, 'edits'), { recursive: true });
  const staging = makeTrack({ trackId: 'track_takes', kind: 'video', role: 'staging', clips: [makeClip('clip_take_01', 'a1', 30), makeClip('clip_take_02', 'a2', 31)] });
  const timeline = makeTrack({ trackId: 'track_video', kind: 'video', order: 0, clips: [] });
  const manifest = makeManifest({ assets: [makeVideoAsset('a1', 30), makeVideoAsset('a2', 31)], tracks: [timeline, staging], takeGroups: [{ groupId: 'main', label: 'main', clipIds: ['clip_take_01', 'clip_take_02'] }] });
  saveManifestV3(dir, manifest, { revision: false });
  const text = 'Alpha beta gamma delta. Epsilon zeta eta theta.';
  for (const clipId of ['clip_take_01', 'clip_take_02']) {
    // writeTranscript expects a TranscriptWords doc; build from makeWords
    const words = makeWords(text, { clipId });
    writeTranscript(dir, { schemaVersion: 1, source: clipId, provider: { name: 'mock', model: 'mock', requestId: null, timing: 'mock' }, language: 'en', durationSec: 30, words, segments: [] }, { clipId, updateProject: false });
  }
  return dir;
}

describe('takes agent tools', () => {
  it('aligns and lists via agent tools', () => {
    const ctx = { workspacePath: setup() };
    const align = runAgentTool(ctx, 'takes_align', { groupId: 'main' });
    expect((align.result as { spans: unknown[] }).spans.length).toBe(2);
    const list = runAgentTool(ctx, 'takes_list', {});
    expect((list.result as { takes: unknown[] }).takes.length).toBe(2);
  });
});
