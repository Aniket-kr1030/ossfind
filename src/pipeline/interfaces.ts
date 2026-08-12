import type {
  ComponentCandidate,
  EnrichmentBundle,
  FitSignal,
  ScoredComponent,
} from "../contracts/index.js";

export interface Discoverer {
  discover(query: string): Promise<ComponentCandidate[]>;
}

export interface Enricher {
  enrich(candidate: ComponentCandidate): Promise<EnrichmentBundle>;
}

export interface FitScorer {
  fit(query: string, candidates: ComponentCandidate[]): Promise<FitSignal[]>;
}

export interface Ranker {
  rank(
    query: string,
    enriched: Array<{ candidate: ComponentCandidate; bundle: EnrichmentBundle }>,
    fit: FitSignal[],
  ): ScoredComponent[];
}

export interface PipelineDependencies {
  discoverer: Discoverer;
  enricher: Enricher;
  fitScorer: FitScorer;
  ranker: Ranker;
}
