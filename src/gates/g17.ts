import { HttpEnricher } from "../adapters/enrichment.js";
import { repositoryClaimCorroborated } from "../adapters/repo-claim.js";
import type { HttpClient } from "../http/client.js";
import { WeightedRanker } from "../ranking/rank.js";
import type { Result } from "./types.js";

export const id = "G17";
export const description = "Health evidence belongs to the package: an uncorroborated repository claim never earns a ship verdict";

/**
 * A package's repository URL is self-declared, and typosquats name the real project's
 * repository to inherit its reputation. Searching PyPI for "http requests" returned
 * `definitely-not-requests`, `degree72-requests`, `odigos-requests` and `requeste` —
 * all declaring `github.com/psf/requests`, all copying its summary verbatim, and all
 * reported SHIP 92/100 on psf/requests' OpenSSF score of 8.1.
 *
 * This gate holds the whole chain: the name check itself, the enricher refusing to
 * fetch health evidence for an uncorroborated claim, and the ranker refusing to ship
 * without it.
 */

const IMPOSTOR_REPO = "https://github.com/psf/requests";

type Corroborator = typeof repositoryClaimCorroborated;

/** Serves a scorecard of 9.5 for any project asked about, so a leak is unmistakable. */
function supplier(repoUrl: string): HttpClient {
  return async (url) => {
    if (url.includes("packages.ecosyste.ms")) {
      return { ok: true, status: 200, json: async () => ({
        normalized_licenses: ["Apache-2.0"],
        latest_release_number: "1.0.0",
        repository_url: repoUrl,
      }) };
    }
    if (url.includes("api.osv.dev")) return { ok: true, status: 200, json: async () => ({ vulns: [] }) };
    if (url.includes("/v3/projects/")) {
      return { ok: true, status: 200, json: async () => ({ scorecard: { overallScore: 9.5, checks: [] } }) };
    }
    return { ok: true, status: 200, json: async () => ({ versions: [] }) };
  };
}

async function verdictFor(packageName: string, repoUrl: string): Promise<{ verdict: string; scorecard: number | null }> {
  const bundle = await new HttpEnricher(supplier(repoUrl)).enrich({
    id: `pypi:${packageName}`, name: packageName, ecosystem: "pypi", description: "Python HTTP for Humans.",
  });
  const [scored] = new WeightedRanker({ projectLicense: "MIT" }).rank(
    "http requests",
    [{ candidate: { id: `pypi:${packageName}`, name: packageName, ecosystem: "pypi", description: "Python HTTP for Humans.", latestVersion: "1.0.0" }, bundle }],
    [{ id: `pypi:${packageName}`, fitScore: 0.9, rationale: "gate fixture" }],
  );
  return { verdict: scored.verdict, scorecard: bundle.scorecard.overall };
}

export async function hasEvidenceAttributionFact(corroborated: Corroborator = repositoryClaimCorroborated): Promise<boolean> {
  // 1. The name check: the real package is corroborated, the impostors are not.
  if (!corroborated("requests", IMPOSTOR_REPO)) return false;
  for (const impostor of ["definitely-not-requests", "degree72-requests", "odigos-requests", "requeste"]) {
    if (corroborated(impostor, IMPOSTOR_REPO)) return false;
  }
  // A repo name embedded in a longer package name is the impostor's own trick.
  if (corroborated("evil-axios", "https://github.com/axios/axios")) return false;
  // Legitimate shapes must survive: monorepos, scopes, language-affixed repo names.
  for (const [name, repo] of [
    ["lodash.clonedeep", "https://github.com/lodash/lodash"],
    ["@babel/core", "https://github.com/babel/babel"],
    ["commander", "https://github.com/tj/commander.js"],
    ["jsonwebtoken", "https://github.com/auth0/node-jsonwebtoken"],
  ] as const) {
    if (!corroborated(name, repo)) return false;
  }
  // A missing or non-GitHub repository is not corroboration.
  if (corroborated("requests", undefined) || corroborated("requests", "https://gitlab.com/psf/requests")) return false;

  // 2. The enricher must not attribute the repository's score to the impostor, and
  //    3. the ranker must not ship a package whose health is therefore unverified.
  const impostor = await verdictFor("definitely-not-requests", IMPOSTOR_REPO);
  if (impostor.scorecard !== null) return false;
  if (impostor.verdict === "ship") return false;

  // The real package still gets its evidence and can still ship.
  const genuine = await verdictFor("requests", IMPOSTOR_REPO);
  return genuine.scorecard === 9.5 && genuine.verdict === "ship";
}

/** Mutant restoring the original behaviour: trust the self-declared repository. */
const trustEveryClaim: Corroborator = () => true;

export async function check(): Promise<Result> {
  try {
    return await hasEvidenceAttributionFact()
      ? { status: "pass" }
      : { status: "fail", message: "Health evidence was attributed to a package that did not corroborate its repository claim" };
  } catch (error: unknown) {
    return { status: "fail", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function proveFailure(): Promise<Result> {
  try {
    return !(await hasEvidenceAttributionFact(trustEveryClaim))
      ? { status: "detected" }
      : { status: "undetected", message: "G17 did not detect a self-declared repository being trusted outright" };
  } catch (error: unknown) {
    return { status: "detected", message: error instanceof Error ? error.message : String(error) };
  }
}
