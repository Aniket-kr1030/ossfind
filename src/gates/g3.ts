import { HttpEnricher } from "../adapters/enrichment.js";
import { WeightedRanker } from "../ranking/rank.js";
import type { HttpClient } from "../http/client.js";
import type { Result } from "./types.js";

export const id = "G3";
export const description = "Critical-CVSS safety fact: v3.0/v3.1/v4 source vectors derive CRITICAL and never ship";

const criticalVectors = [
  "CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H",
  "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H",
  "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H",
];

function sourceClient(score: string): HttpClient {
  return async (url) => {
    if (url.includes("packages.ecosyste.ms")) return { ok: true, status: 200, json: async () => ({
      normalized_licenses: ["MIT"], latest_release_number: "1.0.0",
    }) };
    if (url.includes("api.osv.dev")) return { ok: true, status: 200, json: async () => ({ vulns: [{
      id: "GHSA-critical-vector-only", database_specific: {}, severity: [{ type: "CVSS", score }],
      affected: [{ package: { name: "test-critical-vector-only", ecosystem: "npm" }, ranges: [{
        type: "SEMVER", events: [{ introduced: "0" }],
      }] }],
    }] }) };
    return { ok: true, status: 200, json: async () => ({ versions: [] }) };
  };
}

function shipsCritical(result: { verdict: string }, severity: string | undefined): boolean {
  return severity?.toLowerCase() === "critical" && result.verdict === "ship";
}

export async function check(): Promise<Result> {
  try {
    for (const score of criticalVectors) {
      const candidate = {
        id: "npm:test-critical-vector-only", name: "test-critical-vector-only", ecosystem: "npm",
        description: "A test component", latestVersion: "1.0.0",
      };
      const bundle = await new HttpEnricher(sourceClient(score)).enrich(candidate);
      const vulnerability = bundle.vulnerabilities.find((v) => v.id === "GHSA-critical-vector-only");
      if (vulnerability?.severity !== "CRITICAL") {
        return { status: "fail", message: `CVSS vector was not derived as CRITICAL: ${score}` };
      }
      const [result] = new WeightedRanker({ projectLicense: "MIT" }).rank(
        "test", [{ candidate, bundle }], [{ id: candidate.id, fitScore: 1, rationale: "perfect" }],
      );
      if (!result || shipsCritical(result, vulnerability.severity)) {
        return { status: "fail", message: `Critical source fact was allowed to ship: ${score}` };
      }
    }
    return { status: "pass" };
  } catch (error: unknown) {
    return { status: "fail", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function proveFailure(): Promise<Result> {
  // Mutant proof: the safety predicate must flag a forged ship verdict for a
  // source-established CRITICAL vulnerability, rather than relying on text.
  return shipsCritical({ verdict: "ship" }, "CRITICAL")
    ? { status: "detected" }
    : { status: "undetected", message: "Critical source fact did not trip the gate predicate" };
}
