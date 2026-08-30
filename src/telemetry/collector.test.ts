import { describe, expect, it } from "vitest";
import type { HttpResponse } from "../http/client.js";
import type { PipelineDependencies } from "../pipeline/interfaces.js";
import { searchComponents } from "../pipeline/orchestrator.js";
import { UsageCollector } from "./collector.js";

function response(status: number, headers: Record<string, string> = {}): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

describe("UsageCollector", () => {
  it("records supplier aggregates and the latest numeric rate-limit headroom", () => {
    const collector = new UsageCollector();
    collector.recordHttpResponse("https://api.github.com/search/repositories?q=secret", "miss", response(429, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-limit": "60",
      "x-ratelimit-reset": "123456",
      "retry-after": "30",
    }));
    collector.recordHttpError("https://api.github.com/search/repositories?q=secret", "miss");
    collector.recordHttpResponse("https://data.jsdelivr.com/v1/package/npm/private-lib", "hit", response(200));

    const snapshot = collector.snapshot();
    expect(snapshot.suppliers["api.github.com"]).toMatchObject({
      requests: 2,
      cacheMisses: 2,
      cacheHits: 0,
      statusClasses: { "4xx": 1 },
      rateLimited429: 1,
      errors: 1,
      rateLimit: { remaining: 0, limit: 60, reset: 123456, retryAfter: 30 },
    });
    expect(snapshot.suppliers["cdn.jsdelivr.net"]).toMatchObject({ requests: 1, cacheHits: 1 });
  });

  it("uses a bounded latency reservoir and deterministic nearest-rank percentiles", () => {
    let now = 0;
    const collector = new UsageCollector({ now: () => now, reservoirSize: 3 });
    for (const elapsed of [10, 20, 30, 40]) {
      const startedAt = collector.beginSearch();
      now += elapsed;
      collector.recordSearchSuccess(startedAt, [{ id: "npm:component", verdict: "ship" }]);
    }

    expect(collector.snapshot().operations).toMatchObject({
      searchesServed: 4,
      ecosystems: { npm: 4 },
      verdicts: { ship: 4 },
      results: { count: 4, total: 4, min: 1, max: 1, mean: 1 },
      latency: { count: 4, reservoirSize: 3, p50: 30, p95: 40 },
    });

    collector.reset();
    expect(collector.snapshot().operations).toMatchObject({
      searchesServed: 0,
      results: { count: 0, total: 0 },
      latency: { count: 0, reservoirSize: 0, p50: 0, p95: 0 },
    });
  });

  it("never includes a pipeline query or package name in a snapshot", async () => {
    const collector = new UsageCollector();
    const query = "SUPERSECRET internal payments lib";
    const packageName = "SUPERSECRET-PACKAGE-NAME";
    const deps = {
      discoverer: { discover: async () => [] },
      enricher: { enrich: async () => ({}) },
      fitScorer: { fit: async () => [] },
      ranker: { rank: () => [] },
    } as unknown as PipelineDependencies;

    await searchComponents(query, deps, { collector });

    const serialised = JSON.stringify(collector.snapshot());
    expect(serialised).not.toContain(query);
    expect(serialised).not.toContain(packageName);
    expect(serialised).not.toContain("payments");
  });

  it("counts pipeline failures while rethrowing the original error", async () => {
    let now = 0;
    const collector = new UsageCollector({ now: () => now });
    const deps = {
      discoverer: { discover: async () => { now = 25; throw new Error("supplier failed"); } },
    } as unknown as PipelineDependencies;

    await expect(searchComponents("not retained", deps, { collector })).rejects.toThrow("supplier failed");
    expect(collector.snapshot().operations).toMatchObject({
      searchesServed: 0,
      errors: 1,
      latency: { count: 1, p50: 25, p95: 25 },
    });
  });
});
