import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpClient, HttpResponse } from "./client.js";
import { withCache } from "./cache.js";

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
    const key = createHash("sha256").update(`GET\n${url}\n`).digest("hex");
    await writeFile(join(directory, `${key}.json`), "not json", "utf8");
    let calls = 0;
    const client = withCache(async () => jsonResponse({ value: ++calls }), { dir: directory });

    await expect(client(url).then((response) => response.json())).resolves.toEqual({ value: 1 });
    expect(calls).toBe(1);
  });
});
