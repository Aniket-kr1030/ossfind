import { describe, expect, it } from "vitest";
import {
  ComponentCandidateSchema,
  EnrichmentBundleSchema,
  type ComponentCandidate,
} from "../contracts/index.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import type { HttpClient } from "../http/client.js";
import { WeightedRanker } from "../ranking/rank.js";
import { HttpEnricher } from "./enrichment.js";

function osvClient(latestVersion: string, vulns: unknown[]): HttpClient {
  return async (url) => {
    if (url.includes("packages.ecosyste.ms")) {
      return { ok: true, status: 200, json: async () => ({
        normalized_licenses: ["MIT"], latest_release_number: latestVersion,
      }) };
    }
    if (url.includes("api.osv.dev")) {
      return { ok: true, status: 200, json: async () => ({ vulns }) };
    }
    if (url.includes("/projects/")) {
      return { ok: true, status: 200, json: async () => ({ scorecard: { overallScore: 10, checks: [] } }) };
    }
    return { ok: true, status: 200, json: async () => ({ versions: [] }) };
  };
}

function advisory(id: string, score: string, affected: object): object {
  return {
    id,
    database_specific: {},
    severity: [{ type: "CVSS", score }],
    affected: [{ package: { name: "test-package", ecosystem: "npm" }, ...affected }],
  };
}

function candidate(name: string, repoUrl: string, ecosystem: "npm" | "pypi" | "github" = "npm"): ComponentCandidate {
  return ComponentCandidateSchema.parse({
    id: `${ecosystem}:${name}`,
    name,
    ecosystem,
    description: "fixture test candidate",
    repoUrl,
  });
}

