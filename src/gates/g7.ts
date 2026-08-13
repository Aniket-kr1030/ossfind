import { WeightedRanker } from "../ranking/rank.js";
import type { ComponentCandidate, EnrichmentBundle, FitSignal, ScoredComponent } from "../contracts/index.js";
import type { Result } from "./types.js";

export const id = "G7";
export const description = "Evidence completeness: unverified OSV, license, or health never ships";

type SourceState = EnrichmentBundle["sources"];
type MaximumVerdict = "ship" | "caution";
type CompletenessRow = {
  label: string;
  sources: SourceState;
  scorecardOverall: number | null;
  maximum: MaximumVerdict;
};

const completenessMatrix: CompletenessRow[] = [
  { label: "OSV failed", sources: { osv: "failed", license: "ok", scorecard: "ok" }, scorecardOverall: 10, maximum: "caution" },
  { label: "OSV missing", sources: { osv: "missing", license: "ok", scorecard: "ok" }, scorecardOverall: 10, maximum: "caution" },
  { label: "license failed", sources: { osv: "ok", license: "failed", scorecard: "ok" }, scorecardOverall: 10, maximum: "caution" },
  { label: "license missing", sources: { osv: "ok", license: "missing", scorecard: "ok" }, scorecardOverall: 10, maximum: "caution" },
  { label: "scorecard failed", sources: { osv: "ok", license: "ok", scorecard: "failed" }, scorecardOverall: null, maximum: "caution" },
  { label: "scorecard missing", sources: { osv: "ok", license: "ok", scorecard: "missing" }, scorecardOverall: null, maximum: "caution" },
  { label: "scorecard no overall", sources: { osv: "ok", license: "ok", scorecard: "ok" }, scorecardOverall: null, maximum: "caution" },
];

function verdictFor(sources: SourceState, scorecardOverall: number | null): ScoredComponent["verdict"] {
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
    scorecard: { overall: scorecardOverall, checks: [] },
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
  verdict: (sources: SourceState, scorecardOverall: number | null) => ScoredComponent["verdict"] = verdictFor,
): boolean {
  return completenessMatrix.every((row) =>
    doesNotExceed(verdict(row.sources, row.scorecardOverall), row.maximum)
  );
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
  return !hasCompletenessSafetyFact((sources, scorecardOverall) =>
    sources.scorecard !== "ok" || scorecardOverall == null
      ? "ship"
      : verdictFor(sources, scorecardOverall)
  )
    ? { status: "detected" }
    : { status: "undetected", message: "Completeness safety fact did not detect a ship result with unverified health evidence" };
}
