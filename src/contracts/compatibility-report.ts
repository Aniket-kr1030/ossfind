import { z } from "zod";

/** Concrete compatibility facts for adding a component to a project. */
export const CompatibilityReportSchema = z.object({
  component: z.string().min(1),
  verdict: z.enum(["compatible", "conflicts", "unknown"]),
  findings: z.array(z.object({
    kind: z.enum([
      "peer-unmet",
      "peer-conflict",
      "version-conflict",
      "runtime-mismatch",
      "already-present",
      "license",
    ]),
    severity: z.enum(["blocker", "warning", "info"]),
    detail: z.string().min(1),
    evidence: z.string().min(1),
  })),
  notes: z.array(z.string()),
});

export type CompatibilityReport = z.infer<typeof CompatibilityReportSchema>;
