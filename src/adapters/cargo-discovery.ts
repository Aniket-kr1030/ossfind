import {
  ComponentCandidateSchema,
  type ComponentCandidate,
} from "../contracts/index.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";
import { expandDiscovery, type ProbeOutcome } from "../discovery/expand.js";
import type { Discoverer } from "../pipeline/interfaces.js";

const CARGO_SEARCH_URL = "https://crates.io/api/v1/crates";
const DEFAULT_USER_AGENT = "ossfind (https://github.com/user/ossfind)";

export interface CargoDiscovererOptions {
  size?: number;
  attempts?: number;
  userAgent?: string;
  /** Registry probes issued per search; see discovery/query-probes.ts. */
  maxProbes?: number;
}

interface CargoCrate {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  downloads?: unknown;
  recent_downloads?: unknown;
  repository?: unknown;
  homepage?: unknown;
  documentation?: unknown;
  keywords?: unknown;
  categories?: unknown;
  max_version?: unknown;
  default_version?: unknown;
  yanked?: unknown;
}

interface CargoSearchResponse {
  crates?: CargoCrate[];
  meta?: unknown;
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

function candidateFromCrate(crate: CargoCrate): ComponentCandidate | undefined {
  if (crate.yanked === true) return undefined;

  const name = stringValue(crate.name) ?? stringValue(crate.id);
  if (!name) return undefined;

  const latestVersion = stringValue(crate.max_version) ?? stringValue(crate.default_version);

  try {
    return ComponentCandidateSchema.parse({
      id: `cargo:${name}`,
      name,
      ecosystem: "cargo",
      description: stringValue(crate.description) ?? "",
      keywords: stringArray(crate.keywords),
      repoUrl: normalizeUrl(crate.repository),
      homepage: normalizeUrl(crate.homepage),
      downloads: nonnegativeNumber(crate.downloads),
      latestVersion,
    });
  } catch {
    return undefined;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Discovers Cargo packages through the crates.io search endpoint. */
export class CargoDiscoverer implements Discoverer {
  private readonly cache = new Map<string, Promise<ComponentCandidate[]>>();
  private readonly size: number;
  private readonly attempts: number;
  private readonly userAgent: string;
  private readonly maxProbes: number;

  constructor(
    private readonly http: HttpClient = defaultHttpClient,
    optionsOrSize: CargoDiscovererOptions | number = 20,
    attempts = 3,
  ) {
    if (typeof optionsOrSize === "number") {
      this.size = optionsOrSize;
      this.attempts = attempts;
      this.userAgent = DEFAULT_USER_AGENT;
      this.maxProbes = 6;
    } else {
      this.size = optionsOrSize.size ?? 20;
      this.attempts = optionsOrSize.attempts ?? attempts;
      this.userAgent = optionsOrSize.userAgent ?? DEFAULT_USER_AGENT;
      this.maxProbes = optionsOrSize.maxProbes ?? 6;
    }
  }

  discover(query: string): Promise<ComponentCandidate[]> {
    const cached = this.cache.get(query);
    if (cached) return cached;

    const discovery = expandDiscovery(query, (text) => this.fetchCandidates(text), {
      sourceName: "crates.io",
      maxProbes: this.maxProbes,
    });
    this.cache.set(query, discovery);
    return discovery;
  }

  /**
   * `ok: false` means crates.io never answered, which must stay distinct from an
   * empty result list; see expand.ts.
   */
  private async fetchCandidates(query: string): Promise<ProbeOutcome> {
    const url = new URL(CARGO_SEARCH_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", String(this.size));

    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
    };

    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      try {
        const response = await this.http(url.toString(), { headers });
        if (!response.ok) {
          if (attempt + 1 < this.attempts) await sleep(10 * (attempt + 1));
          continue;
        }

        const payload = await response.json() as CargoSearchResponse;
        return {
          ok: true,
          candidates: Array.isArray(payload.crates)
            ? payload.crates.flatMap((crate) => {
              const candidate = candidateFromCrate(crate);
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
