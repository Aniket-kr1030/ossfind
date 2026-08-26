/**
 * Python project compatibility checker.
 * Compares IntegrationManifest facts with Python project context facts (PEP 440 / PEP 508),
 * enforcing fail-closed uncertainty tracking and producing CompatibilityReport.
 */

import {
  CompatibilityReportSchema,
  type CompatibilityReport,
} from "../contracts/compatibility-report.js";
import type { IntegrationManifest } from "../contracts/integration-manifest.js";
import { checkLicense } from "../license/compat.js";
import {
  normalizeDistributionName,
  parsePep508Requirement,
  type PyProjectContext,
} from "./py-project.js";

type Finding = CompatibilityReport["findings"][number];

export interface ParsedVersion {
  epoch: number;
  release: number[];
  prerelease?: { phase: "a" | "b" | "rc" | "dev"; num: number };
  post?: number;
}

export type ComparatorOp = "==" | "!=" | ">=" | "<=" | ">" | "<" | "~=" | "===";

export interface VersionClause {
  op: ComparatorOp;
  versionStr: string;
  parsed: ParsedVersion;
  wildcardPrefix?: number[];
}

function knownText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parses a PEP 440 version string into its numeric and tag components.
 * Supports standard release numbers, epochs, prereleases (a/b/rc/dev), and postreleases.
 */
export function parsePep440Version(raw: string): ParsedVersion | null {
  const trimmed = raw.trim().replace(/^v/i, "");
  if (!trimmed) return null;

  // Epoch: e.g. 1!2.0.0
  let epoch = 0;
  let versionPart = trimmed;
  const epochMatch = /^(\d+)!/.exec(versionPart);
  if (epochMatch) {
    epoch = parseInt(epochMatch[1], 10);
    versionPart = versionPart.slice(epochMatch[0].length);
  }

  // Release segments: e.g. 2.34.2
  const releaseMatch = /^(\d+(?:\.\d+)*)/.exec(versionPart);
  if (!releaseMatch) return null;

  const release = releaseMatch[1].split(".").map((seg) => parseInt(seg, 10));
  if (release.some((n) => Number.isNaN(n))) return null;

  let remainder = versionPart.slice(releaseMatch[0].length);
  let prerelease: ParsedVersion["prerelease"];
  let post: number | undefined;

  if (remainder) {
    const preMatch = /^[._-]?(a|alpha|b|beta|rc|c|preview|pre|dev)[._-]?(\d+)?/i.exec(remainder);
    if (preMatch) {
      let phase: "a" | "b" | "rc" | "dev" = "rc";
      const tag = preMatch[1].toLowerCase();
      if (tag.startsWith("a")) phase = "a";
      else if (tag.startsWith("b")) phase = "b";
      else if (tag === "dev") phase = "dev";
      prerelease = { phase, num: preMatch[2] ? parseInt(preMatch[2], 10) : 0 };
      remainder = remainder.slice(preMatch[0].length);
    }

    if (remainder) {
      const postMatch = /^[._-]?(?:post|rev|r)[._-]?(\d+)?/i.exec(remainder);
      if (postMatch) {
        post = postMatch[1] ? parseInt(postMatch[1], 10) : 0;
      }
    }
  }

  return { epoch, release, prerelease, post };
}

/**
 * Compares two PEP 440 parsed versions.
 * Returns negative if a < b, 0 if a == b, positive if a > b.
 */
export function compareParsedVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;

  const maxLen = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < maxLen; i++) {
    const segA = a.release[i] ?? 0;
    const segB = b.release[i] ?? 0;
    if (segA !== segB) return segA - segB;
  }

  // Prerelease versions are strictly less than final release versions
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && b.prerelease) {
    const phaseOrder = { dev: 0, a: 1, b: 2, rc: 3 };
    const phaseDiff = phaseOrder[a.prerelease.phase] - phaseOrder[b.prerelease.phase];
    if (phaseDiff !== 0) return phaseDiff;
    if (a.prerelease.num !== b.prerelease.num) return a.prerelease.num - b.prerelease.num;
  }

  // Postrelease versions are strictly greater than final release versions
  const postA = a.post ?? -1;
  const postB = b.post ?? -1;
  return postA - postB;
}

/**
 * Parses a PEP 440 version specifier (e.g. ">=2.0,<3", "==3.10.*", "~=2.2").
 */
