import { describe, expect, it, vi } from "vitest";
import { ComponentCandidateSchema } from "../contracts/index.js";
import type { HttpClient } from "../http/client.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import { CargoDiscoverer } from "./cargo-discovery.js";

describe("CargoDiscoverer", () => {
  it("maps frozen cargo search results into schema-valid candidates for http client", async () => {
    const candidates = await new CargoDiscoverer(createFixtureHttpClient()).discover("http client");

    expect(candidates).toHaveLength(15);
    expect(candidates.length).toBeGreaterThanOrEqual(5);
    expect(candidates.some((candidate) => candidate.id === "cargo:rabbitmq_http_client")).toBe(true);
    expect(candidates.some((candidate) => candidate.id === "cargo:cdk-http-client")).toBe(true);

    const rabbit = candidates.find((c) => c.id === "cargo:rabbitmq_http_client");
    expect(rabbit).toMatchObject({
      id: "cargo:rabbitmq_http_client",
      name: "rabbitmq_http_client",
      ecosystem: "cargo",
      description: "RabbitMQ HTTP API client",
      repoUrl: "https://github.com/michaelklishin/rabbitmq-http-api-rs",
      latestVersion: "0.91.0",
      downloads: 60898,
    });
    // crates.io search results have no license field
    expect(rabbit?.license).toBeUndefined();

    for (const candidate of candidates) {
      expect(candidate.id).toMatch(/^cargo:.+/);
      expect(candidate.license).toBeUndefined();
      expect(ComponentCandidateSchema.parse(candidate)).toEqual(candidate);
    }
  });

  it("maps frozen cargo search results for json serialization", async () => {
    const candidates = await new CargoDiscoverer(createFixtureHttpClient()).discover("json serialization");

    expect(candidates).toHaveLength(15);
    expect(candidates.length).toBeGreaterThanOrEqual(5);
    expect(candidates.some((candidate) => candidate.id === "cargo:serde_json")).toBe(true);

    const serdeJson = candidates.find((c) => c.id === "cargo:serde_json");
    expect(serdeJson).toMatchObject({
      id: "cargo:serde_json",
      name: "serde_json",
      ecosystem: "cargo",
      description: "A JSON serialization file format",
      repoUrl: "https://github.com/serde-rs/json",
      latestVersion: "1.0.151",
    });

    for (const candidate of candidates) {
      expect(candidate.id).toMatch(/^cargo:.+/);
      expect(ComponentCandidateSchema.parse(candidate)).toEqual(candidate);
    }
  });

  it("skips yanked crates", async () => {
    const http: HttpClient = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        crates: [
          {
            id: "yanked-crate",
            name: "yanked-crate",
            description: "A yanked crate",
            yanked: true,
            max_version: "1.0.0",
          },
          {
            id: "active-crate",
            name: "active-crate",
            description: "An active crate",
            yanked: false,
            max_version: "2.0.0",
          },
        ],
      }),
    });

    const candidates = await new CargoDiscoverer(http).discover("test");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("cargo:active-crate");
  });

  it("sends a descriptive User-Agent header", async () => {
    const http = vi.fn<HttpClient>(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ crates: [] }),
    }));

    await new CargoDiscoverer(http).discover("http client");

    expect(http).toHaveBeenCalledWith(
      expect.stringContaining("q=http+client"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": expect.stringContaining("ossfind"),
        }),
      }),
    );
  });

  it("gracefully degrades to [] on rate limits (429), server errors (500), or exceptions", async () => {
    const rateLimited: HttpClient = async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: "rate limited" }),
    });
    await expect(new CargoDiscoverer(rateLimited).discover("query-429")).resolves.toEqual([]);

    const serverError: HttpClient = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "internal error" }),
    });
    await expect(new CargoDiscoverer(serverError).discover("query-500")).resolves.toEqual([]);

    const throwsError: HttpClient = async () => {
      throw new Error("Network failure");
    };
    await expect(new CargoDiscoverer(throwsError).discover("query-throws")).resolves.toEqual([]);
  });

  it("preserves determinism and caches identical queries", async () => {
    const http = vi.fn<HttpClient>(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        crates: [
          {
            id: "test-crate",
            name: "test-crate",
            description: "A test crate",
            max_version: "1.0.0",
            yanked: false,
          },
        ],
      }),
    }));

    const discoverer = new CargoDiscoverer(http);
    const result1 = await discoverer.discover("repeated-query");
    const result2 = await discoverer.discover("repeated-query");

    expect(result1).toEqual(result2);
    expect(http).toHaveBeenCalledTimes(1);
  });
});
