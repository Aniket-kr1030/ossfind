import { z } from "zod";
import * as semver from "semver";

const ScorecardCheckSchema = z
  .object({
    name: z.string().min(1),
    score: z.number().nullable().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export const EnrichmentBundleSchema = z.object({
  id: z.string().regex(/^(npm|pypi|github):.+$/, 'id must use the "<ecosystem>:<name>" format'),
  license: z.object({
    spdxId: z.string().min(1).nullable(),
    source: z.string().min(1),
    confidence: z.number().min(0).max(1),
  }),
  vulnerabilities: z.array(
    z.object({
      id: z.string().min(1),
      severity: z.string().min(1),
      // A non-version fix must never suppress a critical-vulnerability rule.
      // Keep this strict at the boundary so all ranker callers get the same
      // fail-closed behaviour.
      fixedIn: z.string().refine((version) => semver.valid(version) !== null, {
        message: "fixedIn must be a valid semantic version",
      }).optional(),
    }),
  ),
  sources: z.object({
    /** OSV request/result provenance; `ok` includes a successful empty result. */
    osv: z.enum(["ok", "failed", "missing"]),
    /** License source/result provenance, independent from the parsed SPDX value. */
    license: z.enum(["ok", "failed", "missing"]),
    /** OpenSSF Scorecard provenance. */
    scorecard: z.enum(["ok", "failed", "missing"]),
  }),
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
