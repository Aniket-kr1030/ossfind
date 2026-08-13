import { HttpDiscoverer } from "../adapters/discovery.js";
import { type EmbeddingsProvider, EmbeddingFitScorer } from "../fit/embeddings.js";
import { HttpEnricher } from "../adapters/enrichment.js";
import type { PackageEcosystem } from "../adapters/enrichment.js";
import { TfidfFitScorer } from "../fit/tfidf.js";
import { TransformersEmbeddingsProvider } from "../fit/transformers-provider.js";
import { withCache } from "../http/cache.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import type { Discoverer, FitScorer, PipelineDependencies } from "../pipeline/interfaces.js";
import { WeightedRanker } from "../ranking/rank.js";

export interface BuildPipelineOptions {
  /** Use the frozen supplier responses instead of making network requests. */
  fixtures?: boolean;
  /** SPDX identifier for the consuming project; defaults to MIT in the ranker. */
  projectLicense?: string;
  /** Injectable live-only provider, principally for embedding integration tests. */
  embeddingsProvider?: EmbeddingsProvider;
  /** Source package ecosystem. PyPI discovery is deliberately deferred to M4b. */
  ecosystem?: PackageEcosystem;
}

function fixtureModeRequested(): boolean {
  const environment = (globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  return environment?.OSSFIND_FIXTURES === "1";
}

function cacheDisabled(): boolean {
  const environment = (globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  return environment?.OSSFIND_NO_CACHE === "1";
}

function requestedFitMode(): "tfidf" | "embeddings" | undefined {
  const environment = (globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  const mode = environment?.OSSFIND_FIT;
  return mode === "tfidf" || mode === "embeddings" ? mode : undefined;
}

class NoopDiscoverer implements Discoverer {
  async discover(): Promise<[]> {
    return [];
  }
}

/**
 * Uses the semantic scorer until its provider fails (for example, a missing
 * local model), then permanently uses the deterministic scorer for this
 * pipeline instance. This keeps live search useful when model loading is not.
 */
export class FallbackFitScorer implements FitScorer {
  private primaryFailed = false;

  constructor(
    private readonly primary: FitScorer,
    private readonly fallback: FitScorer,
    private readonly warn: (message: string) => void = console.warn,
  ) {}

  async fit(query: string, candidates: Parameters<FitScorer["fit"]>[1]) {
    if (this.primaryFailed) return this.fallback.fit(query, candidates);

    try {
      return await this.primary.fit(query, candidates);
    } catch {
      this.primaryFailed = true;
      this.warn("[ossfind] embeddings unavailable; falling back to TF-IDF.");
      return this.fallback.fit(query, candidates);
    }
  }
}

/** Construct the production pipeline, optionally replacing its HTTP boundary with fixtures. */
export function buildPipeline(options: BuildPipelineOptions = {}): PipelineDependencies {
  const ecosystem = options.ecosystem ?? "npm";
  const fixtures = options.fixtures || fixtureModeRequested();
  const http: HttpClient = fixtures
    ? createFixtureHttpClient()
    : cacheDisabled()
      ? defaultHttpClient
      : withCache(defaultHttpClient);
  const fallbackFitScorer = new TfidfFitScorer();
  const fitMode = requestedFitMode();
  const fitScorer: FitScorer = fixtures || fitMode === "tfidf"
    ? fallbackFitScorer
    : new FallbackFitScorer(
        new EmbeddingFitScorer(options.embeddingsProvider ?? new TransformersEmbeddingsProvider()),
        fallbackFitScorer,
      );

  return {
    discoverer: ecosystem === "npm" ? new HttpDiscoverer(http) : new NoopDiscoverer(),
    enricher: new HttpEnricher(http, undefined, ecosystem),
    fitScorer,
    ranker: new WeightedRanker({ projectLicense: options.projectLicense }),
  };
}
