import type { ScoredComponent } from "../contracts/index.js";
import type { PipelineDependencies } from "./interfaces.js";

export interface SearchComponentsOptions {
  /** Restrict the final result set; omitted means return every ranked item. */
  limit?: number;
}

/** Wires the four pipeline stages without imposing ranking or supplier policy. */
export async function searchComponents(
  query: string,
  deps: PipelineDependencies,
  opts: SearchComponentsOptions = {},
): Promise<ScoredComponent[]> {
  const candidates = await deps.discoverer.discover(query);
  const enriched = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      bundle: await deps.enricher.enrich(candidate),
    })),
  );
  const fit = await deps.fitScorer.fit(query, candidates);
  const ranked = deps.ranker.rank(query, enriched, fit);

  return opts.limit === undefined ? ranked : ranked.slice(0, Math.max(0, opts.limit));
}
