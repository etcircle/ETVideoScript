import type { ManifestV3 } from '../manifest/schema';
import { getOperationKind } from '../operations/registry';
import type { PillView } from '../operations/base';
import type { TranscriptWord, TranscriptWords } from '../schemas';
import type { TimeMap } from '../timeMap/types';
import { outputTime } from '../timeMap/compose';

// PREVIEW script tokens reflect what the user is EDITING toward — Preview is the
// final-draft editing surface, not a purely passive projection (see feedback_preview_first
// 2026-05-24). Cuts are removed entirely. Voice patches become inline replacement text
// (rendered audio speaks the new line). Mute-with-draftText also becomes an inline
// replacement so the user can SEE the text they typed before hitting Generate — the
// render itself still just silences the source audio until generation runs, but the
// editing surface needs to show pending intent or the type-over flow looks broken
// (user feedback 2026-05-24). Plain mutes (no draftText) stay visible-but-flagged so the
// user understands they'll see the speaker's mouth move silently. transcript_amend stays
// out of preview because it changes nothing in render output. No operation pills, no
// glyphs — the goal is a clean transcript of the edited output. Filler-word highlighting
// is a UI concern (workspace-scoped list).
export type V3PreviewScriptWordToken = {
  type: 'word';
  word: TranscriptWord;
  outputStart: number;
  outputEnd: number;
  muted: boolean;
  operationIds: string[];
};

export type V3PreviewScriptReplacementToken = {
  type: 'replacement';
  text: string;
  operationId: string;
  opType: string;
  replacedWordIds: string[];
  hiddenText: string;
  isReRecorded: boolean;
  // Rendered output position of the replacement. Used by the UI to seek into the draft —
  // word tokens already carry their time-map projected outputStart/outputEnd, so emitting
  // the same on replacements keeps preview seek behavior consistent across token kinds.
  // Null when the time-map doesn't project the replaced range (shouldn't happen for valid
  // voice_patch/amend ops, but stays nullable for defensive safety).
  outputStart: number | null;
  outputEnd: number | null;
};

export type V3PreviewScriptToken = V3PreviewScriptWordToken | V3PreviewScriptReplacementToken;
export type V3PreviewScript = { tokens: V3PreviewScriptToken[]; plainText: string };

function textForWords(words: TranscriptWord[]): string {
  return words.map((word) => word.text).join(' ').trim();
}

function overlaps(word: TranscriptWord, view: PillView): boolean {
  return word.start < view.end && word.end > view.start;
}

// Pulled the clip-id off the op target so we don't apply a clip-span op to words from a
// different clip whose source-time range happens to overlap. Multi-clip projects (recorded
// take on track A + screen recording on track B that share the 0–Ns source range) used to
// silently fold an op on clip A onto clip B's words. Non-clip-scoped ops (e.g. caption-
// style targeting a track) get a null clipId and don't restrict the match — those ops
// generally don't return a transcriptView anyway.
function opTargetClipId(op: ManifestV3['operations'][number]): string | null {
  if (op.target.kind === 'clip-span') return op.target.clipId;
  if (op.target.kind === 'clip-boundary') return op.target.clipId;
  return null;
}

// `defaultClipId` mirrors the same fallback the time-map projection uses below: in older /
// single-clip transcripts, TranscriptWord.clipId is the schema default `''` and we want
// those words to count against the project's only clip. Codex P2 (2026-05-24): a strict
// `word.clipId === op.target.clipId` comparison without this fallback dropped preview-mode
// voice patches and mutes for every existing single-clip project.
function matchesClip(op: ManifestV3['operations'][number], word: TranscriptWord, defaultClipId: string): boolean {
  const opClipId = opTargetClipId(op);
  if (opClipId == null) return true;
  const wordClipId = word.clipId || defaultClipId;
  return wordClipId === opClipId;
}

function tokenText(token: V3PreviewScriptToken): string {
  return token.type === 'word' ? token.word.text : token.text;
}

