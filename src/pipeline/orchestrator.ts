import type { ComponentCandidate, ScoredComponent } from "../contracts/index.js";
import type { PipelineDependencies } from "./interfaces.js";
import type { UsageCollector } from "../telemetry/collector.js";

export interface SearchComponentsOptions {
  /** Restrict the final result set; omitted means return every ranked item. */
  limit?: number;
  /** Optional in-process aggregate metrics; never receives the query text. */
  collector?: UsageCollector;
  /** Ceiling on how many candidates are enriched; see enrichmentBudget below. */
  enrichmentBudget?: number;
}

/**
 * Enrichment costs several supplier requests per candidate (OSV, deps.dev, Scorecard),
 * so it — not discovery — sets the cost of a search. Query expansion widened discovery
 * from ~20 candidates to 150+, which would be unaffordable to enrich wholesale.
 *
 * Fit runs on candidate metadata alone and needs no network, so scoring *before*
 * enriching costs nothing and lets the budget be spent on the candidates most likely
 * to matter. Safety ranking is unaffected: it still decides every verdict, and still
 * outranks adoption — it simply now operates on a better-chosen shortlist.
 */
const DEFAULT_ENRICHMENT_BUDGET = 25;

/**
 * Fit rewards a description that echoes the query, which small packages do most
 * literally: `cli-argparser` ("An command line argument parser") outscores
 * `commander` 0.84 to 0.65. Sorting the shortlist on fit alone therefore pushed
 * every widely-used package past the budget and out of the search.
 *
 * A few slots are reserved for the most-adopted candidates that clear a relevance
 * floor. Adoption only decides *who gets examined* — never a verdict. The ranker
 * still caps adoption's influence on the score, and no candidate below the floor can
 * buy its way in with downloads, so a popular irrelevant package stays out.
 */
const ADOPTION_RESERVED_SLOTS = 5;
const ADOPTION_RELEVANCE_FLOOR = 0.45;

function shortlistFor(
  candidates: ComponentCandidate[],
  fitById: Map<string, number>,
  budget: number,
): ComponentCandidate[] {
  if (candidates.length <= budget) return candidates;

  const ordered = candidates
    // Ties keep discovery order, which favours the probe closest to the user's words.
    .map((candidate, index) => ({ candidate, index, score: fitById.get(candidate.id) ?? 0 }))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const reserved = Math.min(ADOPTION_RESERVED_SLOTS, Math.max(0, budget - 1));
  const byFit = ordered.slice(0, budget - reserved);
  const chosen = new Set(byFit.map((entry) => entry.candidate.id));

  const byAdoption = ordered
    .filter((entry) => !chosen.has(entry.candidate.id)
      && entry.score >= ADOPTION_RELEVANCE_FLOOR
      && (entry.candidate.downloads ?? 0) > 0)
    .sort((left, right) => (right.candidate.downloads ?? 0) - (left.candidate.downloads ?? 0))
    .slice(0, reserved);

  const filler = ordered.filter((entry) => !chosen.has(entry.candidate.id)
    && !byAdoption.includes(entry));

  return [...byFit, ...byAdoption, ...filler]
    .slice(0, budget)
    .map((entry) => entry.candidate);
}

async function runPipeline(
  query: string,
  deps: PipelineDependencies,
  opts: SearchComponentsOptions,
): Promise<ScoredComponent[]> {
  const candidates = await deps.discoverer.discover(query);
  const fit = await deps.fitScorer.fit(query, candidates);

  const budget = Math.max(1, opts.enrichmentBudget ?? DEFAULT_ENRICHMENT_BUDGET);
  const fitById = new Map(fit.map((signal) => [signal.id, signal.fitScore]));
  const shortlist = shortlistFor(candidates, fitById, budget);

  const enriched = await Promise.all(
    shortlist.map(async (candidate) => ({
      candidate,
      bundle: await deps.enricher.enrich(candidate),
    })),
  );

  const shortlisted = new Set(shortlist.map((candidate) => candidate.id));
  const ranked = deps.ranker.rank(query, enriched, fit.filter((signal) => shortlisted.has(signal.id)));
  return opts.limit === undefined ? ranked : ranked.slice(0, Math.max(0, opts.limit));
}

/** Wires the four pipeline stages without imposing ranking or supplier policy. */
export async function searchComponents(
  query: string,
  deps: PipelineDependencies,
  opts: SearchComponentsOptions = {},
): Promise<ScoredComponent[]> {
  const collector = opts.collector;
  if (!collector) return runPipeline(query, deps, opts);

  const startedAt = collector.beginSearch();
  try {
    const results = await runPipeline(query, deps, opts);
    collector.recordSearchSuccess(startedAt, results);
    return results;
  } catch (error) {
    collector.recordSearchError(startedAt);
    throw error;
  }
}
