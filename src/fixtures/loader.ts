import { readFile, readdir } from "node:fs/promises";

export type FixtureEcosystem = "npm" | "pypi";

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

export interface GitHubSearchFixture {
  total_count: number;
  items: unknown[];
  [key: string]: unknown;
}

/** Frozen Hugging Face model-search response. */
export interface HuggingFaceSearchFixture {
  [index: number]: unknown;
  length: number;
}

/** Minimal npm registry document used by the API-surface extractor. */
export interface ApiRegistryFixture {
  name: string;
  version: string;
  types?: string;
  typings?: string;
  [key: string]: unknown;
}

/** jsDelivr's flat package listing, reduced to the fields the extractor reads. */
export interface ApiListingFixture {
  files: Array<{ name: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** Capture metadata accompanying a declaration-file fixture. */
export interface ApiDtsMetadataFixture {
  package: string;
  version: string;
  path: string | null;
  truncated?: boolean;
  note?: string;
  __error?: number;
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

function fixtureDirectory(ecosystem: FixtureEcosystem): string {
  return ecosystem === "pypi" ? `${rawFixturesDirectory}pypi/` : rawFixturesDirectory;
}

function githubFixturePath(supplier: "search" | "scorecard", name: string): string {
  return `${rawFixturesDirectory}github/${supplier}/${name}.json`;
}

function huggingFaceFixturePath(name: string): string {
  return `${rawFixturesDirectory}huggingface/search/${name}.json`;
}

async function loadJson<T>(supplier: string, name: string, ecosystem: FixtureEcosystem = "npm"): Promise<T> {
  const path = `${fixtureDirectory(ecosystem)}${supplier}/${name}.json`;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function apiFixtureSlug(packageName: string): string {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)) {
    throw new Error(`Invalid API fixture package name: ${packageName}`);
  }
  return packageName.replace("/", "__");
}

function apiFixturePath(kind: "registry" | "listing" | "dts", packageName: string, extension: ".json" | ".meta.json" | ".d.ts"): string {
  return `${rawFixturesDirectory}api/${kind}/${apiFixtureSlug(packageName)}${extension}`;
}

/** Load the frozen npm registry latest-document used by API-surface tests. */
export async function loadApiRegistry(packageName: string): Promise<ApiRegistryFixture> {
  return JSON.parse(await readFile(apiFixturePath("registry", packageName, ".json"), "utf8")) as ApiRegistryFixture;
}

/** Load the frozen jsDelivr flat listing used by API-surface tests. */
export async function loadApiListing(packageName: string): Promise<ApiListingFixture> {
  return JSON.parse(await readFile(apiFixturePath("listing", packageName, ".json"), "utf8")) as ApiListingFixture;
}

/** Load declaration content and its capture metadata for a package. */
export async function loadApiDts(packageName: string): Promise<{ content: string; metadata: ApiDtsMetadataFixture }> {
  const [content, metadata] = await Promise.all([
    readFile(apiFixturePath("dts", packageName, ".d.ts"), "utf8"),
    readFile(apiFixturePath("dts", packageName, ".meta.json"), "utf8"),
  ]);
  return { content, metadata: JSON.parse(metadata) as ApiDtsMetadataFixture };
}

/** Load a captured declaration reached through a relative declaration re-export. */
export async function loadApiReexportDts(packageName: string, path: string): Promise<string> {
  const cleanPath = path.replace(/^\.\//, "");
  if (!/^[a-z0-9@._/-]+$/i.test(cleanPath) || cleanPath.includes("..")) {
    throw new Error(`Invalid API re-export declaration path: ${path}`);
  }
  const filename = `${apiFixtureSlug(packageName)}__${cleanPath.replace(/\//g, "__")}.d.ts`;
  return readFile(`${rawFixturesDirectory}api/dts/${filename}`, "utf8");
}

/** Load an ecosyste.ms package response from the frozen local fixtures. */
export async function loadEcosystems(
  pkg: string,
  ecosystem: FixtureEcosystem = "npm",
): Promise<EcosystemsPackageFixture> {
  return loadJson("ecosystems", fixtureSegment(pkg, "package name"), ecosystem);
}

/** Load a deps.dev package response from the frozen local fixtures. */
export async function loadDepsDev(pkg: string, ecosystem: FixtureEcosystem = "npm"): Promise<DepsDevPackageFixture> {
  return loadJson("depsdev", fixtureSegment(pkg, "package name"), ecosystem);
}

/** Load a deps.dev project/scorecard response from the frozen local fixtures. */
export async function loadScorecard(pkg: string, ecosystem: FixtureEcosystem = "npm"): Promise<ScorecardFixture> {
  return loadJson("scorecard", fixtureSegment(pkg, "package name"), ecosystem);
}

/** Load an OSV vulnerability response from the frozen local fixtures. */
export async function loadOsv(pkg: string, ecosystem: FixtureEcosystem = "npm"): Promise<OsvFixture> {
  return loadJson("osv", fixtureSegment(pkg, "package name"), ecosystem);
}

/** Load an npm registry search response from the frozen local fixtures. */
export async function loadSearch(slug: string, ecosystem: FixtureEcosystem = "npm"): Promise<NpmSearchFixture> {
  return loadJson("search", fixtureSegment(slug, "search slug"), ecosystem);
}

/** Load a frozen GitHub repository-search response. */
export async function loadGitHubSearch(slug: string): Promise<GitHubSearchFixture> {
  return JSON.parse(await readFile(
    githubFixturePath("search", fixtureSegment(slug, "GitHub search slug")),
    "utf8",
  )) as GitHubSearchFixture;
}

/** Load a frozen Hugging Face model-search response. */
export async function loadHuggingFaceSearch(slug: string): Promise<HuggingFaceSearchFixture> {
  return JSON.parse(await readFile(
    huggingFaceFixturePath(fixtureSegment(slug, "Hugging Face search slug")),
    "utf8",
  )) as HuggingFaceSearchFixture;
}

/** Load a frozen deps.dev project/scorecard response for a GitHub repository. */
export async function loadGitHubScorecard(owner: string, repository: string): Promise<ScorecardFixture> {
  const fixtureName = `${fixtureSegment(owner, "GitHub owner")}__${fixtureSegment(repository, "GitHub repository")}`;
  return JSON.parse(await readFile(githubFixturePath("scorecard", fixtureName), "utf8")) as ScorecardFixture;
}

/** Return package fixture names available across the package-oriented suppliers. */
export async function listFixturePackages(ecosystem: FixtureEcosystem = "npm"): Promise<string[]> {
  const files = await readdir(`${fixtureDirectory(ecosystem)}ecosystems`, {
    withFileTypes: true,
  });

  return files
    .filter((file) => file.isFile() && file.name.endsWith(".json"))
    .map((file) => file.name.slice(0, -".json".length))
    .sort();
}

export interface PyApiPypiFixture {
  info: {
    name: string;
    version: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PyApiTypeshedMetaFixture {
  package: string;
  distribution?: string;
  importPackage?: string;
  path?: string;
  bytes?: number;
  __error?: number;
  note?: string;
  [key: string]: unknown;
}

/** Load the frozen PyPI package JSON document. */
export async function loadPyApiPypi(packageName: string): Promise<PyApiPypiFixture> {
  const slug = packageName.toLowerCase();
  return JSON.parse(await readFile(`${rawFixturesDirectory}pyapi/pypi/${slug}.json`, "utf8")) as PyApiPypiFixture;
}

/** Load typeshed stub content and its metadata for a package. */
export async function loadPyApiTypeshed(packageName: string): Promise<{ content?: string; metadata: PyApiTypeshedMetaFixture }> {
  const slug = packageName.toLowerCase();
  const meta = JSON.parse(await readFile(`${rawFixturesDirectory}pyapi/typeshed/${slug}.meta.json`, "utf8")) as PyApiTypeshedMetaFixture;
  if (meta.__error === 404) {
    return { metadata: meta };
  }
  const content = await readFile(`${rawFixturesDirectory}pyapi/typeshed/${slug}.pyi`, "utf8");
  return { content, metadata: meta };
}

/** Load a frozen wheel used by the PyPI API-surface extractor. */
export async function loadPyApiWheel(filename: string): Promise<Uint8Array> {
  if (!/^[a-z0-9][a-z0-9._-]*\.whl$/i.test(filename)) {
    throw new Error(`Invalid PyPI wheel fixture filename: ${filename}`);
  }
  return new Uint8Array(await readFile(`${rawFixturesDirectory}pyapi/wheels/${filename}`));
}
