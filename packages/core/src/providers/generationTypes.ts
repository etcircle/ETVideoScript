export type GeneratedMediaOutput = {
  media: Buffer;
  mimeType: string;
  durationSec?: number;
  providerStatus?: number;
};

export type ImageGenInput = {
  prompt: string;
  count?: number;
  aspectRatio?: string;
  model?: string;
};

export type VideoGenInput = {
  prompt: string;
  durationSec?: number;
  aspectRatio?: string;
  resolution?: string;
  model?: string;
};

export type MusicGenInput = {
  prompt: string;
  durationMs?: number;
  model?: string;
};

export function generatedMediaLedgerOutput(output: GeneratedMediaOutput) {
  return {
    media: { type: 'Buffer', bytes: output.media.byteLength },
    mimeType: output.mimeType,
    ...(output.durationSec == null ? {} : { durationSec: output.durationSec }),
    ...(output.providerStatus == null ? {} : { providerStatus: output.providerStatus })
  };
}
