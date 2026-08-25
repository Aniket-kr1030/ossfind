import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import {
  ApiSurfaceSchema,
  CompatibilityReportSchema,
  IntegrationManifestSchema,
  ScaffoldSchema,
  ScoredComponentSchema,
} from "../contracts/index.js";
import {
  CompactScoredComponentSchema,
  InspectComponentOutputSchema,
  PlanIntegrationOutputSchema,
  createCheckCompatibilityHandler,
  createInspectComponentHandler,
  createPlanIntegrationHandler,
  createSearchComponentsHandler,
} from "./server.js";

function structuredResults(result: { structuredContent?: Record<string, unknown> }): unknown[] {
  const results = result.structuredContent?.results;
  expect(Array.isArray(results)).toBe(true);
  return results as unknown[];
}

function fixtureEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  environment.OSSFIND_FIXTURES = "1";
  return environment;
}

describe("search_components MCP tool", () => {
  it("preserves full schema-valid ranked fixture results and a human summary", async () => {
    const handler = createSearchComponentsHandler({ fixtures: true });

    const result = await handler({ query: "http client", detail: "full" });
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

  it("defaults to a genuinely smaller compact result that retains the verdict", async () => {
    const handler = createSearchComponentsHandler({ fixtures: true });
    const compact = await handler({ query: "http client" });
    const full = await handler({ query: "http client", detail: "full" });
    const compactResults = structuredResults(compact);
    const fullResults = structuredResults(full);

    expect(compact.isError).not.toBe(true);
    expect(full.isError).not.toBe(true);
    expect(JSON.stringify(compact.structuredContent).length)
      .toBeLessThan(JSON.stringify(full.structuredContent).length);
    expect(compactResults).toHaveLength(fullResults.length);
    for (const component of compactResults) {
      expect(CompactScoredComponentSchema.parse(component)).toEqual(component);
      expect(component).toHaveProperty("verdict");
      expect(component).not.toHaveProperty("reasons");
    }
  });

  it("returns a structured MCP error for an empty query", async () => {
    const handler = createSearchComponentsHandler({ fixtures: true });

    await expect(handler({ query: "" })).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text" }],
      structuredContent: { error: { message: expect.any(String) } },
    });
  });

  it("routes PyPI searches through the PyPI fixture pipeline in full detail", async () => {
    const handler = createSearchComponentsHandler({ fixtures: true });

    const result = await handler({ query: "video editing", ecosystem: "pypi", detail: "full" });
    const results = structuredResults(result);

    expect(result.isError).not.toBe(true);
    expect(results.map((result) => ScoredComponentSchema.parse(result).id)).toContain("pypi:moviepy");
  });

  it("routes GitHub searches through the fixture pipeline in full detail", async () => {
    const handler = createSearchComponentsHandler({ fixtures: true });
    const result = await handler({ query: "video generation", ecosystem: "github", detail: "full" });
    const results = structuredResults(result);

    expect(result.isError).not.toBe(true);
    expect(results.map((result) => ScoredComponentSchema.parse(result).id))
      .toContain("github:huggingface/diffusers");
  });

  it("routes Hugging Face searches through the fixture pipeline in full detail", async () => {
    const handler = createSearchComponentsHandler({ fixtures: true });
    const result = await handler({ query: "video generation", ecosystem: "huggingface", detail: "full" });
    const results = structuredResults(result);

    expect(result.isError).not.toBe(true);
    expect(results.map((result) => ScoredComponentSchema.parse(result).id)
      .some((id) => id.startsWith("huggingface:"))).toBe(true);
  });

  it("routes all-ecosystem searches through the federated fixture pipeline in full detail", async () => {
    const handler = createSearchComponentsHandler({ fixtures: true });
    const result = await handler({ query: "video editing", ecosystem: "all", limit: 30, detail: "full" });
    const ids = structuredResults(result).map((component) => ScoredComponentSchema.parse(component).id);

    expect(result.isError).not.toBe(true);
    expect(ids.some((id) => id.startsWith("pypi:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("github:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("huggingface:"))).toBe(true);
  });
});

describe("agent-ergonomic MCP integration tools", () => {
  it("inspects a fixture package with an honest default export cap", async () => {
    const handler = createInspectComponentHandler({ fixtures: true });
    const result = await handler({ component: "npm:axios" });
    const output = InspectComponentOutputSchema.parse(result.structuredContent);

    expect(result.isError).not.toBe(true);
    expect(ApiSurfaceSchema.parse(output.surface)).toEqual(output.surface);
    expect(IntegrationManifestSchema.parse(output.manifest)).toEqual(output.manifest);
    expect(output).toMatchObject({
      totalExports: 63,
      exportsTruncated: true,
      surface: { id: "npm:axios" },
    });
    expect(output.surface.exports).toHaveLength(40);
    const summary = result.content.find((content) => content.type === "text");
    expect(summary).toMatchObject({ type: "text" });
    if (summary?.type === "text") expect(summary.text).toContain("Showing 40 of 63 exports");
  });

  it("returns a schema-valid A3 compatibility report with verified component license data", async () => {
    const handler = createCheckCompatibilityHandler({ fixtures: true });
    const result = await handler({
      component: "npm:axios",
      project: { engines: { node: ">=20" }, license: "MIT" },
    });
    const report = CompatibilityReportSchema.parse(result.structuredContent);

    expect(result.isError).not.toBe(true);
    expect(report.component).toBe("npm:axios");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining(report.verdict) }));
  });

  it("returns a schema-valid scaffold and optional compatibility report", async () => {
    const handler = createPlanIntegrationHandler({ fixtures: true });
    const result = await handler({
      component: "npm:axios",
      preferExport: "formToJSON",
      project: { engines: { node: ">=20" }, license: "MIT" },
    });
    const output = PlanIntegrationOutputSchema.parse(result.structuredContent);

    expect(result.isError).not.toBe(true);
    expect(ScaffoldSchema.parse(output.scaffold)).toEqual(output.scaffold);
    expect(output.compatibility && CompatibilityReportSchema.parse(output.compatibility)).toEqual(output.compatibility);
    expect(output.scaffold.basedOn).toContainEqual(expect.objectContaining({ name: "formToJSON" }));
  });

  it("returns structured errors rather than throwing for invalid new-tool inputs", async () => {
    const cases = [
      createInspectComponentHandler({ fixtures: true })({ component: "" }),
      createInspectComponentHandler({ fixtures: true })({ component: "pypi:moviepy" }),
      createCheckCompatibilityHandler({ fixtures: true })({ component: "", project: {} }),
      createPlanIntegrationHandler({ fixtures: true })({ component: "" }),
    ];

    for (const result of await Promise.all(cases)) {
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text" }],
        structuredContent: { error: { message: expect.any(String) } },
      });
    }
  });
});

describe("MCP stdio server", () => {
  it("lists and calls all four tools over real fixture-backed stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp/server.ts"],
      cwd: process.cwd(),
      env: fixtureEnvironment(),
      stderr: "pipe",
    });
    const client = new Client({ name: "ossfind-mcp-test", version: "1.0.0" });

    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "search_components",
        "inspect_component",
        "check_compatibility",
        "plan_integration",
      ]));

      const calls = [
        { name: "search_components", arguments: { query: "http client" } },
        { name: "inspect_component", arguments: { component: "npm:axios", limit: 1 } },
        { name: "check_compatibility", arguments: { component: "npm:axios", project: { license: "MIT" } } },
        { name: "plan_integration", arguments: { component: "npm:axios", preferExport: "formToJSON" } },
      ] as const;
      for (const call of calls) {
        const result = await client.callTool(call);
        expect("content" in result).toBe(true);
        if ("content" in result) expect(result.isError).not.toBe(true);
      }
    } finally {
      await client.close();
    }
  });
});
