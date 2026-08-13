import {
  ComponentCandidateSchema,
  type ComponentCandidate,
} from "../contracts/index.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";
import type { Discoverer } from "../pipeline/interfaces.js";

const LIBRARIES_IO_SEARCH_URL = "https://libraries.io/api/search";

export interface LibrariesIoDiscovererOptions {
  size?: number;
  /** Explicit override used by the offline fixture boundary. */
  apiKey?: string;
  warn?: (message: string) => void;
}

interface LibrariesIoSearchResult {
  name?: unknown;
  description?: unknown;
  repository_url?: unknown;
  homepage?: unknown;
  latest_release_number?: unknown;
  stars?: unknown;
  keywords?: unknown;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function validUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;

  try {
    new URL(raw);
    return raw;
  } catch {
    return undefined;
  }
}

function candidateFromResult(result: LibrariesIoSearchResult): ComponentCandidate | undefined {
  const name = stringValue(result.name);
  if (!name) return undefined;

  try {
    return ComponentCandidateSchema.parse({
      id: `pypi:${name}`,
      name,
      ecosystem: "pypi",
      description: stringValue(result.description) ?? "",
      repoUrl: validUrl(result.repository_url),
      homepage: validUrl(result.homepage),
      keywords: stringArray(result.keywords),
      latestVersion: stringValue(result.latest_release_number),
      stars: nonnegativeNumber(result.stars),
    });
  } catch {
    return undefined;
  }
}

/** Discovers PyPI packages through the Libraries.io search API. */
export class LibrariesIoDiscoverer implements Discoverer {
  private readonly cache = new Map<string, Promise<ComponentCandidate[]>>();
  private readonly apiKey: string | undefined;
  private readonly size: number;
  private readonly warn: (message: string) => void;
  private missingKeyWarned = false;

  constructor(
    private readonly http: HttpClient = defaultHttpClient,
    options: LibrariesIoDiscovererOptions = {},
  ) {
    this.size = options.size ?? 20;
    this.apiKey = options.apiKey
      ?? process.env.LIBRARIES_IO_API_KEY
      ?? process.env.LIBRARY_IO_API_KEY;
    this.warn = options.warn ?? console.warn;
  }

  discover(query: string): Promise<ComponentCandidate[]> {
    const cached = this.cache.get(query);
    if (cached) return cached;

    const discovery = this.fetchCandidates(query);
    this.cache.set(query, discovery);
    return discovery;
  }

  private async fetchCandidates(query: string): Promise<ComponentCandidate[]> {
    if (!this.apiKey) {
      if (!this.missingKeyWarned) {
        this.missingKeyWarned = true;
        this.warn("[ossfind] libraries.io discovery unavailable: no API key configured.");
      }
      return [];
    }

    const url = new URL(LIBRARIES_IO_SEARCH_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("platforms", "Pypi");
    url.searchParams.set("per_page", String(this.size));
    // This URL is never logged: it contains the runtime-only API key.
    url.searchParams.set("api_key", this.apiKey);

    try {
      const response = await this.http(url.toString());
      if (!response.ok) return [];

      const payload = await response.json() as unknown;
      return Array.isArray(payload)
        ? payload.flatMap((result) => {
          const candidate = result && typeof result === "object"
            ? candidateFromResult(result as LibrariesIoSearchResult)
            : undefined;
          return candidate ? [candidate] : [];
        })
        : [];
    } catch {
      return [];
    }
  }
}
