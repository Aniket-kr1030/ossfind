import type { Ranker } from "../pipeline/interfaces.js";
import type {
  ComponentCandidate,
  EnrichmentBundle,
  FitSignal,
  ScoredComponent,
} from "../contracts/index.js";
import { ScoredComponentSchema } from "../contracts/index.js";
import { checkLicense } from "../license/compat.js";
import { DEFAULT_WEIGHTS, type RankerWeights } from "./weights.js";
import * as semver from "semver";

const NEUTRAL_ADOPTION = 0.5;
const CURATED_REPOSITORY_PENALTY = 0.20;
const CURATED_TOPICS = new Set([
  "awesome",
  "awesome-list",
  "curated-list",
  "tutorial",
  "learning-resources",
  "books",
]);

type AdoptionMetric = { value: number; label: string };
type AdoptionSignal = { score: number; factored: boolean; reason: string };

function adoptionMetric(candidate: ComponentCandidate): AdoptionMetric | undefined {
  if (candidate.ecosystem === "github" && candidate.stars !== undefined) {
    return { value: candidate.stars, label: "GitHub stars" };
  }
  if (candidate.ecosystem !== "github" && candidate.downloads !== undefined) {
    return { value: candidate.downloads, label: `${candidate.ecosystem} downloads` };
  }
  return undefined;
}

