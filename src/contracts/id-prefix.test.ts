import { describe, expect, it } from "vitest";
import {
  ApiSurfaceSchema,
  EnrichmentBundleSchema,
  FitSignalSchema,
  IntegrationManifestSchema,
  ScoredComponentSchema,
} from "./index.js";

describe("package ecosystem id prefixes", () => {
  it("accepts cargo and RubyGems ids in every contract that carries one", () => {
    for (const id of ["cargo:serde", "rubygems:rails"]) {
      expect(ApiSurfaceSchema.safeParse({
        id, version: null, typesAvailable: "none", typesSource: null, exports: [], truncated: false, notes: [],
      }).success).toBe(true);
      expect(EnrichmentBundleSchema.safeParse({
        id,
        license: { spdxId: null, source: "fixture", confidence: 0 },
        vulnerabilities: [],
        sources: { license: "missing", osv: "missing", scorecard: "missing" },
        scorecard: { overall: null, checks: [] },
        maintenance: {},
      }).success).toBe(true);
      expect(FitSignalSchema.safeParse({ id, fitScore: 1, rationale: "fixture" }).success).toBe(true);
      expect(IntegrationManifestSchema.safeParse({
        id,
        version: null,
        install: { command: "fixture install" },
        importForm: { moduleType: "unknown", esm: null, cjs: null, typesPackage: null },
        runtime: { engines: {}, os: null, cpu: null },
        peerDependencies: {}, prerequisites: [], hasInstallScript: false, notes: [],
      }).success).toBe(true);
      expect(ScoredComponentSchema.safeParse({
        id,
        name: id.slice(id.indexOf(":") + 1),
        scores: { fit: 1, license: 1, security: 1, health: 1, effort: 1, adoption: 1 },
        overall: 100,
        verdict: "ship",
        reasons: ["fixture"],
        badges: { license: "MIT", cveCount: 0, scorecard: 10 },
      }).success).toBe(true);
    }
  });
});
