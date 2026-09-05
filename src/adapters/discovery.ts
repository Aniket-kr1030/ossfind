import {
  ComponentCandidateSchema,
  type ComponentCandidate,
} from "../contracts/index.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";
import { queryProbes } from "../discovery/query-probes.js";
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
   * Union the results of several progressively shorter probes. npm's conjunctive text
   * match drops well-known packages from natural-language queries entirely, so the
   * query alone under-recalls; see query-probes.ts for the measurements.
   *
   * A probe that fails contributes nothing and never fails the search — the same
   * error isolation the federated discoverer applies across sources.
   */
  private async fetchExpanded(query: string): Promise<ComponentCandidate[]> {
    const probes = queryProbes(query, { maxProbes: this.maxProbes });
    if (probes.length === 0) return [];

    const settled = await Promise.all(probes.map(async (probe) => ({
      tier: probe.tier,
      candidates: await this.fetchCandidates(probe.text).catch(() => [] as ComponentCandidate[]),
    })));

    // Earliest probe wins a duplicate: its wording was closer to what the user asked.
    const byId = new Map<string, ComponentCandidate>();
    for (const { candidates } of settled.sort((left, right) => left.tier - right.tier)) {
      for (const candidate of candidates) {
        if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
      }
    }
    return [...byId.values()];
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
