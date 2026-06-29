import type { ManifestV3 } from '../manifest/schema';
import type { Output } from './schema';
import type { TranscriptWords } from '../schemas';

function timelineDuration(manifest: ManifestV3): number {
  return Math.max(0, ...manifest.tracks.flatMap((track) => track.clips.map((clip) => clip.timelineStart + (clip.sourceEnd - clip.sourceStart))));
}

function scoreFor(text: string, duration: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const durationScore = duration >= 15 && duration <= 90 ? 0.45 : duration < 8 || duration > 120 ? 0.1 : 0.25;
  const wordScore = Math.min(0.4, words / 100);
  const hookScore = /\b(how|why|best|worst|secret|mistake|tip|first|finally)\b/i.test(text) ? 0.15 : 0.05;
  return Math.round(Math.min(1, durationScore + wordScore + hookScore) * 100) / 100;
}

export function proposeOutputs(manifest: ManifestV3, transcript: TranscriptWords): Output[] {
  const duration = timelineDuration(manifest) || transcript.durationSec;
  const candidates = transcript.segments
    .filter((segment) => segment.end > segment.start)
    .map((segment, index): Output => {
      const start = Math.max(0, segment.start);
      const end = Math.min(duration, segment.end);
      const text = segment.text.trim();
      const title = text ? text.split(/\s+/).slice(0, 8).join(' ') : `Clip ${index + 1}`;
      return {
        outputId: `output_clip_${String(index + 1).padStart(3, '0')}`,
        kind: 'clip',
        rangeSec: { start, end },
        aspects: ['9:16', '1:1', '16:9'],
        title,
        score: scoreFor(text, end - start),
        status: 'proposed'
      };
    })
    .filter((output) => output.rangeSec && output.rangeSec.end > output.rangeSec.start);

  return candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.rangeSec!.start - b.rangeSec!.start).slice(0, 10);
}
