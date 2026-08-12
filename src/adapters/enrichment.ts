import {
  EnrichmentBundleSchema,
  type ComponentCandidate,
  type EnrichmentBundle,
} from "../contracts/index.js";
import type { Enricher } from "../pipeline/interfaces.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";
import { getBaseScore } from "cvss";
import * as semver from "semver";

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

type FetchResult =
  | { status: "ok"; data: unknown }
  | { status: "failed"; httpStatus?: number };

async function fetchJson(http: HttpClient, url: string, init?: RequestInit): Promise<FetchResult> {
  try {
    const response = await http(url, init);
    if (!response.ok) return { status: "failed", httpStatus: response.status };
    return { status: "ok", data: await response.json() };
  } catch {
    return { status: "failed" };
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

function defaultVersionFromDepsDev(depsDev: unknown): string | undefined {
  if (!isRecord(depsDev) || !Array.isArray(depsDev.versions)) return undefined;
  for (const v of depsDev.versions) {
    if (isRecord(v) && v.isDefault === true && isRecord(v.versionKey)) {
      const ver = v.versionKey.version;
      if (typeof ver === "string") {
        return ver;
      }
    }
  }
  return undefined;
}

function parseVersion(version: string): string | undefined {
  return semver.valid(version.trim()) ?? undefined;
}

/**
 * OSV version relevance must be conservative. `semver.valid` keeps prerelease
 * identifiers; `coerce` would incorrectly turn 1.0.0-beta.1 into 1.0.0.
 */
function isAffected(latestVersion: string, affected: JsonRecord): boolean {
  const latest = parseVersion(latestVersion);
  if (!latest) return true;
  let hasVersionSemantics = false;

  if (Array.isArray(affected.versions)) {
    hasVersionSemantics = true;
    for (const rawVersion of affected.versions) {
      if (typeof rawVersion !== "string") return true;
      const listed = parseVersion(rawVersion);
      if (!listed) return true;
      if (semver.eq(latest, listed)) return true;
    }
  }

  if (Array.isArray(affected.ranges)) {
    hasVersionSemantics = true;
    for (const range of affected.ranges) {
      if (!isRecord(range) || !Array.isArray(range.events)) return true;
      let introduced: string | undefined;
      for (const event of range.events) {
        if (!isRecord(event)) return true;
        if (typeof event.introduced === "string") {
          if (introduced !== undefined) return true;
          introduced = event.introduced;
          continue;
        }
        const fixed = stringAt(event, "fixed");
        const lastAffected = stringAt(event, "last_affected");
        if (!fixed && !lastAffected) continue;
        if (introduced === undefined || (fixed && lastAffected)) return true;

        const lower = introduced === "0" ? undefined : parseVersion(introduced);
        const upper = parseVersion(fixed ?? lastAffected!);
        if ((introduced !== "0" && !lower) || !upper) return true;
        const afterLower = !lower || semver.gte(latest, lower);
        const beforeUpper = fixed ? semver.lt(latest, upper) : semver.lte(latest, upper);
        if (afterLower && beforeUpper) return true;
        introduced = undefined;
      }
      if (introduced !== undefined) {
        const lower = introduced === "0" ? undefined : parseVersion(introduced);
        if (introduced !== "0" && !lower) return true;
        if (!lower || semver.gte(latest, lower)) return true;
      }
    }
  }

  // An affected record with no usable range/list does not prove safety.
  return !hasVersionSemantics;
}

function severityFromScore(score: number): string {
  if (score >= 9.0) return "CRITICAL";
  if (score >= 7.0) return "HIGH";
  if (score >= 4.0) return "MODERATE";
  return "LOW";
}

function severityFromCvssV4(vector: string): string | undefined {
  const parts = vector.split("/");
  if (!/^CVSS:4\.[01]$/i.test(parts[0] ?? "")) return undefined;
  const metrics = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const [metric, value, ...extra] = part.split(":");
    if (!metric || !value || extra.length > 0) return undefined;
    metrics.set(metric.toUpperCase(), value.toUpperCase());
  }
  // V4 impact metrics are VC/VI/VA. Do not reinterpret them as v3 C/I/A.
  const impacts = [metrics.get("VC"), metrics.get("VI"), metrics.get("VA")];
  if (impacts.some((impact) => impact === undefined)) return undefined;
  if (impacts.every((impact) => impact === "H")) return "CRITICAL";
  if (impacts.some((impact) => impact === "H")) return "HIGH";
  if (impacts.some((impact) => impact === "L")) return "MODERATE";
  if (impacts.every((impact) => impact === "N")) return "LOW";
  return undefined;
}

function severityFromCvss(vector: string): string | undefined {
  if (/^CVSS:4\.[01]\//i.test(vector)) return severityFromCvssV4(vector);
  if (!/^CVSS:3\.[01]\//i.test(vector)) return undefined;
  try {
    // V3.0 and V3.1 share base-score semantics; the dependency accepts V3.0.
    const score = getBaseScore(vector.replace(/^CVSS:3\.1/i, "CVSS:3.0"));
    return typeof score === "number" && Number.isFinite(score) ? severityFromScore(score) : undefined;
  } catch {
    return undefined;
  }
}

function vulnerabilitiesFrom(
  osv: unknown,
  latestVersion?: string,
  pkg?: string
): EnrichmentBundle["vulnerabilities"] {
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
          const scoreStr = stringAt(entry, "score");
          const parsedSeverity = scoreStr ? severityFromCvss(scoreStr) : undefined;
          if (parsedSeverity) {
            severity = parsedSeverity;
            break;
          }
        }
      }
    }

    if (!severity) {
      severity = "unknown";
    }

    let affectsLatest = !latestVersion;
    let fixedIn: string | undefined;

    if (Array.isArray(raw.affected)) {
      for (const affected of raw.affected) {
        if (!isRecord(affected)) continue;

        if (pkg) {
          const affectedPkg = isRecord(affected.package) ? stringAt(affected.package, "name") : undefined;
          if (affectedPkg && affectedPkg.toLowerCase() !== pkg.toLowerCase()) {
            continue;
          }
        }

        if (latestVersion && isAffected(latestVersion, affected)) {
          affectsLatest = true;
        }

        if (Array.isArray(affected.ranges)) {
          for (const range of affected.ranges) {
            if (!isRecord(range) || !Array.isArray(range.events)) continue;
            for (const event of range.events) {
              if (isRecord(event) && stringAt(event, "fixed")) {
                const fixVer = stringAt(event, "fixed");
                // An active record can expose a future fix, but it must never
                // imply that the selected version is already fixed. Invalid
                // versions are excluded by the contract boundary.
                if (fixVer && parseVersion(fixVer)) fixedIn = fixVer.trim();
              }
            }
          }
        }
      }
    }

    if (!affectsLatest) {
      return [];
    }

    return [{ id, severity, ...(fixedIn ? { fixedIn } : {}) }];
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

    const ecosystemsResult = await fetchJson(this.http, ecosystemsUrl);
    const ecosystems = ecosystemsResult.status === "ok" ? ecosystemsResult.data : undefined;
    const ecosystemRecord = isRecord(ecosystems) ? ecosystems : undefined;
    const repositoryUrl = candidate.repoUrl ?? stringAt(ecosystemRecord, "repository_url");
    const scorecardUrl = githubProjectUrl(repositoryUrl);
    const [depsDevResult, osvResult, scorecardResult] = await Promise.all([
      // The current bundle schema has no field for default version/deprecation,
      // but this request keeps the adapter ready for those contract additions.
      fetchJson(this.http, depsUrl),
      fetchJson(this.http, osvUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ package: { ecosystem: "npm", name: pkg } }),
      }),
      scorecardUrl
        ? fetchJson(this.http, scorecardUrl)
        : Promise.resolve<FetchResult>({ status: "ok", data: undefined }),
    ]);
    const depsDev = depsDevResult.status === "ok" ? depsDevResult.data : undefined;
    const osv = osvResult.status === "ok" ? osvResult.data : undefined;
    const scorecard = scorecardResult.status === "ok" ? scorecardResult.data : undefined;

    const license = firstLicense(ecosystems);
    const repositoryMetadata = isRecord(ecosystemRecord?.repo_metadata)
      ? ecosystemRecord.repo_metadata
      : undefined;
    const lastCommit = stringAt(ecosystemRecord, "latest_release_published_at")
      ?? stringAt(repositoryMetadata, "pushed_at");
    const archived = repositoryMetadata?.archived;

    const latestVersion = stringAt(ecosystemRecord, "latest_release_number")
      ?? defaultVersionFromDepsDev(depsDev);

    return EnrichmentBundleSchema.parse({
      id: candidate.id,
      license: {
        spdxId: license ?? null,
        source: "ecosyste.ms",
        confidence: license ? 1 : 0,
      },
      vulnerabilities: vulnerabilitiesFrom(osv, latestVersion, pkg),
      sources: {
        // A successful OSV response containing no advisories is positive
        // evidence; a failed request is not equivalent to an empty result.
        osv: osvResult.status === "failed"
          ? "failed"
          : isRecord(osv) && Array.isArray(osv.vulns) ? "ok" : "missing",
        license: ecosystemsResult.status === "failed" ? "failed" : license ? "ok" : "missing",
        scorecard: !scorecardUrl
          ? "missing"
          : scorecardResult.status === "failed"
            ? scorecardResult.httpStatus === 404 ? "missing" : "failed"
            : isRecord(scorecard) && isRecord(scorecard.scorecard) ? "ok" : "missing",
      },
      scorecard: scorecardFrom(scorecard),
      maintenance: {
        ...(lastCommit ? { lastCommit } : {}),
        ...(typeof archived === "boolean" ? { archived } : {}),
      },
    });
  }
}
