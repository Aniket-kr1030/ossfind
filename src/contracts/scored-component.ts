import { z } from "zod";

const UnitScoreSchema = z.number().min(0).max(1);

export const ScoredComponentSchema = z.object({
  id: z.string().regex(/^(npm|pypi|github|huggingface):.+$/, 'id must use the "<ecosystem>:<name>" format'),
  name: z.string().min(1),
  repoUrl: z.string().url().optional(),
  scores: z.object({
    fit: UnitScoreSchema,
    license: UnitScoreSchema,
    security: UnitScoreSchema,
    health: UnitScoreSchema,
    effort: UnitScoreSchema,
  }),
  overall: z.number().int().min(0).max(100),
  verdict: z.enum(["ship", "caution", "avoid"]),
  reasons: z.array(z.string().min(1)).min(1),
  badges: z.object({
    license: z.string().min(1),
    cveCount: z.number().int().nonnegative(),
    scorecard: z.number().nullable(),
  }),
});

export type ScoredComponent = z.infer<typeof ScoredComponentSchema>;
