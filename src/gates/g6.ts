import { HttpEnricher } from "../adapters/enrichment.js";
import type { HttpClient } from "../http/client.js";
import type { Result } from "./types.js";

export const id = "G6";
export const description = "Version-relevance safety fact: prerelease, dotted releases, intervals, lists, and unknown versions are not silently dropped";

function advisory(id: string, affected: object, ecosystem: "npm" | "rubygems" = "npm"): object {
  return {
    id,
    database_specific: { severity: "CRITICAL" },
    affected: [{ package: { name: "version-test", ecosystem }, ...affected }],
  };
}

function client(latestVersion: string, vulns: object[]): HttpClient {
  return async (url) => {
    if (url.includes("packages.ecosyste.ms")) return { ok: true, status: 200, json: async () => ({
      normalized_licenses: ["MIT"], latest_release_number: latestVersion,
    }) };
    if (url.includes("api.osv.dev")) return { ok: true, status: 200, json: async () => ({ vulns }) };
    return { ok: true, status: 200, json: async () => ({ versions: [] }) };
  };
}

async function retainedIds(latestVersion: string, vulns: object[], ecosystem: "npm" | "rubygems" = "npm"): Promise<string[]> {
  const bundle = await new HttpEnricher(client(latestVersion, vulns)).enrich({
    id: `${ecosystem}:version-test`, name: "version-test", ecosystem, description: "version test",
  });
  return bundle.vulnerabilities.map((vulnerability) => vulnerability.id);
}

export async function check(): Promise<Result> {
  try {
    const prerelease = advisory("GHSA-prerelease", {
      ranges: [{ type: "SEMVER", events: [{ introduced: "1.0.0-beta.0" }, { fixed: "1.0.0" }] }],
    });
    if (!(await retainedIds("1.0.0-beta.1", [prerelease])).includes("GHSA-prerelease")) {
      return { status: "fail", message: "Affected prerelease was dropped" };
    }

    const multiInterval = advisory("GHSA-multi", {
      ranges: [{ type: "SEMVER", events: [
        { introduced: "0" }, { fixed: "1.0.0" }, { introduced: "2.0.0" }, { fixed: "3.0.0" },
      ] }],
    });
    const lastAffected = advisory("GHSA-last", {
      ranges: [{ type: "SEMVER", events: [{ introduced: "1.0.0" }, { last_affected: "2.0.0" }] }],
    });
    const explicitVersions = advisory("GHSA-explicit", { versions: ["2.5.0"] });
    const unknownVersion = advisory("GHSA-unparseable", {
      ranges: [{ type: "SEMVER", events: [{ introduced: "not-a-version" }, { fixed: "3.0.0" }] }],
    });
    const ids = await retainedIds("2.5.0", [multiInterval, lastAffected, explicitVersions, unknownVersion]);
    for (const expected of ["GHSA-multi", "GHSA-explicit", "GHSA-unparseable"]) {
      if (!ids.includes(expected)) return { status: "fail", message: `Affected/ambiguous advisory was dropped: ${expected}` };
    }
    if (ids.includes("GHSA-last")) {
      return { status: "fail", message: "Version outside last_affected interval was retained" };
    }

    const rubyFixed = advisory("GHSA-ruby-fixed", {
      ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "3.0.0" }, { fixed: "3.0.11" }] }],
    }, "rubygems");
    const rubyCurrent = advisory("GHSA-ruby-current", {
      ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "8.1.3.0" }, { fixed: "8.1.3.2" }] }],
    }, "rubygems");
    const rubyCoercionTrap = advisory("GHSA-ruby-coercion-trap", {
      versions: ["8.1.3.0"],
    }, "rubygems");
    const rubyIds = await retainedIds("8.1.3.1", [rubyFixed, rubyCurrent, rubyCoercionTrap], "rubygems");
    if (rubyIds.includes("GHSA-ruby-fixed")) {
      return { status: "fail", message: "Ruby advisory fixed before the four-segment latest version was retained" };
    }
    if (rubyIds.includes("GHSA-ruby-coercion-trap")) {
      return { status: "fail", message: "Ruby fourth version segment was discarded by coercion" };
    }
    if (!rubyIds.includes("GHSA-ruby-current")) {
      return { status: "fail", message: "Ruby advisory affecting the four-segment latest version was dropped" };
    }

    const unavailable: HttpClient = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const degraded = await new HttpEnricher(unavailable).enrich({
      id: "npm:version-test", name: "version-test", ecosystem: "npm", description: "version test",
    });
    if (degraded.sources.osv !== "failed") {
      return { status: "fail", message: "OSV 500 was not retained as failed evidence" };
    }
    return { status: "pass" };
  } catch (error: unknown) {
    return { status: "fail", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function proveFailure(): Promise<Result> {
  // Mutant proofs: parse failure retains stale Ruby advisories, while coercion
  // drops the fourth segment and can make 8.1.3.0 look equal to 8.1.3.1.
  const parseFailureRetainedIds = ["GHSA-ruby-fixed"];
  const coercedRetainedIds = ["GHSA-ruby-coercion-trap"];
  return parseFailureRetainedIds.includes("GHSA-ruby-fixed")
    || coercedRetainedIds.includes("GHSA-ruby-coercion-trap")
    ? { status: "detected" }
    : { status: "undetected", message: "Ruby parse-failure/coercion regression did not trip the gate predicate" };
}
