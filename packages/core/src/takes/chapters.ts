import type { AlignmentArtifact, CompositionFile } from './schema';
import type { MaterializedClipPlan } from './composition';

export interface Chapter { title: string; startSec: number }

export function deriveChapters(_composition: CompositionFile, _alignment: AlignmentArtifact, plan: MaterializedClipPlan[]): Chapter[] {
  return plan.filter((p) => p.chapterTitle).map((p) => ({ title: p.chapterTitle as string, startSec: p.timelineStart }));
}
