import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VoiceRecordSchema,
  readVoicesLibrary,
  upsertVoice,
  voicesLibraryPath
} from '../providerSettings';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'etvs-voices-clone-'));
}

function cleanup(root: string) {
  rmSync(root, { recursive: true, force: true });
}

// ── Back-compat: old voices.json without W4 fields parses unchanged ───────────

describe('VoiceRecordSchema backward compatibility', () => {
  it('parses a legacy voice record (no W4 fields) unchanged', () => {
    const legacy = {
      schemaVersion: 1,
      id: 'demo-el',
      name: 'Demo Voice (EL)',
      provider: 'elevenlabs',
      voiceId: 'el_demo_voiceid',
      createdAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z'
    };
    const parsed = VoiceRecordSchema.parse(legacy);
    expect(parsed.id).toBe('demo-el');
    expect(parsed.provider).toBe('elevenlabs');
    expect(parsed.cloneScope).toBeUndefined();
    expect(parsed.sourceAudioRange).toBeUndefined();
    expect(parsed.provenance).toBeUndefined();
  });

  it('existing voices.json without W4 fields parses cleanly', () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, '.etvs'), { recursive: true });
      writeFileSync(voicesLibraryPath({ homeDir: root }), JSON.stringify({
        schemaVersion: 1,
        voices: [
          {
            schemaVersion: 1,
            id: 'legacy-voice',
            name: 'Legacy Voice',
            provider: 'elevenlabs',
            voiceId: 'el_old_voice_id',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ],
        updatedAt: '2026-01-01T00:00:00.000Z'
      }));
      const library = readVoicesLibrary({ homeDir: root }).value;
      expect(library.voices).toHaveLength(1);
      expect(library.voices[0]!.id).toBe('legacy-voice');
    } finally {
      cleanup(root);
    }
  });
});

// ── Round-trip: upsertVoice with W4 fields persists and re-reads identically ──

describe('upsertVoice with W4 clone fields', () => {
  it('round-trips cloneScope, sourceAudioRange, and provenance through VoiceRecordSchema', () => {
    const root = tempRoot();
    try {
      const voice = upsertVoice({
        homeDir: root,
        voice: {
          id: 'demo-cartesia',
          name: 'Demo Voice (Cartesia)',
          provider: 'cartesia',
          voiceId: '00000000-0000-4000-8000-000000000000',
          originProjectId: 'proj_test_001',
          cloneScope: 'project',
          sourceAudioRange: { clipId: 'clip_001', start: 5.0, end: 15.0 },
          provenance: { method: 'ivc', createdBy: 'clone-route' }
        } as any
      });
      expect(voice.cloneScope).toBe('project');
      expect((voice as any).sourceAudioRange).toMatchObject({
        clipId: 'clip_001',
        start: 5.0,
        end: 15.0
      });
      expect((voice as any).provenance).toMatchObject({
        method: 'ivc',
        createdBy: 'clone-route'
      });

      // Re-read and verify it's identical
      const rereads = readVoicesLibrary({ homeDir: root }).value.voices;
      const found = rereads.find((v) => v.id === 'demo-cartesia');
      expect(found).toBeDefined();
      expect((found as any).cloneScope).toBe('project');
      expect((found as any).sourceAudioRange?.clipId).toBe('clip_001');
      expect((found as any).sourceAudioRange?.start).toBe(5.0);
      expect((found as any).sourceAudioRange?.end).toBe(15.0);
    } finally {
      cleanup(root);
    }
  });

  it('round-trips local scope with clipId in sourceAudioRange', () => {
    const root = tempRoot();
    try {
      const voice = upsertVoice({
        homeDir: root,
        voice: {
          id: 'local-clone',
          name: 'Local Clone',
          provider: 'cartesia',
          voiceId: 'cart-local-voice-001',
          cloneScope: 'local',
          sourceAudioRange: { clipId: 'clip_abc', start: 2.5, end: 12.5 },
          provenance: { method: 'ivc', createdBy: 'clone-route', sourceAssetPath: 'media/clip_abc/reference-48k.wav' }
        } as any
      });
      expect((voice as any).cloneScope).toBe('local');
      expect((voice as any).sourceAudioRange?.clipId).toBe('clip_abc');
      expect((voice as any).provenance?.sourceAssetPath).toBe('media/clip_abc/reference-48k.wav');
    } finally {
      cleanup(root);
    }
  });
});

// ── Validation: invalid sourceAudioRange and provenance paths ────────────────

