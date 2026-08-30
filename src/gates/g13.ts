import { WeightedRanker } from "../ranking/rank.js";
import type { ComponentCandidate, EnrichmentBundle, FitSignal, ScoredComponent } from "../contracts/index.js";
import type { Ranker } from "../pipeline/interfaces.js";
import type { Result } from "./types.js";

export const id = "G13";
export const description = "Adoption cannot override safety";

const HUGE_ADOPTION = 1_000_000_000_000;

function candidateFor(
  id: string,
  adoption: number | undefined,
): ComponentCandidate {
  const ecosystem = id.slice(0, id.indexOf(":")) as ComponentCandidate["ecosystem"];
  return {
    id,
    name: id.slice(id.indexOf(":") + 1),
    ecosystem,
    description: "adoption safety gate component",
    ...(adoption === undefined ? {} : ecosystem === "github" ? { stars: adoption } : { downloads: adoption }),
  };
}

function bundleFor(id: string, overrides: Partial<EnrichmentBundle> = {}): EnrichmentBundle {
  return {
    id,
    license: { spdxId: "MIT", source: "gate", confidence: 1 },
    vulnerabilities: [],
    sources: { osv: "ok", license: "ok", scorecard: "ok" },
    scorecard: { overall: 10, checks: [] },
    maintenance: {},
    ...overrides,
  };
}

function scoredTarget(
  ranker: Pick<Ranker, "rank">,
  target: ComponentCandidate,
  targetBundle: EnrichmentBundle,
): ScoredComponent | undefined {
  const reference = candidateFor(
    target.ecosystem === "github" ? "github:owner/adoption-reference" : `${target.ecosystem}:adoption-reference`,
    1,
  );
  const fit: FitSignal[] = [target, reference].map((candidate) => ({
    id: candidate.id,
    fitScore: 1,
    rationale: "ideal fit",
  }));
  return ranker.rank("adoption safety gate", [
    { candidate: target, bundle: targetBundle },
    { candidate: reference, bundle: bundleFor(reference.id) },
  ], fit).find((component) => component.id === target.id);
}

/** Every case below has maximized adoption relative to its same-ecosystem peer. */
export function hasAdoptionSafetyFact(
  ranker: Pick<Ranker, "rank"> = new WeightedRanker({ projectLicense: "MIT" }),
): boolean {
  const critical = candidateFor("npm:adoption-critical", HUGE_ADOPTION);
  const gpl = candidateFor("npm:adoption-gpl", HUGE_ADOPTION);
  const rawRepository = candidateFor("github:owner/adoption-raw", HUGE_ADOPTION);
  const osvUnverified = candidateFor("npm:adoption-osv-unverified", HUGE_ADOPTION);
  const licenseUnverified = candidateFor("npm:adoption-license-unverified", HUGE_ADOPTION);
  const healthUnverified = candidateFor("npm:adoption-health-unverified", HUGE_ADOPTION);

  const criticalResult = scoredTarget(ranker, critical, bundleFor(critical.id, {
    vulnerabilities: [{ id: "CVE-adoption-critical", severity: "CRITICAL" }],
  }));
  const gplResult = scoredTarget(ranker, gpl, bundleFor(gpl.id, {
    license: { spdxId: "GPL-3.0", source: "gate", confidence: 1 },
  }));
  const rawResult = scoredTarget(ranker, rawRepository, bundleFor(rawRepository.id));
  const osvResult = scoredTarget(ranker, osvUnverified, bundleFor(osvUnverified.id, {
    sources: { osv: "failed", license: "ok", scorecard: "ok" },
  }));
  const licenseResult = scoredTarget(ranker, licenseUnverified, bundleFor(licenseUnverified.id, {
    sources: { osv: "ok", license: "missing", scorecard: "ok" },
    license: { spdxId: null, source: "gate", confidence: 0 },
  }));
  const healthResult = scoredTarget(ranker, healthUnverified, bundleFor(healthUnverified.id, {
    sources: { osv: "ok", license: "ok", scorecard: "missing" },
    scorecard: { overall: null, checks: [] },
  }));

  const unknown = candidateFor("npm:adoption-unknown", undefined);
  const [unknownResult] = ranker.rank(
    "adoption safety gate",
    [{ candidate: unknown, bundle: bundleFor(unknown.id) }],
    [{ id: unknown.id, fitScore: 1, rationale: "ideal fit" }],
  );

  const passes = criticalResult?.scores.adoption === 1
    && criticalResult.verdict === "avoid"
    && gplResult?.scores.adoption === 1
    && gplResult.verdict === "avoid"
    && rawResult?.scores.adoption === 1
    && rawResult.verdict !== "ship"
    && osvResult?.scores.adoption === 1
    && osvResult.verdict === "caution"
    && licenseResult?.scores.adoption === 1
    && licenseResult.verdict === "caution"
    && healthResult?.scores.adoption === 1
    && healthResult.verdict === "caution"
    && unknownResult?.scores.adoption === 0.5
    && unknownResult.reasons.includes("adoption unknown — not factored");
  return passes;
}

export async function check(): Promise<Result> {
  try {
    return hasAdoptionSafetyFact()
      ? { status: "pass" }
      : { status: "fail", message: "Maximal adoption bypassed a safety cap or missing data was not neutral" };
  } catch (error: unknown) {
    return { status: "fail", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function proveFailure(): Promise<Result> {
  const realRanker = new WeightedRanker({ projectLicense: "MIT" });
  const unsafeAdoptionRanker: Pick<Ranker, "rank"> = {
    rank(query, enriched, fit) {
      return realRanker.rank(query, enriched, fit).map((component) =>
        component.scores.adoption === 1 && component.id.includes("adoption-")
          ? { ...component, overall: 100, verdict: "ship" as const }
          : component,
      );
    },
  };

  // This mutant permits maximally-adopted components to cross their caps. The
  // same matrix above must reject it or G13 would be a hollow check.
  return !hasAdoptionSafetyFact(unsafeAdoptionRanker)
    ? { status: "detected" }
    : { status: "undetected", message: "G13 did not detect adoption lifting a safety-capped component" };
}
