import { describe, expect, it } from "vitest";
import { CompatibilityReportSchema } from "../contracts/compatibility-report.js";
import type { IntegrationManifest } from "../contracts/integration-manifest.js";
import {
  checkPyCompatibility,
  compareParsedVersions,
  parsePep440Specifier,
  parsePep440Version,
  specifiersIntersect,
  versionSatisfiesSpecifier,
} from "./py-compat.js";
import { parsePyprojectToml, parseRequirementsTxt, type PyProjectContext } from "./py-project.js";

function pyManifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return {
    id: "pypi:requests",
    version: "2.34.2",
    install: { command: "pip install requests" },
    importForm: {
      moduleType: "unknown",
      esm: null,
      cjs: null,
      typesPackage: null,
      python: {
        importName: "requests",
        statements: ["import requests"],
        confidence: "verified",
        evidence: "Verified import-name mapping",
      },
    },
    runtime: { engines: { python: ">=3.8" }, os: null, cpu: null },
    peerDependencies: {},
    prerequisites: [
      {
        kind: "peer-dependency",
        name: "urllib3",
        confidence: "verified",
        evidence: 'info.requires_dist: "urllib3<3,>=1.26".',
      },
      {
        kind: "peer-dependency",
        name: "certifi",
        confidence: "verified",
        evidence: 'info.requires_dist: "certifi>=2017.4.17".',
      },
    ],
    hasInstallScript: false,
    notes: [],
    ...overrides,
  };
}

function checked(report: unknown): void {
  expect(CompatibilityReportSchema.parse(report)).toEqual(report);
}

describe("PEP 440 utilities", () => {
  it("parses and compares versions correctly", () => {
    const v1 = parsePep440Version("2.34.2");
    const v2 = parsePep440Version("2.34.0");
    const v3 = parsePep440Version("3.0.0");
    const vPre = parsePep440Version("2.34.2a1");

    expect(v1).not.toBeNull();
    expect(v2).not.toBeNull();
    expect(v3).not.toBeNull();
    expect(vPre).not.toBeNull();

    expect(compareParsedVersions(v1!, v2!)).toBeGreaterThan(0);
    expect(compareParsedVersions(v2!, v3!)).toBeLessThan(0);
    expect(compareParsedVersions(vPre!, v1!)).toBeLessThan(0);
  });

  it("checks versionSatisfiesSpecifier with various PEP 440 operators", () => {
    expect(versionSatisfiesSpecifier("2.34.2", ">=2.0,<3")).toBe(true);
    expect(versionSatisfiesSpecifier("3.0.0", ">=2.0,<3")).toBe(false);
    expect(versionSatisfiesSpecifier("2.34.2", "==2.34.*")).toBe(true);
    expect(versionSatisfiesSpecifier("2.35.0", "==2.34.*")).toBe(false);
    expect(versionSatisfiesSpecifier("2.2.5", "~=2.2")).toBe(true);
    expect(versionSatisfiesSpecifier("3.0.0", "~=2.2")).toBe(false);
    expect(versionSatisfiesSpecifier("1.4.6", "~=1.4.5")).toBe(true);
    expect(versionSatisfiesSpecifier("1.5.0", "~=1.4.5")).toBe(false);
  });

  it("checks specifiersIntersect for overlapping and disjoint ranges", () => {
    expect(specifiersIntersect(">=1.26,<3", "==1.25.0")?.intersect).toBe(false);
    expect(specifiersIntersect(">=1.26,<3", ">=2.0,<4")?.intersect).toBe(true);
    expect(specifiersIntersect(">=3.8", ">=3.10")?.intersect).toBe(true);
    expect(specifiersIntersect(">=3.10", "<3.9")?.intersect).toBe(false);
    expect(specifiersIntersect(">=3.9", "==3.8.*")?.intersect).toBe(false);
  });
});

