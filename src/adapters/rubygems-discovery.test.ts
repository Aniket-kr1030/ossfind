import { describe, expect, it, vi } from "vitest";
import { ComponentCandidateSchema } from "../contracts/index.js";
import type { HttpClient } from "../http/client.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import { RubyGemsDiscoverer } from "./rubygems-discovery.js";

describe("RubyGemsDiscoverer", () => {
  it("maps frozen rubygems search results into schema-valid candidates for http client", async () => {
    const candidates = await new RubyGemsDiscoverer(createFixtureHttpClient()).discover("http client");

    expect(candidates).toHaveLength(30);
    expect(candidates.length).toBeGreaterThanOrEqual(5);
    expect(candidates.some((candidate) => candidate.id === "rubygems:ruby_http_client")).toBe(true);
    expect(candidates.some((candidate) => candidate.id === "rubygems:philiprehberger-http_client")).toBe(true);
    expect(candidates.some((candidate) => candidate.id === "rubygems:faraday")).toBe(true);

    const faraday = candidates.find((c) => c.id === "rubygems:faraday");
    expect(faraday).toMatchObject({
      id: "rubygems:faraday",
      name: "faraday",
      ecosystem: "rubygems",
      description: "HTTP/REST API client library.",
      repoUrl: "https://github.com/lostisland/faraday",
      latestVersion: "2.14.3",
      downloads: 1247785889,
      license: "MIT",
    });

    for (const candidate of candidates) {
      expect(candidate.id).toMatch(/^rubygems:.+/);
      expect(ComponentCandidateSchema.parse(candidate)).toEqual(candidate);
    }
  });

  it("maps frozen rubygems search results for web framework", async () => {
    const candidates = await new RubyGemsDiscoverer(createFixtureHttpClient()).discover("web framework");

    expect(candidates).toHaveLength(30);
    expect(candidates.length).toBeGreaterThanOrEqual(5);
    expect(candidates.some((candidate) => candidate.id === "rubygems:rails")).toBe(true);
    expect(candidates.some((candidate) => candidate.id === "rubygems:actionpack")).toBe(true);

    const rails = candidates.find((c) => c.id === "rubygems:rails");
    expect(rails).toMatchObject({
      id: "rubygems:rails",
      name: "rails",
      ecosystem: "rubygems",
      description: expect.stringContaining("Ruby on Rails is a full-stack web framework"),
      homepage: "https://rubyonrails.org/",
      latestVersion: "8.1.3.1",
      license: "MIT",
    });

    for (const candidate of candidates) {
      expect(candidate.id).toMatch(/^rubygems:.+/);
      expect(ComponentCandidateSchema.parse(candidate)).toEqual(candidate);
    }
  });

  it("parses bare JSON array and handles null/empty licenses as unknown without permissive default", async () => {
    const http: HttpClient = async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          name: "gem-no-license",
          info: "Gem with null licenses",
          version: "1.0.0",
          licenses: null,
        },
        {
          name: "gem-empty-licenses",
          info: "Gem with empty licenses array",
          version: "1.0.0",
          licenses: [],
        },
        {
          name: "gem-mit-license",
          info: "Gem with MIT license",
          version: "1.0.0",
          licenses: ["MIT"],
        },
        {
          name: "gem-dual-license",
          info: "Gem with dual license",
          version: "1.0.0",
          licenses: ["MIT", "MPL-2.0"],
        },
      ],
    });

    const candidates = await new RubyGemsDiscoverer(http).discover("test");
    expect(candidates).toHaveLength(4);

    const nullLic = candidates.find((c) => c.id === "rubygems:gem-no-license");
    expect(nullLic?.license).toBeUndefined();

    const emptyLic = candidates.find((c) => c.id === "rubygems:gem-empty-licenses");
    expect(emptyLic?.license).toBeUndefined();

    const mitLic = candidates.find((c) => c.id === "rubygems:gem-mit-license");
    expect(mitLic?.license).toBe("MIT");

    const dualLic = candidates.find((c) => c.id === "rubygems:gem-dual-license");
    expect(dualLic?.license).toBe("MIT OR MPL-2.0");

    for (const candidate of candidates) {
      expect(ComponentCandidateSchema.parse(candidate)).toEqual(candidate);
    }
  });

  it("gracefully degrades to [] on rate limits (429), server errors (500), or exceptions", async () => {
    const rateLimited: HttpClient = async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: "rate limited" }),
    });
    await expect(new RubyGemsDiscoverer(rateLimited).discover("query-429")).resolves.toEqual([]);

    const serverError: HttpClient = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "server error" }),
    });
    await expect(new RubyGemsDiscoverer(serverError).discover("query-500")).resolves.toEqual([]);

    const throwsError: HttpClient = async () => {
      throw new Error("Network error");
    };
    await expect(new RubyGemsDiscoverer(throwsError).discover("query-throws")).resolves.toEqual([]);
  });

  it("preserves determinism and caches identical queries", async () => {
    const http = vi.fn<HttpClient>(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          name: "test-gem",
          info: "A test gem",
          version: "1.0.0",
          licenses: ["MIT"],
        },
      ],
    }));

    const discoverer = new RubyGemsDiscoverer(http);
    const result1 = await discoverer.discover("repeated-query");
    const result2 = await discoverer.discover("repeated-query");

    expect(result1).toEqual(result2);
    expect(http).toHaveBeenCalledTimes(1);
  });
});