export function parsePep440Specifier(specifierStr: string): VersionClause[] | null {
  const trimmed = specifierStr.trim();
  if (!trimmed || trimmed === "*" || trimmed === "latest") return [];

  const rawClauses = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  const clauses: VersionClause[] = [];

  for (const raw of rawClauses) {
    const match = /^(==|!=|>=|<=|>|<|~=|===)?\s*(.+)$/.exec(raw);
    if (!match) return null;

    const op: ComparatorOp = (match[1] as ComparatorOp) || "==";
    const versionPart = match[2].trim();

    let wildcardPrefix: number[] | undefined;
    let cleanVersion = versionPart;

    if (versionPart.endsWith(".*") || versionPart === "*") {
      const prefixStr = versionPart.replace(/\.?\*$/, "");
      if (prefixStr) {
        wildcardPrefix = prefixStr.split(".").map((n) => parseInt(n, 10));
        if (wildcardPrefix.some((n) => Number.isNaN(n))) return null;
        cleanVersion = prefixStr;
      } else {
        // Just "*"
        continue;
      }
    }

    const parsed = parsePep440Version(cleanVersion);
    if (!parsed) return null;

    clauses.push({ op, versionStr: versionPart, parsed, wildcardPrefix });
  }

  return clauses;
}

/**
 * Evaluates whether a concrete version string satisfies a PEP 440 specifier string.
 * Returns boolean, or null if either cannot be parsed.
 */
export function versionSatisfiesSpecifier(versionStr: string, specifierStr: string): boolean | null {
  const parsedVer = parsePep440Version(versionStr);
  if (!parsedVer) return null;

  const clauses = parsePep440Specifier(specifierStr);
  if (!clauses) return null;

  return clauses.every((clause) => {
    if (clause.op === "==") {
      if (clause.wildcardPrefix) {
        for (let i = 0; i < clause.wildcardPrefix.length; i++) {
          if ((parsedVer.release[i] ?? 0) !== clause.wildcardPrefix[i]) return false;
        }
        return true;
      }
      return compareParsedVersions(parsedVer, clause.parsed) === 0;
    }

    if (clause.op === "!=") {
      if (clause.wildcardPrefix) {
        for (let i = 0; i < clause.wildcardPrefix.length; i++) {
          if ((parsedVer.release[i] ?? 0) !== clause.wildcardPrefix[i]) return true;
        }
        return false;
      }
      return compareParsedVersions(parsedVer, clause.parsed) !== 0;
    }

    if (clause.op === ">=") return compareParsedVersions(parsedVer, clause.parsed) >= 0;
    if (clause.op === "<=") return compareParsedVersions(parsedVer, clause.parsed) <= 0;
    if (clause.op === ">") return compareParsedVersions(parsedVer, clause.parsed) > 0;
    if (clause.op === "<") return compareParsedVersions(parsedVer, clause.parsed) < 0;

    if (clause.op === "~=") {
      // Compatible release: ~= X.Y.Z -> >= X.Y.Z, < X.(Y+1).0
      // ~= X.Y -> >= X.Y, < (X+1).0
      if (compareParsedVersions(parsedVer, clause.parsed) < 0) return false;
      const upperRelease = [...clause.parsed.release];
      if (upperRelease.length <= 2) {
        upperRelease[0] += 1;
        upperRelease.length = 1;
      } else {
        upperRelease[upperRelease.length - 2] += 1;
        upperRelease.length = upperRelease.length - 1;
      }
      const upperVer: ParsedVersion = { epoch: clause.parsed.epoch, release: upperRelease };
      return compareParsedVersions(parsedVer, upperVer) < 0;
    }

    return compareParsedVersions(parsedVer, clause.parsed) === 0;
  });
}

interface IntervalBound {
  version: ParsedVersion;
  inclusive: boolean;
}

/**
 * Checks whether two PEP 440 specifiers intersect (i.e. have at least one common satisfying version).
 * Returns { intersect: boolean } or null if beyond supported subset.
 */
