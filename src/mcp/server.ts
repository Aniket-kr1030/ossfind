#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiSurfaceExtractor } from "../api/surface.js";
import { IntegrationManifestBuilder } from "../api/manifest.js";
import { checkCompatibility, type ProjectContext } from "../api/compat.js";
import { buildScaffold } from "../api/scaffold.js";
import {
  ApiSurfaceSchema,
  CompatibilityReportSchema,
  IntegrationManifestSchema,
  ScaffoldSchema,
  ScoredComponentSchema,
  type CompatibilityReport,
  type IntegrationManifest,
  type ScoredComponent,
} from "../contracts/index.js";
import { searchComponents } from "../pipeline/orchestrator.js";
import {
  buildPipeline,
  createPipelineHttpClient,
  type BuildPipelineOptions,
} from "./pipeline.js";

export const CompactScoredComponentSchema = z.object({
  id: ScoredComponentSchema.shape.id,
  name: ScoredComponentSchema.shape.name,
  verdict: ScoredComponentSchema.shape.verdict,
  overall: ScoredComponentSchema.shape.overall,
  badges: ScoredComponentSchema.shape.badges,
  reason: z.string().min(1),
});

export const SearchComponentsInputSchema = z.object({
  query: z.string().trim().min(1, "query must not be empty"),
  projectLicense: z.string().trim().min(1).optional(),
  limit: z.number().int().nonnegative().default(10),
  ecosystem: z.enum(["npm", "pypi", "github", "huggingface", "all"]).default("npm"),
  detail: z.enum(["compact", "full"]).default("compact"),
});

const SearchComponentsOutputSchema = z.object({
  results: z.array(z.union([ScoredComponentSchema, CompactScoredComponentSchema])),
});

const ProjectContextInputSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  engines: z.record(z.string(), z.string()).optional(),
  license: z.string().trim().min(1).optional(),
}).strict();

const NpmComponentInputFields = {
  component: z.string().trim().min(1, "component must not be empty"),
  ecosystem: z.literal("npm").default("npm"),
};

export const InspectComponentInputSchema = z.object({
  ...NpmComponentInputFields,
  limit: z.number().int().nonnegative().max(500).default(40),
});

export const CheckCompatibilityInputSchema = z.object({
  ...NpmComponentInputFields,
  project: ProjectContextInputSchema,
});

export const PlanIntegrationInputSchema = z.object({
  ...NpmComponentInputFields,
  project: ProjectContextInputSchema.optional(),
  preferExport: z.string().trim().min(1).optional(),
});

export const InspectComponentOutputSchema = z.object({
  surface: ApiSurfaceSchema,
  manifest: IntegrationManifestSchema,
  totalExports: z.number().int().nonnegative(),
  /** True only when this tool's response hides exports because of its limit. */
  exportsTruncated: z.boolean(),
});

export const PlanIntegrationOutputSchema = z.object({
  scaffold: ScaffoldSchema,
  compatibility: CompatibilityReportSchema.optional(),
});

export type SearchComponentsInput = z.infer<typeof SearchComponentsInputSchema>;
export type InspectComponentInput = z.infer<typeof InspectComponentInputSchema>;
export type CheckCompatibilityInput = z.infer<typeof CheckCompatibilityInputSchema>;
export type PlanIntegrationInput = z.infer<typeof PlanIntegrationInputSchema>;

function errorResult(tool: string, error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : `Unable to ${tool.replace(/_/g, " ")}.`;
  return {
    content: [{ type: "text", text: `${tool} failed: ${message}` }],
    structuredContent: { error: { message } },
    isError: true,
  };
}

function summaryFor(results: ScoredComponent[]): string {
  if (results.length === 0) return "No matching components found.";
  return results
    .slice(0, 3)
    .map((component) =>
      `${component.name} — ${component.verdict} — ${component.overall} — ${component.reasons[0] ?? "No rationale available."}`,
    )
    .join("\n");
}

