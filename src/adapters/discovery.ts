import {
  ComponentCandidateSchema,
  type ComponentCandidate,
} from "../contracts/index.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";
import type { Discoverer } from "../pipeline/interfaces.js";

const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search";

interface NpmSearchResult {
  package?: {
    name?: unknown;
    description?: unknown;
    version?: unknown;
    date?: unknown;
    links?: {
      homepage?: unknown;
      repository?: unknown;
    };
  };
  downloads?: { monthly?: unknown };
}

interface NpmSearchResponse {
  objects?: NpmSearchResult[];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;

  const normalized = raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
  try {
    return new URL(normalized).toString();
  } catch {
    return undefined;
  }
}

function candidateFromResult(result: NpmSearchResult): ComponentCandidate | undefined {
  const pkg = result.package;
  const name = stringValue(pkg?.name);
  if (!name) return undefined;

  try {
    return ComponentCandidateSchema.parse({
      id: `npm:${name}`,
      name,
      ecosystem: "npm",
      description: stringValue(pkg?.description) ?? "",
      repoUrl: normalizeUrl(pkg?.links?.repository),
      homepage: normalizeUrl(pkg?.links?.homepage),
      downloads: nonnegativeNumber(result.downloads?.monthly),
      latestVersion: stringValue(pkg?.version),
      publishedAt: stringValue(pkg?.date),
    });
  } catch {
    return undefined;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Discovers npm packages through the public registry search endpoint. */
export class HttpDiscoverer implements Discoverer {
  private readonly cache = new Map<string, Promise<ComponentCandidate[]>>();

  constructor(
    private readonly http: HttpClient = defaultHttpClient,
    private readonly size = 20,
    private readonly attempts = 3,
  ) {}

  discover(query: string): Promise<ComponentCandidate[]> {
    const cached = this.cache.get(query);
    if (cached) return cached;

    const discovery = this.fetchCandidates(query);
    this.cache.set(query, discovery);
    return discovery;
  }

  private async fetchCandidates(query: string): Promise<ComponentCandidate[]> {
    const url = new URL(NPM_SEARCH_URL);
    url.searchParams.set("text", query);
    url.searchParams.set("size", String(this.size));

    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      try {
        const response = await this.http(url.toString());
        if (!response.ok) {
          if (attempt + 1 < this.attempts) await sleep(10 * (attempt + 1));
          continue;
        }

        const payload = await response.json() as NpmSearchResponse;
        return Array.isArray(payload.objects)
          ? payload.objects.flatMap((result) => {
            const candidate = candidateFromResult(result);
            return candidate ? [candidate] : [];
          })
          : [];
      } catch {
        if (attempt + 1 < this.attempts) await sleep(10 * (attempt + 1));
      }
    }

    return [];
  }
}
