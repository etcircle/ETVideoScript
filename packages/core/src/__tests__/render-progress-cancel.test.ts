import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runFfmpegProgress } from '../render/pipeline';
import type { V3RenderPlan } from '../render/plan';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const itIfFfmpeg = ffmpegAvailable ? it : it.skip;

function plan(): V3RenderPlan {
  return {
    schemaVersion: 3,
    planVersion: 1,
    timeMap: { segments: [] },
    stages: [],
    composition: {
      videoBase: [{ trackId: 'track_video_001', clipId: 'clip_001', sourceStart: 0, sourceEnd: 2, outputStart: 0, outputEnd: 2, rate: 1 } as V3RenderPlan['composition']['videoBase'][number]],
      audioMix: []
    },
    targetProfile: { resolution: '16x16', videoBitrate: '250k', audioBitrate: '64k', aspect: '16:9' },
    outputDurationSec: 2
  };
}

describe('runFfmpegProgress cancellation', () => {
  itIfFfmpeg('rejects cleanly when onProgress throws instead of crashing the process', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'etv-render-progress-'));
    const cancelError = new Error('Render cancelled by user');

    try {
      await expect(runFfmpegProgress([
        '-hide_banner',
        '-progress', 'pipe:1',
        '-f', 'lavfi',
        '-i', 'testsrc2=duration=2:size=16x16:rate=2',
        '-f', 'null',
        '-'
      ], cwd, plan(), () => { throw cancelError; })).rejects.toThrow(cancelError);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
