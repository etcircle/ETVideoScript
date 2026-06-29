import { z } from 'zod';

export const OutputRangeSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative()
}).refine((range) => range.start < range.end, { message: 'range start must be < end', path: ['end'] });

export const AspectSchema = z.string().regex(/^[1-9]\d*:[1-9]\d*$/, 'aspect must be a W:H ratio, e.g. 16:9');

export const OutputSchema = z.object({
  outputId: z.string().min(1),
  kind: z.enum(['full', 'clip']),
  rangeSec: OutputRangeSchema.optional(),
  aspects: z.array(AspectSchema).min(1),
  title: z.string().min(1).optional(),
  score: z.number().min(0).max(1).optional(),
  status: z.enum(['manual', 'proposed', 'approved', 'rejected', 'disabled'])
}).superRefine((output, ctx) => {
  if (output.kind === 'clip' && !output.rangeSec) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rangeSec'], message: 'clip outputs require rangeSec' });
  }
});

export type Output = z.infer<typeof OutputSchema>;
