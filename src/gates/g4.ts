import { WeightedRanker } from "../ranking/rank.js";
import type { ComponentCandidate, EnrichmentBundle, FitSignal, ScoredComponent } from "../contracts/index.js";
import type { Result } from "./types.js";

export const id = "G4";
export const description = "License safety fact: GPL/AGPL SPDX expressions and unknown licenses never ship into permissive projects";

const unsafeExpressions: Array<string | null> = [
  "GPL-3.0",
  "gpl-3.0",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "GPL-3.0+",
  "(GPL-3.0)",
  "GPL-3.0 OR MIT",
  "GPL-3.0 AND MIT",
  "AGPL-3.0",
  "agpl-3.0-or-later",
  "LGPL-3.0-only",
  "MIT OR LGPL-3.0-or-later",
  "unknown",
  null,
];

function verdictFor(projectLicense: string, spdxId: string | null): ScoredComponent["verdict"] {
  const candidate: ComponentCandidate = {
    id: "npm:license-gate-package",
    name: "license-gate-package",
    ecosystem: "npm",
    description: "license safety gate package",
  };
  const bundle: EnrichmentBundle = {
    id: candidate.id,
    license: { spdxId, source: "gate", confidence: spdxId ? 1 : 0 },
    vulnerabilities: [],
    sources: { osv: "ok", license: spdxId ? "ok" : "missing", scorecard: "ok" },
    scorecard: { overall: 10, checks: [] },
    maintenance: {},
  };
  const fit: FitSignal = { id: candidate.id, fitScore: 1, rationale: "ideal fit" };
  return new WeightedRanker({ projectLicense }).rank("license gate", [{ candidate, bundle }], [fit])[0].verdict;
}

/** The safety fact is the ranker's verdict, never a UI badge or reason string. */
export function hasLicenseSafetyFact(
  verdict: (projectLicense: string, spdxId: string | null) => ScoredComponent["verdict"] = verdictFor,
): boolean {
  return ["MIT", "Apache-2.0"].every((projectLicense) =>
    unsafeExpressions.every((spdxId) => verdict(projectLicense, spdxId) !== "ship"),
  );
}

export async function check(): Promise<Result> {
  try {
    return hasLicenseSafetyFact()
      ? { status: "pass" }
      : { status: "fail", message: "A GPL/AGPL expression or unverified license can ship into a permissive project" };
  } catch (e: unknown) {
    return { status: "fail", message: e instanceof Error ? e.message : String(e) };
  }
}

export async function proveFailure(): Promise<Result> {
  // A deliberately unsafe verdict source must trip the same fact check.
  return !hasLicenseSafetyFact(() => "ship")
    ? { status: "detected" }
    : { status: "undetected", message: "License safety fact did not detect a shipping GPL/AGPL expression" };
}
