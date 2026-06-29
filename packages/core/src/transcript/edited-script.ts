import type { ManifestV3 } from '../manifest/schema';
import { getOperationKind } from '../operations/registry';
import type { PillView } from '../operations/base';
import type { TranscriptWord, TranscriptWords } from '../schemas';
import type { TimeMap } from '../timeMap/types';
import { outputTime } from '../timeMap/compose';

export type V3EditedScriptWordToken = {
  type: 'word';
  word: TranscriptWord;
  outputStart: number;
  outputEnd: number;
  muted: boolean;
  operationIds: string[];
  /** Set when a speed op covers this word (approved). */
  fx?: 'speed';
  /** Speed factor (2 | 4 | 8 | 16) when fx === 'speed'. */
  factor?: number;
  /** True on the last word covered by a speed op — signals where to render the factor superscript. */
  speedLast?: boolean;
  /** True when a proposed/awaiting_approval op covers this word — triggers dashed underline in the UI. */
  proposed?: boolean;
};

export type V3EditedScriptMarkerToken = {
  type: 'operation_marker';
  operationId: string;
  view: PillView;
  hiddenWordIds: string[];
  hiddenText: string;
};

export type V3EditedScriptToken = V3EditedScriptWordToken | V3EditedScriptMarkerToken;
export type V3EditedScript = { tokens: V3EditedScriptToken[]; hiddenWordIds: string[]; plainText: string };

function textForWords(words: TranscriptWord[]): string {
  return words.map((word) => word.text).join(' ').trim();
}

function overlaps(word: TranscriptWord, view: PillView): boolean {
  return word.start < view.end && word.end > view.start;
}

