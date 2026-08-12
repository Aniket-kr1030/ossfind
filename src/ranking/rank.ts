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

    const scored = enriched.map(({ candidate, bundle }) => {
      const reasons: string[] = [];

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
        if (licenseSpdx) {
          licenseScore = 0.7;
          reasons.push(`${licenseSpdx} license — weak copyleft/conditional compatibility`);
        } else {
          licenseScore = 0.3;
          reasons.push("unknown license — manual audit required");
        }
      } else {
        licenseScore = 0.1;
        reasons.push(`${licenseSpdx || "Incompatible"} license — incompatible with project license ${projLicense}`);
      }

      // 3. Security Score
      let securityScore = 1.0;
      let worstSeverity = "none";
      let hasUnfixedCritical = false;
      let criticalCount = 0;
      let firstCriticalId = "";

      if (bundle.vulnerabilities.length > 0) {
        let maxPenalty = 0.0;
        for (const vuln of bundle.vulnerabilities) {
          const sev = vuln.severity.toLowerCase();
          let penalty = 0.05;
          if (sev === "critical") {
            penalty = 0.5;
            if (!vuln.fixedIn) {
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
          reasons.push(
            `${bundle.vulnerabilities.length} vulnerabilities detected (worst severity: ${worstSeverity})`
          );
        }
      } else {
        reasons.push("No known vulnerabilities detected.");
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

      // Calculate overall score (weighted blend, normalized to 0-100)
      const totalWeight =
        this.weights.fit +
        this.weights.license +
        this.weights.security +
        this.weights.health +
        this.weights.effort;

      const rawOverall =
        (fitScore * this.weights.fit +
          licenseScore * this.weights.license +
          securityScore * this.weights.security +
          healthScore * this.weights.health +
          effortScore * this.weights.effort) /
        totalWeight;

      const overall = Math.max(0, Math.min(100, Math.round(rawOverall * 100)));

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

      // Hard rule triggers
      if (hasUnfixedCritical || isLicenseIncompatible) {
        verdict = "avoid";
      } else if (isArchived || isDeprecated) {
        if (verdict === "ship") {
          verdict = "caution";
        }
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
