import { buildPipeline } from "../mcp/pipeline.js";
import { searchComponents } from "../pipeline/orchestrator.js";
import { HttpEnricher } from "../adapters/enrichment.js";
import type { ComponentCandidate } from "../contracts/index.js";
import type { Result } from "./types.js";

export const id = "G5";
export const description = "Offline check: the whole pipeline runs with the fixture client and makes ZERO network calls";

export async function check(): Promise<Result> {
  const originalFetch = globalThis.fetch;
  let networkCallAttempted = false;

  globalThis.fetch = async () => {
    networkCallAttempted = true;
    throw new Error("Network call blocked by offline gate");
  };

  try {
    const pipeline = buildPipeline({ fixtures: true });
    await searchComponents("http-client", pipeline);

    if (networkCallAttempted) {
      return { status: "fail", message: "Network calls were made during fixture mode" };
    }
    return { status: "pass" };
  } catch (e: any) {
    return { status: "fail", message: e.message };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export async function proveFailure(): Promise<Result> {
  const originalFetch = globalThis.fetch;
  let networkCallAttempted = false;

  globalThis.fetch = async () => {
    networkCallAttempted = true;
    throw new Error("Network call blocked by offline gate");
  };

  try {
    const enricher = new HttpEnricher();
    const candidate: ComponentCandidate = {
      id: "npm:axios",
      name: "axios",
      ecosystem: "npm" as const,
      description: "axios",
    };
    await enricher.enrich(candidate);

    if (networkCallAttempted) {
      return { status: "detected" };
    }

    return { status: "undetected", message: "HttpEnricher did not trigger a network call or failed to throw" };
  } catch (e: any) {
    if (networkCallAttempted || e.message.includes("Network call blocked")) {
      return { status: "detected" };
    }
    return { status: "undetected", message: e.message };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
