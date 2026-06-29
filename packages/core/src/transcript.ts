import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TranscriptWords, TranscriptWordsSchema } from './schemas';
import { assertInside, atomicWriteFile, atomicWriteJson, loadProject, nowIso, saveProject } from './filesystem';
import { loadManifestV3 } from './manifest/io';
import type { ManifestV3 } from './manifest/schema';
import './providers';
import { ProviderEnvelopeError, runProvider, type SttHomelabWhisperOutput, type SttMockOutput } from './providers';
import { resolveWhisperBaseUrl, resolveWhisperBasicAuth, type SettingsPathsInput } from './providerSettings';

function normalize(text: string) { return text.toLowerCase().replace(/[^a-z0-9]+/gi, ''); }
function formatTime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s}`;
}
function withClipId(doc: TranscriptWords, clipId: string, source = `media/${clipId}/extracted-audio.wav`): TranscriptWords {
  return TranscriptWordsSchema.parse({ ...doc, source, words: doc.words.map((word, i) => ({ ...word, id: word.id || `w${String(i + 1).padStart(6, '0')}`, clipId })), segments: doc.segments });
}

export type TranscribeProvider = 'mock' | 'homelab-whisper' | 'whisper' | string;
// Include SettingsPathsInput so tests can opt into a hermetic etvsDir and so callers
// that already pass settings paths to other core APIs can pass them through here too.
export type TranscribeClipOptions = SettingsPathsInput & { provider?: TranscribeProvider; mockText?: string };
export type TranscribeAudioInput = SettingsPathsInput & {
  provider?: TranscribeProvider;
  mockText?: string;
  clipId?: string;
  requestId?: string;
  projectId?: string;
  env?: Record<string, string | undefined>;
};

export function transcriptMarkdown(doc: TranscriptWords): string {
  const lines = ['# Transcript', '', `<!-- source: ${doc.source} -->`, `<!-- generatedAt: ${nowIso()} -->`, `<!-- provider: ${doc.provider.name} -->`, `<!-- timing: ${doc.provider.timing} -->`, ''];
  if (doc.provider.timing === 'approximate') lines.push('> Timing is approximate/demo-only because the provider did not return word timestamps.', '');
  for (const seg of doc.segments) lines.push(`[${formatTime(seg.start)} - ${formatTime(seg.end)}] **${seg.speaker}**: ${seg.text}`, '');
  return lines.join('\n');
}

export function wordsFromPlainText(text: string, durationSec: number, providerName = 'mock', timing: 'mock' | 'approximate' = providerName === 'mock' ? 'mock' : 'approximate', requestId: string | null = providerName === 'mock' ? null : `transcribe_${Date.now()}`): TranscriptWords {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const safeDuration = Math.max(durationSec || tokens.length * 0.4, 1);
  const step = safeDuration / Math.max(tokens.length, 1);
  const words = tokens.map((token, index) => ({ id: `w${String(index + 1).padStart(6, '0')}`, text: token, normalized: normalize(token), start: Number((index * step).toFixed(3)), end: Number(Math.min((index + 0.82) * step, safeDuration).toFixed(3)), speaker: 'speaker_1', confidence: timing === 'mock' ? 0.9 : 0.5, segmentId: `seg${String(Math.floor(index / 28) + 1).padStart(4, '0')}`, clipId: '' }));
  const segments = Array.from(new Set(words.map((w) => w.segmentId))).map((segmentId) => {
    const segmentWords = words.filter((w) => w.segmentId === segmentId);
    return { id: segmentId, speaker: 'speaker_1', start: segmentWords[0]?.start || 0, end: segmentWords.at(-1)?.end || safeDuration, text: segmentWords.map((w) => w.text).join(' ') };
  });
  return TranscriptWordsSchema.parse({ schemaVersion: 1, source: 'media/extracted-audio.wav', provider: { name: providerName, model: providerName === 'mock' ? 'mock-word-timestamps' : 'homelab-whisper', requestId, timing }, language: 'en', durationSec: safeDuration, words, segments });
}

export function plainTextFromWhisperResponse(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed?.text === 'string') return parsed.text;
    if (Array.isArray(parsed?.segments)) return parsed.segments.map((segment: any) => String(segment?.text || '').trim()).filter(Boolean).join('\n');
  } catch {}
  return trimmed;
}

// Trailing punctuation that whisper sometimes emits as standalone tokens. We fold these onto
// the preceding real word so the transcript UI doesn't show clickable comma/period boxes and
// so a voice_patch selection over a word also covers its trailing punctuation. The list is
// intentionally narrow: only unambiguous trailing punctuation. Currency symbols ($, €, ¥),
// hashtags (#), at-signs (@), opening brackets ((, [, {), and opening quotes are NOT in the
// set because they carry meaning before a number/identifier and dropping them would mangle
// transcripts like "$5", "#sap", "@alice". Em-dash, en-dash, and curly closing quotes are
// included because they almost always sit between words.
//
// ASCII straight quotes (' and ") are ambiguous (could be opening or closing). They ARE in
// the set as a 95%-case heuristic — most speech transcripts contain closing-context quotes.
// Consequence: a segment whose first token is a standalone straight quote will drop it (the
// "leading punct with no preceding word" branch in the loop below). Accepted trade-off
// because whisper rarely emits standalone leading quotes for natural speech.
//
// If a future whisper variant emits other trailing-attaching punctuation (e.g. CJK 。), extend
// this list rather than re-broadening to \p{P}\p{S}.
const PUNCT_ONLY = /^[.,!?;:…—–’”'")\]}]+$/;

// Paragraph merging thresholds. Whisper.cpp / faster-whisper-server return one segment per
// sentence (and sometimes per phrase), which makes the transcript pane look like a list of
// fragments. Merge consecutive same-speaker segments separated by a short pause into a single
// paragraph until either the gap grows past MAX_GAP_SEC or the paragraph hits SOFT_WORD_CAP
// words. Tunable from a single place if users want denser/looser paragraphs later.
const PARAGRAPH_MAX_GAP_SEC = 1.5;
const PARAGRAPH_SOFT_WORD_CAP = 80;

export function parseTimedWhisperResponse(raw: string, durationSec: number, requestId: string, clipId = '', providerName: string = 'homelab-whisper'): TranscriptWords | null {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const segmentsInput = Array.isArray(parsed.segments) ? [...parsed.segments] : [];
  // OpenAI verbose_json with `timestamp_granularities=word` returns words at the TOP level
  // (https://platform.openai.com/docs/api-reference/audio/transcribe). Homelab Whisper returns
  // them on each segment. Normalize the OpenAI shape into per-segment buckets so the loop below
  // works uniformly across providers without a second parsing path.
  const topLevelWords = Array.isArray(parsed.words) ? parsed.words : null;
  if (topLevelWords && topLevelWords.length && !segmentsInput.some((segment: any) => Array.isArray(segment.words) && segment.words.length)) {
    if (!segmentsInput.length) {
      segmentsInput.push({ start: 0, end: Number(parsed.duration ?? durationSec) || durationSec, text: String(parsed.text ?? ''), words: topLevelWords });
    } else {
      for (const segment of segmentsInput) segment.words = [];
      for (const word of topLevelWords) {
        const start = Number(word.start);
        if (!Number.isFinite(start)) continue;
        let idx = segmentsInput.findIndex((segment: any) => Number(segment.start) <= start && start < Number(segment.end));
        if (idx === -1) idx = segmentsInput.length - 1;
        segmentsInput[idx].words.push(word);
      }
      // Drop segments that ended up with no words so the empty-segment guard below doesn't
      // reject an otherwise-valid OpenAI response that had a sparse segment timeline.
      for (let i = segmentsInput.length - 1; i >= 0; i--) if (!segmentsInput[i].words.length) segmentsInput.splice(i, 1);
    }
  }
  const words: any[] = [];
  const segments: any[] = [];
  for (let s = 0; s < segmentsInput.length; s++) {
    const segment = segmentsInput[s];
    const segId = `seg${String(s + 1).padStart(4, '0')}`;
    const rawWords = Array.isArray(segment.words) ? segment.words : [];
    // Build segmentWords with punctuation-token attachment: any token whose stripped text is
    // pure-punctuation (PUNCT_ONLY) gets folded onto the preceding real word instead of
    // becoming its own entry. This collapses "Screen" + "," into "Screen,".
    const segmentWords: Array<{ text: string; start: number; end: number; probability: number }> = [];
    for (const word of rawWords) {
      const text = String(word.word ?? word.text ?? '').trim();
      const start = Number(word.start);
      const end = Number(word.end);
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) continue;
      const probability = Number(word.probability ?? word.confidence ?? 0.8);
      if (PUNCT_ONLY.test(text)) {
        // Attach to the preceding real word if there is one; otherwise drop. Leading punctuation
        // (a segment that opens with "," "." "—" etc.) is meaningless on its own — dropping it
        // avoids a confusing standalone clickable punctuation box at the start of a paragraph
        // and lets the empty-segment guard below skip purely-punctuation segments cleanly
        // (e.g. whisper's "..." rendering of a laugh or beat).
        if (segmentWords.length) {
          const prev = segmentWords[segmentWords.length - 1]!;
          prev.text = `${prev.text}${text}`;
          prev.end = Math.max(prev.end, end);
        }
        continue;
      }
      segmentWords.push({ text, start, end, probability });
    }
    // Skip segments that contained only filtered tokens (pure-punctuation, blank, or
    // bogus-timing). Failing the whole transcript for one degenerate segment (e.g. a
    // laugh-only segment whisper transcribed as just `["."]`) was the prior behavior;
    // keeping the rest of the transcript is strictly better and the empty-segment guard
    // below still catches the "no segments at all" failure mode.
    if (!segmentWords.length) continue;
    for (const word of segmentWords) words.push({ id: `w${String(words.length + 1).padStart(6, '0')}`, text: word.text, normalized: normalize(word.text), start: Number(word.start.toFixed(3)), end: Number(word.end.toFixed(3)), speaker: 'speaker_1', confidence: Math.max(0, Math.min(1, Number.isFinite(word.probability) ? word.probability : 0.8)), segmentId: segId, clipId });
    const segStart = Number(segment.start ?? segmentWords[0]!.start);
    const segEnd = Number(segment.end ?? segmentWords.at(-1)!.end);
    segments.push({ id: segId, speaker: 'speaker_1', start: Number(segStart.toFixed(3)), end: Number(segEnd.toFixed(3)), text: String(segment.text ?? segmentWords.map((w) => w.text).join(' ')).trim() });
  }
  if (!words.length) return null;
  // Merge whisper's per-sentence segments into reading-friendly paragraphs. Walk in time
  // order; if the current segment has the same speaker, a short gap from the previous, and
  // the previous paragraph hasn't hit the soft cap, fold it into the previous and remap
  // every word's segmentId. The first segment's id wins so the UI's segment list stays stable.
  const mergedSegments: typeof segments = [];
  const segmentIdRemap = new Map<string, string>();
  const wordCountBySegment = new Map<string, number>();
  for (const word of words) wordCountBySegment.set(word.segmentId, (wordCountBySegment.get(word.segmentId) || 0) + 1);
  for (const segment of segments) {
    const prev = mergedSegments[mergedSegments.length - 1];
    if (prev) {
      const gap = segment.start - prev.end;
      const prevWordCount = wordCountBySegment.get(prev.id) || 0;
      if (segment.speaker === prev.speaker && gap < PARAGRAPH_MAX_GAP_SEC && prevWordCount < PARAGRAPH_SOFT_WORD_CAP) {
        prev.end = Number(Math.max(prev.end, segment.end).toFixed(3));
        prev.text = `${prev.text} ${segment.text}`.replace(/\s+/g, ' ').trim();
        segmentIdRemap.set(segment.id, prev.id);
        wordCountBySegment.set(prev.id, prevWordCount + (wordCountBySegment.get(segment.id) || 0));
        continue;
      }
    }
    mergedSegments.push(segment);
  }
  if (segmentIdRemap.size) for (const word of words) {
    const target = segmentIdRemap.get(word.segmentId);
    if (target) word.segmentId = target;
  }
  return TranscriptWordsSchema.parse({ schemaVersion: 1, source: clipId ? `media/${clipId}/extracted-audio.wav` : 'media/extracted-audio.wav', provider: { name: providerName, model: String(parsed.model || 'configured-whisper'), requestId, timing: 'exact' }, language: String(parsed.language || 'en'), durationSec: Number(parsed.duration ?? durationSec), words, segments: mergedSegments });
}

export function writeTranscript(workspacePath: string, doc: TranscriptWords, options: { clipId?: string; updateProject?: boolean } = {}) {
  const workspace = resolve(workspacePath);
  const dirRel = options.clipId ? `transcript/${options.clipId}` : 'transcript';
  const dir = assertInside(workspace, dirRel);
  mkdirSync(dir, { recursive: true });
  const wordsPath = join(dir, 'words.json');
  const mdPath = join(dir, 'transcript.md');
  atomicWriteJson(wordsPath, doc);
  atomicWriteFile(mdPath, transcriptMarkdown(doc));
  const originalWords = join(dir, 'original.words.json');
  const originalMd = join(dir, 'original.transcript.md');
  if (!existsSync(originalWords)) copyFileSync(wordsPath, originalWords);
  if (!existsSync(originalMd)) copyFileSync(mdPath, originalMd);
  if (options.updateProject !== false) {
    const project = loadProject(workspace);
    project.status.transcribed = true;
    project.updatedAt = nowIso();
    saveProject(project);
  }
}

function normalizeProvider(provider?: TranscribeProvider): string | undefined {
  if (!provider) return undefined;
  const bare = provider === 'whisper' ? 'homelab-whisper' : provider;
  return bare.includes('.') ? bare : `stt.${bare}`;
}

function whisperAuthorizationHeader(env: Record<string, string | undefined>): string | undefined {
  const raw = resolveWhisperBasicAuth(env);
  if (!raw) return undefined;
  return /^Basic\s+/i.test(raw) ? raw : `Basic ${raw}`;
}

export function primaryVideoClips(manifest: ManifestV3): Array<{ clipId: string }> {
  const track = manifest.tracks.find((candidate) => candidate.kind === 'video' && candidate.clips.length > 0) ?? manifest.tracks.find((candidate) => candidate.kind === 'video') ?? manifest.tracks[0];
  return (track?.clips ?? []).flatMap((clip) => clip.clipId ? [{ clipId: clip.clipId }] : []);
}

export function transcribableClips(manifest: ManifestV3): Array<{ clipId: string }> {
  const videoTrack = manifest.tracks.find((track) => track.kind === 'video' && track.clips.length > 0) ?? manifest.tracks.find((track) => track.kind === 'video');
  const voiceoverTracks = manifest.tracks.filter((track) => track.kind === 'audio' && track.subtype === 'voiceover');
  const seen = new Set<string>();
  return [videoTrack, ...voiceoverTracks]
    .flatMap((track) => (track?.clips ?? []).map((clip) => ({ clipId: clip.clipId, timelineStart: clip.timelineStart, order: track?.order ?? 0 })))
    .filter((clip) => clip.clipId)
    .sort((a, b) => a.timelineStart - b.timelineStart || a.order - b.order)
    .filter((clip) => {
      if (seen.has(clip.clipId)) return false;
      seen.add(clip.clipId);
      return true;
    })
    .map((clip) => ({ clipId: clip.clipId }));
}

export async function transcribeAudio(workspacePath: string, input: TranscribeAudioInput = {}): Promise<TranscriptWords> {
  const workspace = resolve(workspacePath);
  const project = loadProject(workspace);
  const clipId = input.clipId;
  const source = clipId ? project.clipSources.find((candidate) => candidate.clipId === clipId) : project.clipSources[0];
  if (clipId && !source) throw new Error(`Unknown clipId: ${clipId}`);
  const audioRel = clipId ? `media/${clipId}/extracted-audio.wav` : 'media/extracted-audio.wav';
  const audioPath = assertInside(workspace, audioRel);
  const providerId = normalizeProvider(input.provider);
  const bareProvider = (providerId ?? 'stt.mock').replace(/^stt\./, '');
  const durationSec = source?.durationSec || 60;
  let providerInput: any;
  if (bareProvider === 'mock') {
    const defaultText = clipId ? `Transcript placeholder for ${clipId}.` : `Screen recording imported for ${project.title}. This placeholder transcript proves the local transcript editing loop. Select words on the left, create cut or mute operations, validate the manifest, and render a draft video. Replace this with homelab Whisper transcription when audio extraction is ready.`;
    providerInput = { text: input.mockText ?? defaultText, durationSec };
  } else if (bareProvider === 'openai-whisper') {
    if (!existsSync(audioPath)) throw new Error(`${audioRel} not found; run ets extract-audio first`);
    providerInput = { audioPath, audioRel, durationSec, timeoutMs: 10 * 60 * 1000 };
  } else if (bareProvider === 'elevenlabs') {
    if (!existsSync(audioPath)) throw new Error(`${audioRel} not found; run ets extract-audio first`);
    providerInput = { audioPath, audioRel, durationSec };
  } else if (bareProvider === 'cartesia') {
    // Cartesia Ink-Whisper STT. Distinct branch so it does NOT inherit the homelab-whisper
    // baseUrl/basicAuth from the else-branch — Cartesia auth + base come from the provider record.
    if (!existsSync(audioPath)) throw new Error(`${audioRel} not found; run ets extract-audio first`);
    providerInput = { audioPath, audioRel, durationSec };
  } else {
    if (!existsSync(audioPath)) throw new Error(`${audioRel} not found; run ets extract-audio first`);
    providerInput = { audioPath, audioRel, durationSec, baseUrl: resolveWhisperBaseUrl(input.env ?? process.env), basicAuth: whisperAuthorizationHeader(input.env ?? process.env), timeoutMs: 10 * 60 * 1000 };
  }
  const envelope = await runProvider<any, SttMockOutput | SttHomelabWhisperOutput>({
    workspacePath: workspace,
    kind: 'stt',
    providerId,
    requestType: 'transcription',
    requestId: input.requestId,
    projectId: input.projectId ?? project.projectId,
    input: providerInput,
    env: input.env,
    homeDir: input.homeDir,
    etvsDir: input.etvsDir,
    timeoutMs: 15 * 60 * 1000
  });
  if (envelope.ok === false) throw new ProviderEnvelopeError(envelope.error);
  let doc: TranscriptWords | null;
  if (envelope.providerId === 'stt.mock') {
    const out = envelope.output as SttMockOutput;
    doc = wordsFromPlainText(out.text, out.durationSec, 'mock', 'mock', null);
  } else {
    const out = envelope.output as SttHomelabWhisperOutput;
    doc = parseTimedWhisperResponse(out.rawJson, out.durationSec, envelope.requestId, clipId ?? '', bareProvider);
    if (!doc) {
      if ((input.env ?? process.env).ETVS_ALLOW_APPROXIMATE_TRANSCRIPT !== '1' && (input.env ?? process.env).ALLOW_APPROXIMATE_TRANSCRIPT !== '1' && (input.env ?? process.env).ETVIDEO_ALLOW_APPROXIMATE_TRANSCRIPT !== '1') {
        throw new Error(`${bareProvider} response did not include word-level timestamps. Set ETVS_ALLOW_APPROXIMATE_TRANSCRIPT=1 or ETVIDEO_ALLOW_APPROXIMATE_TRANSCRIPT=1 only for demo-mode approximate timing.`);
      }
      doc = withClipId(wordsFromPlainText(plainTextFromWhisperResponse(out.rawJson), out.durationSec || 60, bareProvider, 'approximate', envelope.requestId), clipId ?? '', audioRel);
    }
  }
  if (clipId) doc = withClipId(doc, clipId, audioRel);
  writeTranscript(workspace, doc, { clipId, updateProject: !clipId });
  return doc;
}

export async function transcribeMock(workspacePath: string) {
  return transcribeAudio(workspacePath, { provider: 'mock' });
}

export async function transcribeHomelabWhisper(workspacePath: string) {
  return transcribeAudio(workspacePath, { provider: 'homelab-whisper' });
}

export async function transcribeClip(workspacePath: string, clipId: string, providerOptions: TranscribeClipOptions = {}): Promise<TranscriptWords> {
  return transcribeAudio(workspacePath, { ...providerOptions, clipId });
}

function concurrencyLimit(): number {
  const raw = Number(process.env.ETVS_TRANSCRIBE_CONCURRENCY || '1');
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}
async function pLimitMap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  }));
  return out;
}

export async function mergeTranscripts(workspacePath: string): Promise<TranscriptWords> {
  const workspace = resolve(workspacePath);
  const manifest = loadManifestV3(workspace);
  const clips = transcribableClips(manifest);
  const docs = clips.flatMap((clip) => {
    const path = assertInside(workspace, `transcript/${clip.clipId}/words.json`);
    if (!existsSync(path)) return [];
    return [TranscriptWordsSchema.parse(JSON.parse(readFileSync(path, 'utf8')))];
  });
  // FIX 3: remap word.segmentId to the same clip${docIndex+1}_ prefix applied to segments,
  // so SENTENCE-mode FK lookups (word.segmentId → segment.id) remain intact after merge.
  const words = docs.flatMap((doc, docIndex) => doc.words.map((word) => ({ ...word, segmentId: `clip${docIndex + 1}_${word.segmentId}`, clipId: word.clipId || doc.source.split('/')[1] || '' })));
  const merged = TranscriptWordsSchema.parse({ schemaVersion: 1, source: 'transcript/per-clip', provider: docs[0]?.provider || { name: 'mock', model: 'mock-word-timestamps', requestId: null, timing: 'mock' }, language: docs[0]?.language || 'en', durationSec: docs.reduce((sum, doc) => sum + doc.durationSec, 0), words, segments: docs.flatMap((doc, docIndex) => doc.segments.map((seg) => ({ ...seg, id: `clip${docIndex + 1}_${seg.id}` }))) });
  writeTranscript(workspace, merged);
  return merged;
}

export async function transcribeAllClips(workspacePath: string, providerOptions: TranscribeClipOptions = {}): Promise<TranscriptWords> {
  const workspace = resolve(workspacePath);
  const manifest = loadManifestV3(workspace);
  const clips = transcribableClips(manifest);
  await pLimitMap(clips, concurrencyLimit(), (clip) => transcribeClip(workspace, clip.clipId, providerOptions));
  return mergeTranscripts(workspace);
}

export function loadTranscript(workspacePath: string): TranscriptWords | null {
  const path = join(resolve(workspacePath), 'transcript/words.json');
  return existsSync(path) ? TranscriptWordsSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : null;
}
