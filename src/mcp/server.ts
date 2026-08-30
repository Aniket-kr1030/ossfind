#!/usr/bin/env node

import { PACKAGE_VERSION } from "../version.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { checkPyCompatibility } from "../api/py-compat.js";
import { PyIntegrationManifestBuilder } from "../api/py-manifest.js";
import type { PyProjectContext } from "../api/py-project.js";
import { PyApiSurfaceExtractor } from "../api/py-surface.js";
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
import type { Discoverer } from "../pipeline/interfaces.js";
import {
  FederatedDiscoverer,
  type DiscoveryAvailability,
} from "../discovery/federated.js";
import {
  buildPipeline,
  createPipelineHttpClient,
  type BuildPipelineOptions,
  type SearchEcosystem,
} from "./pipeline.js";
import { UsageCollector, type UsageSnapshot } from "../telemetry/collector.js";
import {
  TelemetryEmitter,
  formatUsageSummary,
} from "../telemetry/emitter.js";

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
  availability: z.object({
    available: z.boolean(),
    sources: z.array(z.object({ name: z.string(), available: z.boolean() })),
  }).optional(),
});

const ProjectContextInputSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  engines: z.record(z.string(), z.string()).optional(),
  requiresPython: z.string().trim().min(1).optional(),
  license: z.string().trim().min(1).optional(),
}).strict();

const ApiComponentEcosystemSchema = z.enum(["npm", "pypi", "github", "huggingface"]);
type ApiComponentEcosystem = z.infer<typeof ApiComponentEcosystemSchema>;
type SupportedApiComponentEcosystem = Extract<ApiComponentEcosystem, "npm" | "pypi">;
type ApiProjectContext = ProjectContext & PyProjectContext;

const ApiComponentInputFields = {
  component: z.string().trim().min(1, "component must not be empty"),
  ecosystem: ApiComponentEcosystemSchema.default("npm"),
};

export const InspectComponentInputSchema = z.object({
  ...ApiComponentInputFields,
  limit: z.number().int().nonnegative().max(500).default(40),
});

export const CheckCompatibilityInputSchema = z.object({
  ...ApiComponentInputFields,
  project: ProjectContextInputSchema,
});

