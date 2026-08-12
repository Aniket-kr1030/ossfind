import {
  EnrichmentBundleSchema,
  type ComponentCandidate,
  type EnrichmentBundle,
} from "../contracts/index.js";
import type { Enricher } from "../pipeline/interfaces.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberAt(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function fetchJson(http: HttpClient, url: string, init?: RequestInit): Promise<unknown> {
  try {
    const response = await http(url, init);
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

function packageName(candidate: ComponentCandidate): string {
  return candidate.id.slice("npm:".length);
}

function githubProjectUrl(repositoryUrl: string | undefined): string | undefined {
  if (!repositoryUrl) return undefined;
  try {
    const url = new URL(repositoryUrl.replace(/^git\+/, "").replace(/\.git$/, ""));
    if (url.hostname !== "github.com") return undefined;
    const [owner, repository] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repository) return undefined;
    return `https://api.deps.dev/v3/projects/${encodeURIComponent(`github.com/${owner}/${repository}`)}`;
  } catch {
    return undefined;
  }
}

function firstLicense(ecosystems: unknown): string | undefined {
  if (!isRecord(ecosystems) || !Array.isArray(ecosystems.normalized_licenses)) return undefined;
  return ecosystems.normalized_licenses.find(
    (license): license is string => typeof license === "string" && license.length > 0,
  );
}

function vulnerabilitiesFrom(osv: unknown): EnrichmentBundle["vulnerabilities"] {
  if (!isRecord(osv) || !Array.isArray(osv.vulns)) return [];
  return osv.vulns.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const id = stringAt(raw, "id");
    if (!id) return [];
    const databaseSpecific = isRecord(raw.database_specific) ? raw.database_specific : undefined;
    let severity = stringAt(databaseSpecific, "severity");
    if (!severity && Array.isArray(raw.severity)) {
      for (const entry of raw.severity) {
        if (isRecord(entry) && stringAt(entry, "score")) {
          severity = stringAt(entry, "score");
          break;
        }
      }
    }

    let fixedIn: string | undefined;
    if (Array.isArray(raw.affected)) {
      for (const affected of raw.affected) {
        if (!isRecord(affected) || !Array.isArray(affected.ranges)) continue;
        for (const range of affected.ranges) {
          if (!isRecord(range) || !Array.isArray(range.events)) continue;
          for (const event of range.events) {
            if (isRecord(event) && stringAt(event, "fixed")) {
              fixedIn = stringAt(event, "fixed");
              break;
            }
          }
          if (fixedIn) break;
        }
        if (fixedIn) break;
      }
    }

    return [{ id, severity: severity ?? "unknown", ...(fixedIn ? { fixedIn } : {}) }];
  });
}

function scorecardFrom(scorecard: unknown): EnrichmentBundle["scorecard"] {
  const data = isRecord(scorecard) && isRecord(scorecard.scorecard) ? scorecard.scorecard : undefined;
  if (!data) return { overall: null, checks: [] };
  const checks = Array.isArray(data.checks)
    ? data.checks.flatMap((raw) => {
      if (!isRecord(raw)) return [];
      const name = stringAt(raw, "name");
      return name
        ? [{
          name,
          ...(numberAt(raw, "score") !== undefined ? { score: numberAt(raw, "score") } : {}),
          ...(stringAt(raw, "reason") ? { reason: stringAt(raw, "reason") } : {}),
        }]
        : [];
    })
    : [];
  return { overall: numberAt(data, "overallScore") ?? null, checks };
}

/** Real API implementation with source-by-source graceful degradation. */
export class HttpEnricher implements Enricher {
  constructor(private readonly http: HttpClient = defaultHttpClient) {}

  async enrich(candidate: ComponentCandidate): Promise<EnrichmentBundle> {
    const pkg = packageName(candidate);
    const encodedPackage = encodeURIComponent(pkg);
    const ecosystemsUrl = `https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/${encodedPackage}`;
    const depsUrl = `https://api.deps.dev/v3/systems/npm/packages/${encodedPackage}`;
    const osvUrl = "https://api.osv.dev/v1/query";

    const ecosystems = await fetchJson(this.http, ecosystemsUrl);
    const ecosystemRecord = isRecord(ecosystems) ? ecosystems : undefined;
    const repositoryUrl = candidate.repoUrl ?? stringAt(ecosystemRecord, "repository_url");
    const scorecardUrl = githubProjectUrl(repositoryUrl);
    const [, osv, scorecard] = await Promise.all([
      // The current bundle schema has no field for default version/deprecation,
      // but this request keeps the adapter ready for those contract additions.
      fetchJson(this.http, depsUrl),
      fetchJson(this.http, osvUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ package: { ecosystem: "npm", name: pkg } }),
      }),
      scorecardUrl ? fetchJson(this.http, scorecardUrl) : Promise.resolve(undefined),
    ]);

    const license = firstLicense(ecosystems);
    const repositoryMetadata = isRecord(ecosystemRecord?.repo_metadata)
      ? ecosystemRecord.repo_metadata
      : undefined;
    const lastCommit = stringAt(ecosystemRecord, "latest_release_published_at")
      ?? stringAt(repositoryMetadata, "pushed_at");
    const archived = repositoryMetadata?.archived;

    return EnrichmentBundleSchema.parse({
      id: candidate.id,
      license: {
        spdxId: license ?? null,
        source: "ecosyste.ms",
        confidence: license ? 1 : 0,
      },
      vulnerabilities: vulnerabilitiesFrom(osv),
      scorecard: scorecardFrom(scorecard),
      maintenance: {
        ...(lastCommit ? { lastCommit } : {}),
        ...(typeof archived === "boolean" ? { archived } : {}),
      },
    });
  }
}