export function specifiersIntersect(spec1: string, spec2: string): { intersect: boolean } | null {
  const clauses1 = parsePep440Specifier(spec1);
  const clauses2 = parsePep440Specifier(spec2);
  if (!clauses1 || !clauses2) return null;

  if (clauses1.length === 0 || clauses2.length === 0) return { intersect: true };

  const allClauses = [...clauses1, ...clauses2];

  // If there are exact equality clauses (without wildcards), test each candidate version
  const exactClauses = allClauses.filter((c) => c.op === "==" && !c.wildcardPrefix);
  if (exactClauses.length > 0) {
    const candidate = exactClauses[0].parsed;
    const satisfiesAll = allClauses.every((c) => {
      if (c.op === "==") {
        if (c.wildcardPrefix) {
          for (let i = 0; i < c.wildcardPrefix.length; i++) {
            if ((candidate.release[i] ?? 0) !== c.wildcardPrefix[i]) return false;
          }
          return true;
        }
        return compareParsedVersions(candidate, c.parsed) === 0;
      }
      if (c.op === "!=") {
        if (c.wildcardPrefix) {
          for (let i = 0; i < c.wildcardPrefix.length; i++) {
            if ((candidate.release[i] ?? 0) !== c.wildcardPrefix[i]) return true;
          }
          return false;
        }
        return compareParsedVersions(candidate, c.parsed) !== 0;
      }
      if (c.op === ">=") return compareParsedVersions(candidate, c.parsed) >= 0;
      if (c.op === "<=") return compareParsedVersions(candidate, c.parsed) <= 0;
      if (c.op === ">") return compareParsedVersions(candidate, c.parsed) > 0;
      if (c.op === "<") return compareParsedVersions(candidate, c.parsed) < 0;
      if (c.op === "~=") {
        if (compareParsedVersions(candidate, c.parsed) < 0) return false;
        const upperRelease = [...c.parsed.release];
        if (upperRelease.length <= 2) {
          upperRelease[0] += 1;
          upperRelease.length = 1;
        } else {
          upperRelease[upperRelease.length - 2] += 1;
          upperRelease.length = upperRelease.length - 1;
        }
        const upperVer: ParsedVersion = { epoch: c.parsed.epoch, release: upperRelease };
        return compareParsedVersions(candidate, upperVer) < 0;
      }
      return compareParsedVersions(candidate, c.parsed) === 0;
    });
    return { intersect: satisfiesAll };
  }

  // Derive continuous interval bounds
  let maxLower: IntervalBound | null = null;
  let minUpper: IntervalBound | null = null;

  for (const c of allClauses) {
    if (c.op === ">=" || c.op === ">") {
      const bound: IntervalBound = { version: c.parsed, inclusive: c.op === ">=" };
      if (!maxLower || compareParsedVersions(bound.version, maxLower.version) > 0 ||
          (compareParsedVersions(bound.version, maxLower.version) === 0 && !bound.inclusive && maxLower.inclusive)) {
        maxLower = bound;
      }
    } else if (c.op === "<=" || c.op === "<") {
      const bound: IntervalBound = { version: c.parsed, inclusive: c.op === "<=" };
      if (!minUpper || compareParsedVersions(bound.version, minUpper.version) < 0 ||
          (compareParsedVersions(bound.version, minUpper.version) === 0 && !bound.inclusive && minUpper.inclusive)) {
        minUpper = bound;
      }
    } else if (c.op === "~=") {
      // Lower bound >= c.parsed
      const lowerBound: IntervalBound = { version: c.parsed, inclusive: true };
      if (!maxLower || compareParsedVersions(lowerBound.version, maxLower.version) > 0) {
        maxLower = lowerBound;
      }
      // Upper bound < upperVer
      const upperRelease = [...c.parsed.release];
      if (upperRelease.length <= 2) {
        upperRelease[0] += 1;
        upperRelease.length = 1;
      } else {
        upperRelease[upperRelease.length - 2] += 1;
        upperRelease.length = upperRelease.length - 1;
      }
      const upperVer: ParsedVersion = { epoch: c.parsed.epoch, release: upperRelease };
      const upperBound: IntervalBound = { version: upperVer, inclusive: false };
      if (!minUpper || compareParsedVersions(upperBound.version, minUpper.version) < 0) {
        minUpper = upperBound;
      }
    } else if (c.op === "==" && c.wildcardPrefix) {
      // Prefix match == X.Y.* -> >= X.Y.0, < X.(Y+1).0
      const lowerVer: ParsedVersion = { epoch: c.parsed.epoch, release: [...c.wildcardPrefix] };
      const lowerBound: IntervalBound = { version: lowerVer, inclusive: true };
      if (!maxLower || compareParsedVersions(lowerBound.version, maxLower.version) > 0) {
        maxLower = lowerBound;
      }
      const upperRelease = [...c.wildcardPrefix];
      upperRelease[upperRelease.length - 1] += 1;
      const upperVer: ParsedVersion = { epoch: c.parsed.epoch, release: upperRelease };
      const upperBound: IntervalBound = { version: upperVer, inclusive: false };
      if (!minUpper || compareParsedVersions(upperBound.version, minUpper.version) < 0) {
        minUpper = upperBound;
      }
    }
  }

  if (maxLower && minUpper) {
    const cmp = compareParsedVersions(maxLower.version, minUpper.version);
    if (cmp > 0) return { intersect: false };
    if (cmp === 0) {
      if (!maxLower.inclusive || !minUpper.inclusive) return { intersect: false };
      // Degenerate closed single-point interval: maxLower.version == minUpper.version and both inclusive!
      // Test if this single point satisfies all != clauses in allClauses
      const singlePoint = maxLower.version;
      const notEqualClauses = allClauses.filter((c) => c.op === "!=");
      for (const ne of notEqualClauses) {
        if (ne.wildcardPrefix) {
          let matchesPrefix = true;
          for (let i = 0; i < ne.wildcardPrefix.length; i++) {
            if ((singlePoint.release[i] ?? 0) !== ne.wildcardPrefix[i]) {
              matchesPrefix = false;
              break;
            }
          }
          if (matchesPrefix) {
            return { intersect: false };
          }
        } else {
          if (compareParsedVersions(singlePoint, ne.parsed) === 0) {
            return { intersect: false };
          }
        }
      }
    }
  }

  return { intersect: true };
}

