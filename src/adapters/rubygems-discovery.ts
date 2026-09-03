import {
  ComponentCandidateSchema,
  type ComponentCandidate,
} from "../contracts/index.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";
import type { Discoverer } from "../pipeline/interfaces.js";

const RUBYGEMS_SEARCH_URL = "https://rubygems.org/api/v1/search.json";

export interface RubyGemsDiscovererOptions {
  attempts?: number;
}

interface RubyGemsSearchResult {
  name?: unknown;
  info?: unknown;
  downloads?: unknown;
  version?: unknown;
  licenses?: unknown;
  source_code_uri?: unknown;
  homepage_uri?: unknown;
  project_uri?: unknown;
  documentation_uri?: unknown;
  metadata?: Record<string, unknown> | null;
  keywords?: unknown;
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

function licenseHintFromGem(licenses: unknown): string | undefined {
  if (!Array.isArray(licenses)) return undefined;
  const validLicenses = licenses
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  if (validLicenses.length === 0) return undefined;
  if (validLicenses.length === 1) return validLicenses[0];
  return validLicenses.join(" OR ");
}

function repoUrlFromGem(gem: RubyGemsSearchResult): string | undefined {
  const sourceCode = stringValue(gem.source_code_uri)
    ?? (gem.metadata && typeof gem.metadata === "object" ? stringValue(gem.metadata.source_code_uri) : undefined);
  const homepage = stringValue(gem.homepage_uri)
    ?? (gem.metadata && typeof gem.metadata === "object" ? stringValue(gem.metadata.homepage_uri) : undefined);
  return normalizeUrl(sourceCode) ?? normalizeUrl(homepage);
}

function homepageUrlFromGem(gem: RubyGemsSearchResult): string | undefined {
  const homepage = stringValue(gem.homepage_uri)
    ?? (gem.metadata && typeof gem.metadata === "object" ? stringValue(gem.metadata.homepage_uri) : undefined);
  const project = stringValue(gem.project_uri);
  return normalizeUrl(homepage) ?? normalizeUrl(project);
}

function candidateFromGem(gem: RubyGemsSearchResult): ComponentCandidate | undefined {
  const name = stringValue(gem.name);
  if (!name) return undefined;

  const keywords = stringArray(gem.keywords)
    ?? (gem.metadata && typeof gem.metadata === "object" ? stringArray(gem.metadata.keywords) : undefined);

  const license = licenseHintFromGem(gem.licenses);

  try {
    return ComponentCandidateSchema.parse({
      id: `rubygems:${name}`,
      name,
      ecosystem: "rubygems",
      description: stringValue(gem.info) ?? "",
      repoUrl: repoUrlFromGem(gem),
      homepage: homepageUrlFromGem(gem),
      keywords,
      latestVersion: stringValue(gem.version),
      downloads: nonnegativeNumber(gem.downloads),
      ...(license ? { license } : {}),
    });
  } catch {
    return undefined;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Discovers Ruby gems through the RubyGems search API. */
export class RubyGemsDiscoverer implements Discoverer {
  private readonly cache = new Map<string, Promise<ComponentCandidate[]>>();
  private readonly attempts: number;

  constructor(
    private readonly http: HttpClient = defaultHttpClient,
    optionsOrAttempts: RubyGemsDiscovererOptions | number = 3,
  ) {
    if (typeof optionsOrAttempts === "number") {
      this.attempts = optionsOrAttempts;
    } else {
      this.attempts = optionsOrAttempts.attempts ?? 3;
    }
  }

  discover(query: string): Promise<ComponentCandidate[]> {
    const cached = this.cache.get(query);
    if (cached) return cached;

    const discovery = this.fetchCandidates(query);
    this.cache.set(query, discovery);
    return discovery;
  }

  private async fetchCandidates(query: string): Promise<ComponentCandidate[]> {
    const url = new URL(RUBYGEMS_SEARCH_URL);
    url.searchParams.set("query", query);

    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      try {
        const response = await this.http(url.toString());
        if (!response.ok) {
          if (attempt + 1 < this.attempts) await sleep(10 * (attempt + 1));
          continue;
        }

        const payload = await response.json() as unknown;
        return Array.isArray(payload)
          ? payload.flatMap((gem) => {
            const candidate = gem && typeof gem === "object"
              ? candidateFromGem(gem as RubyGemsSearchResult)
              : undefined;
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
