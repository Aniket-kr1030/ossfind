import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpDiscoverer } from "../adapters/discovery.js";
import { CargoDiscoverer } from "../adapters/cargo-discovery.js";
import { GitHubDiscoverer } from "../adapters/github-discovery.js";
import { HuggingFaceDiscoverer } from "../adapters/huggingface-discovery.js";
import { LibrariesIoDiscoverer } from "../adapters/libraries-discovery.js";
import { LocalIndexDiscoverer } from "../adapters/local-index-discovery.js";
import { RubyGemsDiscoverer } from "../adapters/rubygems-discovery.js";
import { FederatedDiscoverer, type FederatedSource } from "../discovery/federated.js";
import { type EmbeddingsProvider, EmbeddingFitScorer } from "../fit/embeddings.js";
import { HttpEnricher } from "../adapters/enrichment.js";
import type { PackageEcosystem } from "../adapters/enrichment.js";
import { TfidfFitScorer } from "../fit/tfidf.js";
import { TransformersEmbeddingsProvider } from "../fit/transformers-provider.js";
import { withCache } from "../http/cache.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import type { IndexRecord } from "../index/corpus.js";
import { buildIndex } from "../index/local-index.js";
import type { FitScorer, PipelineDependencies } from "../pipeline/interfaces.js";
import { WeightedRanker } from "../ranking/rank.js";

export type SearchEcosystem = PackageEcosystem | "all";

export interface BuildPipelineOptions {
  /** Use the frozen supplier responses instead of making network requests. */
  fixtures?: boolean;
  /** SPDX identifier for the consuming project; defaults to MIT in the ranker. */
  projectLicense?: string;
  /** Injectable live-only provider, principally for embedding integration tests. */
  embeddingsProvider?: EmbeddingsProvider;
  /** Source discovery ecosystem. */
  ecosystem?: SearchEcosystem;
  /** Override the PyPI local-index path, primarily for deterministic integration tests. */
  pypiIndexPath?: string;
  /** Override the npm local-index path, primarily for deterministic integration tests. */
  npmIndexPath?: string;
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

/**
 * Create the HTTP boundary shared by MCP search and inspection tools. Keeping
 * fixture-mode selection here makes an MCP stdio server as deterministic as
 * its direct handler tests when OSSFIND_FIXTURES=1 is set.
 */
export function createPipelineHttpClient(
  options: Pick<BuildPipelineOptions, "fixtures"> = {},
): HttpClient {
  const fixtures = options.fixtures || fixtureModeRequested();
  if (fixtures) return createFixtureHttpClient();
  return cacheDisabled() ? defaultHttpClient : withCache(defaultHttpClient);
}

function requestedFitMode(): "tfidf" | "embeddings" | undefined {
  const environment = (globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  const mode = environment?.OSSFIND_FIT;
  return mode === "tfidf" || mode === "embeddings" ? mode : undefined;
}

type PypiDiscoveryMode = "index" | "libraries" | "auto";

function requestedPypiDiscoveryMode(): PypiDiscoveryMode {
  const environment = (globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  const mode = environment?.OSSFIND_PYPI_DISCOVERY;
  return mode === "index" || mode === "libraries" ? mode : "auto";
}

let fixturePypiIndexPath: string | undefined;

/**
 * The package-search API fixtures are intentionally not used for PyPI
 * discovery: fixtures exercise the same FTS index path as production. The
 * process-local temp directory also keeps checked-in caches out of test runs.
 */
function fixtureIndexPath(): string {
  if (fixturePypiIndexPath) return fixturePypiIndexPath;

  const fixture = new URL("../../fixtures/index/pypi-sample.json", import.meta.url);
  const records = JSON.parse(readFileSync(fixture, "utf8")) as IndexRecord[];
  const directory = mkdtempSync(join(tmpdir(), "ossfind-pypi-index-"));
  fixturePypiIndexPath = join(directory, "pypi.db");
  buildIndex(fixturePypiIndexPath, records);
  return fixturePypiIndexPath;
}

/**
 * npm discovery federates the registry's own search with the local semantic index.
 *
 * The registry matches text conjunctively, which query expansion partly compensates
 * for but cannot fix outright: `marked` describes itself as "A markdown parser built
 * for speed", so no slice of "markdown to html renderer" reaches it. Bridging
 * *renderer* to *parser* needs embeddings, which is what the local index provides.
 * It is optional — when the index has not been built, this is exactly the previous
 * registry-only behaviour.
 */
function npmDiscoverer(http: HttpClient, fixtures: boolean, indexPath?: string) {
  const sources: FederatedSource[] = [
    { name: "npm-registry", discoverer: new HttpDiscoverer(http) },
  ];
  if (!fixtures) {
    const local = new LocalIndexDiscoverer("npm", indexPath);
    // An index that was never built must not be advertised as a source at all,
    // otherwise every npm search reports a permanently unavailable one.
    if (local.isAvailable()) sources.push({ name: "local-index", discoverer: local });
  }
  return new FederatedDiscoverer(sources);
}

function pypiDiscoverer(http: HttpClient, fixtures: boolean, indexPath?: string) {
  const local = new LocalIndexDiscoverer("pypi", fixtures ? fixtureIndexPath() : indexPath);
  const mode = requestedPypiDiscoveryMode();
  const libraries = new LibrariesIoDiscoverer(http, fixtures ? { apiKey: "fixture" } : {});
  const sources: FederatedSource[] = mode === "index"
    ? [{ name: "local-index", discoverer: local }]
    : mode === "libraries"
      ? [{ name: "libraries.io", discoverer: libraries }]
      : [
          { name: "local-index", discoverer: local },
          { name: "libraries.io", discoverer: libraries },
        ];
  return new FederatedDiscoverer(sources);
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
  const http = createPipelineHttpClient(options);
  const fallbackFitScorer = new TfidfFitScorer();
  const fitMode = requestedFitMode();
  const fitScorer: FitScorer = fixtures || fitMode === "tfidf"
    ? fallbackFitScorer
    : new FallbackFitScorer(
        new EmbeddingFitScorer(options.embeddingsProvider ?? new TransformersEmbeddingsProvider()),
        fallbackFitScorer,
      );

  return {
    discoverer: ecosystem === "npm"
      ? npmDiscoverer(http, fixtures, options.npmIndexPath)
      : ecosystem === "github"
        ? new GitHubDiscoverer(http)
        : ecosystem === "huggingface"
          ? new HuggingFaceDiscoverer(http)
        : ecosystem === "pypi"
          ? pypiDiscoverer(http, fixtures, options.pypiIndexPath)
        : ecosystem === "cargo"
          ? new CargoDiscoverer(http)
        : ecosystem === "rubygems"
          ? new RubyGemsDiscoverer(http)
          : new FederatedDiscoverer([
              { name: "npm-registry", discoverer: npmDiscoverer(http, fixtures, options.npmIndexPath) },
              { name: "pypi", discoverer: pypiDiscoverer(http, fixtures, options.pypiIndexPath) },
              { name: "github", discoverer: new GitHubDiscoverer(http) },
              { name: "huggingface", discoverer: new HuggingFaceDiscoverer(http) },
              { name: "cargo", discoverer: new CargoDiscoverer(http) },
              { name: "rubygems", discoverer: new RubyGemsDiscoverer(http) },
            ]),
    enricher: new HttpEnricher(http),
    fitScorer,
    ranker: new WeightedRanker({ projectLicense: options.projectLicense }),
  };
}
