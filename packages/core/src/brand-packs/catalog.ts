import { z } from 'zod';

export const BrandPackPreviewKindSchema = z.enum(['paper', 'bold', 'wave', 'screen']);
export const BrandPackPreviewSchema = z.object({
  bg: z.string(),
  accent: z.string(),
  ink: z.string(),
  kind: BrandPackPreviewKindSchema
});
export const BrandPackSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  desc: z.string(),
  installed: z.boolean(),
  preview: BrandPackPreviewSchema
});

export type BrandPackPreviewKind = z.infer<typeof BrandPackPreviewKindSchema>;
export type BrandPack = z.infer<typeof BrandPackSchema>;

export const BRAND_PACKS: readonly BrandPack[] = [
  { id: 'etcircle', label: 'ETCircle · warm editorial',
    desc: 'Paper · clay · Instrument Serif. Hairline lower-thirds.',
    installed: true,
    preview: { bg: '#f4efe6', accent: '#d65a36', ink: '#171411', kind: 'paper' } },
  { id: 'shorts', label: 'Shorts · bold',
    desc: 'High-contrast captions, animated word-by-word, vertical.',
    installed: false,
    preview: { bg: '#171411', accent: '#f5c542', ink: '#fefefe', kind: 'bold' } },
  { id: 'podcast', label: 'Podcast · waveform',
    desc: 'Static frame with waveform · chapter cards · two-line caption.',
    installed: false,
    preview: { bg: '#0d0b09', accent: '#e98b62', ink: '#f4efe6', kind: 'wave' } },
  { id: 'tutorial', label: 'Tutorial · screen',
    desc: 'Picture-in-picture facecam · subtitle bar · timestamp chips.',
    installed: false,
    preview: { bg: '#072752', accent: '#e15924', ink: '#f4efe6', kind: 'screen' } }
];

export function getBrandPack(id: string): BrandPack | undefined {
  return BRAND_PACKS.find((pack) => pack.id === id);
}

export function isKnownBrandPackId(id: string): boolean {
  return getBrandPack(id) !== undefined;
}
