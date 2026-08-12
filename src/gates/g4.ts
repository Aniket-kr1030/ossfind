import { buildPipeline } from "../mcp/pipeline.js";
import { searchComponents } from "../pipeline/orchestrator.js";
import type { Result } from "./types.js";
import type { ScoredComponent } from "../contracts/index.js";

export const id = "G4";
export const description = "License check: GPL-3.0 component into an MIT project is never 'ship'";

export function isLicenseOk(results: ScoredComponent[]): boolean {
  for (const r of results) {
    if (r.badges.license === "GPL-3.0" && r.verdict === "ship") {
      return false;
    }
  }
  return true;
}

export async function check(): Promise<Result> {
  try {
    const pipeline = buildPipeline({ fixtures: true, projectLicense: "MIT" });
    const results = await searchComponents("http-client", pipeline);

    if (!isLicenseOk(results)) {
      return { status: "fail", message: "GPL-3.0 component was marked as ship in MIT project" };
    }
    return { status: "pass" };
  } catch (e: any) {
    return { status: "fail", message: e.message };
  }
}

export async function proveFailure(): Promise<Result> {
  const badComponent: any = {
    id: "npm:gpl-pkg",
    name: "gpl-pkg",
    overall: 90,
    verdict: "ship",
    badges: {
      license: "GPL-3.0",
      cveCount: 0,
      scorecard: null,
    },
  };

  if (!isLicenseOk([badComponent])) {
    return { status: "detected" };
  }

  return { status: "undetected", message: "License check failed to detect GPL-3.0 component marked as ship" };
}
