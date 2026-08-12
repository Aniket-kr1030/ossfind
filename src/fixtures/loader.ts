import { readFile, readdir } from "node:fs/promises";

/**
 * Minimal, supplier-shaped representations of the frozen API responses.
 * These deliberately remain separate from the application's normalized contracts.
 */
export interface EcosystemsPackageFixture {
  name: string;
  ecosystem: string;
  description: string | null;
  homepage: string | null;
  normalized_licenses: string[] | null;
  repository_url: string | null;
  latest_release_number: string | null;
  latest_release_published_at: string | null;
  downloads?: number | null;
  metadata?: Record<string, unknown> | null;
  repo_metadata?: {
    stargazers_count?: number | null;
    archived?: boolean | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export interface DepsDevPackageKey {
  system: string;
  name: string;
}

export interface DepsDevVersion {
  versionKey: DepsDevPackageKey & { version: string };
  publishedAt: string;
  isDefault: boolean;
  isDeprecated: boolean;
  deprecatedReason?: string;
  [key: string]: unknown;
}

export interface DepsDevPackageFixture {
  packageKey: DepsDevPackageKey;
  versions: DepsDevVersion[];
  [key: string]: unknown;
}

export interface ScorecardCheckFixture {
  name: string;
  score: number;
  reason: string;
  details: string[];
  documentation?: {
    shortDescription?: string;
    url?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ScorecardProjectFixture {
  projectKey: Record<string, unknown>;
  openIssuesCount: number;
  starsCount: number;
  forksCount: number;
  license: string;
  description: string;
  homepage: string;
  scorecard: {
    overallScore: number;
    checks: ScorecardCheckFixture[];
    date: string;
    metadata?: Record<string, unknown>;
    repository?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ScorecardErrorFixture {
  __error: number;
}

export type ScorecardFixture = ScorecardProjectFixture | ScorecardErrorFixture;

export interface OsvVulnerabilityFixture {
  id: string;
  summary?: string;
  severity?: Array<{ type: string; score: string }>;
  affected?: Array<{
    ranges?: Array<{
      type: string;
      events: Array<{ introduced?: string; fixed?: string; last_affected?: string }>;
    }>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface OsvFixture {
  vulns?: OsvVulnerabilityFixture[];
  [key: string]: unknown;
}

export interface NpmSearchPackageFixture {
  name: string;
  description?: string;
  version?: string;
  date?: string;
  links?: {
    homepage?: string;
    repository?: string;
    [key: string]: string | undefined;
  };
  [key: string]: unknown;
}

export interface NpmSearchFixture {
  objects: Array<{
    package: NpmSearchPackageFixture;
    downloads?: { monthly?: number; weekly?: number };
    score?: { final?: number; detail?: Record<string, number> };
    [key: string]: unknown;
  }>;
  total: number;
  time: string;
  [key: string]: unknown;
}

const rawFixturesDirectory = decodeURIComponent(
  new URL("../../fixtures/raw/", import.meta.url).pathname,
);

function fixtureSegment(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(value)) {
    throw new Error(`Invalid fixture ${label}: ${value}`);
  }

  return value;
}

async function loadJson<T>(supplier: string, name: string): Promise<T> {
  const path = `${rawFixturesDirectory}${supplier}/${name}.json`;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** Load an ecosyste.ms package response from the frozen local fixtures. */
export async function loadEcosystems(
  pkg: string,
): Promise<EcosystemsPackageFixture> {
  return loadJson("ecosystems", fixtureSegment(pkg, "package name"));
}

/** Load a deps.dev package response from the frozen local fixtures. */
export async function loadDepsDev(pkg: string): Promise<DepsDevPackageFixture> {
  return loadJson("depsdev", fixtureSegment(pkg, "package name"));
}

/** Load a deps.dev project/scorecard response from the frozen local fixtures. */
export async function loadScorecard(pkg: string): Promise<ScorecardFixture> {
  return loadJson("scorecard", fixtureSegment(pkg, "package name"));
}

/** Load an OSV vulnerability response from the frozen local fixtures. */
export async function loadOsv(pkg: string): Promise<OsvFixture> {
  return loadJson("osv", fixtureSegment(pkg, "package name"));
}

/** Load an npm registry search response from the frozen local fixtures. */
export async function loadSearch(slug: string): Promise<NpmSearchFixture> {
  return loadJson("search", fixtureSegment(slug, "search slug"));
}

/** Return package fixture names available across the package-oriented suppliers. */
export async function listFixturePackages(): Promise<string[]> {
  const files = await readdir(`${rawFixturesDirectory}ecosystems`, {
    withFileTypes: true,
  });

  return files
    .filter((file) => file.isFile() && file.name.endsWith(".json"))
    .map((file) => file.name.slice(0, -".json".length))
    .sort();
}
