import { HttpEnricher } from "../adapters/enrichment.js";
import {
  ComponentCandidateSchema,
  type ComponentCandidate,
  type EnrichmentBundle,
  type FitSignal,
  type ScoredComponent,
} from "../contracts/index.js";
import type { HttpClient } from "../http/client.js";
import { WeightedRanker } from "../ranking/rank.js";
import type { Result } from "./types.js";

export const id = "G8";
export const description = "Federation provenance and raw-repository integrity";

const rawCapReason = "GitHub/Hugging Face components cannot be verified for dependency vulnerabilities the way a published package can — capped below ship.";

const identityMismatches = [
  ["npm:not-real", "github"],
  ["pypi:github", "npm"],
  ["github:owner/repo", "huggingface"],
  ["huggingface:owner/model", "github"],
] as const;

function candidateFor(id: string, ecosystem: ComponentCandidate["ecosystem"]): ComponentCandidate {
  return ComponentCandidateSchema.parse({
    id,
    name: id.slice(id.indexOf(":") + 1),
    ecosystem,
    description: "federation integrity gate candidate",
  });
}

/** The public contract must reject contradictory source identities. */
export function rejectsIdentityMismatches(
  parse: (value: unknown) => { success: boolean } = ComponentCandidateSchema.safeParse,
): boolean {
  return identityMismatches.every(([id, ecosystem]) => !parse({
    id,
    name: "contradictory",
    ecosystem,
    description: "contradictory identity",
  }).success);
}

type RecordedCall = { url: string; body?: string };

async function preservesSupplierRouting(): Promise<boolean> {
  const calls: RecordedCall[] = [];
  const http: HttpClient = async (url, init) => {
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("packages.ecosyste.ms")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ normalized_licenses: [url.includes("npmjs.org") ? "MIT" : "Apache-2.0"] }),
      };
    }
    if (url.includes("api.deps.dev/v3/systems/")) {
      return { ok: true, status: 200, json: async () => ({ versions: [] }) };
    }
    if (url === "https://api.osv.dev/v1/query") {
      return { ok: true, status: 200, json: async () => ({ vulns: [] }) };
    }
    throw new Error(`unexpected supplier request: ${url}`);
  };

  const [npm, pypi, github, huggingface] = await Promise.all([
    new HttpEnricher(http).enrich(candidateFor("npm:github", "npm")),
    new HttpEnricher(http).enrich(candidateFor("pypi:github", "pypi")),
    new HttpEnricher(http).enrich(candidateFor("github:npm:not-real", "github")),
    new HttpEnricher(http).enrich(candidateFor("huggingface:npm:not-real", "huggingface")),
  ]);

  const urls = calls.map((call) => call.url);
  const osvBodies = calls
    .filter((call) => call.url === "https://api.osv.dev/v1/query")
    .map((call) => call.body)
    .filter((body): body is string => body !== undefined)
    .map((body) => JSON.parse(body) as { package?: { ecosystem?: string; name?: string } });

  return calls.length === 6
    && urls.filter((url) => url.includes("packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/github")).length === 1
    && urls.filter((url) => url.includes("api.deps.dev/v3/systems/npm/packages/github")).length === 1
    && urls.filter((url) => url.includes("packages.ecosyste.ms/api/v1/registries/pypi.org/packages/github")).length === 1
    && urls.filter((url) => url.includes("api.deps.dev/v3/systems/pypi/packages/github")).length === 1
    && osvBodies.some((body) => body.package?.ecosystem === "npm" && body.package.name === "github")
    && osvBodies.some((body) => body.package?.ecosystem === "PyPI" && body.package.name === "github")
    && github.sources.osv === "missing"
    && huggingface.sources.osv === "missing"
    && huggingface.sources.scorecard === "missing"
    && npm.sources.osv === "ok"
    && pypi.sources.osv === "ok";
}

function forgedBundle(id: string, license: string | null = "MIT"): EnrichmentBundle {
  return {
    id,
    license: { spdxId: license, source: "forged", confidence: license ? 1 : 0 },
    vulnerabilities: [],
    sources: { osv: "ok", license: "ok", scorecard: "ok" },
    scorecard: { overall: 10, checks: [] },
    maintenance: {},
  };
}

function forgedVerdict(id: string, license: string | null = "MIT"): ScoredComponent["verdict"] {
  const ecosystem = id.slice(0, id.indexOf(":")) as ComponentCandidate["ecosystem"];
  const candidate = candidateFor(id, ecosystem);
  const fit: FitSignal = { id, fitScore: 1, rationale: "ideal fit" };
  return new WeightedRanker({ projectLicense: "MIT" }).rank(
    "federation integrity gate",
    [{ candidate, bundle: forgedBundle(id, license) }],
    [fit],
  )[0].verdict;
}

/** Forged positive provenance can never ship raw repositories or model cards. */
export function rawComponentsCannotShip(
  verdict: (id: string) => ScoredComponent["verdict"] = forgedVerdict,
): boolean {
  return ["github:owner/repo", "huggingface:owner/model"].every((id) => verdict(id) !== "ship");
}

/** Lookalike and oversized license strings are not permissive SPDX evidence. */
export function licenseSpoofsCannotShip(
  verdict: (license: string) => ScoredComponent["verdict"] = (license) => forgedVerdict("npm:license-spoof", license),
): boolean {
  return ["MIT-ish", "MΙT", "ＭＩＴ", "MIT".repeat(2000)].every((license) => verdict(license) !== "ship");
}

export async function check(): Promise<Result> {
  try {
    if (!rejectsIdentityMismatches()) {
      return { status: "fail", message: "Component candidate contract accepted a mismatched id prefix and ecosystem" };
    }
    if (!await preservesSupplierRouting()) {
      return { status: "fail", message: "Enrichment supplier routing crossed ecosystem boundaries or raw sources claimed unavailable evidence" };
    }
    if (!rawComponentsCannotShip()) {
      return { status: "fail", message: "Forged GitHub or Hugging Face evidence was able to ship" };
    }
    if (!licenseSpoofsCannotShip()) {
      return { status: "fail", message: "A license lookalike or oversized string was treated as permissive evidence" };
    }
    return { status: "pass" };
  } catch (error: unknown) {
    return { status: "fail", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function proveFailure(): Promise<Result> {
  // Mutants independently bypass the contract identity check and the raw cap.
  const identityDetected = !rejectsIdentityMismatches(() => ({ success: true }));
  const rawCapDetected = !rawComponentsCannotShip(() => "ship");
  return identityDetected && rawCapDetected
    ? { status: "detected" }
    : { status: "undetected", message: "G8 did not detect a bypassed identity check or raw-component cap" };
}