describe('VoiceRecordSchema validation for W4 fields', () => {
  it('rejects sourceAudioRange where end <= start', () => {
    expect(() => VoiceRecordSchema.parse({
      schemaVersion: 1,
      id: 'bad-range',
      name: 'Bad Range',
      provider: 'cartesia',
      voiceId: 'v1',
      sourceAudioRange: { clipId: 'clip_001', start: 10, end: 5 }, // end < start
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })).toThrow();
  });

  it('rejects sourceAudioRange where end === start', () => {
    expect(() => VoiceRecordSchema.parse({
      schemaVersion: 1,
      id: 'bad-range2',
      name: 'Bad Range2',
      provider: 'cartesia',
      voiceId: 'v2',
      sourceAudioRange: { clipId: 'clip_001', start: 5, end: 5 }, // end === start
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })).toThrow();
  });

  it('rejects provenance.sourceAssetPath that is absolute', () => {
    expect(() => VoiceRecordSchema.parse({
      schemaVersion: 1,
      id: 'bad-path',
      name: 'Bad Path',
      provider: 'cartesia',
      voiceId: 'v3',
      provenance: { sourceAssetPath: '/etc/passwd' }, // absolute path
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })).toThrow();
  });

  it('rejects provenance.sourceAssetPath with .. traversal', () => {
    expect(() => VoiceRecordSchema.parse({
      schemaVersion: 1,
      id: 'bad-traversal',
      name: 'Bad Traversal',
      provider: 'cartesia',
      voiceId: 'v4',
      provenance: { sourceAssetPath: '../../../etc/passwd' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })).toThrow();
  });

  it('accepts valid relative sourceAssetPath', () => {
    const parsed = VoiceRecordSchema.parse({
      schemaVersion: 1,
      id: 'good-path',
      name: 'Good Path',
      provider: 'cartesia',
      voiceId: 'v5',
      provenance: { sourceAssetPath: 'media/clip_001/reference-48k.wav' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    expect((parsed as any).provenance?.sourceAssetPath).toBe('media/clip_001/reference-48k.wav');
  });
});

// ── Handle dedupe: two Cartesia clones with distinct voiceIds don't collide ───

describe('VoicesFileSchema handle dedupe — multi-clone safety', () => {
  it('two cartesia clones with distinct voiceIds in the same project do not trip dedupe', () => {
    const root = tempRoot();
    try {
      const v1 = upsertVoice({
        homeDir: root,
        voice: {
          id: 'clone-local',
          name: 'Local Clone',
          provider: 'cartesia',
          voiceId: 'cart-ivc-local-001',
          cloneScope: 'local',
          originProjectId: 'proj_test'
        } as any
      });
      const v2 = upsertVoice({
        homeDir: root,
        voice: {
          id: 'clone-project',
          name: 'Project Clone',
          provider: 'cartesia',
          voiceId: 'cart-ivc-project-002', // different voiceId
          cloneScope: 'project',
          originProjectId: 'proj_test'
        } as any
      });
      expect(v1.id).toBe('clone-local');
      expect(v2.id).toBe('clone-project');
      const library = readVoicesLibrary({ homeDir: root }).value;
      expect(library.voices).toHaveLength(2);
    } finally {
      cleanup(root);
    }
  });

  // Handle is (provider, accountRef, voiceId): provider-local voice IDs are only unique
  // WITHIN one account, so the same voiceId under two different accounts is two distinct
  // voices and must both persist — rejecting the second would strand a paid remote clone.
  it('same provider+voiceId under two DIFFERENT accountRefs both persist', () => {
    const root = tempRoot();
    try {
      upsertVoice({
        homeDir: root,
        voice: {
          id: 'acct-a-voice', name: 'A', provider: 'elevenlabs', voiceId: 'el_shared_id',
          accountRef: 'elevenlabs:acct-a'
        } as any
      });
      upsertVoice({
        homeDir: root,
        voice: {
          id: 'acct-b-voice', name: 'B', provider: 'elevenlabs', voiceId: 'el_shared_id',
          accountRef: 'elevenlabs:acct-b'
        } as any
      });
      const library = readVoicesLibrary({ homeDir: root }).value;
      expect(library.voices).toHaveLength(2);
      expect(library.voices.map((v) => v.accountRef).sort()).toEqual(['elevenlabs:acct-a', 'elevenlabs:acct-b']);
    } finally {
      cleanup(root);
    }
  });

  it('same provider+accountRef+voiceId is still rejected as a duplicate handle', () => {
    const root = tempRoot();
    try {
      upsertVoice({
        homeDir: root,
        voice: {
          id: 'dup-1', name: 'Dup 1', provider: 'elevenlabs', voiceId: 'el_dup_id',
          accountRef: 'elevenlabs:acct-a'
        } as any
      });
      expect(() => upsertVoice({
        homeDir: root,
        voice: {
          id: 'dup-2', name: 'Dup 2', provider: 'elevenlabs', voiceId: 'el_dup_id',
          accountRef: 'elevenlabs:acct-a'
        } as any
      })).toThrow(/already registered/);
    } finally {
      cleanup(root);
    }
  });

  it('legacy untagged duplicates (no accountRef) are still rejected — untagged is its own class', () => {
    const root = tempRoot();
    try {
      upsertVoice({
        homeDir: root,
        voice: { id: 'legacy-1', name: 'L1', provider: 'cartesia', voiceId: 'cart_legacy_id' } as any
      });
      expect(() => upsertVoice({
        homeDir: root,
        voice: { id: 'legacy-2', name: 'L2', provider: 'cartesia', voiceId: 'cart_legacy_id' } as any
      })).toThrow(/already registered/);
    } finally {
      cleanup(root);
    }
  });
});