function pyDeclarationsFor(project: PyProjectContext, name: string): Array<[string, string]> {
  const target = normalizeDistributionName(name);
  return (["dependencies", "devDependencies"] as const).flatMap((section) => {
    const sectionObj = project[section];
    if (!sectionObj) return [];
    return Object.entries(sectionObj)
      .filter(([k]) => normalizeDistributionName(k) === target)
      .map(([, v]) => [section, v] as [string, string]);
  });
}

function extractComponentRequirements(manifest: IntegrationManifest): Map<string, { specifier: string; rawEvidence: string }> {
  const reqs = new Map<string, { specifier: string; rawEvidence: string }>();

  // Check peerDependencies
  for (const [name, spec] of Object.entries(manifest.peerDependencies)) {
    const norm = normalizeDistributionName(name);
    reqs.set(norm, { specifier: spec, rawEvidence: `manifest.peerDependencies.${name}=${JSON.stringify(spec)}` });
  }

  // Check prerequisites
  for (const prereq of manifest.prerequisites) {
    if (prereq.kind === "peer-dependency") {
      const norm = normalizeDistributionName(prereq.name);
      if (!reqs.has(norm)) {
        let specifier = "";
        const match = /info\.requires_dist:\s*"([^"]+)"/.exec(prereq.evidence);
        if (match) {
          const parsed = parsePep508Requirement(match[1]);
          if (parsed) specifier = parsed.specifier;
        } else {
          const direct = parsePep508Requirement(prereq.evidence);
          if (direct) specifier = direct.specifier;
        }
        reqs.set(norm, { specifier, rawEvidence: prereq.evidence });
      }
    }
  }

  return reqs;
}

/**
 * Checks compatibility between a PyPI component's IntegrationManifest and a Python project context.
 * Performs requirement conflict checking, Python runtime version matching, already-present checking,
 * and license verification with deterministic sorting and fail-closed uncertainty tracking.
 */
