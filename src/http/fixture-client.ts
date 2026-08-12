import {
  listFixturePackages,
  loadDepsDev,
  loadEcosystems,
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
  };
}

function notFound(): HttpResponse {
  return response({}, 404);
}

function querySlug(url: URL): string {
  return (url.searchParams.get("text") ?? "").trim().toLowerCase().replace(/\s+/g, "-");
}

function packageFromPath(url: URL, marker: string): string | undefined {
  const index = url.pathname.indexOf(marker);
  return index >= 0 ? decodeURIComponent(url.pathname.slice(index + marker.length)) : undefined;
}

async function fixtureProjectPackages(): Promise<Map<string, string>> {
  const projects = new Map<string, string>();
  for (const pkg of await listFixturePackages()) {
    const fixture = await loadEcosystems(pkg);
    if (!fixture.repository_url) continue;

    try {
      const repository = new URL(fixture.repository_url.replace(/^git\+/, "").replace(/\.git$/, ""));
      if (repository.hostname === "github.com") {
        projects.set(`github.com${repository.pathname.replace(/\/$/, "")}`, pkg);
      }
    } catch {
      // A malformed fixture repository URL simply cannot supply a scorecard.
    }
  }
  return projects;
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
      if (url.hostname === "registry.npmjs.org" && url.pathname === "/-/v1/search") {
        return response(await loadSearch(querySlug(url)));
      }
      if (url.hostname === "packages.ecosyste.ms") {
        const pkg = packageFromPath(url, "/packages/");
        return pkg ? response(await loadEcosystems(pkg)) : notFound();
      }
      if (url.hostname === "api.deps.dev" && url.pathname.includes("/systems/npm/packages/")) {
        const pkg = packageFromPath(url, "/packages/");
        return pkg ? response(await loadDepsDev(pkg)) : notFound();
      }
      if (url.hostname === "api.deps.dev" && url.pathname.includes("/projects/")) {
        const project = decodeURIComponent(url.pathname.slice("/v3/projects/".length));
        const pkg = (await projects).get(project);
        if (!pkg) return notFound();

        const scorecard = await loadScorecard(pkg);
        return "__error" in scorecard ? response(scorecard, 404) : response(scorecard);
      }
      if (url.hostname === "api.osv.dev" && url.pathname === "/v1/query") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
        const pkg = body && typeof body === "object"
          && "package" in body && body.package && typeof body.package === "object"
          && "name" in body.package && typeof body.package.name === "string"
          ? body.package.name
          : undefined;
        return pkg ? response(await loadOsv(pkg)) : response({}, 400);
      }
    } catch {
      return notFound();
    }

    return notFound();
  };
}
