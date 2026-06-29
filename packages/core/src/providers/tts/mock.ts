import { registerProvider } from '../registry';
import type { LocalMediaProvider } from '../contract';

export type TtsInput = { text: string; voice: string; language: string; model?: string; previousText?: string; nextText?: string; keepSilence?: boolean; granularity?: 'word' | 'phrase' | 'sentence' };
export type TtsOutput = { audio: Buffer; mimeType: 'audio/wav'; providerStatus?: number };

export function wavTone(text: string): Buffer {
  const sampleRate = 24000;
  const channels = 1;
  const bytesPerSample = 2;
  const durationSec = Math.min(Math.max(0.35, text.length * 0.055), 8);
  const samples = Math.ceil(sampleRate * durationSec);
  const dataBytes = samples * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i += 1) {
    const fade = Math.min(i / 800, (samples - i) / 800, 1);
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 2400 * Math.max(fade, 0));
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  return buffer;
}

// Copy this adapter to start a new local provider. Keep adapters pure: they
// return provider output only. They must never write transcript, manifest, or
// asset files; the per-kind public function owns those domain writes.
export const ttsMockProvider: LocalMediaProvider<TtsInput, TtsOutput> = registerProvider({
  id: 'tts.mock',
  kind: 'tts',
  tier: 'local',
  mode: 'local',
  displayName: 'Mock TTS',
  capabilities: { polling: false, cancel: false, outputFormats: ['audio/wav'] },
  estimateCost() { return { currency: 'USD', estimated: 0, actual: 0 }; },
  actualCost() { return { currency: 'USD', estimated: 0, actual: 0 }; },
  async run(input) {
    return { audio: wavTone(input.text), mimeType: 'audio/wav' };
  }
});
