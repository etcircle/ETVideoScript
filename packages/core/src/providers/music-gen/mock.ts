import { registerProvider } from '../registry';
import type { LocalMediaProvider } from '../contract';
import { wavTone } from '../tts/mock';
import type { GeneratedMediaOutput, MusicGenInput } from '../generationTypes';
import { generatedMediaLedgerOutput } from '../generationTypes';

export const musicGenMockProvider: LocalMediaProvider<MusicGenInput, GeneratedMediaOutput> = registerProvider({
  id: 'music-gen.mock',
  kind: 'music-gen',
  tier: 'local',
  mode: 'local',
  displayName: 'Mock Music Generation',
  capabilities: { polling: false, cancel: false, outputFormats: ['audio/wav'] },
  estimateCost() { return { currency: 'USD', estimated: 0, actual: 0 }; },
  actualCost() { return { currency: 'USD', estimated: 0, actual: 0 }; },
  ledgerOutput: generatedMediaLedgerOutput,
  async run(input) {
    return { media: wavTone(`${input.prompt} ${input.prompt} ${input.prompt}`), mimeType: 'audio/wav' };
  }
});
