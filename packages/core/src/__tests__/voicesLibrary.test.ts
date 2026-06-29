import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readVoicesLibrary,
  removeVoice,
  upsertVoice,
  voicesLibraryPath,
  writeVoicesLibrary,
  type VoiceRecord
} from '../index';

function tempRoot() { return mkdtempSync(join(tmpdir(), 'etvs-voices-')); }
function cleanup(root: string) { rmSync(root, { recursive: true, force: true }); }

function voice(overrides: Partial<VoiceRecord> = {}): VoiceRecord {
  return {
    schemaVersion: 1,
    id: 'narrator-eve',
    name: 'Narrator Eve',
    provider: 'elevenlabs',
    voiceId: 'el_voice_abc123',
    createdAt: '2026-05-20T00:00:00.000Z',
    updatedAt: '2026-05-20T00:00:00.000Z',
    ...overrides
  };
}

describe('voices library (~/.etvs/voices.json)', () => {
  it('returns an empty file with null hash before any voice exists', () => {
    const root = tempRoot();
    try {
      const snap = readVoicesLibrary({ homeDir: root });
      expect(snap.value).toEqual({ schemaVersion: 1, voices: [], updatedAt: expect.any(String) });
      expect(snap.hash).toBeNull();
      expect(snap.mtimeMs).toBeNull();
    } finally { cleanup(root); }
  });

  it('upserts a voice and reads it back with deterministic id ordering', () => {
    const root = tempRoot();
    try {
      const first = upsertVoice({ homeDir: root, voice: { id: 'narrator-tom', name: 'Tom', provider: 'elevenlabs', voiceId: 'el_voice_t1' } });
      const second = upsertVoice({ homeDir: root, voice: { id: 'narrator-eve', name: 'Eve', provider: 'elevenlabs', voiceId: 'el_voice_e1', sampleAssetPath: 'assets/voice/eve-sample.wav', originProjectId: 'phase1-whisper' } });
      expect(first.createdAt).toBe(first.updatedAt);
      const all = readVoicesLibrary({ homeDir: root }).value.voices;
      // Sorted by id ASC.
      expect(all.map((v) => v.id)).toEqual(['narrator-eve', 'narrator-tom']);
      expect(all.find((v) => v.id === 'narrator-eve')?.sampleAssetPath).toBe('assets/voice/eve-sample.wav');
      expect(all.find((v) => v.id === 'narrator-eve')?.originProjectId).toBe('phase1-whisper');
      expect(second.id).toBe('narrator-eve');
    } finally { cleanup(root); }
  });

  it('keeps createdAt across renames and bumps updatedAt on edit', async () => {
    const root = tempRoot();
    try {
      const original = upsertVoice({ homeDir: root, voice: { id: 'eve', name: 'Eve', provider: 'elevenlabs', voiceId: 'el_a' } });
      // Tiny sleep so updatedAt clock advances at ms resolution (nowIso uses Date).
      await new Promise((resolve) => setTimeout(resolve, 5));
      const renamed = upsertVoice({ homeDir: root, voice: { id: 'eve', name: 'Eve Updated', provider: 'elevenlabs', voiceId: 'el_a' } });
      expect(renamed.createdAt).toBe(original.createdAt);
      expect(renamed.updatedAt >= original.updatedAt).toBe(true);
      expect(renamed.name).toBe('Eve Updated');
    } finally { cleanup(root); }
  });

  it('removes a voice and throws voice_not_found when the id is not in the library', () => {
    const root = tempRoot();
    try {
      upsertVoice({ homeDir: root, voice: { id: 'eve', name: 'Eve', provider: 'elevenlabs', voiceId: 'el_a' } });
      removeVoice({ homeDir: root, id: 'eve' });
      expect(readVoicesLibrary({ homeDir: root }).value.voices).toHaveLength(0);
      let caught: unknown;
      try { removeVoice({ homeDir: root, id: 'unknown' }); } catch (err) { caught = err; }
      expect((caught as { code?: string })?.code).toBe('voice_not_found');
      expect((caught as Error)?.message).toMatch(/Voice not found: unknown/);
    } finally { cleanup(root); }
  });

  it('rejects stale concurrent writes with settings_stale', () => {
    const root = tempRoot();
    try {
      const first = readVoicesLibrary({ homeDir: root });
      writeVoicesLibrary({ ...first.value, voices: [voice()], updatedAt: '2026-05-20T00:00:00.000Z' }, first, { homeDir: root });
      expect(() => writeVoicesLibrary({ ...first.value, voices: [voice({ id: 'narrator-tom', voiceId: 'el_t' })], updatedAt: '2026-05-20T00:00:01.000Z' }, first, { homeDir: root })).toThrow(/voices library changed/i);
    } finally { cleanup(root); }
  });

  it('reports malformed voices.json without silently resetting it', () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, '.etvs'), { recursive: true });
      const path = voicesLibraryPath({ homeDir: root });
      writeFileSync(path, '{broken');
      expect(() => readVoicesLibrary({ homeDir: root })).toThrow(/Malformed settings JSON/);
      expect(readFileSync(path, 'utf8')).toBe('{broken');
    } finally { cleanup(root); }
  });

  it('rejects voice ids that are not stable slugs', () => {
    const root = tempRoot();
    try {
      expect(() => upsertVoice({ homeDir: root, voice: { id: 'Has Spaces', name: 'Bad', provider: 'elevenlabs', voiceId: 'el_a' } })).toThrow(/voice id must be a stable slug/);
      expect(() => upsertVoice({ homeDir: root, voice: { id: 'has/slash', name: 'Bad', provider: 'elevenlabs', voiceId: 'el_a' } })).toThrow(/voice id must be a stable slug/);
    } finally { cleanup(root); }
  });

  it('writes voices.json chmod 0600 — voice metadata is biometric-adjacent', () => {
    const root = tempRoot();
    const previousUmask = process.umask(0);
    try {
      upsertVoice({ homeDir: root, voice: { id: 'eve', name: 'Eve', provider: 'elevenlabs', voiceId: 'el_a' } });
      const path = voicesLibraryPath({ homeDir: root });
      expect(existsSync(path)).toBe(true);
      expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
      expect(readFileSync(path, 'utf8')).toContain('elevenlabs');
    } finally {
      process.umask(previousUmask);
      cleanup(root);
    }
  });

  it('rejects sampleAssetPath that is absolute or contains `..`', () => {
    const root = tempRoot();
    try {
      expect(() => upsertVoice({ homeDir: root, voice: { id: 'a', name: 'A', provider: 'elevenlabs', voiceId: 'el_a', sampleAssetPath: '/etc/passwd' } })).toThrow(/project-relative/);
      expect(() => upsertVoice({ homeDir: root, voice: { id: 'b', name: 'B', provider: 'elevenlabs', voiceId: 'el_b', sampleAssetPath: '../escape.wav' } })).toThrow(/project-relative/);
      expect(() => upsertVoice({ homeDir: root, voice: { id: 'c', name: 'C', provider: 'elevenlabs', voiceId: 'el_c', sampleAssetPath: 'assets/voice/../../escape.wav' } })).toThrow(/project-relative/);
      expect(() => upsertVoice({ homeDir: root, voice: { id: 'd', name: 'D', provider: 'elevenlabs', voiceId: 'el_d', sampleAssetPath: 'C:\\Windows\\System32\\config.wav' } })).toThrow(/project-relative/);
      // Sanity: a clean project-relative path is accepted.
      const ok = upsertVoice({ homeDir: root, voice: { id: 'okvoice', name: 'OK', provider: 'elevenlabs', voiceId: 'el_ok', sampleAssetPath: 'assets/voice/sample.wav' } });
      expect(ok.sampleAssetPath).toBe('assets/voice/sample.wav');
    } finally { cleanup(root); }
  });

  it('rejects voices.json with duplicate voice ids', () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, '.etvs'), { recursive: true });
      writeFileSync(voicesLibraryPath({ homeDir: root }), JSON.stringify({
        schemaVersion: 1,
        voices: [
          { schemaVersion: 1, id: 'eve', name: 'Eve A', provider: 'elevenlabs', voiceId: 'el_a', createdAt: '2026-05-20T00:00:00.000Z', updatedAt: '2026-05-20T00:00:00.000Z' },
          { schemaVersion: 1, id: 'eve', name: 'Eve B', provider: 'elevenlabs', voiceId: 'el_b', createdAt: '2026-05-20T00:00:00.000Z', updatedAt: '2026-05-20T00:00:00.000Z' }
        ],
        updatedAt: '2026-05-20T00:00:00.000Z'
      }));
      let caught: unknown;
      try { readVoicesLibrary({ homeDir: root }); } catch (err) { caught = err; }
      expect((caught as { code?: string })?.code).toBe('invalid_settings');
      expect(JSON.stringify((caught as { details?: unknown })?.details)).toMatch(/duplicate voice id: eve/);
    } finally { cleanup(root); }
  });

  it('accepts a Cartesia-provider voice and still parses the existing ElevenLabs record', () => {
    const root = tempRoot();
    try {
      // The pre-existing ElevenLabs 'Demo Voice' record must keep parsing after the provider
      // enum widened to include 'cartesia' (no migration; both literals are valid).
      const el = upsertVoice({ homeDir: root, voice: { id: 'demo-el', name: 'Demo Voice (EL)', provider: 'elevenlabs', voiceId: 'el_demo_voiceid' } });
      expect(el.provider).toBe('elevenlabs');
      const cart = upsertVoice({ homeDir: root, voice: { id: 'demo-cartesia', name: 'Demo Voice (Cartesia)', provider: 'cartesia', voiceId: '00000000-0000-4000-8000-000000000000' } });
      expect(cart.provider).toBe('cartesia');
      const all = readVoicesLibrary({ homeDir: root }).value.voices;
      expect(all.map((v) => `${v.provider}:${v.voiceId}`).sort()).toEqual([
        'cartesia:00000000-0000-4000-8000-000000000000',
        'elevenlabs:el_demo_voiceid'
      ]);
    } finally { cleanup(root); }
  });

  it('rejects an unknown voice provider', () => {
    const root = tempRoot();
    try {
      expect(() => upsertVoice({ homeDir: root, voice: { id: 'bad', name: 'Bad', provider: 'openai' as any, voiceId: 'x' } })).toThrow();
    } finally { cleanup(root); }
  });

  it('rejects voices.json with the same (provider, voiceId) registered under two slugs', () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, '.etvs'), { recursive: true });
      writeFileSync(voicesLibraryPath({ homeDir: root }), JSON.stringify({
        schemaVersion: 1,
        voices: [
          { schemaVersion: 1, id: 'eve-one', name: 'Eve 1', provider: 'elevenlabs', voiceId: 'el_same', createdAt: '2026-05-20T00:00:00.000Z', updatedAt: '2026-05-20T00:00:00.000Z' },
          { schemaVersion: 1, id: 'eve-two', name: 'Eve 2', provider: 'elevenlabs', voiceId: 'el_same', createdAt: '2026-05-20T00:00:00.000Z', updatedAt: '2026-05-20T00:00:00.000Z' }
        ],
        updatedAt: '2026-05-20T00:00:00.000Z'
      }));
      let caught: unknown;
      try { readVoicesLibrary({ homeDir: root }); } catch (err) { caught = err; }
      expect((caught as { code?: string })?.code).toBe('invalid_settings');
      expect(JSON.stringify((caught as { details?: unknown })?.details)).toMatch(/handle elevenlabs:el_same is already registered as eve-one/);
    } finally { cleanup(root); }
  });
});
