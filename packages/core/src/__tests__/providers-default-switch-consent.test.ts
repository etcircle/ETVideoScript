import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readStudioSoundDefaultProvider, setStudioSoundDefaultProvider } from '../audioEnhance';

describe('studio sound default provider consent', () => {
  it('refuses switching local default to paid without explicit acknowledgement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvs-provider-default-'));
    const configPath = join(root, 'studio-sound-default.json');
    const etvsDir = join(root, '.etvs');
    try {
      const prompt = vi.fn(async () => false);
      await expect(setStudioSoundDefaultProvider('adobe-enhance', { configPath, etvsDir, confirm: prompt })).rejects.toThrow(/refused/i);
      expect(prompt).toHaveBeenCalledWith('Adobe Enhance will be charged on your account for every Studio Sound op. Continue? [y/N]');
      expect(readStudioSoundDefaultProvider({ configPath, etvsDir })).toBe('ffmpeg-local');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not synthesize paid acknowledgement when no confirmation is provided', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvs-provider-default-'));
    const configPath = join(root, 'studio-sound-default.json');
    const etvsDir = join(root, '.etvs');
    try {
      await expect(setStudioSoundDefaultProvider('elevenlabs-isolation', { configPath, etvsDir })).rejects.toThrow(/requires|refused/i);
      expect(readStudioSoundDefaultProvider({ configPath, etvsDir })).toBe('ffmpeg-local');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists the paid default after explicit acknowledgement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'etvs-provider-default-'));
    const configPath = join(root, 'studio-sound-default.json');
    const etvsDir = join(root, '.etvs');
    try {
      await setStudioSoundDefaultProvider('elevenlabs-isolation', { configPath, etvsDir, confirm: async () => true });
      expect(readStudioSoundDefaultProvider({ configPath, etvsDir })).toBe('elevenlabs-isolation');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
