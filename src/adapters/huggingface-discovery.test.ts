import { describe, expect, it, vi } from "vitest";
import { ComponentCandidateSchema } from "../contracts/index.js";
import type { HttpClient } from "../http/client.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import { HuggingFaceDiscoverer } from "./huggingface-discovery.js";

describe("HuggingFaceDiscoverer", () => {
  it("maps frozen model-search results into schema-valid candidates", async () => {
    const candidates = await new HuggingFaceDiscoverer(createFixtureHttpClient())
      .discover("video generation");

    expect(candidates).toContainEqual(expect.objectContaining({
      id: "huggingface:Ngvrd/video_generation_model-Q2_K-GGUF",
      name: "Ngvrd/video_generation_model-Q2_K-GGUF",
      ecosystem: "huggingface",
      description: "text-to-video model",
      license: "apache-2.0",
      stars: 5,
      downloads: 303,
      publishedAt: "2026-06-14T10:45:09.000Z",
    }));
    expect(candidates.find((candidate) => candidate.id === "huggingface:nagayama0706/video_generation_model"))
      .toEqual(expect.objectContaining({ description: "text-to-video model (transformers)" }));
    for (const candidate of candidates) {
      expect(candidate.id).toMatch(/^huggingface:.+/);
      expect(ComponentCandidateSchema.parse(candidate)).toEqual(candidate);
    }
  });

  it("uses Hugging Face's download-sorted model-search endpoint and caches each query", async () => {
    const http = vi.fn<HttpClient>(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
    }));
    const discoverer = new HuggingFaceDiscoverer(http, { size: 7 });

    await expect(discoverer.discover("video generation")).resolves.toEqual([]);
    await expect(discoverer.discover("video generation")).resolves.toEqual([]);

    expect(http).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledWith(
      "https://huggingface.co/api/models?search=video+generation&sort=downloads&direction=-1&limit=7",
    );
  });
});