function compactResult(component: ScoredComponent): z.infer<typeof CompactScoredComponentSchema> {
  return {
    id: component.id,
    name: component.name,
    verdict: component.verdict,
    overall: component.overall,
    badges: component.badges,
    reason: component.reasons[0] ?? "No rationale available.",
  };
}

/** Search-result IDs are accepted directly so agents can chain tools without rewriting them. */
function npmPackageName(component: string): string {
  const prefix = /^([a-z]+):(.*)$/i.exec(component);
  if (!prefix) return component;
  if (prefix[1]?.toLowerCase() !== "npm") {
    throw new Error(`Only npm components are supported; received ${prefix[1]}.`);
  }
  const packageName = prefix[2]?.trim();
  if (!packageName) throw new Error("component must name an npm package after the npm: prefix");
  return packageName;
}

function apiTools(options: BuildPipelineOptions) {
  const http = createPipelineHttpClient(options);
  return {
    extractor: new ApiSurfaceExtractor(http),
    manifestBuilder: new IntegrationManifestBuilder(http),
  };
}

async function compatibilityFor(
  component: string,
  manifest: IntegrationManifest,
  project: ProjectContext,
  options: BuildPipelineOptions,
): Promise<CompatibilityReport> {
  // The A3 API accepts a component SPDX string separately from A2's manifest.
  // Obtain it from the existing enricher rather than asserting a license from
  // registry prose or leaving a readily-verifiable check undone.
  const pipeline = buildPipeline({ fixtures: options.fixtures, ecosystem: "npm" });
  const enrichment = await pipeline.enricher.enrich({
    id: `npm:${component}`,
    name: component,
    ecosystem: "npm",
    description: "",
  });
  return checkCompatibility(manifest, project, enrichment.license.spdxId ?? undefined);
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
      const results = parsed.detail === "full" ? components : components.map(compactResult);

      return {
        content: [{ type: "text", text: summaryFor(components) }],
        structuredContent: { results },
      };
    } catch (error) {
      return errorResult("search_components", error);
    }
  };
}

/** Extract a verified API surface and installation manifest for one npm package. */
export function createInspectComponentHandler(
  pipelineOptions: BuildPipelineOptions = {},
): (input: unknown) => Promise<CallToolResult> {
  const { extractor, manifestBuilder } = apiTools(pipelineOptions);
  return async (input: unknown): Promise<CallToolResult> => {
    try {
      const parsed = InspectComponentInputSchema.parse(input);
      const component = npmPackageName(parsed.component);
      const [surface, manifest] = await Promise.all([
        extractor.extract(component),
        manifestBuilder.build(component),
      ]);
      const totalExports = surface.exports.length;
      const exportsTruncated = totalExports > parsed.limit;
      const limitedSurface = { ...surface, exports: surface.exports.slice(0, parsed.limit) };
      const disclosure = exportsTruncated
        ? ` Showing ${limitedSurface.exports.length} of ${totalExports} exports; use limit to request more.`
        : ` Showing all ${totalExports} exports.`;

      return {
        content: [{
          type: "text",
          text: `${surface.id} — ${surface.typesAvailable} TypeScript surface.${disclosure}\n${manifest.install.command}`,
        }],
        structuredContent: {
          surface: limitedSurface,
          manifest,
          totalExports,
          exportsTruncated,
        },
      };
    } catch (error) {
      return errorResult("inspect_component", error);
    }
  };
}

/** Compare an npm component's verified integration facts with a project context. */
export function createCheckCompatibilityHandler(
  pipelineOptions: BuildPipelineOptions = {},
): (input: unknown) => Promise<CallToolResult> {
  const { manifestBuilder } = apiTools(pipelineOptions);
  return async (input: unknown): Promise<CallToolResult> => {
    try {
      const parsed = CheckCompatibilityInputSchema.parse(input);
      const component = npmPackageName(parsed.component);
      const manifest = await manifestBuilder.build(component);
      const compatibility = await compatibilityFor(component, manifest, parsed.project, pipelineOptions);

      return {
        content: [{
          type: "text",
          text: `${compatibility.component} — ${compatibility.verdict}; ${compatibility.findings.length} finding(s).`,
        }],
        structuredContent: compatibility,
      };
    } catch (error) {
      return errorResult("check_compatibility", error);
    }
  };
}

