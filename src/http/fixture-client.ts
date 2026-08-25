import {
  loadApiDts,
  loadApiListing,
  loadApiReexportDts,
  loadApiRegistry,
  type FixtureEcosystem,
  listFixturePackages,
  loadDepsDev,
  loadEcosystems,
  loadGitHubScorecard,
  loadGitHubSearch,
  loadHuggingFaceSearch,
  loadOsv,
  loadScorecard,
  loadSearch,
} from "../fixtures/loader.js";
import type { HttpClient, HttpResponse } from "./client.js";

function response(body: unknown, status = 200): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    // Declaration files are fetched as text by the API-surface extractor.
    // Keep JSON fixtures usable through the existing json() boundary too.
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  };
}

function notFound(): HttpResponse {
  return response({}, 404);
}

function querySlug(url: URL, parameter = "text"): string {
  return (url.searchParams.get(parameter) ?? "").trim().toLowerCase().replace(/\s+/g, "-");
}

function packageFromPath(url: URL, marker: string): string | undefined {
  const index = url.pathname.indexOf(marker);
  return index >= 0 ? decodeURIComponent(url.pathname.slice(index + marker.length)) : undefined;
}

function apiRegistryPackage(url: URL): string | undefined {
  const suffix = "/latest";
  if (!url.pathname.startsWith("/") || !url.pathname.endsWith(suffix)) return undefined;
  const packageName = decodeURIComponent(url.pathname.slice(1, -suffix.length));
  return packageName.includes("/") || packageName.length > 0 ? packageName : undefined;
}

function apiListingPackage(url: URL): string | undefined {
  const prefix = "/v1/package/npm/";
  const suffix = "/flat";
  if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith(suffix)) return undefined;
  const packageAndVersion = decodeURIComponent(url.pathname.slice(prefix.length, -suffix.length));
  const versionMarker = packageAndVersion.lastIndexOf("@");
  return versionMarker > 0 ? packageAndVersion.slice(0, versionMarker) : undefined;
}

