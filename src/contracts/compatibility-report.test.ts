import { describe, expect, it } from "vitest";
import { CompatibilityReportSchema } from "./compatibility-report.js";

describe("CompatibilityReportSchema", () => {
  it("accepts a concrete compatibility conflict report", () => {
    const report = CompatibilityReportSchema.parse({
      component: "npm:axios",
      verdict: "conflicts",
      findings: [{
        kind: "peer-conflict",
        severity: "blocker",
        detail: "react 17.0.2 does not satisfy ^18.0.0",
        evidence: "project.dependencies.react=17.0.2; component.peerDependencies.react=^18.0.0",
      }],
      notes: [],
    });

    expect(report.verdict).toBe("conflicts");
  });

  it("rejects findings without concrete evidence", () => {
    expect(CompatibilityReportSchema.safeParse({
      component: "npm:axios",
      verdict: "unknown",
      findings: [{
        kind: "peer-unmet",
        severity: "blocker",
        detail: "react is missing",
        evidence: "",
      }],
      notes: ["Project manifest did not declare react."],
    }).success).toBe(false);
  });
});
