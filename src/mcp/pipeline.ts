import { HttpDiscoverer } from "../adapters/discovery.js";
import { HttpEnricher } from "../adapters/enrichment.js";
import { TfidfFitScorer } from "../fit/tfidf.js";
import { withCache } from "../http/cache.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import type { PipelineDependencies } from "../pipeline/interfaces.js";
import { WeightedRanker } from "../ranking/rank.js";

export interface BuildPipelineOptions {
  /** Use the frozen supplier responses instead of making network requests. */
  fixtures?: boolean;
  /** SPDX identifier for the consuming project; defaults to MIT in the ranker. */
  projectLicense?: string;
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

/** Construct the production pipeline, optionally replacing its HTTP boundary with fixtures. */
export function buildPipeline(options: BuildPipelineOptions = {}): PipelineDependencies {
  const fixtures = options.fixtures || fixtureModeRequested();
  const http: HttpClient = fixtures
    ? createFixtureHttpClient()
    : cacheDisabled()
      ? defaultHttpClient
      : withCache(defaultHttpClient);

  return {
    discoverer: new HttpDiscoverer(http),
    enricher: new HttpEnricher(http),
    fitScorer: new TfidfFitScorer(),
    ranker: new WeightedRanker({ projectLicense: options.projectLicense }),
  };
}
