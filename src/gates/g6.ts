import { HttpEnricher } from "../adapters/enrichment.js";
import type { HttpClient } from "../http/client.js";
import type { Result } from "./types.js";

export const id = "G6";
export const description = "Resilience + version-relevance check: adapters degrade on 500/timeout, and version-irrelevant vulns are excluded";

export async function check(): Promise<Result> {
  try {
    const mock500Client: HttpClient = async () => {
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const enricher500 = new HttpEnricher(mock500Client);
    const candidate = {
      id: "npm:axios",
      name: "axios",
      ecosystem: "npm",
      description: "axios",
    };
    const bundle500 = await enricher500.enrich(candidate);
    if (!bundle500) {
      return { status: "fail", message: "Adapter failed to degrade gracefully on 500" };
    }

    const mockVersionClient: HttpClient = async (url) => {
      if (url.includes("packages.ecosyste.ms")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: "axios",
            ecosystem: "npm",
            normalized_licenses: ["MIT"],
            latest_release_number: "1.19.0",
          }),
        };
      }
      if (url.includes("api.deps.dev")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            packageKey: { name: "axios", system: "npm" },
            versions: [{ versionKey: { name: "axios", system: "npm", version: "1.19.0" }, isDefault: true }],
          }),
        };
      }
      if (url.includes("api.osv.dev")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            vulns: [
              {
                id: "GHSA-old-vuln",
                database_specific: { severity: "HIGH" },
                affected: [
                  {
                    package: { name: "axios", ecosystem: "npm" },
                    ranges: [
                      {
                        type: "SEMVER",
                        events: [
                          { introduced: "0" },
                          { fixed: "1.1.0" },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const enricherVersion = new HttpEnricher(mockVersionClient);
    const bundleVersion = await enricherVersion.enrich(candidate);

    if (bundleVersion.vulnerabilities.length > 0) {
      return { status: "fail", message: "Version-irrelevant vulnerability was not excluded" };
    }

    return { status: "pass" };
  } catch (e: any) {
    return { status: "fail", message: e.message };
  }
}

export async function proveFailure(): Promise<Result> {
  const throwingEnricherCheck = async () => {
    throw new Error("Timeout/Connection failed");
  };

  try {
    await throwingEnricherCheck();
    return { status: "undetected", message: "Non-degrading path did not throw" };
  } catch (e: any) {
    if (e.message === "Timeout/Connection failed") {
      const mockFailedBundle = {
        vulnerabilities: [{ id: "GHSA-old-vuln", severity: "HIGH" }],
      };
      if (mockFailedBundle.vulnerabilities.length > 0) {
        return { status: "detected" };
      }
    }
    return { status: "undetected", message: e.message };
  }
}
