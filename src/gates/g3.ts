import { HttpEnricher } from "../adapters/enrichment.js";
import { WeightedRanker } from "../ranking/rank.js";
import { searchComponents } from "../pipeline/orchestrator.js";
import { buildPipeline } from "../mcp/pipeline.js";
import type { Result } from "./types.js";
import type { HttpClient } from "../http/client.js";

export const id = "G3";
export const description = "Explainability + critical-CVE: every ScoredComponent has reasons, and unfixed critical vulns are never 'ship'";

export async function check(): Promise<Result> {
  try {
    const pipeline = buildPipeline({ fixtures: true });
    const results = await searchComponents("http-client", pipeline);

    for (const r of results) {
      if (!r.reasons || r.reasons.length === 0 || r.reasons.some(reason => !reason)) {
        return { status: "fail", message: `Component ${r.id} has empty or missing reasons` };
      }
      const hasUnfixedCritical = r.reasons.some(reason => reason.toLowerCase().includes("critical cve") && reason.toLowerCase().includes("unfixed"));
      if (hasUnfixedCritical && r.verdict === "ship") {
        return { status: "fail", message: `Component ${r.id} has unfixed critical vuln but is marked as 'ship'` };
      }
    }

    return { status: "pass" };
  } catch (e: any) {
    return { status: "fail", message: e.message };
  }
}

export async function proveFailure(): Promise<Result> {
  const mockHttpClient: HttpClient = async (url) => {
    if (url.includes("packages.ecosyste.ms")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: "test-critical-vector-only",
          ecosystem: "npm",
          normalized_licenses: ["MIT"],
          latest_release_number: "1.0.0",
        }),
      };
    }
    if (url.includes("api.deps.dev")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          packageKey: { name: "test-critical-vector-only", system: "npm" },
          versions: [{ versionKey: { name: "test-critical-vector-only", system: "npm", version: "1.0.0" }, isDefault: true }],
        }),
      };
    }
    if (url.includes("api.osv.dev")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          vulns: [
            {
              id: "GHSA-critical-vector-only",
              database_specific: {},
              severity: [
                {
                  type: "CVSS_V3",
                  score: "CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H",
                },
              ],
              affected: [
                {
                  package: { name: "test-critical-vector-only", ecosystem: "npm" },
                  ranges: [
                    {
                      type: "SEMVER",
                      events: [
                        { introduced: "0" },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  try {
    const enricher = new HttpEnricher(mockHttpClient);
    const candidate = {
      id: "npm:test-critical-vector-only",
      name: "test-critical-vector-only",
      ecosystem: "npm",
      description: "A test component",
    };
    const bundle = await enricher.enrich(candidate);

    const vuln = bundle.vulnerabilities.find(v => v.id === "GHSA-critical-vector-only");
    if (!vuln || vuln.severity !== "CRITICAL") {
      return { status: "undetected", message: "Failed to parse CVSS-only severity as CRITICAL" };
    }

    const ranker = new WeightedRanker({ projectLicense: "MIT" });
    const scored = ranker.rank("test-critical-vector-only", [{ candidate, bundle }], [{ id: candidate.id, fitScore: 1.0, rationale: "Perfect fit" }]);

    const resultComp = scored.find(c => c.id === candidate.id);
    if (!resultComp) {
      return { status: "undetected", message: "Scored component not found" };
    }

    if (resultComp.verdict === "ship") {
      return { status: "undetected", message: "Critical vulnerability component was marked as ship" };
    }

    if (resultComp.verdict === "avoid") {
      return { status: "detected" };
    }

    return { status: "undetected", message: `Verdict was ${resultComp.verdict}, expected avoid` };
  } catch (e: any) {
    return { status: "fail", message: e.message };
  }
}
