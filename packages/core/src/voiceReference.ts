import { z } from 'zod';

// VoiceReference binds a TTS provider id to the provider-native voice handle. A bare voice
// string is ambiguous across providers — 'eve' could mean an xAI stock voice or an ElevenLabs
// cloned voice. Persisting the pair makes manifest re-renders and `taskOptions.tts.defaultVoice`
// self-describing without ledger lookups. providerId is constrained to tts.* because voices
// are a TTS concern.
//
// This file is intentionally dependency-free (only zod) so it can be imported from both the
// providerSettings module and the operations/voice-patch module without creating an import
// cycle through filesystem.ts → manifest/schema.ts → operations/registry.ts.
export const VoiceReferenceSchema = z.object({
  providerId: z.string().regex(/^tts\.[a-z0-9][a-z0-9-]*$/, 'voice reference providerId must be a tts.<name> id'),
  voiceId: z.string().min(1).max(128)
});

export type VoiceReference = z.infer<typeof VoiceReferenceSchema>;