export const PlanIntegrationInputSchema = z.object({
  ...ApiComponentInputFields,
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

export const UsageStatsInputSchema = z.object({}).strict();

export const RateLimitHeadroomSchema = z.object({
  remaining: z.number().optional(),
  limit: z.number().optional(),
  reset: z.number().optional(),
  retryAfter: z.number().optional(),
});

export const SupplierUsageSchema = z.object({
  requests: z.number().int().nonnegative(),
  cacheHits: z.number().int().nonnegative(),
  cacheMisses: z.number().int().nonnegative(),
  statusClasses: z.record(z.enum(["1xx", "2xx", "3xx", "4xx", "5xx"]), z.number().int().nonnegative()),
  rateLimited429: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  rateLimit: RateLimitHeadroomSchema,
});

export const UsageSnapshotSchema = z.object({
  suppliers: z.record(z.string(), SupplierUsageSchema),
  operations: z.object({
    searchesServed: z.number().int().nonnegative(),
    ecosystems: z.record(z.enum(["npm", "pypi", "github", "huggingface"]), z.number().int().nonnegative()),
    verdicts: z.record(z.enum(["ship", "caution", "avoid"]), z.number().int().nonnegative()),
    results: z.object({
      count: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      min: z.number().int().nonnegative(),
      max: z.number().int().nonnegative(),
      mean: z.number().nonnegative(),
    }),
    errors: z.number().int().nonnegative(),
    latency: z.object({
      count: z.number().int().nonnegative(),
      p50: z.number().nonnegative(),
      p95: z.number().nonnegative(),
      reservoirSize: z.number().int().nonnegative(),
    }),
  }),
});

export const UsageStatsOutputSchema = UsageSnapshotSchema;

export type SearchComponentsInput = z.infer<typeof SearchComponentsInputSchema>;
export type InspectComponentInput = z.infer<typeof InspectComponentInputSchema>;
export type CheckCompatibilityInput = z.infer<typeof CheckCompatibilityInputSchema>;
export type PlanIntegrationInput = z.infer<typeof PlanIntegrationInputSchema>;
export type UsageStatsInput = z.infer<typeof UsageStatsInputSchema>;

function errorResult(tool: string, error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : `Unable to ${tool.replace(/_/g, " ")}.`;
  return {
    content: [{ type: "text", text: `${tool} failed: ${message}` }],
    structuredContent: { error: { message } },
    isError: true,
  };
}

function discoveryAvailability(discoverer: Discoverer): DiscoveryAvailability | undefined {
  return discoverer instanceof FederatedDiscoverer ? discoverer.availability() : undefined;
}

function pypiUnavailableSummary(availability: DiscoveryAvailability): string {
  const unavailable = new Set(availability.sources
    .filter((source) => !source.available)
    .map((source) => source.name));
  const missingIndex = unavailable.has("local-index");
  const missingKey = unavailable.has("libraries.io");

  if (missingIndex && missingKey) {
    return "PyPI discovery is not configured: no local index was found and no libraries.io API key is set. Build one with `INDEX_MAX=50000 npm run index:build`, or set `LIBRARY_IO_API_KEY` in `.env.local`. No packages were searched.";
  }
  if (missingIndex) {
    return "PyPI discovery is not configured: no local index was found. Build one with `INDEX_MAX=50000 npm run index:build`. No packages were searched.";
  }
  return "PyPI discovery is not configured: no libraries.io API key is set. Set `LIBRARY_IO_API_KEY` in `.env.local`. No packages were searched.";
}

function summaryFor(
  results: ScoredComponent[],
  ecosystem: SearchEcosystem,
  availability: DiscoveryAvailability | undefined,
): string {
  if (results.length === 0) {
    if (availability && !availability.available) {
      if (ecosystem === "pypi") {
        return pypiUnavailableSummary(availability);
      }
      return `${ecosystem} discovery is not configured. No packages were searched.`;
    }

    const unavailable = availability?.sources
      .filter((source) => !source.available)
      .map((source) => source.name) ?? [];
    return unavailable.length > 0
      ? `No matching components found. Discovery was unavailable for: ${unavailable.join(", ")}.`
      : "No matching components found.";
  }
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

/** Resolve the registry package name while rejecting ecosystems without API-surface support. */
function apiComponent(component: string, ecosystem: ApiComponentEcosystem): {
  ecosystem: SupportedApiComponentEcosystem;
  packageName: string;
} {
  const prefix = /^([a-z]+):(.*)$/i.exec(component);
  const idEcosystem = prefix?.[1]?.toLowerCase();
  const requestedEcosystem = idEcosystem ?? ecosystem;

  if (requestedEcosystem === "github" || requestedEcosystem === "huggingface") {
    throw new Error(`${requestedEcosystem} components do not have a package API surface; only npm and pypi components are supported.`);
  }

  if (requestedEcosystem !== "npm" && requestedEcosystem !== "pypi") {
    throw new Error(`Unsupported component ecosystem ${requestedEcosystem}; only npm and pypi components are supported.`);
  }

  if (idEcosystem && idEcosystem !== ecosystem) {
    throw new Error(`component prefix ${idEcosystem}: does not match ecosystem ${ecosystem}.`);
  }

  const packageName = prefix ? prefix[2]?.trim() : component;
  if (!packageName) {
    throw new Error(`component must name a ${requestedEcosystem} package after the ${requestedEcosystem}: prefix`);
  }
  return { ecosystem: requestedEcosystem, packageName };
}

function apiTools(options: BuildPipelineOptions) {
  const http = createPipelineHttpClient(options);
  return {
    npm: {
      extractor: new ApiSurfaceExtractor(http),
      manifestBuilder: new IntegrationManifestBuilder(http),
    },
    pypi: {
      extractor: new PyApiSurfaceExtractor(http),
      manifestBuilder: new PyIntegrationManifestBuilder(http),
    },
  };
}

async function compatibilityFor(
  component: string,
  manifest: IntegrationManifest,
  project: ApiProjectContext,
  ecosystem: SupportedApiComponentEcosystem,
  options: BuildPipelineOptions,
): Promise<CompatibilityReport> {
  // The A3 API accepts a component SPDX string separately from A2's manifest.
  // Obtain it from the existing enricher rather than asserting a license from
  // registry prose or leaving a readily-verifiable check undone.
  const pipeline = buildPipeline({ fixtures: options.fixtures, ecosystem });
  const enrichment = await pipeline.enricher.enrich({
    id: `${ecosystem}:${component}`,
    name: component,
    ecosystem,
    description: "",
  });
  if (ecosystem === "pypi") {
    return checkPyCompatibility(manifest, project, enrichment.license.spdxId ?? undefined);
  }
  return checkCompatibility(manifest, project, enrichment.license.spdxId ?? undefined);
}

export const defaultUsageCollector = new UsageCollector();
export const defaultTelemetryEmitter = new TelemetryEmitter();

/**
 * Create an independently testable MCP tool callback. Errors, including invalid
 * direct calls in unit tests, are represented as MCP tool error results.
 */
export function createSearchComponentsHandler(
  pipelineOptions: BuildPipelineOptions = {},
  collector: UsageCollector = defaultUsageCollector,
  emitter?: TelemetryEmitter,
): (input: unknown) => Promise<CallToolResult> {
  return async (input: unknown): Promise<CallToolResult> => {
    try {
      const parsed = SearchComponentsInputSchema.parse(input);
      const pipeline = buildPipeline({
        fixtures: pipelineOptions.fixtures,
        projectLicense: parsed.projectLicense ?? pipelineOptions.projectLicense,
        ecosystem: parsed.ecosystem,
        pypiIndexPath: pipelineOptions.pypiIndexPath,
      });
      const components = await searchComponents(parsed.query, pipeline, {
        limit: parsed.limit,
        collector,
      });
      emitter?.emitAsync(collector);
      const results = parsed.detail === "full" ? components : components.map(compactResult);
      const availability = discoveryAvailability(pipeline.discoverer);

      return {
        content: [{ type: "text", text: summaryFor(components, parsed.ecosystem, availability) }],
        structuredContent: { results, availability },
      };
    } catch (error) {
      return errorResult("search_components", error);
    }
  };
}

/** Extract a verified npm or PyPI API surface and installation manifest. */
export function createInspectComponentHandler(
  pipelineOptions: BuildPipelineOptions = {},
): (input: unknown) => Promise<CallToolResult> {
  const tools = apiTools(pipelineOptions);
  return async (input: unknown): Promise<CallToolResult> => {
    try {
      const parsed = InspectComponentInputSchema.parse(input);
      const target = apiComponent(parsed.component, parsed.ecosystem);
      const { extractor, manifestBuilder } = tools[target.ecosystem];
      const [surface, manifest] = await Promise.all([
        extractor.extract(target.packageName),
        manifestBuilder.build(target.packageName),
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
          text: `${surface.id} — ${surface.typesAvailable} ${target.ecosystem === "pypi" ? "Python" : "TypeScript"} surface.${disclosure}\n${manifest.install.command}`,
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

/** Compare an npm or PyPI component's verified integration facts with a project context. */
export function createCheckCompatibilityHandler(
  pipelineOptions: BuildPipelineOptions = {},
): (input: unknown) => Promise<CallToolResult> {
  const tools = apiTools(pipelineOptions);
  return async (input: unknown): Promise<CallToolResult> => {
    try {
      const parsed = CheckCompatibilityInputSchema.parse(input);
      const target = apiComponent(parsed.component, parsed.ecosystem);
      const manifest = await tools[target.ecosystem].manifestBuilder.build(target.packageName);
      const compatibility = await compatibilityFor(
        target.packageName,
        manifest,
        parsed.project,
        target.ecosystem,
        pipelineOptions,
      );

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
  const tools = apiTools(pipelineOptions);
  return async (input: unknown): Promise<CallToolResult> => {
    try {
      const parsed = PlanIntegrationInputSchema.parse(input);
      const target = apiComponent(parsed.component, parsed.ecosystem);
      const { extractor, manifestBuilder } = tools[target.ecosystem];
      const [surface, manifest] = await Promise.all([
        extractor.extract(target.packageName),
        manifestBuilder.build(target.packageName),
      ]);
      const scaffold = buildScaffold(surface, manifest, { preferExport: parsed.preferExport });
      const compatibility = parsed.project
        ? await compatibilityFor(target.packageName, manifest, parsed.project, target.ecosystem, pipelineOptions)
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

/** Return in-memory aggregate usage stats and a human-readable text summary. */
export function createUsageStatsHandler(
  collector: UsageCollector = defaultUsageCollector,
): (input: unknown) => Promise<CallToolResult> {
  return async (input: unknown): Promise<CallToolResult> => {
    try {
      const parsedInput = input === undefined ? {} : input;
      UsageStatsInputSchema.parse(parsedInput);
      const snapshot = collector.snapshot();

      return {
        content: [{
          type: "text",
          text: formatUsageSummary(snapshot),
        }],
        structuredContent: snapshot as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return errorResult("usage_stats", error);
    }
  };
}

export interface McpServerOptions extends BuildPipelineOptions {
  collector?: UsageCollector;
  telemetryEmitter?: TelemetryEmitter;
}

/** The production callbacks registered by the stdio server. */
export const searchComponentsToolHandler = createSearchComponentsHandler();
export const inspectComponentToolHandler = createInspectComponentHandler();
export const checkCompatibilityToolHandler = createCheckCompatibilityHandler();
export const planIntegrationToolHandler = createPlanIntegrationHandler();
export const usageStatsToolHandler = createUsageStatsHandler();

/** Build an MCP server with agent-oriented search, inspection, compatibility, planning, and usage stats tools. */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const collector = options.collector ?? defaultUsageCollector;
  const emitter = options.telemetryEmitter ?? defaultTelemetryEmitter;
  const server = new McpServer({ name: "ossfind", version: PACKAGE_VERSION });
  server.registerTool(
    "search_components",
    {
      title: "Search open-source components",
      description: "Discover, enrich, score, and rank components. detail defaults to compact selection facts; use full for the complete prior result shape.",
      inputSchema: SearchComponentsInputSchema,
      outputSchema: SearchComponentsOutputSchema,
    },
    createSearchComponentsHandler(options, collector, emitter),
  );
  server.registerTool(
    "inspect_component",
    {
      title: "Inspect a component API",
      description: "Return a verified npm TypeScript or PyPI Python API surface and integration manifest. Accepts a package name or matching npm:<name>/pypi:<name> search ID; exported symbols are capped and disclosure is explicit.",
      inputSchema: InspectComponentInputSchema,
      outputSchema: InspectComponentOutputSchema,
    },
    createInspectComponentHandler(options),
  );
  server.registerTool(
    "check_compatibility",
    {
      title: "Check component compatibility",
      description: "Compare a verified npm package manifest with package.json facts or a PyPI manifest with Python project facts. Both use verified SPDX license data; unknown facts remain explicit in the A3 report.",
      inputSchema: CheckCompatibilityInputSchema,
      outputSchema: CompatibilityReportSchema,
    },
    createCheckCompatibilityHandler(options),
  );
  server.registerTool(
    "plan_integration",
    {
      title: "Plan a minimal integration",
      description: "Return install commands, imports, and a signature-verified usage scaffold for an npm or PyPI component. Include matching project facts to attach an A3 compatibility report.",
      inputSchema: PlanIntegrationInputSchema,
      outputSchema: PlanIntegrationOutputSchema,
    },
    createPlanIntegrationHandler(options),
  );
  server.registerTool(
    "usage_stats",
    {
      title: "View usage and operational statistics",
      description: "Return in-memory aggregate usage metrics including supplier request counters, rate-limit headroom, cache hit rates, verdict distributions, and latency percentiles.",
      inputSchema: UsageStatsInputSchema,
      outputSchema: UsageStatsOutputSchema,
    },
    createUsageStatsHandler(collector),
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
