import * as semver from "semver";
import {
  CompatibilityReportSchema,
  type CompatibilityReport,
} from "../contracts/compatibility-report.js";
import type { IntegrationManifest } from "../contracts/integration-manifest.js";
import { checkLicense } from "../license/compat.js";

/** The package.json facts available to the project consuming a component. */
export interface ProjectContext {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  license?: string;
}

type Finding = CompatibilityReport["findings"][number];

function declarationsFor(project: ProjectContext, name: string): Array<[string, string]> {
  return (["dependencies", "devDependencies"] as const).flatMap((section) => {
    const value = project[section]?.[name];
    return typeof value === "string" ? [[section, value]] : [];
  });
}

function knownText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validRange(value: string): string | null {
  return semver.validRange(value);
}

/**
 * Compares registry-derived integration facts with a project's supplied
 * package.json facts. Missing or invalid facts never establish compatibility.
 */
export function checkCompatibility(
  manifest: IntegrationManifest,
  project: ProjectContext,
  componentLicense?: string,
): CompatibilityReport {
  const findings: Finding[] = [];
  const notes = new Set<string>();
  let uncertain = false;
  const componentName = manifest.id.startsWith("npm:") ? manifest.id.slice("npm:".length) : undefined;

  const markUnknown = (note: string): void => {
    uncertain = true;
    notes.add(note);
  };

  for (const [peerName, peerRange] of Object.entries(manifest.peerDependencies)
    .sort(([left], [right]) => left.localeCompare(right))) {
    const declarations = declarationsFor(project, peerName);
    if (declarations.length === 0) {
      findings.push({
        kind: "peer-unmet",
        severity: "blocker",
        detail: `Required peer dependency ${peerName} is absent from the project.`,
        evidence: `component.peerDependencies.${peerName}=${JSON.stringify(peerRange)}; project.dependencies.${peerName}=absent; project.devDependencies.${peerName}=absent`,
      });
      continue;
    }

    const normalizedPeerRange = validRange(peerRange);
    if (!normalizedPeerRange) {
      markUnknown(`Cannot parse component.peerDependencies.${peerName} range ${JSON.stringify(peerRange)}.`);
      continue;
    }

    for (const [section, projectRange] of declarations) {
      const normalizedProjectRange = validRange(projectRange);
      if (!normalizedProjectRange) {
        markUnknown(`Cannot parse project.${section}.${peerName} range ${JSON.stringify(projectRange)}.`);
      } else if (!semver.intersects(normalizedProjectRange, normalizedPeerRange)) {
        findings.push({
          kind: "peer-conflict",
          severity: "blocker",
          detail: `Project ${section}.${peerName} range ${projectRange} cannot satisfy required peer range ${peerRange}.`,
          evidence: `project.${section}.${peerName}=${JSON.stringify(projectRange)}; component.peerDependencies.${peerName}=${JSON.stringify(peerRange)}`,
        });
      }
    }
  }

  if (!componentName) {
    markUnknown(`Cannot compare ${manifest.id} with package.json dependencies because only npm component IDs map to dependency names.`);
  } else {
    for (const [section, projectRange] of declarationsFor(project, componentName)) {
      if (!manifest.version) {
        markUnknown(`Cannot compare project.${section}.${componentName} with the component because manifest.version is missing.`);
        continue;
      }
      const normalizedProjectRange = validRange(projectRange);
      const normalizedComponentVersion = semver.valid(manifest.version);
      if (!normalizedProjectRange) {
        markUnknown(`Cannot parse project.${section}.${componentName} range ${JSON.stringify(projectRange)}.`);
      } else if (!normalizedComponentVersion) {
        markUnknown(`Cannot parse manifest.version ${JSON.stringify(manifest.version)} for ${componentName}.`);
      } else if (semver.satisfies(normalizedComponentVersion, normalizedProjectRange)) {
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
          detail: `${componentName}@${manifest.version} does not satisfy the project's declared ${section} range ${projectRange}.`,
          evidence: `manifest.version=${JSON.stringify(manifest.version)}; project.${section}.${componentName}=${JSON.stringify(projectRange)}`,
        });
      }
    }
  }

  const componentNodeRange = manifest.runtime.engines.node;
  if (knownText(componentNodeRange)) {
    const projectNodeRange = project.engines?.node;
    if (!knownText(projectNodeRange)) {
      markUnknown(`Cannot compare component.runtime.engines.node ${JSON.stringify(componentNodeRange)} because project.engines.node is missing.`);
    } else {
      const normalizedComponentNodeRange = validRange(componentNodeRange);
      const normalizedProjectNodeRange = validRange(projectNodeRange);
      if (!normalizedComponentNodeRange) {
        markUnknown(`Cannot parse component.runtime.engines.node range ${JSON.stringify(componentNodeRange)}.`);
      } else if (!normalizedProjectNodeRange) {
        markUnknown(`Cannot parse project.engines.node range ${JSON.stringify(projectNodeRange)}.`);
      } else if (!semver.intersects(normalizedProjectNodeRange, normalizedComponentNodeRange)) {
        findings.push({
          kind: "runtime-mismatch",
          severity: "blocker",
          detail: `Project Node range ${projectNodeRange} cannot satisfy component Node range ${componentNodeRange}.`,
          evidence: `project.engines.node=${JSON.stringify(projectNodeRange)}; component.runtime.engines.node=${JSON.stringify(componentNodeRange)}`,
        });
      }
    }
  }

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

  findings.sort((left, right) => left.kind.localeCompare(right.kind)
    || left.severity.localeCompare(right.severity)
    || left.evidence.localeCompare(right.evidence)
    || left.detail.localeCompare(right.detail));
  const verdict = findings.some((finding) => finding.severity === "blocker")
    ? "conflicts"
    : uncertain ? "unknown" : "compatible";
  return CompatibilityReportSchema.parse({ component: manifest.id, verdict, findings, notes: [...notes].sort() });
}
