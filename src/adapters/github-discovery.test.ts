import { afterEach, describe, expect, it, vi } from "vitest";
import { ComponentCandidateSchema } from "../contracts/index.js";
import type { HttpClient } from "../http/client.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import { GitHubDiscoverer } from "./github-discovery.js";

const originalGitHubToken = process.env.GITHUB_TOKEN;

afterEach(() => {
  if (originalGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalGitHubToken;
});

describe("GitHubDiscoverer", () => {
  it("maps frozen GitHub search results into schema-valid candidates", async () => {
    const candidates = await new GitHubDiscoverer(createFixtureHttpClient())
      .discover("video generation");

    expect(candidates).toContainEqual(expect.objectContaining({
      id: "github:huggingface/diffusers",
      name: "huggingface/diffusers",
      ecosystem: "github",
      license: "Apache-2.0",
      archived: false,
    }));
    expect(candidates).toContainEqual(expect.objectContaining({ id: "github:zai-org/CogVideo" }));
    expect(candidates.find((candidate) => candidate.id === "github:huggingface/diffusers")?.keywords)
      .toEqual(expect.arrayContaining(["deep-learning", "text2video"]));
    for (const candidate of candidates) {
      expect(candidate.id).toMatch(/^github:.+/);
      expect(ComponentCandidateSchema.parse(candidate)).toEqual(candidate);
    }
  });

  it("sends GitHub's requested media type and optional token without exposing it", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    const http = vi.fn<HttpClient>(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    }));

    await new GitHubDiscoverer(http).discover("video generation");

    expect(http).toHaveBeenCalledWith(
      expect.stringContaining("q=video+generation"),
      expect.objectContaining({
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer test-token",
        },
      }),
    );
  });

  it("returns a rate-limit-safe empty result and caches each query", async () => {
    const rateLimited = vi.fn<HttpClient>(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ message: "rate limit exceeded" }),
    }));
    const discoverer = new GitHubDiscoverer(rateLimited);

    await expect(discoverer.discover("video generation")).resolves.toEqual([]);
    await expect(discoverer.discover("video generation")).resolves.toEqual([]);
    expect(rateLimited).toHaveBeenCalledTimes(1);
  });
});
