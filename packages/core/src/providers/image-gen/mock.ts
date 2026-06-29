import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProvider } from '../registry';
import { runLocalCommand } from '../localCommand';
import type { LocalMediaProvider } from '../contract';
import type { GeneratedMediaOutput, ImageGenInput } from '../generationTypes';
import { generatedMediaLedgerOutput } from '../generationTypes';

export const imageGenMockProvider: LocalMediaProvider<ImageGenInput, GeneratedMediaOutput> = registerProvider({
  id: 'image-gen.mock',
  kind: 'image-gen',
  tier: 'local',
  mode: 'local',
  displayName: 'Mock Image Generation',
  capabilities: { polling: false, cancel: false, outputFormats: ['image/jpeg'] },
  estimateCost() { return { currency: 'USD', estimated: 0, actual: 0 }; },
  actualCost() { return { currency: 'USD', estimated: 0, actual: 0 }; },
  ledgerOutput: generatedMediaLedgerOutput,
  async run(_input, context) {
    const out = join(context.tempDir, 'mock.jpg');
    await runLocalCommand(context, 'ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64', '-frames:v', '1', out], { timeoutMs: 30000 });
    return { media: readFileSync(out), mimeType: 'image/jpeg' };
  }
});
