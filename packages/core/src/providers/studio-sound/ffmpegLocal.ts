import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProvider } from '../registry';
import { runLocalCommand } from '../localCommand';
import type { LocalMediaProvider } from '../contract';

const FILTER_CHAIN_VERSION = 0;
const PROFILES = ['clean_voice', 'podcast', 'meeting', 'tutorial'] as const;
type Profile = typeof PROFILES[number];

export type StudioSoundInput = {
  inputPath: string;
  profile: Profile;
  filterChainVersion: number;
  durationSec: number;
  credential?: string;
  envTestMode?: boolean;
};

export type StudioSoundOutput = {
  audio: Buffer;
  mimeType: 'audio/wav';
  providerStatus?: number;
};

function localFilterChain(profile: Profile): string {
  const filters = ['afftdn=nr=12:nf=-25', 'loudnorm=I=-16:TP=-1.5:LRA=11'];
  if (profile === 'clean_voice' || profile === 'podcast') filters.push('deesser');
  if (profile !== 'tutorial') filters.push('highpass=f=80');
  return filters.join(',');
}

export function ffmpegLocalArgv(input: { inputPath: string; outputPath: string; profile: Profile; filterChainVersion: number }): string[] {
  if (input.filterChainVersion !== FILTER_CHAIN_VERSION) throw new Error(`Unsupported local enhance filterChainVersion: ${input.filterChainVersion}`);
  return ['ffmpeg', '-y', '-i', input.inputPath, '-af', localFilterChain(input.profile), '-acodec', 'pcm_s16le', input.outputPath];
}

export const studioSoundFfmpegLocalProvider = registerProvider({
  id: 'studio-sound.ffmpeg-local',
  kind: 'studio-sound',
  tier: 'local',
  mode: 'local',
  displayName: 'FFmpeg Local',
  estimateCost: () => ({ currency: 'USD', estimated: 0, actual: 0 }),
  actualCost: () => ({ currency: 'USD', estimated: 0, actual: 0 }),
  ledgerOutput(output) { return { audio: { type: 'Buffer', bytes: output.audio.byteLength }, mimeType: output.mimeType }; },
  async run(input, context) {
    const outputPath = join(context.tempDir, 'enhanced.wav');
    const [command, ...args] = ffmpegLocalArgv({ inputPath: input.inputPath, outputPath, profile: input.profile, filterChainVersion: input.filterChainVersion });
    await runLocalCommand(context, command!, args, { timeoutMs: 10 * 60 * 1000, maxStderrBytes: 2 * 1024 * 1024 });
    return { audio: readFileSync(outputPath), mimeType: 'audio/wav' };
  }
} satisfies LocalMediaProvider<StudioSoundInput, StudioSoundOutput>);