function opTargetClipId(op: ManifestV3['operations'][number]): string | undefined {
  const t = (op as { target?: unknown }).target;
  if (t && typeof t === 'object' && 'clipId' in t) {
    const c = (t as { clipId?: unknown }).clipId;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

/**
 * Time overlap PLUS clip scoping (codex P2): in a multi-clip transcript, word
 * times are clip-local, so a time-only overlap would mark words in a different
 * clip that happen to share the same local time. Scope by clipId when BOTH the
 * word and the op carry one; fall back to time-only when either is absent (so
 * single-clip and untagged-word projects are unchanged).
 */
function coversWord(word: TranscriptWord, op: ManifestV3['operations'][number], view: PillView): boolean {
  if (!overlaps(word, view)) return false;
  const oc = opTargetClipId(op);
  return !word.clipId || !oc || word.clipId === oc;
}

function tokenText(token: V3EditedScriptToken): string {
  if (token.type === 'word') return token.word.text;
  const text = typeof token.view.details?.text === 'string' ? token.view.details.text : '';
  return text || `[${token.view.label} ${token.hiddenWordIds.length} ${token.hiddenWordIds.length === 1 ? 'word' : 'words'}]`;
}

export function deriveEditedScriptFromTimeMap(transcript: TranscriptWords, manifest: ManifestV3, timeMap: TimeMap): V3EditedScript {
  const defaultClipId = manifest.tracks.flatMap((track) => track.clips)[0]?.clipId ?? '';
  const approvedViews = manifest.operations
    .filter((op) => op.status === 'approved')
    .map((op) => ({ op, view: getOperationKind(op.type).transcriptView(op) }))
    .filter((entry): entry is { op: ManifestV3['operations'][number]; view: PillView } => !!entry.view)
    .sort((a, b) => a.view.start - b.view.start || a.view.end - b.view.end || a.op.id.localeCompare(b.op.id));

  // Speed views: approved speed ops — used to tag covered word tokens inline.
  const speedViews = approvedViews
    .filter(({ view }) => view.kind === 'speed' && typeof view.details?.rate === 'number')
    .map(({ op, view }) => ({ op, view, rate: view.details!.rate as number }));

  // Proposed views: ops not yet approved — any status other than 'approved'/'rejected'/'disabled'.
  const proposedViews = manifest.operations
    .filter((op) => op.status === 'proposed' || op.status === 'awaiting_approval')
    .map((op) => {
      try { return { op, view: getOperationKind(op.type).transcriptView(op) }; } catch { return null; }
    })
    .filter((entry): entry is { op: ManifestV3['operations'][number]; view: PillView } => !!entry?.view)
    .sort((a, b) => a.view.start - b.view.start || a.view.end - b.view.end || a.op.id.localeCompare(b.op.id));

  // Track which word is the last word covered by each speed op so we can set speedLast.
  const speedLastWordId = new Map<string, string>();
  for (const { op, view } of speedViews) {
    let lastId: string | null = null;
    for (const word of transcript.words) {
      if (coversWord(word, op, view)) lastId = word.id;
    }
    if (lastId) speedLastWordId.set(op.id, lastId);
  }

  const hiddenWordIds = new Set<string>();
  const tokens: V3EditedScriptToken[] = [];
  for (let index = 0; index < transcript.words.length;) {
    const word = transcript.words[index]!;
    const clipId = word.clipId || defaultClipId;
    const outputStart = outputTime(timeMap, clipId, word.start);
    const outputEnd = outputTime(timeMap, clipId, word.end);
    const replacingView = approvedViews.find(({ op, view }) => view.details && typeof view.details.text === 'string' && coversWord(word, op, view));
    if (replacingView) {
      const hiddenWords = transcript.words.slice(index).filter((candidate) => coversWord(candidate, replacingView.op, replacingView.view));
      hiddenWords.forEach((hidden) => hiddenWordIds.add(hidden.id));
      tokens.push({ type: 'operation_marker', operationId: replacingView.op.id, view: replacingView.view, hiddenWordIds: hiddenWords.map((hidden) => hidden.id), hiddenText: textForWords(hiddenWords) });
      index += hiddenWords.length || 1;
      continue;
    }
    if (outputStart == null || outputEnd == null || outputEnd <= outputStart) {
      const hiddenViews = approvedViews.filter(({ op, view }) => coversWord(word, op, view));
      const firstHidden = hiddenViews[0];
      hiddenWordIds.add(word.id);
      if (firstHidden && tokens.at(-1)?.type !== 'operation_marker') {
        const hiddenWords = transcript.words.slice(index).filter((candidate) => coversWord(candidate, firstHidden.op, firstHidden.view));
        hiddenWords.forEach((hidden) => hiddenWordIds.add(hidden.id));
        tokens.push({ type: 'operation_marker', operationId: firstHidden.op.id, view: firstHidden.view, hiddenWordIds: hiddenWords.map((hidden) => hidden.id), hiddenText: textForWords(hiddenWords) });
        index += hiddenWords.length || 1;
        continue;
      }
      index += 1;
      continue;
    }
    // TODO(Chunk 4): tone is presentation metadata; add a semantic mute flag if another warning-tone op ships.
    const mutedBy = approvedViews.filter(({ op, view }) => view.tone === 'warning' && coversWord(word, op, view)).map(({ op }) => op.id);

    // Speed tagging: find the first approved speed op that covers this word.
    const coveringSpeed = speedViews.find(({ op, view }) => coversWord(word, op, view));
    const fx: 'speed' | undefined = coveringSpeed ? 'speed' : undefined;
    const factor: number | undefined = coveringSpeed ? coveringSpeed.rate : undefined;
    const speedLast: boolean | undefined = coveringSpeed ? speedLastWordId.get(coveringSpeed.op.id) === word.id : undefined;

    // Proposed tagging: any proposed/awaiting_approval op covering this word.
    const proposed: boolean | undefined = proposedViews.some(({ op, view }) => coversWord(word, op, view)) ? true : undefined;

    tokens.push({ type: 'word', word, outputStart, outputEnd, muted: mutedBy.length > 0, operationIds: mutedBy, ...(fx ? { fx, factor, speedLast } : {}), ...(proposed ? { proposed } : {}) });
    index += 1;
  }
  return { tokens, hiddenWordIds: Array.from(hiddenWordIds), plainText: tokens.map(tokenText).filter(Boolean).join(' ') };
}
