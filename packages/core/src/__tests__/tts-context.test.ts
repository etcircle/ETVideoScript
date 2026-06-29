import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProvider } from '../providers';
import { setProviderSecret, upsertProvider, type ProviderRecord } from '../providerSettings';
import { extractSurroundingTranscriptText, synthesizeSpeech } from '../tts';
import type { TranscriptWords } from '../schemas';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

const originalFetch = globalThis.fetch;
afterEach(() => { (globalThis as any).fetch = originalFetch; vi.restoreAllMocks(); });

function tempRoot() { return mkdtempSync(join(tmpdir(), 'etvs-tts-ctx-')); }

function record(): ProviderRecord {
  const now = new Date().toISOString();
  return { schemaVersion: 1, id: 'tts.elevenlabs', kind: 'tts', name: 'elevenlabs', tier: 'paid', enabled: true, default: false, createdAt: now, updatedAt: now };
}

function configure(root: string) {
  upsertProvider({ homeDir: root, provider: { ...record(), secretRef: 'elevenlabs-test' } });
  setProviderSecret({ homeDir: root, secretRef: 'elevenlabs-test', value: 'test-key' });
}

async function runTts(root: string, input: Record<string, unknown>) {
  return runProvider({ homeDir: root, workspacePath: root, kind: 'tts', providerId: 'elevenlabs', requestType: 'tts', input, env: {} });
}

// ---------------------------------------------------------------------------
// ElevenLabs adapter: context fields + voice_settings
// ---------------------------------------------------------------------------

