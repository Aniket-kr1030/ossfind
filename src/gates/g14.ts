import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiSurfaceExtractor } from "../api/surface.js";
import { withCache, type CacheOptions } from "../http/cache.js";
import type { HttpClient, HttpResponse } from "../http/client.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import type { Result } from "./types.js";

export const id = "G14";
export const description = "Cache preserves response bodies";

type CacheFactory = (inner: HttpClient, options?: CacheOptions) => HttpClient;

async function cacheDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ossfind-g14-"));
}

function textResponse(body: string): HttpResponse {
  return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
}

export async function hasCacheBodyPreservationFact(cache: CacheFactory = withCache): Promise<boolean> {
  const directory = await cacheDirectory();
  try {
    const declaration = 'export declare const caf\u00e9: "ready";\r\n';
    const document = '{"name":"axios","exports":63}';
    let calls = 0;
    const inner: HttpClient = async (url) => {
      calls += 1;
      return textResponse(url.endsWith(".d.ts") ? declaration : document);
    };
    const client = cache(inner, { dir: directory });

    const firstText = await (await client("https://gate.test/index.d.ts")).text?.();
    const secondText = await (await client("https://gate.test/index.d.ts")).text?.();
    const firstJson = await (await client("https://gate.test/document.json")).json();
    const secondJson = await (await client("https://gate.test/document.json")).json();
    if (firstText !== declaration || secondText !== declaration
      || JSON.stringify(firstJson) !== document || JSON.stringify(secondJson) !== document || calls !== 2) {
      return false;
    }

    const raw = new ApiSurfaceExtractor(createFixtureHttpClient());
    const cached = new ApiSurfaceExtractor(cache(createFixtureHttpClient(), { dir: directory }));
    const rawSurface = await raw.extract("axios");
    const firstCachedSurface = await cached.extract("axios");
    const secondCachedSurface = await cached.extract("axios");
    return rawSurface.exports.length === 63
      && firstCachedSurface.exports.length === rawSurface.exports.length
      && secondCachedSurface.exports.length === rawSurface.exports.length;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Mutant that removes text() only after withCache has reconstructed a hit. */
function cacheWithoutReconstructedText(inner: HttpClient, options?: CacheOptions): HttpClient {
  const cached = withCache(inner, options);
  const warmed = new Set<string>();
  return async (url, init) => {
    const response = await cached(url, init);
    const key = `${init?.method ?? "GET"} ${url}`;
    if (warmed.has(key) && url.startsWith("https://cdn.jsdelivr.net/")) {
      return { ok: response.ok, status: response.status, json: response.json, headers: response.headers };
    }
    warmed.add(key);
    return response;
  };
}

export async function check(): Promise<Result> {
  try {
    return await hasCacheBodyPreservationFact()
      ? { status: "pass" }
      : { status: "fail", message: "Cached text or JSON response bodies did not round-trip" };
  } catch (error: unknown) {
    return { status: "fail", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function proveFailure(): Promise<Result> {
  try {
    return !(await hasCacheBodyPreservationFact(cacheWithoutReconstructedText))
      ? { status: "detected" }
      : { status: "undetected", message: "G14 did not detect cached responses with text() removed" };
  } catch (error: unknown) {
    return { status: "detected", message: error instanceof Error ? error.message : String(error) };
  }
}
