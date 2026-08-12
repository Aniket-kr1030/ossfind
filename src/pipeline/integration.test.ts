import { describe, expect, it } from "vitest";
import { ScoredComponentSchema } from "../contracts/index.js";
import { searchComponents } from "./orchestrator.js";
import { HttpDiscoverer } from "../adapters/discovery.js";
import { HttpEnricher } from "../adapters/enrichment.js";
import { LexicalFitScorer } from "../fit/lexical.js";
import { WeightedRanker } from "../ranking/rank.js";
import {
  loadDepsDev,
  loadEcosystems,
  loadOsv,
  loadScorecard,
  loadSearch,
} from "../fixtures/loader.js";
import type { HttpClient } from "../http/client.js";

function querySlug(url: string): string {
  const text = new URL(url).searchParams.get("text") ?? "";
  return text.trim().toLowerCase().replace(/\s+/g, "-");
}

function packageFromUrl(url: URL, marker: string): string | undefined {
  const index = url.pathname.indexOf(marker);
  return index >= 0 ? decodeURIComponent(url.pathname.slice(index + marker.length)) : undefined;
}

const projects = new Map([
  ["github.com/expressjs/express", "express"],
  ["github.com/Marak/colors", "colors"],
  ["github.com/request/request", "request"],
  ["github.com/axios/axios", "axios"],
  ["github.com/bitinn/node-fetch", "node-fetch"],
]);

const integrationFixtureClient: HttpClient = async (requestUrl, init) => {
  const url = new URL(requestUrl);
  if (url.hostname === "registry.npmjs.org") {
    const slug = querySlug(requestUrl);
    return { ok: true, status: 200, json: async () => loadSearch(slug) };
  }
  if (url.hostname === "packages.ecosyste.ms") {
    const pkg = packageFromUrl(url, "/packages/");
    return pkg
      ? { ok: true, status: 200, json: async () => loadEcosystems(pkg) }
      : { ok: false, status: 404, json: async () => ({}) };
  }
  if (url.hostname === "api.deps.dev" && url.pathname.includes("/systems/npm/packages/")) {
    const pkg = packageFromUrl(url, "/packages/");
    return pkg
      ? { ok: true, status: 200, json: async () => loadDepsDev(pkg) }
      : { ok: false, status: 404, json: async () => ({}) };
  }
  if (url.hostname === "api.deps.dev" && url.pathname.includes("/projects/")) {
    const project = decodeURIComponent(url.pathname.slice("/v3/projects/".length));
    const pkg = projects.get(project);
    if (!pkg) return { ok: false, status: 404, json: async () => ({}) };
    const scorecard = await loadScorecard(pkg);
    return "__error" in scorecard
      ? { ok: false, status: 404, json: async () => scorecard }
      : { ok: true, status: 200, json: async () => scorecard };
  }
  if (url.hostname === "api.osv.dev" && url.pathname === "/v1/query") {
    try {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const pkg = body?.package?.name;
      return typeof pkg === "string"
        ? { ok: true, status: 200, json: async () => loadOsv(pkg) }
        : { ok: false, status: 400, json: async () => ({}) };
    } catch {
      return { ok: false, status: 400, json: async () => ({}) };
    }
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

describe("Pipeline Integration Test", () => {
  it("runs the full searchComponents pipeline offline for query 'http client'", async () => {
    const discoverer = new HttpDiscoverer(integrationFixtureClient);
    const enricher = new HttpEnricher(integrationFixtureClient);
    const fitScorer = new LexicalFitScorer();
    const ranker = new WeightedRanker({ projectLicense: "MIT" });

    const results = await searchComponents("http client", {
      discoverer,
      enricher,
      fitScorer,
      ranker,
    });

    expect(results.length).toBeGreaterThan(0);

    // Verify all results match ScoredComponentSchema and are sorted correctly
    for (const result of results) {
      expect(ScoredComponentSchema.parse(result)).toEqual(result);
    }

    // Verify the results are sorted in descending order of overall score
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].overall).toBeGreaterThanOrEqual(results[i].overall);
    }

    // Find axios and assert it has a high rank/verdict
    const axiosResult = results.find((r) => r.id === "npm:axios");
    expect(axiosResult).toBeDefined();
    expect(axiosResult?.scores.fit).toBeGreaterThan(0.3);
    expect(axiosResult?.overall).toBeGreaterThan(50);
  });
});
