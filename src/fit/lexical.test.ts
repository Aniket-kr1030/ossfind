import { describe, expect, it } from "vitest";
import { LexicalFitScorer } from "./lexical.js";
import type { ComponentCandidate } from "../contracts/index.js";

describe("LexicalFitScorer", () => {
  const scorer = new LexicalFitScorer();

  const candidates: ComponentCandidate[] = [
    {
      id: "npm:axios",
      name: "axios",
      ecosystem: "npm",
      description: "Promise based HTTP client for the browser and node.js",
    },
    {
      id: "npm:lodash",
      name: "lodash",
      ecosystem: "npm",
      description: "Lodash modular utilities.",
    },
    {
      id: "npm:got",
      name: "got",
      ecosystem: "npm",
      description: "Human-friendly and powerful HTTP request library for Node.js",
    },
  ];

  it("outranks an unrelated library by fitScore for query 'http client'", async () => {
    const signals = await scorer.fit("http client", candidates);
    const signalMap = new Map(signals.map((s) => [s.id, s]));

    const axiosSignal = signalMap.get("npm:axios")!;
    const gotSignal = signalMap.get("npm:got")!;
    const lodashSignal = signalMap.get("npm:lodash")!;

    expect(axiosSignal.fitScore).toBeGreaterThan(lodashSignal.fitScore);
    expect(gotSignal.fitScore).toBeGreaterThan(lodashSignal.fitScore);
    expect(axiosSignal.fitScore).toBeGreaterThan(0);
    expect(gotSignal.fitScore).toBeGreaterThan(0);
    expect(lodashSignal.fitScore).toBe(0);

    expect(axiosSignal.rationale).toContain("matched");
    expect(lodashSignal.rationale).toContain("No query terms matched");
  });

  it("is case insensitive", async () => {
    const signals = await scorer.fit("HTTP CLIENT", candidates);
    const signalMap = new Map(signals.map((s) => [s.id, s]));
    expect(signalMap.get("npm:axios")!.fitScore).toBeGreaterThan(0);
  });

  it("handles empty query gracefully", async () => {
    const signals = await scorer.fit("", candidates);
    expect(signals.every((s) => s.fitScore === 0)).toBe(true);
  });
});
