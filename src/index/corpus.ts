import { defaultHttpClient, type HttpClient } from "../http/client.js";

const ECOSYSTEMS_API = "https://packages.ecosyste.ms/api/v1/registries";
const PAGE_SIZE = 100;
const RETRY_ATTEMPTS = 3;
const REQUEST_DELAY_MS = 25;

/** The package metadata retained by the local discovery index. */
export interface IndexRecord {
  ecosystem: string;
  name: string;
  description: string;
  keywords: string[];
  downloads: number;
  repoUrl?: string;
  homepage?: string;
  latestVersion?: string;
}

export interface FetchCorpusOptions {
  /** Package ecosystem, for example `pypi` or `npm`. */
  ecosystem: string;
  /** Maximum number of packages to include. Defaults to `INDEX_MAX` or 50,000. */
  max?: number;
  /** Injectable HTTP boundary so corpus fetches can be tested offline. */
  http?: HttpClient;
}

interface EcosystemsPackage {
  name?: unknown;
  description?: unknown;
  keywords_array?: unknown;
  downloads?: unknown;
  repository_url?: unknown;
  homepage?: unknown;
  latest_release_number?: unknown;
}

function defaultMax(): number {
  const value = Number(process.env.INDEX_MAX);
  return Number.isSafeInteger(value) && value > 0 ? value : 50_000;
}

/** ecosyste.ms names registries by host, not by the ecosystem slug ossfind uses. */
function registryFor(ecosystem: string): string {
  if (ecosystem === "pypi") return "pypi.org";
  if (ecosystem === "npm") return "npmjs.org";
  if (ecosystem === "cargo") return "crates.io";
  if (ecosystem === "rubygems") return "rubygems.org";
  return ecosystem;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function downloadsValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function indexRecordFrom(value: unknown, ecosystem: string): IndexRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as EcosystemsPackage;
  const name = stringValue(record.name);
  if (!name) return undefined;

  return {
    ecosystem,
    name,
    description: stringValue(record.description) ?? "",
    keywords: stringArray(record.keywords_array),
    downloads: downloadsValue(record.downloads),
    repoUrl: stringValue(record.repository_url),
    homepage: stringValue(record.homepage),
    latestVersion: stringValue(record.latest_release_number),
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchPage(http: HttpClient, url: string): Promise<unknown[] | undefined> {
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await http(url);
      if (response.ok) {
        const payload = await response.json();
        return Array.isArray(payload) ? payload : [];
      }
      if (response.status !== 429) return undefined;
    } catch {
      return undefined;
    }

    if (attempt + 1 < RETRY_ATTEMPTS) {
      await sleep(REQUEST_DELAY_MS * (2 ** attempt));
    }
  }

  return undefined;
}

/**
 * Fetches the download-ranked package corpus from ecosyste.ms, one small page
 * at a time. A malformed response or non-rate-limit failure ends the fetch and
 * preserves records already collected, allowing a later refresh to resume with
 * a clean rebuild.
 */
export async function fetchCorpus(options: FetchCorpusOptions): Promise<IndexRecord[]> {
  const ecosystem = options.ecosystem.trim();
  if (!ecosystem) throw new Error("ecosystem must not be empty");

  const max = options.max ?? defaultMax();
  if (!Number.isFinite(max) || max <= 0) return [];
  const limit = Math.floor(max);
  const http = options.http ?? defaultHttpClient;
  const registry = registryFor(ecosystem);
  const records: IndexRecord[] = [];

  for (let page = 1; records.length < limit; page += 1) {
    const url = new URL(`${ECOSYSTEMS_API}/${encodeURIComponent(registry)}/packages`);
    url.searchParams.set("sort", "downloads");
    url.searchParams.set("order", "desc");
    url.searchParams.set("per_page", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));

    const payload = await fetchPage(http, url.toString());
    if (!payload || payload.length === 0) break;

    for (const item of payload) {
      const record = indexRecordFrom(item, ecosystem);
      if (record) records.push(record);
      if (records.length === limit) break;
    }

    // Do not issue the next request in a tight loop when building a large corpus.
    if (records.length < limit) await sleep(REQUEST_DELAY_MS);
  }

  return records;
}