function formatAdoption(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/**
 * Stars and downloads are different measures, so adoption is only compared
 * among candidates from the same ecosystem. Log scaling prevents a single
 * outlier from making every other viable candidate indistinguishable. Missing
 * data, singleton groups, and ties carry the neutral score but do not enter
 * the weighted blend: no observation is neither a reward nor a penalty.
 */
function adoptionSignals(
  enriched: Array<{ candidate: ComponentCandidate; bundle: EnrichmentBundle }>,
): Map<string, AdoptionSignal> {
  const groups = new Map<string, Array<{ id: string; metric: AdoptionMetric }>>();
  for (const { candidate } of enriched) {
    const metric = adoptionMetric(candidate);
    if (!metric) continue;
    const group = groups.get(candidate.ecosystem) ?? [];
    group.push({ id: candidate.id, metric });
    groups.set(candidate.ecosystem, group);
  }

  const signals = new Map<string, AdoptionSignal>();
  for (const { candidate } of enriched) {
    const metric = adoptionMetric(candidate);
    if (!metric) {
      signals.set(candidate.id, {
        score: NEUTRAL_ADOPTION,
        factored: false,
        reason: "adoption unknown — not factored",
      });
      continue;
    }

    const group = groups.get(candidate.ecosystem) ?? [];
    const logged = group.map(({ metric: value }) => Math.log1p(value.value));
    const minimum = Math.min(...logged);
    const maximum = Math.max(...logged);
    if (group.length < 2 || maximum === minimum) {
      signals.set(candidate.id, {
        score: NEUTRAL_ADOPTION,
        factored: false,
        reason: "adoption comparable candidates tied — not factored",
      });
      continue;
    }

    const score = (Math.log1p(metric.value) - minimum) / (maximum - minimum);
    const descriptor = score >= 0.6 ? "widely adopted" : "lower adoption within this result set";
    signals.set(candidate.id, {
      score,
      factored: true,
      reason: `${formatAdoption(metric.value)} ${metric.label} — ${descriptor}`,
    });
  }
  return signals;
}

function isCuratedRepository(candidate: ComponentCandidate): boolean {
  const repositoryName = candidate.name.split("/").at(-1)?.toLowerCase() ?? "";
  const topics = new Set((candidate.keywords ?? []).map((topic) => topic.toLowerCase()));
  const hasCuratedTopic = [...topics].some((topic) => CURATED_TOPICS.has(topic));

  if (hasCuratedTopic || repositoryName.startsWith("awesome-")) return true;
  if (/(?:^|[-_])(tutorial|examples|books)$/.test(repositoryName)) return true;

  // A bare "*-list" would misclassify genuine linked-list libraries. Require
  // a corroborating curated topic for this ambiguous name pattern.
  return /(?:^|[-_])list$/.test(repositoryName) && hasCuratedTopic;
}

export class WeightedRanker implements Ranker {
  private readonly projectLicense?: string;
  private readonly weights: RankerWeights;

  constructor(options?: { projectLicense?: string; weights?: RankerWeights }) {
    this.projectLicense = options?.projectLicense;
    this.weights = options?.weights ?? DEFAULT_WEIGHTS;
  }

  rank(
    query: string,
    enriched: Array<{ candidate: ComponentCandidate; bundle: EnrichmentBundle }>,
    fit: FitSignal[],
    options?: { projectLicense?: string }
  ): ScoredComponent[] {
    const projLicense = options?.projectLicense ?? this.projectLicense ?? "MIT";
    const fitById = new Map(fit.map((signal) => [signal.id, signal]));
    const adoptionById = adoptionSignals(enriched);

    const scored = enriched.map(({ candidate, bundle }) => {
      const reasons: string[] = [];
      const adoption = adoptionById.get(candidate.id) ?? {
        score: NEUTRAL_ADOPTION,
        factored: false,
        reason: "adoption unknown — not factored",
      };

      // 1. Fit Score
      const fitSignal = fitById.get(candidate.id);
      const fitScore = fitSignal?.fitScore ?? 0.0;
      reasons.push(fitSignal?.rationale ?? `Fit score: ${fitScore.toFixed(2)}`);

      // 2. License Score
      const licenseSpdx = bundle.license.spdxId;
      const licenseCompat = checkLicense(projLicense, licenseSpdx);

      let licenseScore = 0.3; // Default low-ish for unknown/missing
      if (licenseCompat.compatible === "yes") {
        licenseScore = 1.0;
        reasons.push(`${licenseSpdx || "Permissive"} license — permissive`);
      } else if (licenseCompat.compatible === "conditional") {
        // Conditional means we cannot establish an unqualified compatible
        // license.  Do not give an unparseable SPDX expression a generous
        // score just because it is non-null.
        licenseScore = 0.3;
        reasons.push(licenseSpdx
          ? `${licenseSpdx} license — compatibility requires manual audit`
          : "unknown license — manual audit required");
      } else {
        licenseScore = 0.1;
        reasons.push(`${licenseSpdx || "Incompatible"} license — incompatible with project license ${projLicense}`);
      }

      // 3. Security Score
      let securityScore = 1.0;
      let worstSeverity = "none";
      let hasUnfixedCritical = false;
      let hasUnknownSeverity = false;
      let criticalCount = 0;
      let firstCriticalId = "";

      if (bundle.vulnerabilities.length > 0) {
        let maxPenalty = 0.0;
        for (const vuln of bundle.vulnerabilities) {
          const sev = vuln.severity.toLowerCase();
          let penalty = 0.05;
          if (sev === "critical") {
            penalty = 0.5;
            const selectedVersion = candidate.latestVersion;
            const fixedAtSelectedVersion = !!selectedVersion
              && !!vuln.fixedIn
              && semver.valid(selectedVersion) !== null
              && semver.valid(vuln.fixedIn) !== null
              && semver.gte(selectedVersion, vuln.fixedIn);
            if (!fixedAtSelectedVersion) {
              hasUnfixedCritical = true;
              criticalCount++;
              if (!firstCriticalId) {
                firstCriticalId = vuln.id;
              }
            }
          } else if (sev === "high") {
            penalty = 0.3;
          } else if (sev === "moderate" || sev === "medium") {
            penalty = 0.2;
          } else if (sev === "low") {
            penalty = 0.1;
          } else {
            // An advisory that affects the selected version but cannot be
            // scored is not evidence of low risk. Keep the uncertainty
            // visible and prevent an otherwise high score from shipping.
            hasUnknownSeverity = true;
          }

          if (penalty > maxPenalty) {
            maxPenalty = penalty;
            worstSeverity = vuln.severity;
          }
        }

        securityScore = Math.max(0, 1.0 - maxPenalty);

        if (hasUnfixedCritical) {
          securityScore = 0.05; // Force very low
          reasons.push(
            `${criticalCount} critical CVE (${firstCriticalId || "unknown"}) unfixed — cannot recommend`
          );
        } else {
          if (hasUnknownSeverity) {
            securityScore = Math.min(securityScore, 0.3);
            reasons.push("Vulnerability severity could not be established — security evidence requires review.");
          }
          reasons.push(
            `${bundle.vulnerabilities.length} vulnerabilities detected (worst severity: ${worstSeverity})`
          );
        }
      } else {
        if (bundle.sources.osv === "ok") {
          reasons.push("No known vulnerabilities detected.");
        } else {
          securityScore = 0.3;
          reasons.push("OSV vulnerability data unavailable — security evidence unverified.");
        }
      }

      // 4. Health Score
      let healthScore = 0.4; // Default low-confidence mid/low value
      const hasScorecard = bundle.scorecard.overall !== null && bundle.scorecard.overall !== undefined;
      
      if (hasScorecard) {
        const rawScorecard = bundle.scorecard.overall as number;
        healthScore = rawScorecard / 10.0;
        reasons.push(
          `OpenSSF score ${rawScorecard.toFixed(1)}/10 — ${
            rawScorecard >= 7.0 ? "well maintained" : "needs maintenance attention"
          }`
        );
      } else {
        reasons.push("no scorecard data — health estimated");
      }

      // Factor maintenance: archived penalizes hard
      const isArchived = !!bundle.maintenance.archived;
      if (isArchived) {
        healthScore = Math.max(0, healthScore - 0.5);
        reasons.push("Component is archived and unmaintained.");
      }

      // 5. Effort Score (cheap proxy for integration effort)
      let effortScore = 0.9; // Base effort (higher score means lower effort)
      const descLower = candidate.description.toLowerCase();
      const isDeprecated = descLower.includes("deprecated") || descLower.includes("legacy");

      if (isArchived) {
        effortScore -= 0.4;
      }
      if (isDeprecated) {
        effortScore -= 0.3;
      }
      if (bundle.maintenance.releaseCadenceDays && bundle.maintenance.releaseCadenceDays > 180) {
        effortScore -= 0.2;
      }

      effortScore = Math.max(0.1, Math.min(1.0, effortScore));
      if (effortScore < 0.6) {
        reasons.push("High integration effort due to archiving or deprecation keywords.");
      } else {
        reasons.push("Low integration effort; active and maintained.");
      }

      const curatedRepository = isCuratedRepository(candidate);
      if (curatedRepository) {
        reasons.push("curated link list, not an integratable library — deprioritised");
      }
      reasons.push(adoption.reason);

      // Calculate overall score (weighted blend, normalized to 0-100)
      const totalWeight =
        this.weights.fit +
        this.weights.license +
        this.weights.security +
        this.weights.health +
        this.weights.effort +
        (adoption.factored ? this.weights.adoption : 0);

      const rawOverall =
        (fitScore * this.weights.fit +
          licenseScore * this.weights.license +
          securityScore * this.weights.security +
          healthScore * this.weights.health +
          effortScore * this.weights.effort +
          (adoption.factored ? adoption.score * this.weights.adoption : 0)) /
        totalWeight;

      // Curated repositories remain visible but are not integration components.
      // This affects ordering only; the safety caps below still run afterward.
      const overall = Math.max(0, Math.min(100, Math.round(
        (rawOverall - (curatedRepository ? CURATED_REPOSITORY_PENALTY : 0)) * 100,
      )));

      // Verdict derivation with explicit hard rules
      let verdict: "ship" | "caution" | "avoid" = "caution";
      if (overall >= 75) {
        verdict = "ship";
      } else if (overall >= 40) {
        verdict = "caution";
      } else {
        verdict = "avoid";
      }

      const isLicenseIncompatible = licenseCompat.compatible === "no";
      const isLicenseUncertain = licenseCompat.compatible === "conditional"
        || bundle.sources.license !== "ok";
      const isSecurityUnverified = bundle.sources.osv !== "ok";
      const isHealthUnverified = bundle.sources.scorecard !== "ok"
        || bundle.scorecard.overall == null;

      // Hard rule triggers
      if (hasUnfixedCritical || isLicenseIncompatible) {
        verdict = "avoid";
      } else if (isArchived || isDeprecated) {
        if (verdict === "ship") {
          verdict = "caution";
        }
      }
      if ((isLicenseUncertain || isSecurityUnverified || isHealthUnverified) && verdict === "ship") {
        verdict = "caution";
        reasons.push(isLicenseUncertain
          ? "License evidence is incomplete or conditional — cannot recommend shipping."
          : isSecurityUnverified
            ? "Security evidence is incomplete — cannot recommend shipping."
            : "Health unverified (no OpenSSF scorecard) — cannot recommend shipping.");
      }
      if (hasUnknownSeverity && verdict === "ship") {
        verdict = "caution";
        reasons.push("Unknown vulnerability severity — cannot recommend shipping.");
      }

      // Raw repositories and model cards do not have a package-level OSV
      // identity that can prove dependency-vulnerability status. Keep this
      // structural cap independent of any upstream provenance claim.
      const isRawRepositoryOrModel = candidate.id.startsWith("github:")
        || candidate.id.startsWith("huggingface:");
      if (isRawRepositoryOrModel) {
        if (verdict === "ship") {
          verdict = "caution";
        }
        reasons.push(
          "GitHub/Hugging Face components cannot be verified for dependency vulnerabilities the way a published package can — capped below ship.",
        );
      }

      // Format badges
      const badges = {
        license: licenseSpdx ?? "unknown",
        cveCount: bundle.vulnerabilities.length,
        scorecard: bundle.scorecard.overall,
      };

      return ScoredComponentSchema.parse({
        id: candidate.id,
        name: candidate.name,
        repoUrl: candidate.repoUrl,
        scores: {
          fit: fitScore,
          license: licenseScore,
          security: securityScore,
          health: healthScore,
          effort: effortScore,
          adoption: adoption.score,
        },
        overall,
        verdict,
        reasons,
        badges,
      });
    });

    // Pure & Deterministic stable sort: overall descending, then id ascending
    return scored.sort((a, b) => {
      if (b.overall !== a.overall) {
        return b.overall - a.overall;
      }
      return a.id.localeCompare(b.id);
    });
  }
}