describe('ElevenLabs TTS — context passing and voice settings', () => {
  it('always includes voice_settings with stable defaults in the request body', async () => {
    const root = tempRoot();
    let body: Record<string, unknown> = {};
    (globalThis as any).fetch = vi.fn(async (_url: unknown, init: any) => { body = JSON.parse(init.body); return new Response(new Uint8Array(2), { status: 200 }); });
    try {
      configure(root);
      await runTts(root, { text: 'hello', voice: 'eve', language: 'en' });
      expect(body.voice_settings).toMatchObject({ stability: 0.50, similarity_boost: 0.80, style: 0, use_speaker_boost: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('includes previous_text in body when previousText is supplied', async () => {
    const root = tempRoot();
    let body: Record<string, unknown> = {};
    (globalThis as any).fetch = vi.fn(async (_url: unknown, init: any) => { body = JSON.parse(init.body); return new Response(new Uint8Array(2), { status: 200 }); });
    try {
      configure(root);
      await runTts(root, { text: 'hello', voice: 'eve', language: 'en', previousText: 'Welcome to the tutorial.' });
      expect(body.previous_text).toBe('Welcome to the tutorial.');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('includes next_text in body when nextText is supplied', async () => {
    const root = tempRoot();
    let body: Record<string, unknown> = {};
    (globalThis as any).fetch = vi.fn(async (_url: unknown, init: any) => { body = JSON.parse(init.body); return new Response(new Uint8Array(2), { status: 200 }); });
    try {
      configure(root);
      await runTts(root, { text: 'hello', voice: 'eve', language: 'en', nextText: 'Now let\'s look at the output.' });
      expect(body.next_text).toBe('Now let\'s look at the output.');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('omits previous_text and next_text when not supplied (backward compat)', async () => {
    const root = tempRoot();
    let body: Record<string, unknown> = {};
    (globalThis as any).fetch = vi.fn(async (_url: unknown, init: any) => { body = JSON.parse(init.body); return new Response(new Uint8Array(2), { status: 200 }); });
    try {
      configure(root);
      await runTts(root, { text: 'hello', voice: 'eve', language: 'en' });
      expect(body).not.toHaveProperty('previous_text');
      expect(body).not.toHaveProperty('next_text');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('passes both context fields when both are supplied', async () => {
    const root = tempRoot();
    let body: Record<string, unknown> = {};
    (globalThis as any).fetch = vi.fn(async (_url: unknown, init: any) => { body = JSON.parse(init.body); return new Response(new Uint8Array(2), { status: 200 }); });
    try {
      configure(root);
      await runTts(root, { text: 'click the button', voice: 'eve', language: 'en', previousText: 'In this section.', nextText: 'As you can see.' });
      expect(body.previous_text).toBe('In this section.');
      expect(body.next_text).toBe('As you can see.');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// extractSurroundingTranscriptText utility
// ---------------------------------------------------------------------------

const now = '2026-05-23T00:00:00.000Z';

function makeWords(items: Array<{ text: string; start: number; end: number; clipId?: string }>): TranscriptWords['words'] {
  return items.map((w, i) => ({ id: `w${i}`, text: w.text, normalized: w.text.toLowerCase(), start: w.start, end: w.end, speaker: 'speaker_1', confidence: 1, segmentId: 's1', clipId: w.clipId ?? 'clip_001' }));
}

describe('extractSurroundingTranscriptText', () => {
  it('returns empty strings when words array is empty', () => {
    expect(extractSurroundingTranscriptText([], 'clip_001', 5, 6)).toEqual({ previousText: '', nextText: '' });
  });

  it('returns words from the 5s window before patch start', () => {
    const words = makeWords([
      { text: 'far', start: 0, end: 0.5 },       // outside 5s window (>5s before patch at 8)
      { text: 'Welcome', start: 3, end: 3.5 },    // inside window
      { text: 'to', start: 3.6, end: 3.8 },
      { text: 'the', start: 3.9, end: 4.1 },
      { text: 'tutorial.', start: 4.2, end: 4.8 } // last word before patch
    ]);
    const { previousText } = extractSurroundingTranscriptText(words, 'clip_001', 8, 9);
    expect(previousText).toBe('Welcome to the tutorial.');
  });

  it('excludes the word that starts exactly at patch start from previousText', () => {
    const words = makeWords([
      { text: 'before', start: 1, end: 1.5 },
      { text: 'patched', start: 5, end: 6 }  // this is the patched word itself
    ]);
    const { previousText } = extractSurroundingTranscriptText(words, 'clip_001', 5, 6);
    expect(previousText).toBe('before');
    expect(previousText).not.toContain('patched');
  });

  it('returns words from the 5s window after patch end', () => {
    const words = makeWords([
      { text: 'Now', start: 7, end: 7.4 },       // first word after patch end at 6
      { text: 'look', start: 7.5, end: 7.8 },
      { text: 'at', start: 7.9, end: 8.0 },
      { text: 'the', start: 8.1, end: 8.2 },
      { text: 'output.', start: 8.3, end: 8.7 },
      { text: 'far', start: 14, end: 14.5 }       // outside 5s window (>5s after patch)
    ]);
    const { nextText } = extractSurroundingTranscriptText(words, 'clip_001', 5, 6);
    expect(nextText).toContain('Now');
    expect(nextText).toContain('output.');
    expect(nextText).not.toContain('far');
  });

  it('excludes words from a different clipId', () => {
    const words = makeWords([
      { text: 'same-clip', start: 1, end: 1.5, clipId: 'clip_001' },
      { text: 'other-clip', start: 2, end: 2.5, clipId: 'clip_002' }
    ]);
    const { previousText } = extractSurroundingTranscriptText(words, 'clip_001', 5, 6);
    expect(previousText).toContain('same-clip');
    expect(previousText).not.toContain('other-clip');
  });

  it('returns empty nextText when no words follow the patch end', () => {
    const words = makeWords([{ text: 'hello', start: 1, end: 1.5 }]);
    const { nextText } = extractSurroundingTranscriptText(words, 'clip_001', 2, 3);
    expect(nextText).toBe('');
  });

  it('excludes a word that starts before but ends after patchStart (straddling boundary)', () => {
    // Word audio overlaps the patch region — should NOT be sent as previous_text.
    const words = makeWords([
      { text: 'before', start: 3, end: 4 },
      { text: 'straddling', start: 4.6, end: 5.4 } // ends inside patch [5, 6]
    ]);
    const { previousText } = extractSurroundingTranscriptText(words, 'clip_001', 5, 6);
    expect(previousText).toBe('before');
    expect(previousText).not.toContain('straddling');
  });

  it('includes words with empty clipId (global/single-clip transcript fallback)', () => {
    const globalWords = makeWords([
      { text: 'global-word', start: 1, end: 1.5 }
    ]).map((w) => ({ ...w, clipId: '' }));
    const { previousText } = extractSurroundingTranscriptText(globalWords, 'clip_001', 5, 6);
    expect(previousText).toContain('global-word');
  });
});

// ---------------------------------------------------------------------------
// synthesizeSpeech keepSilence gate (W3): default trims, keepSilence preserves
// ---------------------------------------------------------------------------

const describeIfFfmpeg = ffmpegAvailable ? describe : describe.skip;

function probeDurationSec(path: string): number {
  const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], { encoding: 'utf8' });
  return Number(out.stdout.trim());
}

// 0.4s 880 Hz tone + 0.4s digital silence (~0.8s). The default trim (silenceremove, -40dB) drops
// the trailing silence; keepSilence:true must preserve it.
function speechThenSilenceWav() {
  const tmp = mkdtempSync(join(tmpdir(), 'etvs-trim-fixture-'));
  const path = join(tmp, 'clip.wav');
  spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=24000:duration=0.4', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono:d=0.4', '-filter_complex', '[0][1]concat=n=2:v=0:a=1[a]', '-map', '[a]', '-ac', '1', '-acodec', 'pcm_s16le', path], { stdio: 'ignore' });
  const buf = Uint8Array.from(readFileSync(path)); // ArrayBuffer-backed → valid BodyInit
  rmSync(tmp, { recursive: true, force: true });
  return buf;
}

describeIfFfmpeg('synthesizeSpeech — keepSilence gate', () => {
  it('trims trailing silence by default but preserves it when keepSilence is set', async () => {
    const root = tempRoot();
    const wav = speechThenSilenceWav();
    (globalThis as any).fetch = vi.fn(async () => new Response(wav, { status: 200 }));
    try {
      configure(root);
      const trimmed = await synthesizeSpeech(root, { text: 'x', provider: 'elevenlabs', voice: 'eve', homeDir: root });
      const trimmedDur = probeDurationSec(join(root, trimmed.asset));
      const kept = await synthesizeSpeech(root, { text: 'x', provider: 'elevenlabs', voice: 'eve', keepSilence: true, homeDir: root });
      const keptDur = probeDurationSec(join(root, kept.asset));
      expect(trimmedDur).toBeLessThan(0.7);            // trailing ~0.4s silence removed
      expect(keptDur).toBeGreaterThan(0.7);            // full ~0.8s preserved
      expect(keptDur).toBeGreaterThan(trimmedDur + 0.2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
