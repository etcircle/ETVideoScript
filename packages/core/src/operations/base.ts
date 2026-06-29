import type { z, ZodRawShape, ZodTypeAny } from 'zod';
import type { ManifestV3 } from '../manifest/schema';
import type { RenderStage } from '../render/types';
import type { Clip, Track } from '../tracks/schema';
import type { TimeMap } from '../timeMap/types';
import { z as zod } from 'zod';

export const OperationStatusSchema = zod.enum(['proposed', 'awaiting_approval', 'approved', 'rejected', 'disabled']);
export const OperationActorSchema = zod.enum(['user', 'agent', 'system']);

export const ClipSpanTargetSchema = zod.object({
  kind: zod.literal('clip-span'),
  trackId: zod.string().min(1),
  clipId: zod.string().min(1),
  start: zod.number().nonnegative(),
  end: zod.number().nonnegative()
});

export const ClipBoundaryTargetSchema = zod.object({
  kind: zod.literal('clip-boundary'),
  trackId: zod.string().min(1),
  clipId: zod.string().min(1)
});

export const TrackTargetSchema = zod.object({
  kind: zod.literal('track'),
  trackId: zod.string().min(1)
});

export const OperationTargetSchema = zod.discriminatedUnion('kind', [ClipSpanTargetSchema, ClipBoundaryTargetSchema, TrackTargetSchema]);

export const OperationBaseSchema = zod.object({
  id: zod.string().min(1),
  status: OperationStatusSchema.default('proposed'),
  disabledReason: zod.string().optional(),
  target: OperationTargetSchema,
  reason: zod.string().optional(),
  confidence: zod.number().min(0).max(1).optional(),
  proposedBy: OperationActorSchema.default('agent'),
  createdBy: OperationActorSchema.default('agent'),
  createdAt: zod.string().datetime()
});

export function defineOperationSchema<const Type extends string, TargetSchema extends ZodTypeAny, Shape extends ZodRawShape>(type: Type, targetSchema: TargetSchema, extraShape: Shape) {
  return OperationBaseSchema.extend({ type: zod.literal(type), target: targetSchema, ...extraShape }).refine((op) => {
    const target = op.target as z.infer<typeof OperationTargetSchema>;
    return target.kind !== 'clip-span' || target.start < target.end;
  }, {
    message: 'operation start must be < end',
    path: ['target', 'end']
  });
}

export interface PillView {
  kind: string;
  label: string;
  tone: 'neutral' | 'danger' | 'warning' | 'success' | 'info';
  operationId: string;
  status: z.infer<typeof OperationStatusSchema>;
  start: number;
  end: number;
  details?: Record<string, unknown>;
}

export interface OverlayView {
  kind: string;
  label: string;
  tone: 'neutral' | 'danger' | 'warning' | 'success' | 'info';
  operationId: string;
  trackId: string;
  clipId?: string;
  start?: number;
  end?: number;
  details?: Record<string, unknown>;
}

export interface OperationValidationContext {
  manifest: ManifestV3;
  track: Track;
  clip?: Clip;
  assetExists?: (assetId: string) => boolean;
  providerRequestExists?: (id: string) => boolean;
}

export interface RenderContributionContext {
  manifest: ManifestV3;
  timeMap: TimeMap;
}

export type OperationTargetKind = z.infer<typeof OperationTargetSchema>['kind'];

export interface OperationKind<Schema extends ZodTypeAny = ZodTypeAny> {
  type: string;
  schema: Schema;
  targetKind: OperationTargetKind;
  precedence: number;
  conflictsWith?: readonly string[];
  affectsTimeline: boolean;
  validateLocal(op: z.infer<Schema>, ctx: OperationValidationContext): string[];
  projectTimeMap?(op: z.infer<Schema>, map: TimeMap): TimeMap;
  renderContribution?(op: z.infer<Schema>, ctx: RenderContributionContext): RenderStage | null;
  transcriptView(op: z.infer<Schema>): PillView | null;
  timelineView(op: z.infer<Schema>): OverlayView;
}

export type ClipSpanTarget = z.infer<typeof ClipSpanTargetSchema>;
export type ClipBoundaryTarget = z.infer<typeof ClipBoundaryTargetSchema>;
export type TrackTarget = z.infer<typeof TrackTargetSchema>;
export type OperationTarget = z.infer<typeof OperationTargetSchema>;
export type OperationBase = z.infer<typeof OperationBaseSchema>;
