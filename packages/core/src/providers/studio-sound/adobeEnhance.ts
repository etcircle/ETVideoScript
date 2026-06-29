import { registerProvider } from '../registry';
import { paidStudioSoundProvider } from './shared';

export const studioSoundAdobeEnhanceProvider = registerProvider(paidStudioSoundProvider({
  id: 'studio-sound.adobe-enhance',
  name: 'adobe-enhance',
  displayName: 'Adobe Enhance',
  endpoint: 'https://api.adobe.example/enhance/audio'
}));
