import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProvider } from '../registry';
import { runLocalCommand } from '../localCommand';
import type { LocalMediaProvider } from '../contract';
import type { GeneratedMediaOutput, VideoGenInput } from '../generationTypes';
import { generatedMediaLedgerOutput } from '../generationTypes';

export const videoGenMockProvider: LocalMediaProvider<VideoGenInput, GeneratedMediaOutput> = registerProvider({
  id: 'video-gen.mock',
  kind: 'video-gen',
  tier: 'local',
  mode: 'local',
  displayName: 'Mock Video Generation',
  capabilities: { polling: false, cancel: false, maxDurationSec: 1, outputFormats: ['video/mp4'] },
  estimateCost() { return { currency: 'USD', estimated: 0, actual: 0 }; },
  actualCost() { return { currency: 'USD', estimated: 0, actual: 0 }; },
  ledgerOutput: generatedMediaLedgerOutput,
  async run(_input, context) {
    const out = join(context.tempDir, 'mock.mp4');
    await runLocalCommand(context, 'ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=128x72:d=1', '-pix_fmt', 'yuv420p', out], { timeoutMs: 30000 });
    return { media: readFileSync(out), mimeType: 'video/mp4', durationSec: 1 };
  }
});
