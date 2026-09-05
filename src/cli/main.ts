import { parseArgs } from "node:util";
import { PACKAGE_VERSION } from "../version.js";
import { buildPipeline, type SearchEcosystem } from "../mcp/pipeline.js";
import { searchComponents } from "../pipeline/orchestrator.js";
import { ApiSurfaceExtractor } from "../api/surface.js";
import { PyApiSurfaceExtractor } from "../api/py-surface.js";
import { IntegrationManifestBuilder } from "../api/manifest.js";
import { PyIntegrationManifestBuilder } from "../api/py-manifest.js";
import { reconcileImportForm } from "../api/import-form.js";
import { createPipelineHttpClient } from "../mcp/pipeline.js";
import type { ScoredComponent } from "../contracts/index.js";

const ECOSYSTEMS: SearchEcosystem[] = ["npm", "pypi", "github", "huggingface", "cargo", "rubygems", "all"];

const USAGE = `ossfind ${PACKAGE_VERSION} — safety-ranked open-source component discovery

  ossfind search <query> [options]     find components, ranked by safety evidence
  ossfind inspect <package> [options]  verified API surface and install manifest

Options
  -e, --ecosystem <name>   ${ECOSYSTEMS.join(" | ")}   (default: npm)
  -n, --limit <n>          results to show                      (default: 10)
  -l, --license <spdx>     your project's license, for compatibility (default: MIT)
      --json               machine-readable output
      --no-color           disable ANSI colour
  -h, --help               show this message
  -v, --version            print the version

Examples
  ossfind search "markdown parser"
  ossfind search "http client" -e cargo -n 5
  ossfind search "web framework" -e pypi --json
  ossfind inspect marked
  ossfind inspect requests -e pypi
`;

interface Style {
  bold: (text: string) => string;
  dim: (text: string) => string;
  verdict: (verdict: string) => string;
}

function styles(enabled: boolean): Style {
  if (!enabled) {
    return { bold: (t) => t, dim: (t) => t, verdict: (v) => v.toUpperCase().padEnd(7) };
  }
  const wrap = (code: string) => (text: string) => `[${code}m${text}[0m`;
  const colours: Record<string, string> = { ship: "32", caution: "33", avoid: "31" };
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    verdict: (v) => wrap(colours[v] ?? "0")(v.toUpperCase().padEnd(7)),
  };
}

/** stdout is a pipe when redirected; colour would corrupt it. */
function colourWanted(disabled: boolean | undefined): boolean {
  if (disabled) return false;
  const env = process.env;
  if (env.NO_COLOR !== undefined) return false;
  return process.stdout.isTTY === true;
}

function renderResult(result: ScoredComponent, index: number, style: Style): string {
  const badges = result.badges;
  const facts = [
    badges.license ?? "license unknown",
    `${badges.cveCount} CVE${badges.cveCount === 1 ? "" : "s"}`,
    badges.scorecard === null || badges.scorecard === undefined
      ? "no scorecard"
      : `OpenSSF ${badges.scorecard}`,
  ].join("  ·  ");

  return [
    `${String(index + 1).padStart(2)}. ${style.bold(result.name)}  ${style.verdict(result.verdict)} ${String(result.overall).padStart(3)}/100`,
    `    ${style.dim(facts)}`,
    `    ${style.dim(result.reasons.join(" · "))}`,
  ].join("\n");
}

