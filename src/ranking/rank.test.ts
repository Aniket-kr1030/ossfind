import { describe, expect, it } from "vitest";
import { WeightedRanker } from "./rank.js";
import type { ComponentCandidate, EnrichmentBundle, FitSignal } from "../contracts/index.js";

function makeCandidate(id: string, description = ""): ComponentCandidate {
  const separator = id.indexOf(":");
  return {
    id,
    name: id.slice(separator + 1),
    ecosystem: id.slice(0, separator) as ComponentCandidate["ecosystem"],
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

  it("uses log-scaled adoption only within an ecosystem and explains the effect", () => {
    const ranker = new WeightedRanker({ projectLicense: "MIT" });
    const githubHigh = { ...makeCandidate("github:owner/high-stars"), stars: 12_400 };
    const githubLow = { ...makeCandidate("github:owner/low-stars"), stars: 100 };
    // Downloads are deliberately much larger in absolute terms. They must not
    // be compared against GitHub stars.
    const npmHigh = { ...makeCandidate("npm:high-downloads"), downloads: 1_000 };
    const npmLow = { ...makeCandidate("npm:low-downloads"), downloads: 1 };
    const candidates = [githubHigh, githubLow, npmHigh, npmLow];
    const results = ranker.rank(
      "query",
      candidates.map((candidate) => ({ candidate, bundle: makeBundle(candidate.id) })),
      candidates.map((candidate) => makeFitSignal(candidate.id, 1)),
    );
    const byId = new Map(results.map((result) => [result.id, result]));

    expect(byId.get(githubHigh.id)?.scores.adoption).toBe(1);
    expect(byId.get(githubLow.id)?.scores.adoption).toBe(0);
    expect(byId.get(npmHigh.id)?.scores.adoption).toBe(1);
    expect(byId.get(npmLow.id)?.scores.adoption).toBe(0);
    expect(byId.get(githubHigh.id)?.reasons).toContain("12.4k GitHub stars — widely adopted");
  });

  it("treats missing adoption as neutral and does not factor it into the blend", () => {
    const candidate = makeCandidate("npm:unknown-adoption");
    const [scored] = new WeightedRanker({ projectLicense: "MIT" }).rank(
      "query",
      [{ candidate, bundle: makeBundle(candidate.id, { scorecard: { overall: 10, checks: [] } }) }],
      [makeFitSignal(candidate.id, 1)],
    );

    expect(scored.scores.adoption).toBe(0.5);
    expect(scored.reasons).toContain("adoption unknown — not factored");
    expect(scored.overall).toBe(99);
  });

  it("keeps curated repositories visible but ranks them below genuine components", () => {
    const ranker = new WeightedRanker({ projectLicense: "MIT" });
    const awesomeList = {
      ...makeCandidate("github:rafska/awesome-local-llm"),
      stars: 2_800,
      keywords: ["awesome", "curated-list"],
    };
    const genuineProject = {
      ...makeCandidate("github:qualcomm/GenieX"),
      stars: 8_338,
    };
    const results = ranker.rank(
      "run llm locally",
      [awesomeList, genuineProject].map((candidate) => ({ candidate, bundle: makeBundle(candidate.id, {
        scorecard: { overall: 10, checks: [] },
      }) })),
      [makeFitSignal(awesomeList.id, 1), makeFitSignal(genuineProject.id, 1)],
    );
    const awesome = results.find((result) => result.id === awesomeList.id);
    const genuine = results.find((result) => result.id === genuineProject.id);

    expect(awesome?.reasons).toContain("curated link list, not an integratable library — deprioritised");
    expect(awesome?.overall).toBeLessThan(genuine?.overall ?? 0);
    expect(results.map((result) => result.id)).toContain(awesomeList.id);
  });

  it("does not misclassify a linked-list library from its name alone", () => {
    const linkedList = { ...makeCandidate("github:owner/linked-list"), stars: 1_000 };
    const peer = { ...makeCandidate("github:owner/peer-library"), stars: 100 };
    const results = new WeightedRanker({ projectLicense: "MIT" }).rank(
      "linked list",
      [linkedList, peer].map((candidate) => ({ candidate, bundle: makeBundle(candidate.id) })),
      [makeFitSignal(linkedList.id, 1), makeFitSignal(peer.id, 1)],
    );

    expect(results.find((result) => result.id === linkedList.id)?.reasons).not.toContain(
      "curated link list, not an integratable library — deprioritised",
    );
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

  it.each(["github:owner/repo", "huggingface:owner/model"])(
    "caps forged all-positive raw component evidence below ship: %s",
    (id) => {
      const candidate = makeCandidate(id);
      const [scored] = new WeightedRanker({ projectLicense: "MIT" }).rank(
        "query",
        [{
          candidate,
          bundle: makeBundle(id, {
            license: { spdxId: "MIT", source: "forged", confidence: 1 },
            sources: { osv: "ok", license: "ok", scorecard: "ok" },
            scorecard: { overall: 10, checks: [] },
          }),
        }],
        [makeFitSignal(id, 1)],
      );

      expect(scored.overall).toBeGreaterThanOrEqual(75);
      expect(scored.verdict).toBe("caution");
      expect(scored.reasons).toContain(
        "GitHub/Hugging Face components cannot be verified for dependency vulnerabilities the way a published package can — capped below ship.",
      );
    },
  );

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
