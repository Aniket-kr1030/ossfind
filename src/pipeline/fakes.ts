import {
  ComponentCandidateSchema,
  EnrichmentBundleSchema,
  FitSignalSchema,
  ScoredComponentSchema,
  type ComponentCandidate,
  type EnrichmentBundle,
  type FitSignal,
  type ScoredComponent,
} from "../contracts/index.js";
import {
  listFixturePackages,
  loadDepsDev,
  loadEcosystems,
  loadOsv,
  loadScorecard,
  loadSearch,
} from "../fixtures/loader.js";
import type { Discoverer, Enricher, FitScorer, Ranker } from "./interfaces.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberAt(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(value: unknown): string | undefined {
  return Array.isArray(value) ? value.find((item): item is string => typeof item === "string" && item.length > 0) : undefined;
}

function canonicalPackageName(candidate: ComponentCandidate): string {
  return candidate.id.slice("npm:".length);
}

function asUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "");
  try {
    return new URL(normalized).toString();
  } catch {
    return undefined;
  }
}

/** Maps one ecosyste.ms package record into the candidate contract. */
export function mapCandidateFromRaw(raw: unknown): ComponentCandidate {
  if (!isRecord(raw)) throw new Error("Expected an ecosyste.ms package object");
  const name = stringAt(raw, "name");
  if (!name) throw new Error("Ecosyste.ms fixture has no package name");
  const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
  const repositoryMetadata = isRecord(raw.repo_metadata) ? raw.repo_metadata : undefined;
  const downloads = numberAt(raw, "downloads") ?? (metadata && numberAt(metadata, "downloads"));

  return ComponentCandidateSchema.parse({
    id: `npm:${name}`,
    name,
    ecosystem: stringAt(raw, "ecosystem") ?? "npm",
    description: stringAt(raw, "description") ?? "",
    repoUrl: asUrl(stringAt(raw, "repository_url")),
    homepage: asUrl(stringAt(raw, "homepage")),
    downloads,
    stars: repositoryMetadata && numberAt(repositoryMetadata, "stargazers_count"),
    latestVersion: stringAt(raw, "latest_release_number"),
    publishedAt: stringAt(raw, "latest_release_published_at"),
  });
}

function fixedVersion(vulnerability: JsonRecord): string | undefined {
  if (!Array.isArray(vulnerability.affected)) return undefined;
  for (const affected of vulnerability.affected) {
    if (!isRecord(affected) || !Array.isArray(affected.ranges)) continue;
    for (const range of affected.ranges) {
      if (!isRecord(range) || !Array.isArray(range.events)) continue;
      for (const event of range.events) {
        if (isRecord(event)) {
          const fixed = stringAt(event, "fixed");
          if (fixed) return fixed;
        }
      }
    }
  }
  return undefined;
}

function vulnerabilitySeverity(vulnerability: JsonRecord): string {
  const databaseSpecific = isRecord(vulnerability.database_specific)
    ? stringAt(vulnerability.database_specific, "severity")
    : undefined;
  if (databaseSpecific) return databaseSpecific;
  if (Array.isArray(vulnerability.severity)) {
    for (const entry of vulnerability.severity) {
      if (isRecord(entry)) {
        const score = stringAt(entry, "score");
        if (score) return score;
      }
    }
  }
  return "unknown";
}

