import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HttpClient, HttpResponse } from "./client.js";

export interface CacheOptions {
  /** Directory containing one JSON file per cached HTTP response. */
  dir?: string;
  /** How long a non-security entry remains usable, in seconds. */
  ttlSeconds?: number;
  /** How long an OSV/vulnerability entry remains usable, in seconds. */
  securityTtlSeconds?: number;
  /** Injectable wall clock, primarily for deterministic expiry tests. */
  now?: () => number;
}

export type CacheCategory = "default" | "security";

interface CacheEntry {
  cachedAt: number;
  ok: boolean;
  status: number;
  body: unknown;
}

function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

type CacheableBody =
  | { type: "empty" }
  | { type: "string"; value: string }
  | { type: "url-search-params"; value: string }
  | { type: "json"; value: string };

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Return a stable representation only when examining the body cannot consume
 * it and its serialisation is unambiguous. Other body shapes are passed to the
 * supplier directly, rather than risking a cache hit for a different request.
 */
function requestBody(body: RequestInit["body"] | undefined): CacheableBody | undefined {
  if (body === undefined || body === null) return { type: "empty" };
  if (typeof body === "string") return { type: "string", value: body };
  if (body instanceof URLSearchParams) return { type: "url-search-params", value: body.toString() };
  if (typeof body === "object" && isPlainObject(body)) {
    try {
      const value = JSON.stringify(body);
      return value === undefined ? undefined : { type: "json", value };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function keyFor(url: string, init: RequestInit | undefined): string | undefined {
  const method = init?.method?.toUpperCase() ?? "GET";
  const body = requestBody(init?.body);
  if (!body) return undefined;
  return createHash("sha256").update(JSON.stringify([method, url, body])).digest("hex");
}

/** Classifies security-sensitive OSV traffic so it can use a shorter TTL. */
export function cacheCategoryFor(url: string): CacheCategory {
  try {
    return new URL(url).hostname === "api.osv.dev" ? "security" : "default";
  } catch {
    return "default";
  }
}

function responseFrom(entry: CacheEntry): HttpResponse {
  return {
    ok: entry.ok,
    status: entry.status,
    json: async () => entry.body,
  };
}

async function loadEntry(path: string): Promise<CacheEntry | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !parsed || typeof parsed !== "object"
      || !("cachedAt" in parsed) || typeof parsed.cachedAt !== "number"
      || !("ok" in parsed) || typeof parsed.ok !== "boolean"
      || !("status" in parsed) || typeof parsed.status !== "number"
      || !("body" in parsed)
    ) return undefined;
    return parsed as CacheEntry;
  } catch {
    return undefined;
  }
}

async function saveEntry(path: string, entry: CacheEntry): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, JSON.stringify(entry), "utf8");
    await rename(temporary, path);
  } catch {
    // Caching is an optimisation: failures must not change supplier behavior.
  }
}

/**
 * Adds a persistent JSON-response cache to an HTTP client. Cache failures and
 * corrupt entries are treated as misses so live discovery remains resilient.
 */
export function withCache(inner: HttpClient, options: CacheOptions = {}): HttpClient {
  const dir = options.dir ?? process.env.OSSFIND_CACHE_DIR ?? ".cache/http";
  const ttlSeconds = options.ttlSeconds ?? envNumber(process.env.OSSFIND_CACHE_TTL, 3600);
  const securityTtlSeconds = options.securityTtlSeconds
    ?? envNumber(process.env.OSSFIND_SECURITY_TTL, 300);
  const now = options.now ?? Date.now;

  return async (url, init) => {
    const key = keyFor(url, init);
    if (!key) return inner(url, init);

    const path = join(dir, `${key}.json`);
    const cached = await loadEntry(path);
    const ttl = cacheCategoryFor(url) === "security" ? securityTtlSeconds : ttlSeconds;
    if (cached && now() - cached.cachedAt < ttl * 1_000) {
      return responseFrom(cached);
    }

    const response = await inner(url, init);
    if (response.ok) {
      const body = await response.json();
      const entry = { cachedAt: now(), ok: response.ok, status: response.status, body };
      await saveEntry(path, entry);
      return responseFrom(entry);
    }
    return response;
  };
}
