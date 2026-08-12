import { describe, expect, it } from "vitest";
import {
  ComponentCandidateSchema,
  EnrichmentBundleSchema,
  type ComponentCandidate,
} from "../contracts/index.js";
import {
  loadDepsDev,
  loadEcosystems,
  loadOsv,
  loadScorecard,
} from "../fixtures/loader.js";
import type { HttpClient } from "../http/client.js";
import { HttpEnricher } from "./enrichment.js";

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function packageFromUrl(url: URL, marker: string): string | undefined {
  const index = url.pathname.indexOf(marker);
  return index >= 0 ? decodeURIComponent(url.pathname.slice(index + marker.length)) : undefined;
}

function fixtureClient(): HttpClient {
  const projects = new Map([
    ["github.com/expressjs/express", "express"],
    ["github.com/Marak/colors", "colors"],
    ["github.com/request/request", "request"],
  ]);

  return async (requestUrl, init) => {
    const url = new URL(requestUrl);
    if (url.hostname === "packages.ecosyste.ms") {
      const pkg = packageFromUrl(url, "/packages/");
      return pkg ? response(await loadEcosystems(pkg)) : response({}, 404);
    }
    if (url.hostname === "api.deps.dev" && url.pathname.includes("/systems/npm/packages/")) {
      const pkg = packageFromUrl(url, "/packages/");
      return pkg ? response(await loadDepsDev(pkg)) : response({}, 404);
    }
    if (url.hostname === "api.deps.dev" && url.pathname.includes("/projects/")) {
      const project = decodeURIComponent(url.pathname.slice("/v3/projects/".length));
      const pkg = projects.get(project);
      if (!pkg) return response({}, 404);
      const scorecard = await loadScorecard(pkg);
      return "__error" in scorecard ? response(scorecard, 404) : response(scorecard);
    }
    if (url.hostname === "api.osv.dev" && url.pathname === "/v1/query") {
      try {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        const pkg = body?.package?.name;
        return typeof pkg === "string" ? response(await loadOsv(pkg)) : response({}, 400);
      } catch {
        return response({}, 400);
      }
    }
    return response({}, 404);
  };
}

function candidate(name: string, repoUrl: string): ComponentCandidate {
  return ComponentCandidateSchema.parse({
    id: `npm:${name}`,
    name,
    ecosystem: "npm",
    description: "fixture test candidate",
    repoUrl,
  });
}

describe("HttpEnricher", () => {
  it("maps express from offline supplier fixtures into a valid bundle", async () => {
    const bundle = await new HttpEnricher(fixtureClient()).enrich(
      candidate("express", "https://github.com/expressjs/express"),
    );

    expect(bundle.license.spdxId).toBe("MIT");
    expect(bundle.scorecard.overall).toEqual(expect.any(Number));
    expect(EnrichmentBundleSchema.parse(bundle)).toEqual(bundle);
  });

  it("treats a 404 scorecard as a null score without throwing", async () => {
    const bundle = await new HttpEnricher(fixtureClient()).enrich(
      candidate("colors", "https://github.com/Marak/colors"),
    );

    expect(bundle.scorecard.overall).toBeNull();
    expect(EnrichmentBundleSchema.parse(bundle)).toEqual(bundle);
  });

  it("keeps OSV vulnerabilities when the other sources are fixture-backed", async () => {
    const bundle = await new HttpEnricher(fixtureClient()).enrich(
      candidate("request", "https://github.com/request/request"),
    );

    expect(bundle.vulnerabilities.length).toBeGreaterThan(0);
    expect(EnrichmentBundleSchema.parse(bundle)).toEqual(bundle);
  });
});
