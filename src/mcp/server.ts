#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ScoredComponentSchema } from "../contracts/index.js";
import { searchComponents } from "../pipeline/orchestrator.js";
import { buildPipeline, type BuildPipelineOptions } from "./pipeline.js";

export const SearchComponentsInputSchema = z.object({
  query: z.string().trim().min(1, "query must not be empty"),
  projectLicense: z.string().trim().min(1).optional(),
  limit: z.number().int().nonnegative().default(10),
  ecosystem: z.enum(["npm", "pypi", "github", "huggingface", "all"]).default("npm"),
});

const SearchComponentsOutputSchema = z.object({
  results: z.array(ScoredComponentSchema),
});

export type SearchComponentsInput = z.infer<typeof SearchComponentsInputSchema>;

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : "Unable to search components.";
  return {
    content: [{ type: "text", text: `search_components failed: ${message}` }],
    isError: true,
  };
}

function summaryFor(results: Array<{
  name: string;
  verdict: string;
  overall: number;
  reasons: string[];
}>): string {
  if (results.length === 0) return "No matching components found.";
  return results
    .slice(0, 3)
    .map((component) =>
      `${component.name} — ${component.verdict} — ${component.overall} — ${component.reasons[0] ?? "No rationale available."}`,
    )
    .join("\n");
}

/**
 * Create an independently testable MCP tool callback. Errors, including invalid
 * direct calls in unit tests, are represented as MCP tool error results.
 */
export function createSearchComponentsHandler(
  pipelineOptions: BuildPipelineOptions = {},
): (input: unknown) => Promise<CallToolResult> {
  return async (input: unknown): Promise<CallToolResult> => {
    try {
      const parsed = SearchComponentsInputSchema.parse(input);
      const pipeline = buildPipeline({
        fixtures: pipelineOptions.fixtures,
        projectLicense: parsed.projectLicense ?? pipelineOptions.projectLicense,
        ecosystem: parsed.ecosystem,
      });
      const components = await searchComponents(parsed.query, pipeline, { limit: parsed.limit });

      return {
        content: [{ type: "text", text: summaryFor(components) }],
        structuredContent: { results: components },
      };
    } catch (error) {
      return errorResult(error);
    }
  };
}

/** The production callback registered by the stdio server. */
export const searchComponentsToolHandler = createSearchComponentsHandler();

/** Build an MCP server with the single ossfind component-search tool. */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "ossfind", version: "0.1.0" });
  server.registerTool(
    "search_components",
    {
      title: "Search open-source components",
      description: "Discover, enrich, score, and rank npm, PyPI, GitHub, Hugging Face, or all-ecosystem components for a query.",
      inputSchema: SearchComponentsInputSchema,
      outputSchema: SearchComponentsOutputSchema,
    },
    searchComponentsToolHandler,
  );
  return server;
}

/** Connect the ossfind MCP server to the process standard streams. */
export async function startServer(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport());
}

const runtimeProcess = (globalThis as unknown as {
  process?: { argv: string[]; exitCode?: number };
}).process;

if (runtimeProcess?.argv[1] && import.meta.url === new URL(`file://${runtimeProcess.argv[1]}`).href) {
  startServer().catch((error: unknown) => {
    console.error(error);
    runtimeProcess.exitCode = 1;
  });
}
