import type { ManifestV3 } from '../manifest/schema';
import type { TranscriptWord } from '../schemas';
import { alignWordSequences } from './align';
import { computeCandidateMetrics } from './metrics';
import { normalizeWords } from './normalize';
import { TAKES_CONSTANTS, TakesError, type AlignmentArtifact, type OrphanSpan, type SpanCandidate } from './schema';
import { findOrphans, normalizeReference, projectSpans, referenceFromScript, referenceFromTranscript, segmentReference, type ReferenceWord } from './spans';

export interface AlignInput {
  manifest: ManifestV3;
  groupId: string;
  transcripts: Map<string, TranscriptWord[]>;
  scriptText?: string;
  generatedAt: string;
}

export function computeAlignment(input: AlignInput): AlignmentArtifact {
  const group = input.manifest.takeGroups.find((g) => g.groupId === input.groupId);
  if (!group) throw new TakesError('TAKES_UNKNOWN_GROUP', `Unknown take group: ${input.groupId}. Known: ${input.manifest.takeGroups.map((g) => g.groupId).join(', ') || '(none)'}`);
  if (group.clipIds.length < 1) throw new TakesError('TAKES_EMPTY_GROUP', `Take group ${input.groupId} has no takes`);

  const missing = group.clipIds.filter((clipId) => !input.transcripts.has(clipId));
  if (missing.length > 0) {
    throw new TakesError('TAKES_MISSING_TRANSCRIPTS',
      `Transcribe these takes first:\n${missing.map((clipId) => `  ets transcribe --clip ${clipId}`).join('\n')}`, { missing });
  }

  const assetOfClip = new Map<string, string>();
  const labelOfClip = new Map<string, string>();
  for (const track of input.manifest.tracks) {
    for (const clip of track.clips) if (group.clipIds.includes(clip.clipId)) assetOfClip.set(clip.clipId, clip.assetId);
  }
  group.clipIds.forEach((clipId, i) => labelOfClip.set(clipId, `take ${String(i + 1).padStart(2, '0')}`));

  // Reference selection
  let referenceWords: ReferenceWord[];
  let reference: AlignmentArtifact['reference'];
  if (group.reference?.kind === 'file' || input.scriptText !== undefined) {
    const text = input.scriptText ?? '';
    referenceWords = referenceFromScript(text);
    reference = { kind: 'file', path: group.reference?.kind === 'file' ? group.reference.path : 'takes/script.txt' };
  } else if (group.reference?.kind === 'take') {
    referenceWords = referenceFromTranscript(input.transcripts.get(group.reference.clipId)!);
    reference = { kind: 'take', clipId: group.reference.clipId };
  } else {
    const refClip = [...group.clipIds].sort((a, b) => {
      const wc = (input.transcripts.get(b)!.length) - (input.transcripts.get(a)!.length);
      return wc !== 0 ? wc : a.localeCompare(b);
    })[0];
    referenceWords = referenceFromTranscript(input.transcripts.get(refClip)!);
    reference = { kind: 'take', clipId: refClip };
  }

  const refNorm = normalizeReference(referenceWords);
  const spans = segmentReference(referenceWords);

  const takes: AlignmentArtifact['takes'] = [];
  const candidates: SpanCandidate[] = [];
  const orphans: OrphanSpan[] = [];
  let orphanSeq = 0;

  for (const clipId of group.clipIds) {
    const takeWords = input.transcripts.get(clipId)!;
    const takeNorm = normalizeWords(takeWords);
    const pairs = alignWordSequences(refNorm, takeNorm);
    const matched = pairs.filter((p) => p.kind === 'match').length;
    const matchedFraction = takeNorm.length > 0 ? Number((matched / takeNorm.length).toFixed(4)) : 0;
    takes.push({
      clipId, assetId: assetOfClip.get(clipId) ?? '', label: labelOfClip.get(clipId)!,
      wordCount: takeWords.length, matchedFraction,
      lowConfidence: matchedFraction < TAKES_CONSTANTS.LOW_CONFIDENCE_MATCH_FRACTION
    });

    for (const raw of projectSpans(spans, refNorm, takeNorm, takeWords, pairs)) {
      candidates.push({ ...raw, clipId, metrics: computeCandidateMetrics(takeWords, raw.takeWordStart, raw.takeWordEnd) });
    }
    for (const raw of findOrphans(pairs, takeNorm, takeWords)) {
      orphanSeq += 1;
      orphans.push({ orphanId: `o${String(orphanSeq).padStart(3, '0')}`, clipId, ...raw });
    }
  }

  candidates.sort((a, b) => a.spanId.localeCompare(b.spanId) || a.clipId.localeCompare(b.clipId));
  orphans.sort((a, b) => a.clipId.localeCompare(b.clipId) || a.tStart - b.tStart);
  // Re-number orphans after the stable sort so ids are ordered (clipId, tStart)
  orphans.forEach((orphan, i) => { orphan.orphanId = `o${String(i + 1).padStart(3, '0')}`; });

  return {
    schemaVersion: 1, groupId: input.groupId, generatedAt: input.generatedAt, reference,
    takes,
    spans: spans.map((s) => ({ spanId: s.spanId, ordinal: s.ordinal, text: s.text })),
    candidates, orphans
  };
}
