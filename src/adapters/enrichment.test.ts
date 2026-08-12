import { describe, expect, it } from "vitest";
import {
  ComponentCandidateSchema,
  EnrichmentBundleSchema,
  type ComponentCandidate,
} from "../contracts/index.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import { HttpEnricher } from "./enrichment.js";

function candidate(name: string, repoUrl: string): ComponentCandidate {
  return ComponentCandidateSchema.parse({
    id: `npm:${name}`,
    name,
    ecosystem: "npm",
    description: "fixture test candidate",
    repoUrl,
  });
}

describe("HttpEnricher", () => {
  it("maps express from offline supplier fixtures into a valid bundle", async () => {
    const bundle = await new HttpEnricher(createFixtureHttpClient()).enrich(
      candidate("express", "https://github.com/expressjs/express"),
    );

    expect(bundle.license.spdxId).toBe("MIT");
    expect(bundle.scorecard.overall).toEqual(expect.any(Number));
    expect(EnrichmentBundleSchema.parse(bundle)).toEqual(bundle);
  });

  it("treats a 404 scorecard as a null score without throwing", async () => {
    const bundle = await new HttpEnricher(createFixtureHttpClient()).enrich(
      candidate("colors", "https://github.com/Marak/colors"),
    );

    expect(bundle.scorecard.overall).toBeNull();
    expect(EnrichmentBundleSchema.parse(bundle)).toEqual(bundle);
  });

  it("keeps OSV vulnerabilities when the other sources are fixture-backed", async () => {
    const bundle = await new HttpEnricher(createFixtureHttpClient()).enrich(
      candidate("request", "https://github.com/request/request"),
    );

    expect(bundle.vulnerabilities.length).toBeGreaterThan(0);
    expect(EnrichmentBundleSchema.parse(bundle)).toEqual(bundle);
  });

  it("filters out vulnerabilities not affecting the latest version of axios", async () => {
    const bundle = await new HttpEnricher(createFixtureHttpClient()).enrich(
      candidate("axios", "https://github.com/axios/axios"),
    );

    // Axios at latest 1.19.0 has almost all vulns fixed.
    expect(bundle.vulnerabilities.length).toBeLessThan(5);
    expect(EnrichmentBundleSchema.parse(bundle)).toEqual(bundle);
  });
});
