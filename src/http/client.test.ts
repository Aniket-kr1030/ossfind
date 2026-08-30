import { describe, expect, it } from "vitest";
import { UsageCollector } from "../telemetry/collector.js";
import { withUsageCollector, type HttpClient } from "./client.js";

describe("withUsageCollector", () => {
  it("counts uncached network outcomes and leaves disabled clients identical", async () => {
    const collector = new UsageCollector();
    const response = { ok: false, status: 429, json: async () => ({}) };
    const inner: HttpClient = async (url) => {
      if (url.includes("throw")) throw new Error("offline");
      return response;
    };
    expect(withUsageCollector(inner)).toBe(inner);

    const client = withUsageCollector(inner, collector);
    await client("https://libraries.io/api/search?q=secret");
    await expect(client("https://libraries.io/throw")).rejects.toThrow("offline");

    expect(collector.snapshot().suppliers["libraries.io"]).toMatchObject({
      requests: 2,
      cacheMisses: 2,
      statusClasses: { "4xx": 1 },
      rateLimited429: 1,
      errors: 1,
    });
  });
});
