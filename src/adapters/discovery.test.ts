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

  // Previously this resolved to []. The relevance eval exposed why that is wrong:
  // a rate-limited run scored as "no relevant results" and was indistinguishable
  // from a query that genuinely matched nothing. Rejecting lets the federated layer
  // mark the source unavailable, which the search response reports to the caller.
  it("rejects when the registry refuses every probe, rather than reporting no results", async () => {
    const alwaysRateLimited: HttpClient = async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: "rate limited" }),
    });

    await expect(new HttpDiscoverer(alwaysRateLimited).discover("http client"))
      .rejects.toThrow(/failed for every probe/);
  });

  it("resolves empty when the registry answers with no matches", async () => {
    const emptyAnswer: HttpClient = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ objects: [] }),
    });

    await expect(new HttpDiscoverer(emptyAnswer).discover("http client")).resolves.toEqual([]);
  });

  it("keeps the results of probes that did answer when others fail", async () => {
    let call = 0;
    const flaky: HttpClient = async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 429, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ objects: [{ package: { name: "axios", description: "http client", version: "1.0.0" } }] }),
      };
    };

    await expect(new HttpDiscoverer(flaky, 20, 1).discover("node http client library"))
      .resolves.toEqual([expect.objectContaining({ id: "npm:axios" })]);
  });
});
