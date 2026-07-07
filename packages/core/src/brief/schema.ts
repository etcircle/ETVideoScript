import { z } from 'zod';

export const BriefFrontmatterSchema = z.object({
  title: z.string().min(1),
  audience: z.string().min(1),
  tone: z.string().min(1).optional(),
  targetDurationSec: z.number().int().positive().optional(),
  structure: z.array(z.string().min(1)).optional()
});

export const BriefSchema = z.object({
  frontmatter: BriefFrontmatterSchema,
  body: z.string()
});
export type Brief = z.infer<typeof BriefSchema>;
