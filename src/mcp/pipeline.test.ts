import { describe, expect, it, vi } from "vitest";
import { LibrariesIoDiscoverer } from "../adapters/libraries-discovery.js";
import { GitHubDiscoverer } from "../adapters/github-discovery.js";
import { LocalIndexDiscoverer } from "../adapters/local-index-discovery.js";
import { HttpDiscoverer } from "../adapters/discovery.js";
import type { ComponentCandidate } from "../contracts/index.js";
import { FederatedDiscoverer } from "../discovery/federated.js";
import type { EmbeddingsProvider } from "../fit/embeddings.js";
import { TfidfFitScorer } from "../fit/tfidf.js";
import { ScoredComponentSchema } from "../contracts/index.js";
import { searchComponents } from "../pipeline/orchestrator.js";
import { buildPipeline } from "./pipeline.js";

const candidates: ComponentCandidate[] = [
  {
    id: "npm:fluent-ffmpeg",
    name: "fluent-ffmpeg",
    ecosystem: "npm",
    description: "A fluent API to use ffmpeg from Node.js.",
  },
  {
    id: "npm:left-pad",
    name: "left-pad",
    ecosystem: "npm",
    description: "String padding utility.",
  },
];

describe("buildPipeline fit scorer selection", () => {
  it("selects fixture-backed local-index PyPI discovery and PyPI enrichment in fixture mode", async () => {
    const pipeline = buildPipeline({ fixtures: true, ecosystem: "pypi" });

    expect(pipeline.discoverer).toBeInstanceOf(FederatedDiscoverer);
    await expect(pipeline.discoverer.discover("video editing")).resolves.toContainEqual(
      expect.objectContaining({ id: "pypi:moviepy", ecosystem: "pypi" }),
    );
    await expect(pipeline.enricher.enrich({
      id: "pypi:moviepy",
      name: "moviepy",
      ecosystem: "pypi",
      description: "Video editing with Python",
      repoUrl: "https://github.com/zulko/moviepy",
    })).resolves.toMatchObject({
      id: "pypi:moviepy",
      license: { spdxId: "MIT" },
      sources: { osv: "ok" },
    });
  });

  it("runs the full PyPI pipeline offline through the fixture local index", async () => {
    const pipeline = buildPipeline({ fixtures: true, ecosystem: "pypi" });
    const results = await searchComponents("video editing", pipeline);
    const discovered = await pipeline.discoverer.discover("video editing");
    const missingFixture = discovered.find((candidate) => candidate.id === "pypi:imageio-ffmpeg");

    expect(discovered).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pypi:moviepy" }),
      expect.objectContaining({ id: "pypi:ffmpeg-python" }),
    ]));
    expect(missingFixture).toBeDefined();
    await expect(pipeline.enricher.enrich(missingFixture!)).resolves.toMatchObject({
      id: "pypi:imageio-ffmpeg",
      sources: { license: "failed", osv: "failed", scorecard: "missing" },
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.id === "pypi:moviepy")).toBe(true);
    for (const result of results) {
      expect(ScoredComponentSchema.parse(result)).toEqual(result);
    }
  });

  it("federates the fixture PyPI local index and libraries.io, deduping their union end-to-end", async () => {
    vi.stubEnv("LIBRARIES_IO_API_KEY", "fixture");

    try {
      const pipeline = buildPipeline({ fixtures: true, ecosystem: "pypi" });
      const discovered = await pipeline.discoverer.discover("video editing");
      const ids = discovered.map((candidate) => candidate.id);
      const results = await searchComponents("video editing", pipeline);

      expect(pipeline.discoverer).toBeInstanceOf(FederatedDiscoverer);
      expect(ids).toEqual(expect.arrayContaining([
        "pypi:ffmpeg-python",
        "pypi:moviepy",
        "pypi:video-editing-ai-mcp",
      ]));
      expect(ids.filter((id) => id === "pypi:moviepy")).toHaveLength(1);
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(ScoredComponentSchema.parse(result)).toEqual(result);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("honors OSSFIND_PYPI_DISCOVERY=libraries", () => {
    vi.stubEnv("OSSFIND_PYPI_DISCOVERY", "libraries");

    try {
      expect(buildPipeline({ ecosystem: "pypi" }).discoverer).toBeInstanceOf(LibrariesIoDiscoverer);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("honors OSSFIND_PYPI_DISCOVERY=index even when the index is unavailable", () => {
    vi.stubEnv("OSSFIND_PYPI_DISCOVERY", "index");

    try {
      expect(buildPipeline({
        ecosystem: "pypi",
        pypiIndexPath: "/tmp/ossfind-no-such-index-directory/pypi.db",
      }).discoverer).toBeInstanceOf(LocalIndexDiscoverer);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("falls back to libraries.io in auto mode when the local index is unavailable", () => {
    vi.stubEnv("OSSFIND_PYPI_DISCOVERY", "auto");
    vi.stubEnv("LIBRARIES_IO_API_KEY", "fixture");

    try {
      expect(buildPipeline({
        ecosystem: "pypi",
        pypiIndexPath: "/tmp/ossfind-no-such-index-directory/pypi.db",
      }).discoverer).toBeInstanceOf(LibrariesIoDiscoverer);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses a one-source federation for npm without changing fixture results", async () => {
    const pipeline = buildPipeline({ fixtures: true, ecosystem: "npm" });

    expect(pipeline.discoverer).toBeInstanceOf(FederatedDiscoverer);
    await expect(pipeline.discoverer.discover("http client")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "npm:axios" }),
    ]));
  });

  it("runs the full GitHub pipeline offline and keeps raw repositories out of ship verdicts", async () => {
    const pipeline = buildPipeline({ fixtures: true, ecosystem: "github", projectLicense: "MIT" });
    const discovered = await pipeline.discoverer.discover("video generation");
    const results = await searchComponents("video generation", pipeline);
    const byId = new Map(results.map((result) => [result.id, result]));

    expect(pipeline.discoverer).toBeInstanceOf(GitHubDiscoverer);
    expect(discovered).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "github:huggingface/diffusers", ecosystem: "github" }),
      expect.objectContaining({ id: "github:zai-org/CogVideo", ecosystem: "github" }),
    ]));
    expect(results.length).toBeGreaterThan(0);
    expect(byId.get("github:krillinai/KrillinAI")?.verdict).not.toBe("ship");
    expect(byId.get("github:krillinai/KrillinAI")?.verdict).toBe("avoid");
    expect(byId.get("github:Tencent-Hunyuan/HunyuanVideo")?.verdict).not.toBe("ship");
    expect(byId.get("github:huggingface/diffusers")?.verdict).toBe("caution");
    for (const result of results) {
      expect(ScoredComponentSchema.parse(result)).toEqual(result);
    }
  });

  it("federates all fixture ecosystems and enriches every candidate from its own source", async () => {
    const pipeline = buildPipeline({ fixtures: true, ecosystem: "all" });
    const discovered = await pipeline.discoverer.discover("video editing");
    const byId = new Map(discovered.map((candidate) => [candidate.id, candidate]));
    const moviepy = byId.get("pypi:moviepy");
    const openshot = byId.get("github:OpenShot/openshot-qt");

    expect(pipeline.discoverer).toBeInstanceOf(FederatedDiscoverer);
    expect(discovered.some((candidate) => candidate.id.startsWith("pypi:"))).toBe(true);
    expect(discovered.some((candidate) => candidate.id.startsWith("github:"))).toBe(true);
    expect(moviepy).toBeDefined();
    expect(openshot).toBeDefined();

    await expect(pipeline.enricher.enrich(moviepy!)).resolves.toMatchObject({
      id: "pypi:moviepy",
      license: { spdxId: "MIT", source: "ecosyste.ms" },
      sources: { license: "ok", osv: "ok", scorecard: "ok" },
      scorecard: { overall: 3.7 },
    });
    await expect(pipeline.enricher.enrich(openshot!)).resolves.toMatchObject({
      id: "github:OpenShot/openshot-qt",
      license: { spdxId: null, source: "github" },
      sources: { license: "missing", osv: "missing", scorecard: "ok" },
      scorecard: { overall: 3.8 },
    });
  });

  it("isolates a failed all-ecosystem source while retaining the other fixture results", async () => {
    const discover = vi.spyOn(HttpDiscoverer.prototype, "discover").mockRejectedValue(new Error("npm unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const discovered = await buildPipeline({ fixtures: true, ecosystem: "all" })
        .discoverer.discover("video editing");

      expect(discovered).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "pypi:moviepy" }),
        expect.objectContaining({ id: "github:OpenShot/openshot-qt" }),
      ]));
      expect(warning).toHaveBeenCalledWith("[ossfind] discovery source unavailable: npm-registry.");
    } finally {
      discover.mockRestore();
      warning.mockRestore();
    }
  });

  it("falls back to TF-IDF when the live embedding provider cannot initialize", async () => {
    const unavailable: EmbeddingsProvider = {
      embed: vi.fn().mockRejectedValue(new Error("model unavailable")),
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const pipeline = buildPipeline({ fixtures: false, embeddingsProvider: unavailable });
      const expected = await new TfidfFitScorer().fit("video encoding ffmpeg", candidates);

      await expect(pipeline.fitScorer.fit("video encoding ffmpeg", candidates)).resolves.toEqual(expected);
      await expect(pipeline.fitScorer.fit("video encoding ffmpeg", candidates)).resolves.toEqual(expected);

      expect(unavailable.embed).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith("[ossfind] embeddings unavailable; falling back to TF-IDF.");
    } finally {
      warning.mockRestore();
    }
  });

  it("keeps fixture mode offline even if an embedding provider is supplied", async () => {
    const provider: EmbeddingsProvider = { embed: vi.fn() };
    const pipeline = buildPipeline({ fixtures: true, embeddingsProvider: provider });

    await pipeline.fitScorer.fit("video encoding ffmpeg", candidates);

    expect(provider.embed).not.toHaveBeenCalled();
    expect(pipeline.fitScorer).toBeInstanceOf(TfidfFitScorer);
  });

  it("honors OSSFIND_FIT=tfidf in live mode", async () => {
    const provider: EmbeddingsProvider = { embed: vi.fn() };
    vi.stubEnv("OSSFIND_FIT", "tfidf");

    try {
      const pipeline = buildPipeline({ fixtures: false, embeddingsProvider: provider });
      await pipeline.fitScorer.fit("video encoding ffmpeg", candidates);

      expect(provider.embed).not.toHaveBeenCalled();
      expect(pipeline.fitScorer).toBeInstanceOf(TfidfFitScorer);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