export function derivePreviewScriptFromTimeMap(transcript: TranscriptWords, manifest: ManifestV3, timeMap: TimeMap): V3PreviewScript {
  const defaultClipId = manifest.tracks.flatMap((track) => track.clips)[0]?.clipId ?? '';
  const approvedViews = manifest.operations
    .filter((op) => op.status === 'approved')
    .map((op) => ({ op, view: getOperationKind(op.type).transcriptView(op) }))
    .filter((entry): entry is { op: ManifestV3['operations'][number]; view: PillView } => !!entry.view)
    .sort((a, b) => a.view.start - b.view.start || a.view.end - b.view.end || a.op.id.localeCompare(b.op.id));

  const tokens: V3PreviewScriptToken[] = [];
  // Codex P2-2 (2026-05-24): for transcripts where words from different clips are interleaved
  // in the words array, the previous logic advanced past `hiddenWords.length` slots — but the
  // filtered hiddenWords only contained target-clip words, so non-target interleaved words
  // were silently skipped (or worse, re-encountered later and produced a duplicate replacement
  // token). Tracking emitted op ids and always advancing by 1 sidesteps the issue: the
  // replacement is emitted once when we first see a matching word, subsequent matching words
  // (from the same op) are dropped, and interleaved words from other clips still get their
  // turn through the normal cut/mute/word branches below.
  const emittedOpIds = new Set<string>();
  for (let index = 0; index < transcript.words.length;) {
    const word = transcript.words[index]!;
    const clipId = word.clipId || defaultClipId;
    const outputStart = outputTime(timeMap, clipId, word.start);
    const outputEnd = outputTime(timeMap, clipId, word.end);
    // Replacement op — emit a single inline token with the replacement text. The user reads
    // what they'll hear (voice_patch) or what they typed (mute draftText), not the original
    // words underneath. PREVIEW is the EDITING surface, so the replacement set is:
    //   - voice_patch: replaces audio with TTS / s2s output (rendered output speaks the new
    //     text). Inline as `re-recorded`.
    //   - mute with draftText: type-over draft. Render still silences original audio until
    //     Generate runs, but the editing surface needs to surface pending intent or the
    //     type-over flow looks broken (user feedback 2026-05-24). Inline as `proposed`.
    //   - transcript_amend: display-only (affectsTimeline: false, excluded from caption
    //     projection) — the rendered audio still speaks the ORIGINAL words. Stays out of
    //     preview; users can see amendments in AUDIT TRAIL mode.
    const replacingView = approvedViews.find(({ op, view }) => {
      if (!view.details || typeof view.details.text !== 'string' || !view.details.text.trim()) return false;
      if (!overlaps(word, view) || !matchesClip(op, word, defaultClipId)) return false;
      return op.type === 'voice_patch' || op.type === 'mute';
    });
    if (replacingView) {
      // A subsequent word covered by the same op — drop it; the replacement was already
      // emitted at the first occurrence and we don't want duplicates in the preview.
      if (emittedOpIds.has(replacingView.op.id)) {
        index += 1;
        continue;
      }
      emittedOpIds.add(replacingView.op.id);
      // Gather all words this op replaces (for hiddenText / replacedWordIds). Don't use the
      // length to drive `index` — see comment above on emittedOpIds.
      const replacedWords = transcript.words.filter((candidate) => overlaps(candidate, replacingView.view) && matchesClip(replacingView.op, candidate, defaultClipId));
      const replacementText = String(replacingView.view.details?.text || '').trim();
      // Skip empty replacements — produces no visible token but still consumes the source
      // word range so we don't re-emit the underlying words.
      const firstReplaced = replacedWords[0];
      const lastReplaced = replacedWords[replacedWords.length - 1];
      const replacementOutputStart = firstReplaced ? outputTime(timeMap, firstReplaced.clipId || defaultClipId, firstReplaced.start) : null;
      const replacementOutputEnd = lastReplaced ? outputTime(timeMap, lastReplaced.clipId || defaultClipId, lastReplaced.end) : null;
      // Codex P2 pass 8 (2026-05-24): gate replacement emission on a valid projected range.
      // If the voice_patch's source span doesn't project into the output (e.g. another
      // overlapping clip's cut removed that output band), the render contributes no insert
      // for this op — showing replacement text in PREVIEW would lie about what plays.
      const rangeProjects = replacementOutputStart != null && replacementOutputEnd != null && replacementOutputEnd > replacementOutputStart;
      if (replacementText && rangeProjects) {
        tokens.push({
          type: 'replacement',
          text: replacementText,
          operationId: replacingView.op.id,
          opType: replacingView.op.type,
          replacedWordIds: replacedWords.map((hidden) => hidden.id),
          hiddenText: textForWords(replacedWords),
          isReRecorded: replacingView.op.type === 'voice_patch',
          outputStart: replacementOutputStart,
          outputEnd: replacementOutputEnd
        });
      }
      index += 1;
      continue;
    }
    // Cut: word doesn't appear in the rendered output. Drop entirely; preview is clean.
    if (outputStart == null || outputEnd == null || outputEnd <= outputStart) {
      index += 1;
      continue;
    }
    // Mute: word still appears on screen but its audio is gone. Show it but mark muted so
    // the UI can render with strikethrough/faded styling and the user understands they'll
    // SEE the speaker's mouth move on a silent frame.
    const muteOps = approvedViews.filter(({ op, view }) => view.tone === 'warning' && overlaps(word, view) && matchesClip(op, word, defaultClipId));
    tokens.push({
      type: 'word',
      word,
      outputStart,
      outputEnd,
      muted: muteOps.length > 0,
      operationIds: muteOps.map(({ op }) => op.id)
    });
    index += 1;
  }
  // Sort tokens by rendered output position so the preview matches the draft's playback
  // order. Single-clip projects (the common case) emit tokens in source order, which IS
  // output order — sort is a no-op there. Multi-clip/rearranged timelines (overlay clip,
  // reordered tracks) interleave clips' words at different output positions; without
  // sorting, the preview text reads in transcript order, not playback order (Codex P2
  // 2026-05-24 pass 7). Replacement tokens with a null outputStart sink to the end so the
  // happy path remains stable. Sort is stable in modern JS (ES2019+), preserving relative
  // order for equal output positions.
  function tokenSortKey(token: V3PreviewScriptToken): number {
    if (token.type === 'word') return token.outputStart;
    return token.outputStart ?? Number.POSITIVE_INFINITY;
  }
  const sortedTokens = tokens.slice().sort((a, b) => tokenSortKey(a) - tokenSortKey(b));
  return { tokens: sortedTokens, plainText: sortedTokens.map(tokenText).filter(Boolean).join(' ') };
}