describe("checkPyCompatibility", () => {
  it("reports a conflicting pin in requirements.txt as a blocker", () => {
    const reqText = `
      # Conflicting pin
      urllib3==1.25.0
    `;
    const project = parseRequirementsTxt(reqText);
    project.requiresPython = ">=3.10";
    project.license = "MIT";

    const report = checkPyCompatibility(pyManifest(), project, "Apache-2.0");

    checked(report);
    expect(report.verdict).toBe("conflicts");
    expect(report.findings).toContainEqual(expect.objectContaining({
      kind: "peer-conflict",
      severity: "blocker",
      detail: expect.stringContaining("urllib3"),
    }));
  });

  it("reports python-version mismatch as a blocker", () => {
    const project: PyProjectContext = {
      requiresPython: "<3.7",
      license: "MIT",
    };

    const report = checkPyCompatibility(pyManifest(), project, "MIT");

    checked(report);
    expect(report.verdict).toBe("conflicts");
    expect(report.findings).toContainEqual(expect.objectContaining({
      kind: "runtime-mismatch",
      severity: "blocker",
      detail: expect.stringContaining("Project Python requirement <3.7 cannot satisfy component Python requirement >=3.8"),
    }));
  });

  it("reports already-present component at a satisfying version as info", () => {
    const reqText = `
      requests>=2.28.0,<3
    `;
    const project = parseRequirementsTxt(reqText);
    project.requiresPython = ">=3.10";
    project.license = "MIT";

    const report = checkPyCompatibility(pyManifest(), project, "Apache-2.0");

    checked(report);
    expect(report.verdict).toBe("compatible");
    expect(report.findings).toContainEqual(expect.objectContaining({
      kind: "already-present",
      severity: "info",
      detail: expect.stringContaining("requests@2.34.2 is already present in project dependencies; no change needed"),
    }));
  });

  it("reports version-conflict when component version does not satisfy project declaration", () => {
    const project: PyProjectContext = {
      dependencies: { requests: "<2.0.0" },
      requiresPython: ">=3.8",
      license: "MIT",
    };

    const report = checkPyCompatibility(pyManifest({ version: "2.34.2" }), project, "MIT");

    checked(report);
    expect(report.verdict).toBe("conflicts");
    expect(report.findings).toContainEqual(expect.objectContaining({
      kind: "version-conflict",
      severity: "blocker",
      detail: expect.stringContaining("requests@2.34.2 does not satisfy the project's declared dependencies specifier <2.0.0"),
    }));
  });

  it("fails closed with unknown and an honest note for an unparseable pyproject.toml (The Honesty Test)", () => {
    const unparseableToml = `
[tool.poetry]
name = "poetry-app"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.10"
requests = "^2.28.0"
    `;
    const project = parsePyprojectToml(unparseableToml);
    project.license = "MIT";

    const report = checkPyCompatibility(pyManifest(), project, "MIT");

    checked(report);
    expect(report.verdict).toBe("unknown");
    expect(report.notes).toContainEqual(expect.stringContaining("No [project] table found in pyproject.toml"));
  });

  it("handles extras and environment markers from parsed requirements.txt", () => {
    const reqText = `
      requests[socks]>=2.28.0
      certifi>=2020.0.0; python_version >= '3.8'
    `;
    const project = parseRequirementsTxt(reqText);
    project.requiresPython = ">=3.9";
    project.license = "MIT";

    const report = checkPyCompatibility(pyManifest(), project, "MIT");

    checked(report);
    expect(report.verdict).toBe("compatible");
    expect(report.notes).toContainEqual(expect.stringContaining('Ignored extras [socks] for package "requests"'));
    expect(report.notes).toContainEqual(expect.stringContaining('Recorded environment marker "python_version >= \'3.8\'"'));
  });

  it("reuses license compatibility checking (GPL component in MIT project)", () => {
    const project: PyProjectContext = {
      requiresPython: ">=3.9",
      license: "MIT",
    };

    const report = checkPyCompatibility(pyManifest(), project, "GPL-3.0");

    checked(report);
    expect(report.verdict).toBe("conflicts");
    expect(report.findings).toContainEqual(expect.objectContaining({
      kind: "license",
      severity: "blocker",
    }));
  });

  it("fails closed when project Python requirement is missing", () => {
    const project: PyProjectContext = {
      license: "MIT",
    };

    const report = checkPyCompatibility(pyManifest(), project, "MIT");

    checked(report);
    expect(report.verdict).toBe("unknown");
    expect(report.notes).toContainEqual(expect.stringContaining("project Python requirement is missing"));
  });

  it("is deterministic for repeated runs", () => {
    const project: PyProjectContext = {
      dependencies: { urllib3: ">=1.26,<3" },
      requiresPython: ">=3.10",
      license: "MIT",
    };
    const first = checkPyCompatibility(pyManifest(), project, "Apache-2.0");
    const second = checkPyCompatibility(pyManifest(), project, "Apache-2.0");

    checked(first);
    checked(second);
    expect(second).toEqual(first);
  });
});