async function runSearch(query: string, values: Record<string, unknown>): Promise<number> {
  const ecosystem = (values.ecosystem as SearchEcosystem | undefined) ?? "npm";
  if (!ECOSYSTEMS.includes(ecosystem)) {
    process.stderr.write(`unknown ecosystem "${ecosystem}" — expected one of ${ECOSYSTEMS.join(", ")}\n`);
    return 1;
  }

  const limit = Number(values.limit ?? 10);
  if (!Number.isInteger(limit) || limit < 1) {
    process.stderr.write(`--limit must be a positive integer, got "${values.limit}"\n`);
    return 1;
  }

  const projectLicense = (values.license as string | undefined) ?? "MIT";
  const pipeline = buildPipeline({ ecosystem, projectLicense });
  const results = await searchComponents(query, pipeline, { limit });

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ query, ecosystem, projectLicense, results }, null, 2)}\n`);
    return 0;
  }

  const style = styles(colourWanted(values["no-color"] as boolean | undefined));
  if (results.length === 0) {
    process.stdout.write(`No ${ecosystem} components matched ${JSON.stringify(query)}.\n`);
    return 0;
  }

  process.stdout.write(`\n${style.dim(`${results.length} result(s) for ${JSON.stringify(query)} in ${ecosystem}, project license ${projectLicense}`)}\n\n`);
  process.stdout.write(`${results.map((result, index) => renderResult(result, index, style)).join("\n\n")}\n\n`);
  return 0;
}

async function runInspect(target: string, values: Record<string, unknown>): Promise<number> {
  const ecosystem = (values.ecosystem as string | undefined) ?? "npm";
  if (ecosystem !== "npm" && ecosystem !== "pypi") {
    process.stderr.write(`inspect supports npm and pypi only — ${ecosystem} publishes no fetchable declarations.\n`);
    return 1;
  }

  const http = createPipelineHttpClient({});
  const [surface, built] = await Promise.all(
    ecosystem === "npm"
      ? [new ApiSurfaceExtractor(http).extract(target), new IntegrationManifestBuilder(http).build(target)]
      : [new PyApiSurfaceExtractor(http).extract(target), new PyIntegrationManifestBuilder(http).build(target)],
  );
  const manifest = ecosystem === "npm"
    ? reconcileImportForm(target, built as never, surface as never)
    : built;

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ surface, manifest }, null, 2)}\n`);
    return 0;
  }

  const style = styles(colourWanted(values["no-color"] as boolean | undefined));
  const limit = Number(values.limit ?? 10);
  // Things you can call come before things you can only annotate with: a reader
  // asking "how do I use this" is served by the class before the type alias.
  const callableFirst = new Set(["default", "class", "function", "const", "enum"]);
  const ordered = [...surface.exports].sort((left, right) =>
    Number(callableFirst.has(right.kind)) - Number(callableFirst.has(left.kind)));
  const shown = ordered.slice(0, Number.isInteger(limit) && limit > 0 ? limit : 10);

  process.stdout.write(`\n${style.bold(surface.id)}  ${style.dim(`${surface.typesAvailable} declarations, ${surface.exports.length} exports`)}\n\n`);
  process.stdout.write(`  ${style.dim("install")}  ${manifest.install.command}\n`);
  const importLine = manifest.importForm.esm ?? manifest.importForm.cjs;
  if (importLine) process.stdout.write(`  ${style.dim("import ")}  ${importLine}\n`);
  process.stdout.write("\n");

  if (shown.length === 0) {
    process.stdout.write(`  ${style.dim("no declarations published — signatures cannot be verified")}\n\n`);
    return 0;
  }

  for (const entry of shown) {
    const signature = entry.signature ? `  ${style.dim(entry.signature.replace(/\s+/g, " "))}` : "";
    process.stdout.write(`  ${style.dim(`[${entry.kind}]`.padEnd(12))}${entry.name}${signature}\n`);

    // A class's own signature is null, so its members are the only usable evidence.
    for (const member of entry.members ?? []) {
      const text = member.signature ?? member.name;
      process.stdout.write(`      ${style.dim(`${member.static ? "static " : ""}${text.replace(/\s+/g, " ").slice(0, 140)}`)}\n`);
    }
    if (entry.membersTruncated) {
      process.stdout.write(`      ${style.dim("… more members not listed")}\n`);
    }
  }
  if (surface.exports.length > shown.length) {
    process.stdout.write(`\n  ${style.dim(`… ${surface.exports.length - shown.length} more; raise --limit to see them`)}\n`);
  }
  process.stdout.write("\n");
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        ecosystem: { type: "string", short: "e" },
        limit: { type: "string", short: "n" },
        license: { type: "string", short: "l" },
        json: { type: "boolean", default: false },
        // node:util's parseArgs has no automatic --no-<flag> negation, so the flag
        // documented in USAGE has to be declared explicitly or it is rejected.
        "no-color": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 1;
  }

  const { values, positionals } = parsed;
  if (values.version) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return 0;
  }

  const [command, ...rest] = positionals;
  // Asking for help is a successful request; running with no arguments is not.
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!command) {
    process.stderr.write(USAGE);
    return 1;
  }

  const argument = rest.join(" ").trim();
  if (command === "search" || command === "inspect") {
    if (!argument) {
      process.stderr.write(`${command} needs ${command === "search" ? "a query" : "a package name"}\n\n${USAGE}`);
      return 1;
    }
    return command === "search"
      ? runSearch(argument, values as Record<string, unknown>)
      : runInspect(argument, values as Record<string, unknown>);
  }

  process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
  return 1;
}
