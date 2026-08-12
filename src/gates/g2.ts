import { buildPipeline } from "../mcp/pipeline.js";
import { searchComponents } from "../pipeline/orchestrator.js";
import type { Result } from "./types.js";

export const id = "G2";
export const description = "Determinism check: same input → identical ranking output twice";

export async function check(): Promise<Result> {
  try {
    const pipeline = buildPipeline({ fixtures: true });
    const query = "http-client";
    const run1 = await searchComponents(query, pipeline);
    const run2 = await searchComponents(query, pipeline);

    if (JSON.stringify(run1) !== JSON.stringify(run2)) {
      return { status: "fail", message: "Output is not deterministic" };
    }
    return { status: "pass" };
  } catch (e: any) {
    return { status: "fail", message: e.message };
  }
}

export async function proveFailure(): Promise<Result> {
  try {
    const pipeline = buildPipeline({ fixtures: true });
    const query = "http-client";
    const run1 = await searchComponents(query, pipeline);
    
    const run2 = JSON.parse(JSON.stringify(run1));
    if (run2.length > 0) {
      run2[0].overall = (run2[0].overall + 1) % 100;
    }

    if (JSON.stringify(run1) !== JSON.stringify(run2)) {
      return { status: "detected" };
    }
    return { status: "undetected", message: "Failed to detect injected non-determinism" };
  } catch (e: any) {
    return { status: "fail", message: e.message };
  }
}
