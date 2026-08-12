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

function isAffected(latestVersion: string, affected: JsonRecord): boolean {
  const coercedLatest = semver.coerce(latestVersion);
  if (!coercedLatest) return false;
  const latestSemver = coercedLatest.version;

  // 1. Check versions list
  if (Array.isArray(affected.versions)) {
    for (const v of affected.versions) {
      if (typeof v === "string") {
        const coercedV = semver.coerce(v);
        if (coercedV && semver.eq(latestSemver, coercedV.version)) {
          return true;
        }
      }
    }
  }

  // 2. Check ranges
  if (Array.isArray(affected.ranges)) {
    for (const range of affected.ranges) {
      if (!isRecord(range)) continue;
      if (Array.isArray(range.events)) {
        let currentIntroduced: string | null = null;
        for (const event of range.events) {
          if (!isRecord(event)) continue;
          if (typeof event.introduced === "string") {
            currentIntroduced = event.introduced;
          }
          if (typeof event.fixed === "string" && currentIntroduced !== null) {
            const intro = currentIntroduced;
            const fixed = event.fixed;
            currentIntroduced = null;

            try {
              const coercedIntro = semver.coerce(intro);
              const coercedFixed = semver.coerce(fixed);
              if (coercedIntro && coercedFixed) {
                if (semver.gte(latestSemver, coercedIntro.version) && semver.lt(latestSemver, coercedFixed.version)) {
                  return true;
                }
              } else if (intro === "0" && coercedFixed) {
                if (semver.lt(latestSemver, coercedFixed.version)) {
                  return true;
                }
              }
            } catch {
              // Ignore invalid semver
            }
          }
          if (typeof event.last_affected === "string" && currentIntroduced !== null) {
            const intro = currentIntroduced;
            const lastAffected = event.last_affected;
            currentIntroduced = null;

            try {
              const coercedIntro = semver.coerce(intro);
              const coercedLastAffected = semver.coerce(lastAffected);
              if (coercedIntro && coercedLastAffected) {
                if (semver.gte(latestSemver, coercedIntro.version) && semver.lte(latestSemver, coercedLastAffected.version)) {
                  return true;
                }
              } else if (intro === "0" && coercedLastAffected) {
                if (semver.lte(latestSemver, coercedLastAffected.version)) {
                  return true;
                }
              }
            } catch {
              // Ignore invalid semver
            }
          }
        }
        if (currentIntroduced !== null) {
          try {
            const coercedIntro = semver.coerce(currentIntroduced);
            if (coercedIntro) {
              if (semver.gte(latestSemver, coercedIntro.version)) {
                return true;
              }
            } else if (currentIntroduced === "0") {
              return true;
            }
          } catch {
            // Ignore
          }
        }
      }
    }
  }

  return false;
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
          if (scoreStr) {
            try {
              // Normalize version prefix for cvss library (it only supports CVSS:3.0)
              const normalizedScoreStr = scoreStr.replace(/^CVSS:[34]\.[0-9]/, "CVSS:3.0");
              const score = getBaseScore(normalizedScoreStr);
              if (typeof score === "number" && !isNaN(score)) {
                if (score >= 9.0) {
                  severity = "CRITICAL";
                } else if (score >= 7.0) {
                  severity = "HIGH";
                } else if (score >= 4.0) {
                  severity = "MODERATE";
                } else {
                  severity = "LOW";
                }
                break;
              }
            } catch {
              // Ignore and try next
            }
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
                if (fixVer) {
                  if (latestVersion) {
                    try {
                      const coercedFix = semver.coerce(fixVer);
                      const coercedLatest = semver.coerce(latestVersion);
                      if (coercedFix && coercedLatest && semver.gt(coercedFix.version, coercedLatest.version)) {
                        fixedIn = fixVer;
                      }
                    } catch {
                      fixedIn = fixVer;
                    }
                  } else {
                    fixedIn = fixVer;
                  }
                }
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

    const ecosystems = await fetchJson(this.http, ecosystemsUrl);
    const ecosystemRecord = isRecord(ecosystems) ? ecosystems : undefined;
    const repositoryUrl = candidate.repoUrl ?? stringAt(ecosystemRecord, "repository_url");
    const scorecardUrl = githubProjectUrl(repositoryUrl);
    const [depsDev, osv, scorecard] = await Promise.all([
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
      scorecard: scorecardFrom(scorecard),
      maintenance: {
        ...(lastCommit ? { lastCommit } : {}),
        ...(typeof archived === "boolean" ? { archived } : {}),
      },
    });
  }
}
