import { describe, expect, it } from "vitest";
import { ComponentCandidateSchema } from "../contracts/index.js";
import { loadSearch } from "../fixtures/loader.js";
import type { HttpClient } from "../http/client.js";
import { HttpDiscoverer } from "./discovery.js";

function querySlug(url: string): string {
  const text = new URL(url).searchParams.get("text") ?? "";
  return text.trim().toLowerCase().replace(/\s+/g, "-");
}

const fixtureHttp: HttpClient = async (url) => {
  const slug = querySlug(url);
  if (!["http-client", "date-formatting", "schema-validation"].includes(slug)) {
    return { ok: false, status: 404, json: async () => ({}) };
  }

  return { ok: true, status: 200, json: async () => loadSearch(slug) };
};

describe("HttpDiscoverer", () => {
  it("maps frozen npm search results into schema-valid candidates", async () => {
    const candidates = await new HttpDiscoverer(fixtureHttp).discover("http client");

    expect(candidates.length).toBeGreaterThanOrEqual(10);
    expect(candidates.some((candidate) => candidate.id === "npm:axios")).toBe(true);
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
