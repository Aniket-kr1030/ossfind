import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HttpClient, HttpResponse } from "./client.js";

export interface CacheOptions {
  /** Directory containing one JSON file per cached HTTP response. */
  dir?: string;
  /** How long an entry remains usable, in seconds. */
  ttlSeconds?: number;
  /** Injectable wall clock, primarily for deterministic expiry tests. */
  now?: () => number;
}

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

function requestBody(body: RequestInit["body"] | undefined): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("base64");
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("base64");
  }

  // Live adapters currently submit JSON strings. Keep a deterministic fallback
  // for other body shapes without consuming a potentially one-shot stream.
  return String(body);
}

function keyFor(url: string, init: RequestInit | undefined): string {
  const method = init?.method?.toUpperCase() ?? "GET";
  const body = requestBody(init?.body);
  return createHash("sha256").update(`${method}\n${url}\n${body}`).digest("hex");
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
  const now = options.now ?? Date.now;

  return async (url, init) => {
    const path = join(dir, `${keyFor(url, init)}.json`);
    const cached = await loadEntry(path);
    if (cached && now() - cached.cachedAt < ttlSeconds * 1_000) {
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