function apiDtsRequest(url: URL): { packageName: string; path: string } | undefined {
  const prefix = "/npm/";
  if (!url.pathname.startsWith(prefix)) return undefined;
  const packageVersionAndPath = decodeURIComponent(url.pathname.slice(prefix.length));
  const versionMarker = packageVersionAndPath.lastIndexOf("@");
  if (versionMarker <= 0) return undefined;
  const pathMarker = packageVersionAndPath.indexOf("/", versionMarker);
  if (pathMarker < 0) return undefined;
  return {
    packageName: packageVersionAndPath.slice(0, versionMarker),
    path: packageVersionAndPath.slice(pathMarker + 1).replace(/^\.\//, ""),
  };
}

interface FixtureProject {
  pkg: string;
  ecosystem: FixtureEcosystem;
}

async function fixtureProjectPackages(): Promise<Map<string, FixtureProject>> {
  const projects = new Map<string, FixtureProject>();
  for (const ecosystem of ["npm", "pypi"] as const) {
    for (const pkg of await listFixturePackages(ecosystem)) {
      const fixture = await loadEcosystems(pkg, ecosystem);
    if (!fixture.repository_url) continue;

    try {
      const repository = new URL(fixture.repository_url.replace(/^git\+/, "").replace(/\.git$/, ""));
      if (repository.hostname === "github.com") {
          projects.set(`github.com${repository.pathname.replace(/\/$/, "")}`, { pkg, ecosystem });
      }
    } catch {
      // A malformed fixture repository URL simply cannot supply a scorecard.
    }
    }
  }
  return projects;
}

function ecosystemForRegistry(url: URL): FixtureEcosystem | undefined {
  if (url.pathname.includes("/registries/npmjs.org/")) return "npm";
  if (url.pathname.includes("/registries/pypi.org/")) return "pypi";
  return undefined;
}

function ecosystemForDepsDev(url: URL): FixtureEcosystem | undefined {
  if (url.pathname.includes("/systems/npm/packages/")) return "npm";
  if (url.pathname.includes("/systems/pypi/packages/")) return "pypi";
  return undefined;
}

function ecosystemForOsv(body: unknown): FixtureEcosystem | undefined {
  if (!body || typeof body !== "object" || !("package" in body)) return undefined;
  const pkg = body.package;
  if (!pkg || typeof pkg !== "object" || !("ecosystem" in pkg)) return undefined;
  return pkg.ecosystem === "npm" ? "npm" : pkg.ecosystem === "PyPI" ? "pypi" : undefined;
}

/**
 * Offline HTTP boundary that maps the production supplier URLs used by the
 * adapters to frozen raw fixtures.
 */
export function createFixtureHttpClient(): HttpClient {
  const projects = fixtureProjectPackages();

  return async (requestUrl, init) => {
    try {
      const url = new URL(requestUrl);
      if (url.hostname === "registry.npmjs.org") {
        const packageName = apiRegistryPackage(url);
        if (packageName) return response(await loadApiRegistry(packageName));
      }
      if (url.hostname === "data.jsdelivr.com") {
        const packageName = apiListingPackage(url);
        if (packageName) return response(await loadApiListing(packageName));
      }
      if (url.hostname === "cdn.jsdelivr.net") {
        const request = apiDtsRequest(url);
        if (request) {
          const dts = await loadApiDts(request.packageName);
          if (dts.metadata.path?.replace(/^\.\//, "") === request.path) {
            // The extractor intentionally receives the capture incompleteness
            // marker as source text, matching production's text-only boundary.
            const content = dts.metadata.truncated && !/\/\/\s*\[fixture truncated\]/i.test(dts.content)
              ? `${dts.content}\n// [fixture truncated]\n`
              : dts.content;
            return response(content);
          }
          return response(await loadApiReexportDts(request.packageName, request.path));
        }
      }
      if (url.hostname === "registry.npmjs.org" && url.pathname === "/-/v1/search") {
        return response(await loadSearch(querySlug(url)));
      }
      // libraries.io uses `q`, while its credentials and requested page size are
      // deliberately irrelevant to a frozen, query-keyed fixture response.
      if (url.hostname === "libraries.io" && url.pathname === "/api/search") {
        return response(await loadSearch(querySlug(url, "q"), "pypi"));
      }
      if (url.hostname === "api.github.com" && url.pathname === "/search/repositories") {
        return response(await loadGitHubSearch(querySlug(url, "q")));
      }
      if (url.hostname === "huggingface.co" && url.pathname === "/api/models") {
        return response(await loadHuggingFaceSearch(querySlug(url, "search")));
      }
      if (url.hostname === "packages.ecosyste.ms") {
        const pkg = packageFromPath(url, "/packages/");
        const ecosystem = ecosystemForRegistry(url);
        return pkg && ecosystem ? response(await loadEcosystems(pkg, ecosystem)) : notFound();
      }
      if (url.hostname === "api.deps.dev" && url.pathname.includes("/projects/")) {
        const project = decodeURIComponent(url.pathname.slice("/v3/projects/".length));
        const fixture = (await projects).get(project);
        if (fixture) {
          const scorecard = await loadScorecard(fixture.pkg, fixture.ecosystem);
          return "__error" in scorecard ? response(scorecard, 404) : response(scorecard);
        }
        const githubProject = /^github\.com\/([^/]+)\/([^/]+)$/.exec(project);
        if (githubProject) {
          const scorecard = await loadGitHubScorecard(githubProject[1], githubProject[2]);
          return "__error" in scorecard ? response(scorecard, 404) : response(scorecard);
        }
        return notFound();
      }
      if (url.hostname === "api.deps.dev") {
        const pkg = packageFromPath(url, "/packages/");
        const ecosystem = ecosystemForDepsDev(url);
        return pkg && ecosystem ? response(await loadDepsDev(pkg, ecosystem)) : notFound();
      }
      if (url.hostname === "api.osv.dev" && url.pathname === "/v1/query") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
        const pkg = body && typeof body === "object"
          && "package" in body && body.package && typeof body.package === "object"
          && "name" in body.package && typeof body.package.name === "string"
          ? body.package.name
          : undefined;
        const ecosystem = ecosystemForOsv(body);
        return pkg && ecosystem ? response(await loadOsv(pkg, ecosystem)) : response({}, 400);
      }
    } catch {
      return notFound();
    }

    return notFound();
  };
}
