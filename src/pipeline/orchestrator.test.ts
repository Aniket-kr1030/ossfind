import { describe, expect, it } from "vitest";
import { searchComponents } from "./orchestrator.js";
import type { ComponentCandidate, EnrichmentBundle, ScoredComponent } from "../contracts/index.js";
import type { PipelineDependencies } from "./interfaces.js";

function candidate(name: string, downloads?: number): ComponentCandidate {
  return {
    id: `npm:${name}`, name, ecosystem: "npm",
    description: `${name} package`, latestVersion: "1.0.0",
    ...(downloads === undefined ? {} : { downloads }),
  } as ComponentCandidate;
}

/** Records which candidates were enriched — the expensive stage the budget protects. */
function deps(
  candidates: ComponentCandidate[],
  fitFor: (candidate: ComponentCandidate) => number,
  enriched: string[],
): PipelineDependencies {
  return {
    discoverer: { async discover() { return candidates; } },
    enricher: {
      async enrich(item) {
        enriched.push(item.name);
        return {
          id: item.id,
          license: { spdxId: "MIT", source: "ecosystems", confidence: 1 },
          vulnerabilities: [],
          sources: { osv: "ok", license: "ok", scorecard: "ok" },
          scorecard: { overall: 9, checks: [] },
          maintenance: {},
        } as EnrichmentBundle;
      },
    },
    fitScorer: {
      async fit(_query, items) {
        return items.map((item) => ({ id: item.id, fitScore: fitFor(item), rationale: "test" }));
      },
    },
    ranker: {
      rank(_query, entries) {
        return entries.map((entry) => entry.candidate) as unknown as ScoredComponent[];
      },
    },
  };
}

describe("searchComponents shortlisting", () => {
  it("enriches nothing beyond the budget", async () => {
    const enriched: string[] = [];
    const pool = Array.from({ length: 60 }, (_u, i) => candidate(`pkg-${i}`));
    await searchComponents("q", deps(pool, () => 0.5, enriched), { enrichmentBudget: 10 });
    expect(enriched).toHaveLength(10);
  });

  it("enriches every candidate when the pool is within budget", async () => {
    const enriched: string[] = [];
    await searchComponents("q", deps([candidate("a"), candidate("b")], () => 0.5, enriched), { enrichmentBudget: 10 });
    expect(enriched.sort()).toEqual(["a", "b"]);
  });

  it("spends the budget on the best-fitting candidates", async () => {
    const enriched: string[] = [];
    const pool = Array.from({ length: 40 }, (_u, i) => candidate(`pkg-${i}`));
    await searchComponents("q", deps(pool, (c) => (c.name === "pkg-39" ? 0.99 : 0.1), enriched), { enrichmentBudget: 5 });
    expect(enriched).toContain("pkg-39");
  });

  // The measured defect: `commander` sat at fit-rank 26 against a budget of 25,
  // because tiny packages echo the query more literally than famous ones do.
  it("reserves slots so an adopted, relevant package is examined despite mid fit", async () => {
    const enriched: string[] = [];
    const pool = [
      ...Array.from({ length: 40 }, (_u, i) => candidate(`tiny-${i}`, 5)),
      candidate("commander", 90_000_000),
    ];
    await searchComponents("q", deps(pool, (c) => (c.name === "commander" ? 0.65 : 0.85), enriched), { enrichmentBudget: 25 });
    expect(enriched).toContain("commander");
  });

  it("does not let downloads rescue a candidate below the relevance floor", async () => {
    const enriched: string[] = [];
    const pool = [
      ...Array.from({ length: 40 }, (_u, i) => candidate(`relevant-${i}`, 5)),
      candidate("left-pad", 500_000_000),
    ];
    await searchComponents("q", deps(pool, (c) => (c.name === "left-pad" ? 0.1 : 0.7), enriched), { enrichmentBudget: 25 });
    expect(enriched).not.toContain("left-pad");
  });

  it("never enriches the same candidate twice", async () => {
    const enriched: string[] = [];
    const pool = [
      ...Array.from({ length: 40 }, (_u, i) => candidate(`pkg-${i}`, 1000)),
      candidate("popular", 9_000_000),
    ];
    await searchComponents("q", deps(pool, () => 0.9, enriched), { enrichmentBudget: 20 });
    expect(enriched).toHaveLength(new Set(enriched).size);
    expect(enriched).toHaveLength(20);
  });

  it("still fills the budget when no candidate clears the adoption floor", async () => {
    const enriched: string[] = [];
    const pool = Array.from({ length: 40 }, (_u, i) => candidate(`pkg-${i}`));
    await searchComponents("q", deps(pool, () => 0.2, enriched), { enrichmentBudget: 12 });
    expect(enriched).toHaveLength(12);
  });

  it("applies limit to the ranked output, not to the budget", async () => {
    const enriched: string[] = [];
    const pool = Array.from({ length: 40 }, (_u, i) => candidate(`pkg-${i}`));
    const results = await searchComponents("q", deps(pool, () => 0.5, enriched), { enrichmentBudget: 15, limit: 3 });
    expect(results).toHaveLength(3);
    expect(enriched).toHaveLength(15);
  });
});