describe("HttpEnricher", () => {
  it("uses GitHub's SPDX hint and scorecard, while fail-closing raw-repository OSV evidence", async () => {
    const requested: string[] = [];
    const githubHttp: HttpClient = async (url) => {
      requested.push(url);
      if (url === "https://api.deps.dev/v3/projects/github.com%2Fhuggingface%2Fdiffusers") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ scorecard: { overallScore: 9, checks: [] } }),
        };
      }
      throw new Error(`unexpected supplier request: ${url}`);
    };
    const githubCandidate = ComponentCandidateSchema.parse({
      id: "github:huggingface/diffusers",
      name: "huggingface/diffusers",
      ecosystem: "github",
      description: "Diffusion models",
      repoUrl: "https://github.com/huggingface/diffusers",
      license: "Apache-2.0",
    });

    const bundle = await new HttpEnricher(githubHttp).enrich(githubCandidate);

    expect(requested).toEqual(["https://api.deps.dev/v3/projects/github.com%2Fhuggingface%2Fdiffusers"]);
    expect(bundle.license).toEqual({ spdxId: "Apache-2.0", source: "github", confidence: 1 });
    expect(bundle.sources).toEqual({ license: "ok", osv: "missing", scorecard: "ok" });
    expect(bundle.vulnerabilities).toEqual([]);
    expect(bundle.scorecard.overall).toBe(9);
  });

  it("makes NOASSERTION and missing GitHub scorecards explicit missing evidence", async () => {
    const githubHttp: HttpClient = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const githubCandidate = ComponentCandidateSchema.parse({
      id: "github:example/unknown-license",
      name: "example/unknown-license",
      ecosystem: "github",
      description: "Unknown license fixture",
      repoUrl: "https://github.com/example/unknown-license",
      license: "NOASSERTION",
    });

    const bundle = await new HttpEnricher(githubHttp).enrich(githubCandidate);

    expect(bundle.license).toEqual({ spdxId: null, source: "github", confidence: 0 });
    expect(bundle.sources).toEqual({ license: "missing", osv: "missing", scorecard: "missing" });
  });

  it("enriches PyPI fixtures with their ecosystem-specific supplier addresses", async () => {
    const bundle = await new HttpEnricher(createFixtureHttpClient(), undefined, "pypi").enrich(
      candidate("moviepy", "https://github.com/zulko/moviepy", "pypi"),
    );

    expect(bundle.id).toBe("pypi:moviepy");
    expect(bundle.license.spdxId).toBe("MIT");
    expect(bundle.sources).toMatchObject({ license: "ok", osv: "ok", scorecard: "ok" });
    expect(EnrichmentBundleSchema.parse(bundle)).toEqual(bundle);
  });

  it("keeps PyPI CVE evidence and degrades a missing scorecard without throwing", async () => {
    const enricher = new HttpEnricher(createFixtureHttpClient(), undefined, "pypi");
    const vulnerable = await enricher.enrich(
      candidate("urllib3", "https://github.com/urllib3/urllib3", "pypi"),
    );
    const noScorecard = await enricher.enrich(
      candidate("moviepy", "https://github.com/example/no-scorecard", "pypi"),
    );

    expect(vulnerable.vulnerabilities.length).toBeGreaterThan(0);
    expect(vulnerable.sources.osv).toBe("ok");
    expect(noScorecard.scorecard.overall).toBeNull();
    expect(noScorecard.sources.scorecard).toBe("missing");
  });

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

  it.each([
    "CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H",
    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H",
    "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H",
  ])("derives CRITICAL from a source CVSS vector (%s)", async (score) => {
    const bundle = await new HttpEnricher(osvClient("1.0.0", [advisory(
      "GHSA-cvss", score, { ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }] },
    )])).enrich(candidate("test-package", "https://github.com/example/test-package"));

    expect(bundle.vulnerabilities).toContainEqual({ id: "GHSA-cvss", severity: "CRITICAL" });
    expect(bundle.sources.osv).toBe("ok");
  });

  it("keeps unknown CVSS severity unknown instead of inventing LOW", async () => {
    const bundle = await new HttpEnricher(osvClient("1.0.0", [advisory(
      "GHSA-unparseable", "CVSS:4.0/not-a-vector", { ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }] },
    )])).enrich(candidate("test-package", "https://github.com/example/test-package"));

    expect(bundle.vulnerabilities).toContainEqual({ id: "GHSA-unparseable", severity: "unknown" });
  });

  it("retains active future-fixed advisories and discards invalid fixedIn", async () => {
    const active = advisory("GHSA-future-fix", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", {
      ranges: [{ type: "SEMVER", events: [{ introduced: "2.0.0" }, { fixed: "3.0.0" }] }],
    });
    const invalidFix = advisory("GHSA-invalid-fix", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", {
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "not-a-version" }] }],
    });
    const bundle = await new HttpEnricher(osvClient("2.5.0", [active, invalidFix])).enrich(
      candidate("test-package", "https://github.com/example/test-package"),
    );

    expect(bundle.vulnerabilities).toContainEqual({ id: "GHSA-future-fix", severity: "CRITICAL", fixedIn: "3.0.0" });
    expect(bundle.vulnerabilities).toContainEqual({ id: "GHSA-invalid-fix", severity: "CRITICAL" });
  });

  it("uses prerelease-aware, multi-interval, last_affected, explicit-list, and fail-closed relevance", async () => {
    const activePrerelease = advisory("GHSA-prerelease", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", {
      ranges: [{ type: "SEMVER", events: [{ introduced: "1.0.0-beta.0" }, { fixed: "1.0.0" }] }],
    });
    const secondInterval = advisory("GHSA-multi", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", {
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.0" }, { introduced: "2.0.0" }, { fixed: "3.0.0" }] }],
    });
    const lastAffected = advisory("GHSA-last", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", {
      ranges: [{ type: "SEMVER", events: [{ introduced: "1.0.0" }, { last_affected: "2.0.0" }] }],
    });
    const explicit = advisory("GHSA-explicit", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", { versions: ["2.5.0"] });
    const ambiguous = advisory("GHSA-ambiguous", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", {
      ranges: [{ type: "SEMVER", events: [{ introduced: "not-a-version" }, { fixed: "3.0.0" }] }],
    });

    const prereleaseBundle = await new HttpEnricher(osvClient("1.0.0-beta.1", [activePrerelease])).enrich(candidate("test-package", "https://github.com/example/test-package"));
    expect(prereleaseBundle.vulnerabilities.map((v) => v.id)).toContain("GHSA-prerelease");
    const bundle = await new HttpEnricher(osvClient("2.5.0", [secondInterval, lastAffected, explicit, ambiguous])).enrich(candidate("test-package", "https://github.com/example/test-package"));
    expect(bundle.vulnerabilities.map((v) => v.id)).toEqual(expect.arrayContaining(["GHSA-multi", "GHSA-explicit", "GHSA-ambiguous"]));
    expect(bundle.vulnerabilities.map((v) => v.id)).not.toContain("GHSA-last");
  });

  it("distinguishes failed OSV evidence from a successful empty response and missing license", async () => {
    const failedOsv: HttpClient = async (url) => {
      if (url.includes("api.osv.dev")) return { ok: false, status: 500, json: async () => ({}) };
      if (url.includes("packages.ecosyste.ms")) return { ok: true, status: 200, json: async () => ({ latest_release_number: "1.0.0" }) };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const bundle = await new HttpEnricher(failedOsv).enrich(candidate("test-package", "https://github.com/example/test-package"));

    expect(bundle.sources).toMatchObject({ osv: "failed", license: "missing" });
    expect(bundle.vulnerabilities).toEqual([]);
  });

  it("treats a successful empty OSV response as clean evidence that can ship", async () => {
    const emptyOsv: HttpClient = async (url) => {
      if (url.includes("api.osv.dev")) return { ok: true, status: 200, json: async () => ({}) };
      if (url.includes("packages.ecosyste.ms")) {
        return { ok: true, status: 200, json: async () => ({
          normalized_licenses: ["MIT"], latest_release_number: "1.0.0",
        }) };
      }
      if (url.includes("/projects/")) {
        return { ok: true, status: 200, json: async () => ({ scorecard: { overallScore: 10, checks: [] } }) };
      }
      return { ok: true, status: 200, json: async () => ({ versions: [] }) };
    };
    const component = candidate("test-package", "https://github.com/example/test-package");
    const bundle = await new HttpEnricher(emptyOsv).enrich(component);

    expect(bundle.sources.osv).toBe("ok");
    expect(bundle.vulnerabilities).toEqual([]);

    const [scored] = new WeightedRanker({ projectLicense: "MIT" }).rank(
      "test query",
      [{ candidate: component, bundle }],
      [{ id: component.id, fitScore: 1, rationale: "ideal fit" }],
    );
    expect(scored.verdict).toBe("ship");
    expect(scored.reasons).not.toContain("OSV vulnerability data unavailable — security evidence unverified.");
  });

  it("does not mark a successful OSV response missing when its vulns field is absent", async () => {
    const emptyOsv: HttpClient = async (url) => {
      if (url.includes("api.osv.dev")) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const bundle = await new HttpEnricher(emptyOsv).enrich(
      candidate("test-package", "https://github.com/example/test-package"),
    );

    expect(bundle.sources.osv).toBe("ok");
    expect(bundle.vulnerabilities).toEqual([]);
  });
});
