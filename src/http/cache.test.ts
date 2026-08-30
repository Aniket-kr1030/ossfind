import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpClient, HttpResponse } from "./client.js";
import { cacheCategoryFor, withCache } from "./cache.js";
import { UsageCollector } from "../telemetry/collector.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function cacheDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ossfind-cache-"));
  directories.push(directory);
  return directory;
}

function jsonResponse(body: unknown, status = 200): HttpResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("withCache", () => {
  it("reports first requests as misses and retained responses as hits", async () => {
    const directory = await cacheDirectory();
    const collector = new UsageCollector();
    let calls = 0;
    const client = withCache(async () => jsonResponse({ value: ++calls }), { dir: directory, collector });

    await client("https://registry.npmjs.org/-/v1/search?text=private-package");
    await client("https://registry.npmjs.org/-/v1/search?text=private-package");

    expect(calls).toBe(1);
    expect(collector.snapshot().suppliers["registry.npmjs.org"]).toMatchObject({
      requests: 2,
      cacheHits: 1,
      cacheMisses: 1,
      statusClasses: { "2xx": 2 },
    });
  });

  it("serves an identical request from disk after the first cache miss", async () => {
    const directory = await cacheDirectory();
    let calls = 0;
    const inner: HttpClient = async () => jsonResponse({ value: ++calls });
    const client = withCache(inner, { dir: directory });

    await expect(client("https://supplier.test/resource", { method: "POST", body: "{\"name\":\"axios\"}" }).then((response) => response.json()))
      .resolves.toEqual({ value: 1 });
    await expect(client("https://supplier.test/resource", { method: "POST", body: "{\"name\":\"axios\"}" }).then((response) => response.json()))
      .resolves.toEqual({ value: 1 });
    expect(calls).toBe(1);
  });

  it("refreshes entries after their TTL expires", async () => {
    const directory = await cacheDirectory();
    let now = 1_000;
    let calls = 0;
    const client = withCache(async () => jsonResponse({ value: ++calls }), {
      dir: directory,
      ttlSeconds: 10,
      now: () => now,
    });

    await client("https://supplier.test/resource");
    now += 10_001;
    await expect(client("https://supplier.test/resource").then((response) => response.json()))
      .resolves.toEqual({ value: 2 });
    expect(calls).toBe(2);
  });

  it("uses a short TTL only for OSV security requests", async () => {
    const directory = await cacheDirectory();
    let now = 1_000;
    const calls = new Map<string, number>();
    const client = withCache(async (url) => {
      const call = (calls.get(url) ?? 0) + 1;
      calls.set(url, call);
      return jsonResponse({ url, call });
    }, {
      dir: directory,
      ttlSeconds: 3_600,
      securityTtlSeconds: 300,
      now: () => now,
    });
    const osvUrl = "https://api.osv.dev/v1/query";
    const supplierUrl = "https://registry.npmjs.org/-/v1/search?text=axios";

    await client(osvUrl, { method: "POST", body: "{}" });
    await client(supplierUrl);
    now += 300_001;

    await expect(client(osvUrl, { method: "POST", body: "{}" }).then((response) => response.json()))
      .resolves.toEqual({ url: osvUrl, call: 2 });
    await expect(client(supplierUrl).then((response) => response.json()))
      .resolves.toEqual({ url: supplierUrl, call: 1 });
    expect(calls).toEqual(new Map([[osvUrl, 2], [supplierUrl, 1]]));
  });

  it("classifies OSV URLs as security-sensitive", () => {
    expect(cacheCategoryFor("https://api.osv.dev/v1/query")).toBe("security");
    expect(cacheCategoryFor("https://registry.npmjs.org/-/v1/search")).toBe("default");
    expect(cacheCategoryFor("not a URL")).toBe("default");
  });

  it("keeps requests with moved newlines, methods, and bodies in distinct entries", async () => {
    const directory = await cacheDirectory();
    let calls = 0;
    const client = withCache(async () => jsonResponse({ value: ++calls }), { dir: directory });
    const newlineInUrl = "https://supplier.test/\nPOST";
    const normalUrl = "https://supplier.test/";

    await expect(client(newlineInUrl, { method: "GET", body: "body" }).then((response) => response.json()))
      .resolves.toEqual({ value: 1 });
    await expect(client(normalUrl, { method: "GET", body: "POST\nbody" }).then((response) => response.json()))
      .resolves.toEqual({ value: 2 });
    await expect(client(normalUrl, { method: "POST", body: "POST\nbody" }).then((response) => response.json()))
      .resolves.toEqual({ value: 3 });
    await expect(client(normalUrl, { method: "GET", body: "different" }).then((response) => response.json()))
      .resolves.toEqual({ value: 4 });
    await expect(client(newlineInUrl, { method: "GET", body: "body" }).then((response) => response.json()))
      .resolves.toEqual({ value: 1 });
    expect(calls).toBe(4);
  });

  it("bypasses the cache for non-serializable request bodies", async () => {
    const directory = await cacheDirectory();
    let calls = 0;
    const client = withCache(async () => jsonResponse({ value: ++calls }), { dir: directory });
    const body = new FormData();
    body.append("package", "axios");

    await expect(client("https://supplier.test/upload", { method: "POST", body }).then((response) => response.json()))
      .resolves.toEqual({ value: 1 });
    await expect(client("https://supplier.test/upload", { method: "POST", body }).then((response) => response.json()))
      .resolves.toEqual({ value: 2 });
    expect(calls).toBe(2);
  });

  it.each([429, 500])("does not cache %i responses", async (status) => {
    const directory = await cacheDirectory();
    let calls = 0;
    const client = withCache(async () => jsonResponse({ call: ++calls }, status), { dir: directory });

    await client("https://supplier.test/resource");
    await client("https://supplier.test/resource");
    expect(calls).toBe(2);
  });

  it("treats a corrupt cache file as a miss", async () => {
    const directory = await cacheDirectory();
    const url = "https://supplier.test/resource";
    let calls = 0;
    const client = withCache(async () => jsonResponse({ value: ++calls }), { dir: directory });

    await client(url);
    const [file] = await readdir(directory);
    await writeFile(join(directory, file!), "not json", "utf8");
    await expect(client(url).then((response) => response.json())).resolves.toEqual({ value: 2 });
    expect(calls).toBe(2);
  });
});