/** Maps frozen supplier responses into the enrichment contract. */
export function mapEnrichmentFromRaw(
  candidate: ComponentCandidate,
  ecosystems: unknown,
  _depsDev: unknown,
  osv: unknown,
  scorecard: unknown,
): EnrichmentBundle {
  const ecosystemRecord = isRecord(ecosystems) ? ecosystems : {};
  const scorecardRecord = isRecord(scorecard) && isRecord(scorecard.scorecard)
    ? scorecard.scorecard
    : undefined;
  const osvRecord = isRecord(osv) ? osv : {};
  const license = firstString(ecosystemRecord.normalized_licenses);
  const repositoryMetadata = isRecord(ecosystemRecord.repo_metadata)
    ? ecosystemRecord.repo_metadata
    : undefined;
  const vulnerabilities = Array.isArray(osvRecord.vulns)
    ? osvRecord.vulns.filter(isRecord).map((vulnerability) => ({
      id: stringAt(vulnerability, "id") ?? "unknown-vulnerability",
      severity: vulnerabilitySeverity(vulnerability),
      ...(fixedVersion(vulnerability) ? { fixedIn: fixedVersion(vulnerability) } : {}),
    }))
    : [];
  const checks = scorecardRecord && Array.isArray(scorecardRecord.checks)
    ? scorecardRecord.checks.filter(isRecord).flatMap((check) => {
      const name = stringAt(check, "name");
      return name ? [{ name, score: numberAt(check, "score"), reason: stringAt(check, "reason") }] : [];
    })
    : [];

  return EnrichmentBundleSchema.parse({
    id: candidate.id,
    license: {
      spdxId: license ?? null,
      source: "ecosyste.ms",
      confidence: license ? 1 : 0,
    },
    vulnerabilities,
    scorecard: {
      overall: scorecardRecord ? numberAt(scorecardRecord, "overallScore") ?? null : null,
      checks,
    },
    maintenance: {
      ...(repositoryMetadata && stringAt(repositoryMetadata, "pushed_at")
        ? { lastCommit: stringAt(repositoryMetadata, "pushed_at") }
        : {}),
      ...(repositoryMetadata && typeof repositoryMetadata.archived === "boolean"
        ? { archived: repositoryMetadata.archived }
        : {}),
    },
  });
}

export class FixtureDiscoverer implements Discoverer {
  async discover(query: string): Promise<ComponentCandidate[]> {
    const slug = query.trim().toLowerCase().replace(/\s+/g, "-");
    const [search, fixturePackages] = await Promise.all([loadSearch(slug), listFixturePackages()]);
    const knownPackages = new Set(fixturePackages);
    const names = search.objects.flatMap((result) => {
      const name = result.package.name;
      return knownPackages.has(name) ? [name] : [];
    });
    return Promise.all(names.map(async (name) => mapCandidateFromRaw(await loadEcosystems(name))));
  }
}

export class FixtureEnricher implements Enricher {
  async enrich(candidate: ComponentCandidate): Promise<EnrichmentBundle> {
    const packageName = canonicalPackageName(candidate);
    const [ecosystems, depsDev, osv, scorecard] = await Promise.all([
      loadEcosystems(packageName),
      loadDepsDev(packageName),
      loadOsv(packageName),
      loadScorecard(packageName),
    ]);
    return mapEnrichmentFromRaw(candidate, ecosystems, depsDev, osv, scorecard);
  }
}

export class FixtureFitScorer implements FitScorer {
  async fit(query: string, candidates: ComponentCandidate[]): Promise<FitSignal[]> {
    return candidates.map((candidate) => FitSignalSchema.parse({
      id: candidate.id,
      fitScore: 0.5,
      rationale: `Fixture placeholder fit for ${query}`,
    }));
  }
}

export class FixtureRanker implements Ranker {
  rank(
    _query: string,
    enriched: Array<{ candidate: ComponentCandidate; bundle: EnrichmentBundle }>,
    fit: FitSignal[],
  ): ScoredComponent[] {
    const fitById = new Map(fit.map((signal) => [signal.id, signal]));
    return enriched.map(({ candidate, bundle }) => {
      const fitScore = fitById.get(candidate.id)?.fitScore ?? 0.5;
      return ScoredComponentSchema.parse({
        id: candidate.id,
        name: candidate.name,
        repoUrl: candidate.repoUrl,
        scores: { fit: fitScore, license: 0.5, security: 0.5, health: 0.5, effort: 0.5 },
        overall: 50,
        verdict: "caution",
        reasons: ["Fixture ranker uses placeholder scores; real ranking is not part of this scaffold."],
        badges: {
          license: bundle.license.spdxId ?? "Unknown",
          cveCount: bundle.vulnerabilities.length,
          scorecard: bundle.scorecard.overall,
        },
      });
    });
  }
}

// Short names make the intended test-double role clear to consumers.
export const FakeDiscoverer = FixtureDiscoverer;
export const FakeEnricher = FixtureEnricher;
export const FakeFitScorer = FixtureFitScorer;
export const FakeRanker = FixtureRanker;
