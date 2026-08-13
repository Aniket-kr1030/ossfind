import {
  ComponentCandidateSchema,
  type ComponentCandidate,
} from "../contracts/index.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";
import type { Discoverer } from "../pipeline/interfaces.js";

const GITHUB_REPOSITORY_SEARCH_URL = "https://api.github.com/search/repositories";

export interface GitHubDiscovererOptions {
  size?: number;
  /** Explicit override for tests; production falls back to GITHUB_TOKEN. */
  token?: string;
}

interface GitHubRepository {
  full_name?: unknown;
  description?: unknown;
  html_url?: unknown;
  homepage?: unknown;
  stargazers_count?: unknown;
  topics?: unknown;
  archived?: unknown;
  license?: { spdx_id?: unknown } | null;
}

interface GitHubSearchResponse {
  items?: unknown;
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

function candidateFromRepository(repository: GitHubRepository): ComponentCandidate | undefined {
  const fullName = stringValue(repository.full_name);
  if (!fullName) return undefined;

  try {
    return ComponentCandidateSchema.parse({
      id: `github:${fullName}`,
      name: fullName,
      ecosystem: "github",
      description: stringValue(repository.description) ?? "",
      repoUrl: validUrl(repository.html_url),
      homepage: validUrl(repository.homepage),
      stars: nonnegativeNumber(repository.stargazers_count),
      keywords: stringArray(repository.topics),
      license: stringValue(repository.license?.spdx_id),
      ...(typeof repository.archived === "boolean" ? { archived: repository.archived } : {}),
    });
  } catch {
    return undefined;
  }
}

/** Discovers GitHub repositories through GitHub's public repository search API. */
export class GitHubDiscoverer implements Discoverer {
  private readonly cache = new Map<string, Promise<ComponentCandidate[]>>();
  private readonly size: number;
  private readonly token: string | undefined;

  constructor(
    private readonly http: HttpClient = defaultHttpClient,
    options: GitHubDiscovererOptions = {},
  ) {
    this.size = options.size ?? 20;
    this.token = options.token ?? process.env.GITHUB_TOKEN;
  }

  discover(query: string): Promise<ComponentCandidate[]> {
    const cached = this.cache.get(query);
    if (cached) return cached;

    const discovery = this.fetchCandidates(query);
    this.cache.set(query, discovery);
    return discovery;
  }

  private async fetchCandidates(query: string): Promise<ComponentCandidate[]> {
    const url = new URL(GITHUB_REPOSITORY_SEARCH_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("sort", "stars");
    url.searchParams.set("order", "desc");
    url.searchParams.set("per_page", String(this.size));

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    try {
      // A non-2xx response (including GitHub's rate-limit response) is a
      // deliberately quiet, empty result: callers can continue with other
      // discovery sources without retrying and amplifying the limit.
      const response = await this.http(url.toString(), { headers });
      if (!response.ok) return [];

      const payload = await response.json() as GitHubSearchResponse;
      return Array.isArray(payload.items)
        ? payload.items.flatMap((item) => {
          const candidate = item && typeof item === "object"
            ? candidateFromRepository(item as GitHubRepository)
            : undefined;
          return candidate ? [candidate] : [];
        })
        : [];
    } catch {
      return [];
    }
  }
}
