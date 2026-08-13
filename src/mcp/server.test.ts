import { describe, expect, it } from "vitest";
import { ScoredComponentSchema } from "../contracts/index.js";
import { createSearchComponentsHandler } from "./server.js";

function structuredResults(result: { structuredContent?: Record<string, unknown> }): unknown[] {
  const results = result.structuredContent?.results;
  expect(Array.isArray(results)).toBe(true);
  return results as unknown[];
}

describe("search_components MCP tool", () => {
  it("returns schema-valid, ranked fixture results and a human summary", async () => {
    const handler = createSearchComponentsHandler({ fixtures: true });

    const result = await handler({ query: "http client" });
    const results = structuredResults(result);

    expect(result.isError).not.toBe(true);
    expect(results.length).toBeGreaterThan(0);
    for (const component of results) {
      expect(ScoredComponentSchema.parse(component)).toEqual(component);
    }
    for (let index = 1; index < results.length; index += 1) {
      const previous = ScoredComponentSchema.parse(results[index - 1]);
      const current = ScoredComponentSchema.parse(results[index]);
      expect(previous.overall).toBeGreaterThanOrEqual(current.overall);
    }

    const summary = result.content.find((content) => content.type === "text");
    expect(summary).toMatchObject({ type: "text" });
    if (summary?.type === "text") expect(summary.text).not.toHaveLength(0);
  });

  it("returns a structured MCP error for an empty query", async () => {
    const handler = createSearchComponentsHandler({ fixtures: true });

    await expect(handler({ query: "" })).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text" }],
    });
  });

  it("routes PyPI searches through the PyPI fixture pipeline", async () => {
    const handler = createSearchComponentsHandler({ fixtures: true });

    const result = await handler({ query: "video editing", ecosystem: "pypi" });
    const results = structuredResults(result);

    expect(result.isError).not.toBe(true);
    expect(results.map((result) => ScoredComponentSchema.parse(result).id)).toContain("pypi:moviepy");
  });

  it("routes GitHub searches through the fixture pipeline", async () => {
    const handler = createSearchComponentsHandler({ fixtures: true });
    const result = await handler({ query: "video generation", ecosystem: "github" });
    const results = structuredResults(result);

    expect(result.isError).not.toBe(true);
    expect(results.map((result) => ScoredComponentSchema.parse(result).id))
      .toContain("github:huggingface/diffusers");
  });
});
