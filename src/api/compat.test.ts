import { describe, expect, it } from "vitest";
import { CompatibilityReportSchema } from "../contracts/compatibility-report.js";
import type { IntegrationManifest } from "../contracts/integration-manifest.js";
import { checkCompatibility, type ProjectContext } from "./compat.js";

function manifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return {
    id: "npm:axios",
    version: "1.7.0",
    install: { command: "npm install axios" },
    importForm: { moduleType: "esm", esm: 'import axios from "axios";', cjs: null, typesPackage: null },
    runtime: { engines: {}, os: null, cpu: null },
    peerDependencies: {},
    prerequisites: [],
    hasInstallScript: false,
    notes: [],
    ...overrides,
  };
}

function checked(report: unknown): void {
  expect(CompatibilityReportSchema.parse(report)).toEqual(report);
}

describe("checkCompatibility", () => {
  it("reports missing and incompatible peer dependencies as concrete blockers", () => {
    const absent = checkCompatibility(manifest({ peerDependencies: { react: "^18.0.0" } }), { license: "MIT" }, "MIT");
    const wrong = checkCompatibility(manifest({ peerDependencies: { react: "^18.0.0" } }), {
      dependencies: { react: "17.0.2" }, license: "MIT",
    }, "MIT");

    checked(absent);
    checked(wrong);
    expect(absent.verdict).toBe("conflicts");
    expect(absent.findings).toContainEqual(expect.objectContaining({ kind: "peer-unmet", severity: "blocker" }));
    expect(wrong.verdict).toBe("conflicts");
    expect(wrong.findings).toContainEqual(expect.objectContaining({
      kind: "peer-conflict", severity: "blocker", evidence: expect.stringContaining("^18.0.0"),
    }));
    expect(wrong.findings.find((finding) => finding.kind === "peer-conflict")?.evidence).toContain("17.0.2");
  });

  it("reports a satisfying existing dependency as no-change-needed compatibility", () => {
    const report = checkCompatibility(manifest(), { dependencies: { axios: "^1.6.0" }, license: "MIT" }, "MIT");

    checked(report);
    expect(report.verdict).toBe("compatible");
    expect(report.findings).toContainEqual(expect.objectContaining({
      kind: "already-present", severity: "info", detail: expect.stringContaining("no change needed"),
    }));
    expect(report.findings).toContainEqual(expect.objectContaining({ kind: "license", severity: "info" }));
  });

  it("reports incompatible Node engine ranges as a blocker", () => {
    const report = checkCompatibility(manifest({ runtime: { engines: { node: ">=22" }, os: null, cpu: null } }), {
      engines: { node: "^20.0.0" }, license: "MIT",
    }, "MIT");

    checked(report);
    expect(report.verdict).toBe("conflicts");
    expect(report.findings).toContainEqual(expect.objectContaining({ kind: "runtime-mismatch", severity: "blocker" }));
  });

  it("reuses license compatibility for a GPL component in an MIT project", () => {
    const report = checkCompatibility(manifest(), { license: "MIT" }, "GPL-3.0");

    checked(report);
    expect(report).toMatchObject({ verdict: "conflicts", findings: [expect.objectContaining({ kind: "license", severity: "blocker" })] });
  });

  it("fails closed for an unparseable range instead of declaring compatibility", () => {
    const report = checkCompatibility(manifest({ peerDependencies: { react: "not-a-range" } }), {
      dependencies: { react: "^18.0.0" }, license: "MIT",
    }, "MIT");

    checked(report);
    expect(report.verdict).toBe("unknown");
    expect(report.notes.join(" ")).toMatch(/cannot parse/i);
  });

  it("is deterministic for repeated inputs", () => {
    const input: ProjectContext = { dependencies: { axios: "^1.6.0" }, engines: { node: ">=22" }, license: "MIT" };
    const inputManifest = manifest({ runtime: { engines: { node: ">=20" }, os: null, cpu: null } });
    const first = checkCompatibility(inputManifest, input, "Apache-2.0");
    const second = checkCompatibility(inputManifest, input, "Apache-2.0");

    checked(first);
    checked(second);
    expect(second).toEqual(first);
  });
});
