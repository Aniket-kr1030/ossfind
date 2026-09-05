import { HttpDiscoverer } from "../adapters/discovery.js";
import { FederatedDiscoverer } from "../discovery/federated.js";
import { queryProbes } from "../discovery/query-probes.js";
import { searchComponents } from "../pipeline/orchestrator.js";
import type { ComponentCandidate, EnrichmentBundle, FitSignal, ScoredComponent } from "../contracts/index.js";
import type { HttpClient } from "../http/client.js";
import type { PipelineDependencies } from "../pipeline/interfaces.js";
import type { Result } from "./types.js";

export const id = "G16";
export const description = "Recall survives discovery: sub-phrase matches reach ranking, and nothing truncates them away";

/**
 * Registry search matches conjunctively, so a natural-language query excludes the
 * best-known packages outright: "command line argument parser" returned no
 * `commander`, whose description reads "the complete solution for node.js
 * command-line programs". The fit model was never the problem — measured, it scored
 * the irrelevant winners 0.31–0.41 — they simply had no better candidates to lose to.
 *
 * The first fix silently did nothing, which is the more valuable half of this gate:
 * query expansion widened discovery to 150+ candidates and the federated layer
 * truncated each source back to 15 before fit ran. This gate holds the whole chain —
 * expansion, union, no truncation below the enrichment budget, budgeted enrichment.
 */

/** Only reachable by the short probe: its text does not contain every query term. */
const SUB_PHRASE_ONLY = "commander";
const QUERY = "command line argument parser";
const ENRICHMENT_BUDGET = 25;

function candidate(name: string, description: string): ComponentCandidate {
  return {
    id: `npm:${name}`, name, ecosystem: "npm", description,
    keywords: [], latestVersion: "1.0.0",
  } as ComponentCandidate;
}

