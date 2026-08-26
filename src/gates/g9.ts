import {
  checkPyCompatibility,
  compareParsedVersions,
  parsePep440Version,
  specifiersIntersect,
} from "../api/py-compat.js";
import { parsePyprojectToml, type PyProjectContext } from "../api/py-project.js";
import type { IntegrationManifest } from "../contracts/integration-manifest.js";
import type { Result } from "./types.js";

export const id = "G9";
export const description = "Python project-context honesty: unclosed/malformed metadata degrades to unknown verdict, degenerate != exclusions hold, and PEP 440 prereleases are preserved";

const unclosedTomlSample = `[project]
requires-python = ">=3.10"
dependencies = [
  "requests>=2.0",
  "numpy<2"
`;

function manifestFor(id = "pypi:requests", version = "2.31.0"): IntegrationManifest {
  return {
    id,
    version,
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
    runtime: { engines: { python: ">=3.10" }, os: null, cpu: null },
    peerDependencies: {},
    prerequisites: [],
    hasInstallScript: false,
    notes: [],
  };
}

export function hasPythonHonestyFact(
  tomlParser: (text: string) => PyProjectContext = parsePyprojectToml,
  compatChecker: typeof checkPyCompatibility = checkPyCompatibility,
  intersectChecker: typeof specifiersIntersect = specifiersIntersect,
  versionParser: typeof parsePep440Version = parsePep440Version,
): boolean {
  // 1. Malformed / unclosed TOML must be uncertain and yield 'unknown' (never 'compatible')
  const project = tomlParser(unclosedTomlSample);
  if (project.uncertain !== true) return false;

  const report = compatChecker(manifestFor(), { ...project, license: "MIT" }, "MIT");
  if (report.verdict === "compatible" || report.verdict !== "unknown") return false;

  // 2. != exclusion against a degenerate interval must NOT intersect
  const intersectResult = intersectChecker(">=2.0,<=2.0", "!=2.0");
  if (intersectResult === null || intersectResult.intersect !== false) return false;

  // 3. rc version must parse as prerelease and not postrelease
  const rc = versionParser("2.0.0rc1");
  if (!rc || rc.prerelease?.phase !== "rc" || rc.prerelease?.num !== 1 || rc.post !== undefined) return false;

  const rcPost = versionParser("2.0.0rc1.post0");
  if (!rcPost || compareParsedVersions(rc, rcPost) >= 0) return false;

  const rcSimple = versionParser("2.0rc1");
  const finalVer = versionParser("2.0");
  if (!rcSimple || !finalVer || compareParsedVersions(rcSimple, finalVer) >= 0) return false;

  return true;
}

export async function check(): Promise<Result> {
  try {
    return hasPythonHonestyFact()
      ? { status: "pass" }
      : {
          status: "fail",
          message: "Python project-context honesty violated: unclosed TOML was not unknown, != degenerate range intersected, or rc was misparsed",
        };
  } catch (error: unknown) {
    return { status: "fail", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function proveFailure(): Promise<Result> {
  // Mutant 1: Bypassing uncertainty (the blocker bug: silent empty dependencies returning compatible)
  const mutantUncertainty = (_toml: string): PyProjectContext => ({
    dependencies: {},
    requiresPython: ">=3.10",
    engines: { python: ">=3.10" },
    notes: [],
  });
  const unclosedDetected = !hasPythonHonestyFact(mutantUncertainty);

  // Mutant 2: Ignoring != in degenerate ranges (the should-fix bug)
  const mutantIntersect = () => ({ intersect: true });
  const intersectDetected = !hasPythonHonestyFact(undefined, undefined, mutantIntersect);

  // Mutant 3: Misparsing rc as post-release (the should-fix bug)
  const mutantVersionParser = (raw: string) => {
    if (raw.includes("rc")) {
      return {
        epoch: 0,
        release: [2, 0, 0],
        prerelease: { phase: "rc" as const, num: 1 },
        post: 0,
      };
    }
    return parsePep440Version(raw);
  };
  const versionDetected = !hasPythonHonestyFact(undefined, undefined, undefined, mutantVersionParser);

  if (unclosedDetected && intersectDetected && versionDetected) {
    return { status: "detected" };
  }
  return {
    status: "undetected",
    message: `G9 mutants were not all detected: unclosed=${unclosedDetected}, intersect=${intersectDetected}, version=${versionDetected}`,
  };
}
