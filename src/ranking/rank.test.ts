import { describe, expect, it } from "vitest";
import { WeightedRanker } from "./rank.js";
import type { ComponentCandidate, EnrichmentBundle, FitSignal } from "../contracts/index.js";

function makeCandidate(id: string, description = ""): ComponentCandidate {
  return {
    id,
    name: id.slice("npm:".length),
    ecosystem: "npm",
    description,
    repoUrl: "https://github.com/example/repo",
  };
}

function makeBundle(id: string, opts: Partial<EnrichmentBundle> = {}): EnrichmentBundle {
  return {
    id,
    license: {
      spdxId: "MIT",
      source: "test",
      confidence: 1.0,
    },
    vulnerabilities: [],
    sources: { osv: "ok", license: "ok", scorecard: "ok" },
    scorecard: {
      overall: 8.0,
      checks: [],
    },
    maintenance: {
      archived: false,
    },
    ...opts,
  };
}

function makeFitSignal(id: string, fitScore = 0.8): FitSignal {
  return {
    id,
    fitScore,
    rationale: "good match",
  };
}

describe("WeightedRanker", () => {
  it("ranking determinism: same input array produces identical deep-equal output twice", () => {
    const ranker = new WeightedRanker();
    const candidate1 = makeCandidate("npm:pkg1");
    const bundle1 = makeBundle("npm:pkg1");
    const candidate2 = makeCandidate("npm:pkg2");
    const bundle2 = makeBundle("npm:pkg2");

    const enriched = [
      { candidate: candidate1, bundle: bundle1 },
      { candidate: candidate2, bundle: bundle2 },
    ];
    const fit = [makeFitSignal("npm:pkg1", 0.9), makeFitSignal("npm:pkg2", 0.5)];

    const result1 = ranker.rank("query", enriched, fit);
    const result2 = ranker.rank("query", enriched, fit);

    expect(result1).toEqual(result2);
  });

  it("critical-CVE gate: a component with an unfixed critical vuln can NEVER get verdict 'ship'", () => {
    const ranker = new WeightedRanker();
    const candidate = makeCandidate("npm:vuln-pkg");
    
    // Critical vulnerability with NO fixedIn field -> unfixed
    const bundle = makeBundle("npm:vuln-pkg", {
      vulnerabilities: [
        {
          id: "CVE-2026-9999",
          severity: "CRITICAL",
        },
      ],
      scorecard: {
        overall: 10.0, // Perfect score otherwise
        checks: [],
      },
    });

    const fit = [makeFitSignal("npm:vuln-pkg", 1.0)];
    const [scored] = ranker.rank("query", [{ candidate, bundle }], fit);

    expect(scored.verdict).not.toBe("ship");
    expect(scored.verdict).toBe("avoid");
    expect(scored.scores.security).toBeLessThan(0.1);
    expect(scored.reasons.some((r) => r.includes("unfixed — cannot recommend"))).toBe(true);
  });

  it("explainability: reasons are non-empty and consistent with scores", () => {
    const ranker = new WeightedRanker();
    const candidate = makeCandidate("npm:pkg");
    const bundle = makeBundle("npm:pkg", {
      license: { spdxId: null, source: "test", confidence: 0 },
      scorecard: { overall: null, checks: [] },
    });
    const fit = [makeFitSignal("npm:pkg", 0.5)];

    const [scored] = ranker.rank("query", [{ candidate, bundle }], fit);

    expect(scored.reasons.length).toBeGreaterThan(0);
    expect(scored.reasons.some((r) => r.includes("no scorecard data — health estimated"))).toBe(true);
    expect(scored.reasons.some((r) => r.includes("unknown license — manual audit required"))).toBe(true);
  });

  it("license gate: GPL-3.0 component into MIT project results in incompatible and 'avoid' verdict", () => {
    const ranker = new WeightedRanker({ projectLicense: "MIT" });
    const candidate = makeCandidate("npm:gpl-pkg");
    const bundle = makeBundle("npm:gpl-pkg", {
      license: { spdxId: "GPL-3.0", source: "test", confidence: 1.0 },
    });
    const fit = [makeFitSignal("npm:gpl-pkg", 1.0)];

    const [scored] = ranker.rank("query", [{ candidate, bundle }], fit);

    expect(scored.scores.license).toBeLessThan(0.2);
    expect(scored.verdict).toBe("avoid");
    expect(scored.reasons.some((r) => r.includes("incompatible"))).toBe(true);
  });

  it.each([
    "GPL-3.0",
    "gpl-3.0",
    "GPL-3.0-only",
    "GPL-3.0-or-later",
    "GPL-3.0+",
    "(GPL-3.0)",
    "GPL-3.0 OR MIT",
    "AGPL-3.0-or-later",
  ])("fails closed for GPL-family SPDX expression %s in a permissive project", (spdxId) => {
    for (const projectLicense of ["MIT", "Apache-2.0"]) {
      const ranker = new WeightedRanker({ projectLicense });
      const candidate = makeCandidate("npm:copyleft-pkg");
      const bundle = makeBundle(candidate.id, {
        license: { spdxId, source: "test", confidence: 1 },
        scorecard: { overall: 10, checks: [] },
      });
      const [scored] = ranker.rank("query", [{ candidate, bundle }], [makeFitSignal(candidate.id, 1)]);
      expect(scored.verdict).not.toBe("ship");
      expect(scored.verdict).toBe("avoid");
    }
  });

  it.each(["unknown", "not valid SPDX", null])("caps unknown or unparseable license %s at caution", (spdxId) => {
    const ranker = new WeightedRanker({ projectLicense: "MIT" });
    const candidate = makeCandidate("npm:uncertain-license-pkg");
    const bundle = makeBundle(candidate.id, {
      license: { spdxId, source: "test", confidence: 1 },
      scorecard: { overall: 10, checks: [] },
    });
    const [scored] = ranker.rank("query", [{ candidate, bundle }], [makeFitSignal(candidate.id, 1)]);
    expect(scored.verdict).not.toBe("ship");
    expect(scored.scores.license).toBe(0.3);
  });

  it("does not claim a clean OSV result or ship when OSV evidence failed", () => {
    const ranker = new WeightedRanker({ projectLicense: "MIT" });
    const candidate = makeCandidate("npm:osv-failed-pkg");
    const bundle = makeBundle(candidate.id, {
      sources: { osv: "failed", license: "ok", scorecard: "ok" },
      scorecard: { overall: 10, checks: [] },
    });
    const [scored] = ranker.rank("query", [{ candidate, bundle }], [makeFitSignal(candidate.id, 1)]);
    expect(scored.verdict).toBe("caution");
    expect(scored.reasons).toContain("OSV vulnerability data unavailable — security evidence unverified.");
    expect(scored.reasons).not.toContain("No known vulnerabilities detected.");
  });

  it("caps a missing or failed license source even with otherwise ideal evidence", () => {
    const ranker = new WeightedRanker({ projectLicense: "MIT" });
    const candidate = makeCandidate("npm:license-missing-pkg");
    const bundle = makeBundle(candidate.id, {
      license: { spdxId: null, source: "test", confidence: 0 },
      sources: { osv: "ok", license: "missing", scorecard: "ok" },
      scorecard: { overall: 10, checks: [] },
    });
    const [scored] = ranker.rank("query", [{ candidate, bundle }], [makeFitSignal(candidate.id, 1)]);
    expect(scored.verdict).toBe("caution");
  });

  it("treats a future fixedIn as unfixed until the selected version reaches it", () => {
    const ranker = new WeightedRanker();
    const candidate = { ...makeCandidate("npm:future-fix-pkg"), latestVersion: "2.5.0" };
    const bundle = makeBundle(candidate.id, {
      vulnerabilities: [{ id: "CVE-future-fix", severity: "CRITICAL", fixedIn: "3.0.0" }],
      scorecard: { overall: 10, checks: [] },
    });
    const [scored] = ranker.rank("query", [{ candidate, bundle }], [makeFitSignal(candidate.id, 1)]);
    expect(scored.verdict).toBe("avoid");
  });

  it("fails closed when an active vulnerability has unknown severity", () => {
    const ranker = new WeightedRanker({ projectLicense: "MIT" });
    const candidate = makeCandidate("npm:unknown-severity-pkg");
    const bundle = makeBundle(candidate.id, {
      vulnerabilities: [{ id: "GHSA-no-severity", severity: "unknown" }],
      scorecard: { overall: 10, checks: [] },
    });
    const [scored] = ranker.rank("query", [{ candidate, bundle }], [makeFitSignal(candidate.id, 1)]);
    expect(scored.verdict).toBe("caution");
    expect(scored.scores.security).toBeLessThanOrEqual(0.3);
    expect(scored.reasons).toContain("Vulnerability severity could not be established — security evidence requires review.");
  });

  it("license gate: MIT into MIT yields compatible/ship", () => {
    const ranker = new WeightedRanker({ projectLicense: "MIT" });
    const candidate = makeCandidate("npm:mit-pkg");
    const bundle = makeBundle("npm:mit-pkg", {
      license: { spdxId: "MIT", source: "test", confidence: 1.0 },
    });
    const fit = [makeFitSignal("npm:mit-pkg", 1.0)];

    const [scored] = ranker.rank("query", [{ candidate, bundle }], fit);

    expect(scored.scores.license).toBe(1.0);
    expect(scored.verdict).toBe("ship");
  });

  it("caps unverified health at caution while scorecard-backed health can ship", () => {
    const ranker = new WeightedRanker({ projectLicense: "MIT" });
    const candidate = makeCandidate("npm:health-evidence-pkg");
    const fit = [makeFitSignal(candidate.id, 1.0)];

    const [withoutScorecard] = ranker.rank("query", [{
      candidate,
      bundle: makeBundle(candidate.id, {
        sources: { osv: "ok", license: "ok", scorecard: "missing" },
        scorecard: { overall: null, checks: [] },
      }),
    }], fit);
    const [withScorecard] = ranker.rank("query", [{
      candidate,
      bundle: makeBundle(candidate.id, {
        sources: { osv: "ok", license: "ok", scorecard: "ok" },
        scorecard: { overall: 9, checks: [] },
      }),
    }], fit);

    expect(withoutScorecard.verdict).toBe("caution");
    expect(withoutScorecard.reasons).toContain(
      "Health unverified (no OpenSSF scorecard) — cannot recommend shipping."
    );
    expect(withScorecard.verdict).toBe("ship");
  });

  it("applies penalty and prevents ship verdict if archived or deprecated", () => {
    const ranker = new WeightedRanker();
    const candidate = makeCandidate("npm:archived-pkg");
    const bundle = makeBundle("npm:archived-pkg", {
      maintenance: { archived: true },
    });
    const fit = [makeFitSignal("npm:archived-pkg", 1.0)];

    const [scored] = ranker.rank("query", [{ candidate, bundle }], fit);

    expect(scored.verdict).not.toBe("ship");
    expect(scored.reasons.some((r) => r.includes("archived"))).toBe(true);
  });
});