/** Stands in for npm's conjunctive text search: every query term must appear. */
function conjunctiveRegistry(corpus: Array<{ name: string; description: string }>): HttpClient {
  return async (url: string) => {
    const text = (new URL(url).searchParams.get("text") ?? "").toLowerCase();
    const terms = text.split(/[^a-z0-9]+/).filter((word) => word.length >= 2);
    const objects = corpus
      .filter((entry) => {
        const haystack = `${entry.name} ${entry.description}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .map((entry) => ({
        package: { name: entry.name, description: entry.description, version: "1.0.0" },
      }));
    const body = JSON.stringify({ objects });
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  };
}

const CORPUS = [
  // Matches the full query, so it is found with or without expansion.
  { name: "cmd-ts", description: "a command line argument parser for typescript" },
  // Matches only the "command line" probe — the shape the real defect took.
  { name: SUB_PHRASE_ONLY, description: "the complete solution for node.js command-line programs" },
  // Padding, so the pool exceeds the old per-source truncation of 15.
  ...Array.from({ length: 40 }, (_unused, index) => ({
    name: `filler-command-line-argument-parser-${index}`,
    description: "command line argument parser filler package",
  })),
];

function fakeDeps(discoverer: PipelineDependencies["discoverer"], enriched: string[]): PipelineDependencies {
  return {
    discoverer,
    enricher: {
      async enrich(item: ComponentCandidate): Promise<EnrichmentBundle> {
        enriched.push(item.id);
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
      // The named package is the best match; filler is mediocre. Deliberately
      // independent of the real fit model, which this gate is not testing.
      async fit(_query: string, candidates: ComponentCandidate[]): Promise<FitSignal[]> {
        return candidates.map((item) => ({
          id: item.id,
          fitScore: item.name === SUB_PHRASE_ONLY ? 0.95 : item.name === "cmd-ts" ? 0.9 : 0.2,
          rationale: "gate fixture",
        }));
      },
    },
    ranker: {
      rank(_query, entries, fit): ScoredComponent[] {
        const byId = new Map(fit.map((signal) => [signal.id, signal.fitScore]));
        return entries
          .map((entry) => ({ ...entry.candidate, fitScore: byId.get(entry.candidate.id) ?? 0 }))
          .sort((left, right) => right.fitScore - left.fitScore) as unknown as ScoredComponent[];
      },
    },
  };
}

type DiscovererFactory = (http: HttpClient) => PipelineDependencies["discoverer"];

const expandingDiscoverer: DiscovererFactory = (http) =>
  new FederatedDiscoverer([{ name: "npm-registry", discoverer: new HttpDiscoverer(http, 50, 1) }]);

export async function hasRecallSurvivalFact(factory: DiscovererFactory = expandingDiscoverer): Promise<boolean> {
  // 1. Expansion must actually produce a shorter probe than the query.
  const probes = queryProbes(QUERY);
  if (!probes.some((probe) => probe.text === "command line")) return false;
  // ...and must leave short queries alone, where expansion measurably added nothing.
  if (queryProbes("http client").length !== 1) return false;

  const http = conjunctiveRegistry(CORPUS);

  // 2. The conjunctive registry really does hide the package from the full query,
  //    otherwise the rest of this gate proves nothing.
  const single = await new HttpDiscoverer(http, 50, 1, 1).discover(QUERY);
  if (single.some((item) => item.name === SUB_PHRASE_ONLY)) return false;

  // 3. Expansion plus federation must carry it through to the candidate list.
  const discoverer = factory(http);
  const discovered = await discoverer.discover(QUERY);
  if (!discovered.some((item) => item.name === SUB_PHRASE_ONLY)) return false;
  // Truncation must not cut the pool below what enrichment is willing to consider.
  if (discovered.length < ENRICHMENT_BUDGET) return false;

  // 4. It must reach ranking, and enrichment must stay inside its budget.
  const enriched: string[] = [];
  const ranked = await searchComponents(QUERY, fakeDeps(discoverer, enriched), {
    limit: 5,
    enrichmentBudget: ENRICHMENT_BUDGET,
  });
  if (enriched.length > ENRICHMENT_BUDGET) return false;
  if (enriched.length !== new Set(enriched).size) return false;
  if (ranked[0]?.name !== SUB_PHRASE_ONLY) return false;

  // 5. Adoption buys a look, never a pass: a hugely popular candidate below the
  //    relevance floor must still be left out of the shortlist entirely.
  return await popularIrrelevantStaysOut();
}

/**
 * Reserving shortlist slots for adopted packages is only safe while relevance still
 * gates them. This builds a candidate that is the most-downloaded thing in the pool
 * and plainly not what was asked for, and requires that it is never enriched.
 */
async function popularIrrelevantStaysOut(): Promise<boolean> {
  const relevant = Array.from({ length: 40 }, (_unused, index) =>
    ({ ...candidate(`arg-parser-${index}`, "command line argument parser"), downloads: 10 }));
  const decoy = { ...candidate("left-pad", "string padding utility"), downloads: 500_000_000 };

  const enriched: string[] = [];
  const deps = fakeDeps({ async discover() { return [...relevant, decoy]; } }, enriched);
  await searchComponents(QUERY, {
    ...deps,
    fitScorer: {
      async fit(_query, candidates) {
        return candidates.map((item) => ({
          id: item.id,
          // Well below ADOPTION_RELEVANCE_FLOOR; downloads must not rescue it.
          fitScore: item.name === "left-pad" ? 0.1 : 0.7,
          rationale: "gate fixture",
        }));
      },
    },
  }, { enrichmentBudget: ENRICHMENT_BUDGET });

  return !enriched.includes("npm:left-pad");
}

/** Mutant restoring the truncation that made the first attempt at this fix a no-op. */
const truncatingDiscoverer: DiscovererFactory = (http) =>
  new FederatedDiscoverer(
    [{ name: "npm-registry", discoverer: new HttpDiscoverer(http, 50, 1) }],
    { perSourceLimit: 15, totalLimit: 30 },
  );

export async function check(): Promise<Result> {
  try {
    return await hasRecallSurvivalFact()
      ? { status: "pass" }
      : { status: "fail", message: "A sub-phrase-only match did not survive discovery into ranking" };
  } catch (error: unknown) {
    return { status: "fail", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function proveFailure(): Promise<Result> {
  try {
    return !(await hasRecallSurvivalFact(truncatingDiscoverer))
      ? { status: "detected" }
      : { status: "undetected", message: "G16 did not detect discovery truncated below the enrichment budget" };
  } catch (error: unknown) {
    return { status: "detected", message: error instanceof Error ? error.message : String(error) };
  }
}