/** Build the least-code integration plan, optionally including a compatibility report. */
export function createPlanIntegrationHandler(
  pipelineOptions: BuildPipelineOptions = {},
): (input: unknown) => Promise<CallToolResult> {
  const { extractor, manifestBuilder } = apiTools(pipelineOptions);
  return async (input: unknown): Promise<CallToolResult> => {
    try {
      const parsed = PlanIntegrationInputSchema.parse(input);
      const component = npmPackageName(parsed.component);
      const [surface, manifest] = await Promise.all([
        extractor.extract(component),
        manifestBuilder.build(component),
      ]);
      const scaffold = buildScaffold(surface, manifest, { preferExport: parsed.preferExport });
      const compatibility = parsed.project
        ? await compatibilityFor(component, manifest, parsed.project, pipelineOptions)
        : undefined;
      const compatibilitySummary = compatibility ? ` Compatibility: ${compatibility.verdict}.` : "";

      return {
        content: [{
          type: "text",
          text: `${scaffold.component} — ${scaffold.confidence}; ${scaffold.install}.${compatibilitySummary}`,
        }],
        structuredContent: compatibility ? { scaffold, compatibility } : { scaffold },
      };
    } catch (error) {
      return errorResult("plan_integration", error);
    }
  };
}

/** The production callbacks registered by the stdio server. */
export const searchComponentsToolHandler = createSearchComponentsHandler();
export const inspectComponentToolHandler = createInspectComponentHandler();
export const checkCompatibilityToolHandler = createCheckCompatibilityHandler();
export const planIntegrationToolHandler = createPlanIntegrationHandler();

/** Build an MCP server with agent-oriented search, inspection, compatibility, and planning tools. */
export function createMcpServer(pipelineOptions: BuildPipelineOptions = {}): McpServer {
  const server = new McpServer({ name: "ossfind", version: "0.1.0" });
  server.registerTool(
    "search_components",
    {
      title: "Search open-source components",
      description: "Discover, enrich, score, and rank components. detail defaults to compact selection facts; use full for the complete prior result shape.",
      inputSchema: SearchComponentsInputSchema,
      outputSchema: SearchComponentsOutputSchema,
    },
    createSearchComponentsHandler(pipelineOptions),
  );
  server.registerTool(
    "inspect_component",
    {
      title: "Inspect a component API",
      description: "Return a verified npm TypeScript API surface and integration manifest. Accepts a package name or an npm:<name> search ID; exported symbols are capped and disclosure is explicit.",
      inputSchema: InspectComponentInputSchema,
      outputSchema: InspectComponentOutputSchema,
    },
    createInspectComponentHandler(pipelineOptions),
  );
  server.registerTool(
    "check_compatibility",
    {
      title: "Check component compatibility",
      description: "Compare a verified npm component manifest and SPDX license with package.json project facts. Unknown facts remain explicit in the A3 report.",
      inputSchema: CheckCompatibilityInputSchema,
      outputSchema: CompatibilityReportSchema,
    },
    createCheckCompatibilityHandler(pipelineOptions),
  );
  server.registerTool(
    "plan_integration",
    {
      title: "Plan a minimal integration",
      description: "Return install commands, imports, and a signature-verified usage scaffold for an npm component. Include project facts to attach an A3 compatibility report.",
      inputSchema: PlanIntegrationInputSchema,
      outputSchema: PlanIntegrationOutputSchema,
    },
    createPlanIntegrationHandler(pipelineOptions),
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
