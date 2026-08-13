import { describe, expect, it, vi } from "vitest";
import type { ComponentCandidate } from "../contracts/index.js";
import type { EmbeddingsProvider } from "../fit/embeddings.js";
import { TfidfFitScorer } from "../fit/tfidf.js";
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
