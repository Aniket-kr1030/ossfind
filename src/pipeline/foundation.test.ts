import { describe, expect, it } from "vitest";
import {
  ComponentCandidateSchema,
  EnrichmentBundleSchema,
  FitSignalSchema,
  LicenseCompatResultSchema,
  ScoredComponentSchema,
  validate,
} from "../contracts/index.js";
import {
  loadDepsDev,
  loadEcosystems,
  loadOsv,
  loadScorecard,
} from "../fixtures/loader.js";
import {
  FixtureDiscoverer,
  FixtureEnricher,
  FixtureFitScorer,
  FixtureRanker,
  mapCandidateFromRaw,
  mapEnrichmentFromRaw,
} from "./fakes.js";
import { searchComponents } from "./orchestrator.js";

function roundTrip<T>(schema: Parameters<typeof validate<T>>[0], value: unknown): T {
  return validate(schema, JSON.parse(JSON.stringify(value)));
}

describe("ossfind foundation contracts", () => {
  it("validates all contract objects mapped from frozen fixtures", async () => {
    const [ecosystems, depsDev, osv, scorecard] = await Promise.all([
      loadEcosystems("axios"),
      loadDepsDev("axios"),
      loadOsv("axios"),
      loadScorecard("axios"),
    ]);
    const candidate = mapCandidateFromRaw(ecosystems);
    const bundle = mapEnrichmentFromRaw(candidate, ecosystems, depsDev, osv, scorecard);
    const fit = new FixtureFitScorer().fit("http client", [candidate]);
    const scored = new FixtureRanker().rank(
      "http client",
      [{ candidate, bundle }],
      await fit,
    )[0];

    expect(roundTrip(ComponentCandidateSchema, candidate)).toEqual(candidate);
    expect(roundTrip(EnrichmentBundleSchema, bundle)).toEqual(bundle);
    expect(roundTrip(FitSignalSchema, (await fit)[0])).toEqual((await fit)[0]);
    expect(roundTrip(ScoredComponentSchema, scored)).toEqual(scored);
    expect(roundTrip(LicenseCompatResultSchema, {
      compatible: "yes",
      obligations: [],
      notes: `License data comes from ${bundle.license.source}.`,
    })).toMatchObject({ compatible: "yes" });
  });

  it("runs the fixture-backed pipeline offline for an HTTP client search", async () => {
    const results = await searchComponents("http client", {
      discoverer: new FixtureDiscoverer(),
      enricher: new FixtureEnricher(),
      fitScorer: new FixtureFitScorer(),
      ranker: new FixtureRanker(),
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => ScoredComponentSchema.safeParse(result).success)).toBe(true);
  });

  it("rejects malformed contract objects", () => {
    expect(() => ComponentCandidateSchema.parse({
      id: "axios",
      name: "axios",
      ecosystem: "npm",
      description: "missing npm id prefix",
    })).toThrow();
  });
});
