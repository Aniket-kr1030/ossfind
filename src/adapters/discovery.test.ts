import { describe, expect, it } from "vitest";
import { ComponentCandidateSchema } from "../contracts/index.js";
import type { HttpClient } from "../http/client.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import { HttpDiscoverer } from "./discovery.js";

describe("HttpDiscoverer", () => {
  it("maps frozen npm search results into schema-valid candidates", async () => {
    const candidates = await new HttpDiscoverer(createFixtureHttpClient()).discover("http client");

    expect(candidates.length).toBeGreaterThanOrEqual(10);
    expect(candidates.some((candidate) => candidate.id === "npm:axios")).toBe(true);
    expect(candidates.find((candidate) => candidate.id === "npm:axios")?.keywords)
      .toEqual(["xhr", "http", "ajax", "promise", "node", "browser", "fetch", "rest", "api", "client"]);
    for (const candidate of candidates) {
      expect(ComponentCandidateSchema.parse(candidate)).toEqual(candidate);
    }
  });

  it("returns a degraded result after repeated rate limits", async () => {
    const alwaysRateLimited: HttpClient = async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: "rate limited" }),
    });

    await expect(new HttpDiscoverer(alwaysRateLimited).discover("http client"))
      .resolves.toEqual([]);
  });
});