export function checkPyCompatibility(
  manifest: IntegrationManifest,
  project: PyProjectContext,
  componentLicense?: string,
): CompatibilityReport {
  const findings: Finding[] = [];
  const notes = new Set<string>();
  let uncertain = false;

  const markUnknown = (note: string): void => {
    uncertain = true;
    notes.add(note);
  };

  // Carry over parser notes and uncertainty from project context
  if (project.notes) {
    for (const note of project.notes) {
      notes.add(note);
    }
  }
  if (project.uncertain) {
    uncertain = true;
    if (notes.size === 0) {
      notes.add("Project context is uncertain or unparseable.");
    }
  }

  const componentName = manifest.id.startsWith("pypi:")
    ? manifest.id.slice("pypi:".length)
    : undefined;

  // 1. Component already present / version conflict check
  if (!componentName) {
    markUnknown(`Cannot compare ${manifest.id} with Python dependencies because only PyPI component IDs map to Python packages.`);
  } else {
    for (const [section, projectRange] of pyDeclarationsFor(project, componentName)) {
      if (!manifest.version) {
        markUnknown(`Cannot compare project.${section}.${componentName} with the component because manifest.version is missing.`);
        continue;
      }
      const satisfies = versionSatisfiesSpecifier(manifest.version, projectRange);
      if (satisfies === null) {
        markUnknown(`Cannot parse project.${section}.${componentName} specifier ${JSON.stringify(projectRange)}.`);
      } else if (satisfies) {
        findings.push({
          kind: "already-present",
          severity: "info",
          detail: `${componentName}@${manifest.version} is already present in project ${section}; no change needed.`,
          evidence: `manifest.version=${JSON.stringify(manifest.version)}; project.${section}.${componentName}=${JSON.stringify(projectRange)}`,
        });
      } else {
        findings.push({
          kind: "version-conflict",
          severity: "blocker",
          detail: `${componentName}@${manifest.version} does not satisfy the project's declared ${section} specifier ${projectRange}.`,
          evidence: `manifest.version=${JSON.stringify(manifest.version)}; project.${section}.${componentName}=${JSON.stringify(projectRange)}`,
        });
      }
    }
  }

  // 2. Requirement conflict check (component runtime requirements vs project pinned dependencies)
  const componentRequirements = extractComponentRequirements(manifest);
  for (const [normName, req] of [...componentRequirements.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const declarations = pyDeclarationsFor(project, normName);
    if (declarations.length === 0) continue;

    for (const [section, projectRange] of declarations) {
      if (!req.specifier || req.specifier === "*") continue;

      const result = specifiersIntersect(projectRange, req.specifier);
      if (result === null) {
        markUnknown(`Cannot parse project.${section}.${normName} specifier ${JSON.stringify(projectRange)} or required specifier ${JSON.stringify(req.specifier)}.`);
      } else if (!result.intersect) {
        findings.push({
          kind: "peer-conflict",
          severity: "blocker",
          detail: `Project ${section}.${normName} specifier ${projectRange} cannot satisfy component runtime requirement ${req.specifier}.`,
          evidence: `project.${section}.${normName}=${JSON.stringify(projectRange)}; component.prerequisite.${normName}=${JSON.stringify(req.specifier)}`,
        });
      }
    }
  }

  // 3. Python version requirement check (requires-python / runtime.engines.python)
  const componentPython = manifest.runtime.engines.python;
  if (knownText(componentPython)) {
    const projectPython = project.requiresPython ?? project.engines?.python;
    if (!knownText(projectPython)) {
      markUnknown(`Cannot compare component.runtime.engines.python ${JSON.stringify(componentPython)} because project Python requirement is missing.`);
    } else {
      const result = specifiersIntersect(projectPython, componentPython);
      if (result === null) {
        markUnknown(`Cannot parse Python requirement project: ${JSON.stringify(projectPython)} or component: ${JSON.stringify(componentPython)}.`);
      } else if (!result.intersect) {
        findings.push({
          kind: "runtime-mismatch",
          severity: "blocker",
          detail: `Project Python requirement ${projectPython} cannot satisfy component Python requirement ${componentPython}.`,
          evidence: `project.requires_python=${JSON.stringify(projectPython)}; component.runtime.engines.python=${JSON.stringify(componentPython)}`,
        });
      }
    }
  }

  // 4. License compatibility check
  if (!knownText(project.license) || !knownText(componentLicense)) {
    markUnknown("Cannot verify license compatibility because both project.license and componentLicense are required.");
  } else {
    const license = checkLicense(project.license, componentLicense);
    if (license.compatible === "no") {
      findings.push({
        kind: "license",
        severity: "blocker",
        detail: license.notes,
        evidence: `project.license=${JSON.stringify(project.license)}; componentLicense=${JSON.stringify(componentLicense)}`,
      });
    } else if (license.compatible === "conditional") {
      uncertain = true;
      findings.push({
        kind: "license",
        severity: "warning",
        detail: license.notes,
        evidence: `project.license=${JSON.stringify(project.license)}; componentLicense=${JSON.stringify(componentLicense)}`,
      });
    } else {
      findings.push({
        kind: "license",
        severity: "info",
        detail: license.notes,
        evidence: `project.license=${JSON.stringify(project.license)}; componentLicense=${JSON.stringify(componentLicense)}`,
      });
    }
  }

  // Deterministic finding sorting
  findings.sort((left, right) =>
    left.kind.localeCompare(right.kind) ||
    left.severity.localeCompare(right.severity) ||
    left.evidence.localeCompare(right.evidence) ||
    left.detail.localeCompare(right.detail)
  );

  const verdict = findings.some((finding) => finding.severity === "blocker")
    ? "conflicts"
    : uncertain
    ? "unknown"
    : "compatible";

  return CompatibilityReportSchema.parse({
    component: manifest.id,
    verdict,
    findings,
    notes: [...notes].sort(),
  });
}
