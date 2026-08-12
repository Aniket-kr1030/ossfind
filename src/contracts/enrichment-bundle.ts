import { z } from "zod";

const ScorecardCheckSchema = z
  .object({
    name: z.string().min(1),
    score: z.number().nullable().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export const EnrichmentBundleSchema = z.object({
  id: z.string().regex(/^npm:.+$/, 'id must use the "npm:<name>" format'),
  license: z.object({
    spdxId: z.string().min(1).nullable(),
    source: z.string().min(1),
    confidence: z.number().min(0).max(1),
  }),
  vulnerabilities: z.array(
    z.object({
      id: z.string().min(1),
      severity: z.string().min(1),
      fixedIn: z.string().min(1).optional(),
    }),
  ),
  scorecard: z.object({
    overall: z.number().nullable(),
    checks: z.array(ScorecardCheckSchema),
  }),
  maintenance: z.object({
    lastCommit: z.string().min(1).optional(),
    releaseCadenceDays: z.number().nonnegative().optional(),
    contributors90d: z.number().int().nonnegative().optional(),
    archived: z.boolean().optional(),
  }),
});

export type EnrichmentBundle = z.infer<typeof EnrichmentBundleSchema>;
export type ScorecardCheck = z.infer<typeof ScorecardCheckSchema>;
