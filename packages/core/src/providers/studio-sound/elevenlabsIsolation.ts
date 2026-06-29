import { registerProvider } from '../registry';
import { paidStudioSoundProvider } from './shared';

export const studioSoundElevenlabsIsolationProvider = registerProvider(paidStudioSoundProvider({
  id: 'studio-sound.elevenlabs-isolation',
  name: 'elevenlabs-isolation',
  displayName: 'ElevenLabs Isolation',
  endpoint: 'https://api.elevenlabs.io/v1/audio-isolation'
}));
