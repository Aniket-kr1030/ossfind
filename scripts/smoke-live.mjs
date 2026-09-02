#!/usr/bin/env node

class SupplierUnavailable extends Error {}

// This deliberately imports the application only after the opt-in guard: the
// default invocation is inert, offline, and safe for deterministic CI.
if (process.env.OSSFIND_LIVE !== "1") {
  console.log("SKIP | live smoke | skipped — set OSSFIND_LIVE=1");
} else {
  await main();
}

async function main() {
  const [
    fs,
    os,
    path,
    server,
    contracts,
    pipelineModule,
  ] = await Promise.all([
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
    import("../src/mcp/server.ts"),
    import("../src/contracts/index.ts"),
    import("../src/mcp/pipeline.ts"),
  ]);

  const { existsSync } = await import("node:fs");
  const { mkdtemp, readdir } = fs;
  const { tmpdir } = os;
  const { join, resolve } = path;
  const {
    createInspectComponentHandler,
    createPlanIntegrationHandler,
    createSearchComponentsHandler,
    InspectComponentOutputSchema,
    PlanIntegrationOutputSchema,
  } = server;
  const { ScoredComponentSchema } = contracts;
  const { buildPipeline, createPipelineHttpClient } = pipelineModule;

  const checkTimeoutMs = positiveInteger(process.env.OSSFIND_LIVE_CHECK_TIMEOUT_MS, 25_000);
  const totalTimeoutMs = positiveInteger(process.env.OSSFIND_LIVE_TIMEOUT_MS, 120_000);
  const startedAt = Date.now();
  const outcomes = [];
  const cacheDir = await mkdtemp(join(tmpdir(), "ossfind-live-cache-"));

  // Force this process onto the actual live/cache branch even if a caller has
  // fixture or no-cache variables in its shell. TF-IDF is a supported live
  // production setting and avoids an unbounded model download in a smoke test.
  delete process.env.OSSFIND_FIXTURES;
  delete process.env.OSSFIND_NO_CACHE;
  process.env.OSSFIND_CACHE_DIR = cacheDir;
  process.env.OSSFIND_FIT = "tfidf";

  const totalTimer = setTimeout(() => {
    outcomes.push({
      check: "total runtime",
      status: "FAIL",
      detail: `exceeded ${totalTimeoutMs}ms hard limit (a live supplier did not finish)`,
    });
    report(outcomes, startedAt);
    process.exit(1);
  }, totalTimeoutMs);
  totalTimer.unref();

  try {
    let cold;
    await runCheck(outcomes, "cached npm API surface (cold)", checkTimeoutMs, async () => {
      cold = await inspectAxios(createInspectComponentHandler, InspectComponentOutputSchema);
      const entries = await readdir(cacheDir, { recursive: true });
      if (!entries.some((entry) => String(entry).endsWith(".json"))) {
        throw new Error("cold live inspection wrote no cache entries");
      }
      return `${cold.totalExports} exports; cache populated`;
    });

    await runCheck(outcomes, "cached npm API surface (warm)", checkTimeoutMs, async () => {
      const warm = await inspectAxios(createInspectComponentHandler, InspectComponentOutputSchema);
      if (warm.totalExports !== cold.totalExports) {
        throw new Error(`export count changed cold=${cold.totalExports}, warm=${warm.totalExports}`);
      }
      return `${warm.totalExports} exports; identical to cold cache`;
    });

    await runCheck(outcomes, "plan_integration verified signatures", checkTimeoutMs, async () => {
      const result = await createPlanIntegrationHandler({ fixtures: false })({
        component: "axios",
        ecosystem: "npm",
        preferExport: "get",
      });
      requireToolSuccess(result, "plan_integration");
      const output = PlanIntegrationOutputSchema.parse(result.structuredContent);
      if (output.scaffold.confidence !== "verified-signatures") {
        throw new Error(`expected verified-signatures, received ${output.scaffold.confidence}`);
      }
      if (!output.scaffold.snippet) throw new Error("verified scaffold omitted its snippet");
      return "axios scaffold is verified-signatures";
    });

    const pypiState = pypiConfiguration(existsSync, resolve);
    const ecosystemChecks = [
      { ecosystem: "npm", query: "http client" },
      { ecosystem: "github", query: "http client" },
      { ecosystem: "huggingface", query: "text classification" },
      { ecosystem: "pypi", query: "http client", configured: pypiState.configured, reason: pypiState.reason },
    ];

    for (const item of ecosystemChecks) {
      const name = `${item.ecosystem} live ranked search`;
      if (item.configured === false) {
        outcomes.push({ check: name, status: "SKIP", detail: item.reason });
        continue;
      }
      await runCheck(outcomes, name, checkTimeoutMs, async () => {
        const handler = createSearchComponentsHandler({ fixtures: false });
        let response;
        try {
          response = await handler({
            query: item.query,
            ecosystem: item.ecosystem,
            detail: "full",
            limit: 1,
          });
        } catch (error) {
          return throwSupplierAwareFailure(
            item.ecosystem, item.query, error, createPipelineHttpClient, existsSync, resolve,
          );
        }

        if (response.isError) {
          return throwSupplierAwareFailure(
            item.ecosystem,
            item.query,
            new Error(toolErrorMessage(response, "search_components")),
            createPipelineHttpClient,
            existsSync,
            resolve,
          );
        }

        const results = response.structuredContent?.results;
        if (!Array.isArray(results)) throw new Error("search_components returned no results array");
        const ranked = results.map((result) => ScoredComponentSchema.parse(result));
        if (ranked.length === 0) {
          return throwSupplierAwareFailure(
            item.ecosystem,
            item.query,
            new Error("returned zero ranked components"),
            createPipelineHttpClient,
            existsSync,
            resolve,
          );
        }

        await assertLiveSafety(ranked, item.ecosystem, item.query, buildPipeline);
        return `${ranked.length} schema-valid result(s); safety invariants hold`;
      });
    }
  } finally {
    clearTimeout(totalTimer);
  }

  report(outcomes, startedAt);
  if (outcomes.some((outcome) => outcome.status === "FAIL")) process.exit(1);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function runCheck(outcomes, check, timeoutMs, work) {
  try {
    const detail = await withTimeout(check, timeoutMs, work());
    outcomes.push({ check, status: "PASS", detail });
  } catch (error) {
    outcomes.push({
      check,
      status: error instanceof SupplierUnavailable ? "SKIP" : "FAIL",
      detail: errorMessage(error),
    });
  }
}

function withTimeout(check, timeoutMs, promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function inspectAxios(createInspectComponentHandler, InspectComponentOutputSchema) {
  const result = await createInspectComponentHandler({ fixtures: false })({
    component: "axios",
    ecosystem: "npm",
    limit: 500,
  });
  requireToolSuccess(result, "inspect_component");
  const output = InspectComponentOutputSchema.parse(result.structuredContent);
  if (output.totalExports <= 0 || output.surface.exports.length <= 0) {
    throw new Error(`axios cached surface is empty (totalExports=${output.totalExports})`);
  }
  return output;
}

function requireToolSuccess(result, tool) {
  if (result?.isError) throw new Error(toolErrorMessage(result, tool));
}

function toolErrorMessage(result, tool) {
  const text = result?.content?.find?.((item) => item.type === "text")?.text;
  return text || `${tool} returned an error result`;
}

async function assertLiveSafety(ranked, ecosystem, query, buildPipeline) {
  for (const component of ranked) {
    if ((component.id.startsWith("github:") || component.id.startsWith("huggingface:"))
      && component.verdict === "ship") {
      throw new Error(`${component.id} was incorrectly ranked ship`);
    }
    if (component.verdict !== "ship") continue;

    // ScoredComponent intentionally omits supplier provenance. Retrieve the
    // same live candidate through buildPipeline before accepting a ship verdict.
    const pipeline = buildPipeline({ fixtures: false, ecosystem });
    const candidates = await pipeline.discoverer.discover(query);
    const candidate = candidates.find((entry) => entry.id === component.id);
    if (!candidate) throw new Error(`could not recover live candidate ${component.id} for safety evidence`);
    const evidence = await pipeline.enricher.enrich(candidate);
    if (evidence.sources.license !== "ok" || evidence.sources.osv !== "ok") {
      throw new Error(
        `${component.id} was ranked ship without verified license/OSV evidence `
        + `(license=${evidence.sources.license}, osv=${evidence.sources.osv})`,
      );
    }
  }
}

function pypiConfiguration(existsSync, resolve) {
  const hasIndex = existsSync(resolve(process.cwd(), ".cache/index/pypi.db"));
  const hasKey = Boolean(process.env.LIBRARIES_IO_API_KEY || process.env.LIBRARY_IO_API_KEY);
  const mode = process.env.OSSFIND_PYPI_DISCOVERY;
  const configured = mode === "index" ? hasIndex : mode === "libraries" ? hasKey : hasIndex || hasKey;
  if (configured) return { configured: true, hasIndex };
  return {
    configured: false,
    reason: "PyPI skipped: no usable local .cache/index/pypi.db or libraries.io API key configured",
  };
}

async function throwSupplierAwareFailure(
  ecosystem,
  query,
  original,
  createPipelineHttpClient,
  existsSync,
  resolve,
) {
  const diagnosis = await supplierDiagnosis(
    ecosystem, query, createPipelineHttpClient, existsSync, resolve,
  );
  if (diagnosis.unavailable) {
    throw new SupplierUnavailable(`${diagnosis.detail}; original result: ${errorMessage(original)}`);
  }
  throw new Error(`${errorMessage(original)}; supplier probe was healthy (${diagnosis.detail})`);
}

async function supplierDiagnosis(ecosystem, query, createPipelineHttpClient, existsSync, resolve) {
  if (
    ecosystem === "pypi"
    && process.env.OSSFIND_PYPI_DISCOVERY !== "libraries"
    && existsSync(resolve(process.cwd(), ".cache/index/pypi.db"))
  ) {
    return { unavailable: false, detail: "local PyPI index is configured" };
  }

  const url = probeUrl(ecosystem, query);
  if (!url) return { unavailable: false, detail: "no external supplier probe applies" };
  try {
    const client = createPipelineHttpClient({ fixtures: false });
    const response = await withTimeout(`${ecosystem} supplier probe`, 8_000, client(url, probeInit(ecosystem)));
    if (response.ok) return { unavailable: false, detail: `HTTP ${response.status}` };
    return { unavailable: true, detail: `supplier returned HTTP ${response.status}` };
  } catch (error) {
    return { unavailable: true, detail: `supplier request failed: ${errorMessage(error)}` };
  }
}

function probeUrl(ecosystem, query) {
  if (ecosystem === "npm") {
    return `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=1`;
  }
  if (ecosystem === "github") {
    return `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=1`;
  }
  if (ecosystem === "huggingface") {
    return `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&limit=1`;
  }
  if (ecosystem === "pypi") {
    const key = process.env.LIBRARIES_IO_API_KEY || process.env.LIBRARY_IO_API_KEY;
    return key
      ? `https://libraries.io/api/search?q=${encodeURIComponent(query)}&platforms=Pypi&per_page=1&api_key=${encodeURIComponent(key)}`
      : undefined;
  }
  return undefined;
}

function probeInit(ecosystem) {
  if (ecosystem !== "github") return undefined;
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return { headers };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function report(outcomes, startedAt) {
  console.log("\nossfind live smoke (production suppliers + disk cache)");
  console.log("| Check | Status | Detail |");
  console.log("|---|---|---|");
  for (const outcome of outcomes) {
    console.log(`| ${outcome.check} | ${outcome.status} | ${outcome.detail.replaceAll("|", "/")} |`);
  }
  console.log(`Completed in ${Date.now() - startedAt}ms.`);
}
