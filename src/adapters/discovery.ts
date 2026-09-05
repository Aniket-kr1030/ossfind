import {
  ComponentCandidateSchema,
  type ComponentCandidate,
} from "../contracts/index.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";
import { expandDiscovery, type ProbeOutcome } from "../discovery/expand.js";
import type { Discoverer } from "../pipeline/interfaces.js";

const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search";

interface NpmSearchResult {
  package?: {
    name?: unknown;
    description?: unknown;
    keywords?: unknown;
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

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
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
      keywords: stringArray(pkg?.keywords),
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
    private readonly maxProbes = 6,
  ) {}

  discover(query: string): Promise<ComponentCandidate[]> {
    const cached = this.cache.get(query);
    if (cached) return cached;

    const discovery = this.fetchExpanded(query);
    this.cache.set(query, discovery);
    return discovery;
  }

  /**
   * Union the results of several progressively shorter probes; see expand.ts and
   * query-probes.ts for why the query alone under-recalls.
   */
  private fetchExpanded(query: string): Promise<ComponentCandidate[]> {
    return expandDiscovery(query, (text) => this.fetchCandidates(text), {
      sourceName: "npm registry",
      maxProbes: this.maxProbes,
    });
  }

  /**
   * `ok: false` means the registry never answered — every attempt failed. It is
   * deliberately distinct from an empty `candidates` list, which is a real answer.
   */
  private async fetchCandidates(query: string): Promise<ProbeOutcome> {
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
        return {
          ok: true,
          candidates: Array.isArray(payload.objects)
            ? payload.objects.flatMap((result) => {
              const candidate = candidateFromResult(result);
              return candidate ? [candidate] : [];
            })
            : [],
        };
      } catch {
        if (attempt + 1 < this.attempts) await sleep(10 * (attempt + 1));
      }
    }

    return { ok: false };
  }
}
