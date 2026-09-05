import type { ComponentCandidate, FitSignal, ScoredComponent } from "../contracts/index.js";
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

/**
 * Adoption buys a look only for a candidate with relevance evidence. Two kinds count:
 * a decent similarity score, or a description that literally contains every content
 * word of the query.
 *
 * The second exists because mean-pooled embeddings penalise length. `rails` describes
 * itself as "a full-stack web framework optimized for programmer happiness…" and
 * scored 0.31 against "web framework", while one-line gems saying exactly that scored
 * 0.62 — so Rails, with 784m downloads and a complete lexical match, could not earn a
 * reserved slot and reached the shortlist only by luck of pool size.
 *
 * A popular but irrelevant package still cannot buy in: it satisfies neither test.
 */
function hasRelevanceEvidence(fit: FitSignal | undefined): boolean {
  if (!fit) return false;
  if (fit.fitScore >= ADOPTION_RELEVANCE_FLOOR) return true;
  return fit.lexicalCoverage !== undefined && fit.lexicalCoverage >= 1;
}

function shortlistFor(
  candidates: ComponentCandidate[],
  fitById: Map<string, FitSignal>,
  budget: number,
): ComponentCandidate[] {
  if (candidates.length <= budget) return candidates;

  const ordered = candidates
    // Ties keep discovery order, which favours the probe closest to the user's words.
    .map((candidate, index) => ({ candidate, index, score: fitById.get(candidate.id)?.fitScore ?? 0 }))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const reserved = Math.min(ADOPTION_RESERVED_SLOTS, Math.max(0, budget - 1));
  const byFit = ordered.slice(0, budget - reserved);
  const chosen = new Set(byFit.map((entry) => entry.candidate.id));

  const byAdoption = ordered
    .filter((entry) => !chosen.has(entry.candidate.id)
      && hasRelevanceEvidence(fitById.get(entry.candidate.id))
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
  const fitById = new Map(fit.map((signal) => [signal.id, signal]));
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
