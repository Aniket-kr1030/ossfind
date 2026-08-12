import { WeightedRanker } from "../ranking/rank.js";
import type { ComponentCandidate, EnrichmentBundle, FitSignal, ScoredComponent } from "../contracts/index.js";
import type { Result } from "./types.js";

export const id = "G7";
export const description = "Evidence completeness: unverified OSV or license never ships; missing scorecard has an explicit policy";

type SourceState = EnrichmentBundle["sources"];
type MaximumVerdict = "ship" | "caution";

const completenessMatrix: Array<{ label: string; sources: SourceState; maximum: MaximumVerdict }> = [
  { label: "OSV failed", sources: { osv: "failed", license: "ok", scorecard: "ok" }, maximum: "caution" },
  { label: "OSV missing", sources: { osv: "missing", license: "ok", scorecard: "ok" }, maximum: "caution" },
  { label: "license failed", sources: { osv: "ok", license: "failed", scorecard: "ok" }, maximum: "caution" },
  { label: "license missing", sources: { osv: "ok", license: "missing", scorecard: "ok" }, maximum: "caution" },
  // Scorecard absence changes the health score but is not security or license
  // evidence. Shipping is allowed only if those two independent sources are ok.
  { label: "scorecard failed", sources: { osv: "ok", license: "ok", scorecard: "failed" }, maximum: "ship" },
  { label: "scorecard missing", sources: { osv: "ok", license: "ok", scorecard: "missing" }, maximum: "ship" },
];

function verdictFor(sources: SourceState): ScoredComponent["verdict"] {
  const candidate: ComponentCandidate = {
    id: "npm:completeness-gate-package",
    name: "completeness-gate-package",
    ecosystem: "npm",
    description: "completeness safety gate package",
  };
  const bundle: EnrichmentBundle = {
    id: candidate.id,
    license: { spdxId: sources.license === "ok" ? "MIT" : null, source: "gate", confidence: sources.license === "ok" ? 1 : 0 },
    vulnerabilities: [],
    sources,
    scorecard: { overall: sources.scorecard === "ok" ? 10 : null, checks: [] },
    maintenance: {},
  };
  const fit: FitSignal = { id: candidate.id, fitScore: 1, rationale: "ideal fit" };
  return new WeightedRanker({ projectLicense: "MIT" }).rank("completeness gate", [{ candidate, bundle }], [fit])[0].verdict;
}

function doesNotExceed(verdict: ScoredComponent["verdict"], maximum: MaximumVerdict): boolean {
  const order = { avoid: 0, caution: 1, ship: 2 } as const;
  return order[verdict] <= order[maximum];
}

export function hasCompletenessSafetyFact(
  verdict: (sources: SourceState) => ScoredComponent["verdict"] = verdictFor,
): boolean {
  return completenessMatrix.every((row) => doesNotExceed(verdict(row.sources), row.maximum));
}

export async function check(): Promise<Result> {
  try {
    return hasCompletenessSafetyFact()
      ? { status: "pass" }
      : { status: "fail", message: "A completeness state exceeded its permitted verdict" };
  } catch (e: unknown) {
    return { status: "fail", message: e instanceof Error ? e.message : String(e) };
  }
}

export async function proveFailure(): Promise<Result> {
  return !hasCompletenessSafetyFact(() => "ship")
    ? { status: "detected" }
    : { status: "undetected", message: "Completeness safety fact did not detect a ship result with missing evidence" };
}
