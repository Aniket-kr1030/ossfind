import { buildPipeline } from "../mcp/pipeline.js";
import { searchComponents } from "../pipeline/orchestrator.js";
import { ScoredComponentSchema } from "../contracts/index.js";
import type { Result } from "./types.js";

export const id = "G1";
export const description = "Contract validation: every pipeline output validates against the zod schemas";

export async function check(): Promise<Result> {
  try {
    const pipeline = buildPipeline({ fixtures: true });
    const queries = ["http-client", "schema-validation", "date-formatting"];
    for (const query of queries) {
      const results = await searchComponents(query, pipeline);
      if (results.length === 0) {
        return { status: "fail", message: `No results returned for query: ${query}` };
      }
      for (const r of results) {
        ScoredComponentSchema.parse(r);
      }
    }
    return { status: "pass" };
  } catch (e: any) {
    return { status: "fail", message: e.message };
  }
}

export async function proveFailure(): Promise<Result> {
  const malformed = {
    id: "not-npm-prefixed",
    name: "malformed",
    scores: {
      fit: 1.5,
      license: 0.5,
      security: 0.5,
      health: 0.5,
      effort: 0.5,
    },
    overall: 120,
    verdict: "maybe",
    reasons: [],
    badges: {
      license: "",
      cveCount: -1,
      scorecard: null,
    },
  };

  try {
    ScoredComponentSchema.parse(malformed);
    return { status: "undetected", message: "Schema failed to throw on malformed object" };
  } catch {
    return { status: "detected" };
  }
}
