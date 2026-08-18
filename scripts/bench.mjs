// Reusable performance harness — drives the shipped dist/ modules, like demo.mjs.
// It reports measurements only: network-dependent results are never pass/fail gates.
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { buildPipeline } from "../dist/mcp/pipeline.js";
import { searchComponents } from "../dist/pipeline/orchestrator.js";
import { openIndex } from "../dist/index/local-index.js";
import { TransformersEmbeddingsProvider } from "../dist/fit/transformers-provider.js";
import { createLimiter } from "../dist/http/limit.js";

const CACHE_DIR = ".cache/http";
const INDEX_PATH = ".cache/index/pypi.db";
const FIXTURE_RUNS = 15;
const INDEX_RUNS = 20;
const MCP_RUNS = 10;
const skips = [];
const concerns = [];

const now = () => performance.now();
const elapsed = async (fn) => {
  const started = now();
  await fn();
  return now() - started;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(sorted, fraction) {
  if (sorted.length === 0) return NaN;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function statistics(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted.at(-1),
    n: samples.length,
  };
}

function milliseconds(value) {
  return Number.isFinite(value) ? `${value.toFixed(value < 10 ? 2 : 1)} ms` : "—";
}

function row(name, samples) {
  return { name, ...statistics(samples) };
}

function printSection(title, rows) {
  console.log(`\n${title}`);
  console.log("scenario                                              p50       p95       min       max     n");
  console.log("─".repeat(91));
  for (const result of rows) {
    console.log(
      `${result.name.slice(0, 52).padEnd(52)} ${milliseconds(result.p50).padStart(9)} ${milliseconds(result.p95).padStart(9)} ${milliseconds(result.min).padStart(9)} ${milliseconds(result.max).padStart(9)} ${String(result.n).padStart(5)}`,
    );
  }
}

async function measureFixtureEndToEnd() {
  const specs = [
    ["npm", "http client"],
    ["pypi", "http client"],
    ["github", "video generation"],
    ["huggingface", "video generation"],
    ["all", "video generation"],
  ];
  const rows = [];
  for (const [ecosystem, query] of specs) {
    // Warm module initialization and fixture parsing, then exclude it from samples.
    await searchComponents(query, buildPipeline({ ecosystem, fixtures: true }));
    const samples = [];
    for (let run = 0; run < FIXTURE_RUNS; run += 1) {
      // Discoverers memoize by query, so use a new pipeline to retain real discovery work.
      samples.push(await elapsed(() => searchComponents(query, buildPipeline({ ecosystem, fixtures: true }))));
    }
    rows.push(row(`fixture E2E ${ecosystem} (${JSON.stringify(query)})`, samples));
  }
  printSection("1. Fixture-mode end-to-end (warm-up excluded)", rows);
  return rows;
}

async function measureEmbeddingStartup() {
  const provider = new TransformersEmbeddingsProvider();
  try {
    const cold = await elapsed(() => provider.embed(["http client"]));
    const warm = await elapsed(() => provider.embed(["video generation"]));
    return { provider, rows: [
      row("time to first embed (model load)", [cold]),
      row("subsequent warm embed", [warm]),
    ] };
  } catch (error) {
    skips.push(`embedding startup: ${errorMessage(error)}`);
    return { provider: undefined, rows: [] };
  }
}

async function measureLocalIndex(provider) {
  if (!existsSync(INDEX_PATH)) {
    skips.push(`local PyPI index: ${INDEX_PATH} is absent`);
    printSection("2. Local PyPI index", []);
    return [];
  }
  let index;
  try {
    index = openIndex(INDEX_PATH);
    const queries = ["http client", "data validation", "video generation"];
    const rows = [];
    let queryVectors;
    if (!index.hasVectors()) {
      skips.push("local PyPI hybrid search: index has no stored vectors");
    } else if (!provider) {
      skips.push("local PyPI hybrid search: embedding provider was unavailable");
    } else {
      try {
        queryVectors = await Promise.all(queries.map(async (query) => {
          const vector = (await provider.embed([query]))[0];
          if (!vector) throw new Error("embedding provider returned no query vector");
          return vector;
        }));
      } catch (error) {
        skips.push(`local PyPI hybrid search: ${errorMessage(error)}`);
      }
    }
    for (const [position, query] of queries.entries()) {
      const options = { ecosystem: "pypi", limit: 20 };
      const bm25 = [];
      for (let run = 0; run < INDEX_RUNS; run += 1) {
        bm25.push(await elapsed(() => index.search(query, options)));
      }
      const bm25Row = row(`PyPI BM25 (${JSON.stringify(query)})`, bm25);
      rows.push(bm25Row);
      if (queryVectors) {
        const hybrid = [];
        for (let run = 0; run < INDEX_RUNS; run += 1) {
          hybrid.push(await elapsed(() => index.searchHybrid(query, queryVectors[position], options)));
        }
        const hybridRow = row(`PyPI hybrid (${JSON.stringify(query)})`, hybrid);
        rows.push(hybridRow);
        const ratio = hybridRow.p50 / bm25Row.p50;
        if (Number.isFinite(ratio) && ratio >= 3) {
          concerns.push(`local PyPI hybrid search for ${JSON.stringify(query)} is ${ratio.toFixed(1)}x BM25 p50`);
        }
      }
    }
    printSection("2. Local PyPI index (20 runs per query/method)", rows);
    return rows;
  } catch (error) {
    skips.push(`local PyPI index: ${errorMessage(error)}`);
    printSection("2. Local PyPI index", []);
    return [];
  } finally {
    index?.close();
  }
}

async function clearHttpCache() {
  await rm(CACHE_DIR, { recursive: true, force: true });
}

async function probeLiveSource(ecosystem, query) {
  const pipeline = buildPipeline({ ecosystem, fixtures: false });
  const candidates = await pipeline.discoverer.discover(query);
  if (candidates.length === 0) throw new Error("discovery returned no candidates");
}

async function measureLiveCache() {
  const candidates = [
    ["npm", "http client"],
    ["pypi", "http client"],
    ["github", "video generation"],
    ["huggingface", "video generation"],
  ];
  const previousFitMode = process.env.OSSFIND_FIT;
  const previousFixtureMode = process.env.OSSFIND_FIXTURES;
  const previousNoCache = process.env.OSSFIND_NO_CACHE;
  const previousCacheDir = process.env.OSSFIND_CACHE_DIR;
  // Cache timing should isolate supplier/cache work rather than model startup (reported above).
  process.env.OSSFIND_FIT = "tfidf";
  process.env.OSSFIND_CACHE_DIR = CACHE_DIR;
  delete process.env.OSSFIND_FIXTURES;
  delete process.env.OSSFIND_NO_CACHE;
  try {
    for (const [ecosystem, query] of candidates) {
      try {
        await clearHttpCache();
        await probeLiveSource(ecosystem, query);
        await clearHttpCache(); // The probe must not turn the measured cold request into a cache hit.
        const cold = await elapsed(() => searchComponents(query, buildPipeline({ ecosystem, fixtures: false })));
        const warm = [];
        for (let run = 0; run < 3; run += 1) {
          warm.push(await elapsed(() => searchComponents(query, buildPipeline({ ecosystem, fixtures: false }))));
        }
        const rows = [row(`live ${ecosystem} cold (${JSON.stringify(query)})`, [cold]), row(`live ${ecosystem} warm (${JSON.stringify(query)})`, warm)];
        printSection("3. Live-mode HTTP cache effectiveness (TF-IDF fit isolates cache)", rows);
        const ratio = cold / statistics(warm).p50;
        if (Number.isFinite(ratio) && ratio >= 2) concerns.push(`live ${ecosystem} cold cache call is ${ratio.toFixed(1)}x warm p50`);
        return rows;
      } catch (error) {
        skips.push(`live ${ecosystem}: ${errorMessage(error)}`);
      }
    }
    printSection("3. Live-mode HTTP cache effectiveness", []);
    return [];
  } finally {
    if (previousFitMode === undefined) delete process.env.OSSFIND_FIT;
    else process.env.OSSFIND_FIT = previousFitMode;
    if (previousFixtureMode === undefined) delete process.env.OSSFIND_FIXTURES;
    else process.env.OSSFIND_FIXTURES = previousFixtureMode;
    if (previousNoCache === undefined) delete process.env.OSSFIND_NO_CACHE;
    else process.env.OSSFIND_NO_CACHE = previousNoCache;
    if (previousCacheDir === undefined) delete process.env.OSSFIND_CACHE_DIR;
    else process.env.OSSFIND_CACHE_DIR = previousCacheDir;
  }
}

async function measureLimiterBurst() {
  const cap = 4;
  const taskCount = 20;
  const taskMs = 25;
  const limiter = createLimiter(cap);
  let active = 0;
  let peak = 0;
  const taskSamples = [];
  const started = now();
  await Promise.all(Array.from({ length: taskCount }, () => limiter.run(async () => {
    const taskStarted = now();
    active += 1;
    peak = Math.max(peak, active);
    await sleep(taskMs);
    active -= 1;
    taskSamples.push(now() - taskStarted);
  })));
  const wall = now() - started;
  const theoreticalSerial = taskCount * taskMs;
  printSection("4. Limiter burst", [
    row(`limited task runtime (${taskCount} tasks, cap ${cap})`, taskSamples),
    row(`burst wall time (serial theory ${theoreticalSerial} ms)`, [wall]),
  ]);
  console.log(`  peak in-flight: ${peak}/${cap}; wall: ${milliseconds(wall)} vs theoretical serial: ${milliseconds(theoreticalSerial)}.`);
  if (peak > cap) concerns.push(`limiter burst reached ${peak} in-flight tasks despite cap ${cap}`);
  return { wall, theoreticalSerial, peak };
}

function errorMessage(error) {
  return error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 180) : String(error);
}

class JsonRpcStdioClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.receive(chunk));
    child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    child.on("exit", (code, signal) => {
      const reason = new Error(`MCP server exited (${code ?? signal ?? "unknown"}): ${this.stderr.trim()}`);
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(reason);
      }
      this.pending.clear();
    });
    child.on("error", (error) => {
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(error);
      }
      this.pending.clear();
    });
  }

  receive(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject, timeout } = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(timeout);
        if (message.error) reject(new Error(message.error.message ?? "JSON-RPC error"));
        else resolve(message.result);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after 60 seconds`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
}

async function measureMcpRoundTrip() {
  const started = now();
  const child = spawn(process.execPath, ["dist/mcp/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, OSSFIND_FIXTURES: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new JsonRpcStdioClient(child);
  try {
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ossfind-bench", version: "0.1.0" },
    });
    client.notify("notifications/initialized", {});
    const startup = now() - started;
    const firstCall = await elapsed(() => client.request("tools/call", {
      name: "search_components",
      arguments: { query: "http client" },
    }));
    const spawnThroughFirstCall = now() - started;
    const samples = [];
    for (let run = 0; run < MCP_RUNS; run += 1) {
      samples.push(await elapsed(() => client.request("tools/call", {
        name: "search_components",
        arguments: { query: "http client" },
      })));
    }
    printSection("5. MCP stdio round trips (one persistent fixture-mode server)", [
      row("process spawn to initialize response", [startup]),
      row("one-time spawn through first tool-call warm-up", [spawnThroughFirstCall]),
      row("tools/call request-write to response-parse", samples),
    ]);
    console.log("  Fixture mode uses TF-IDF, so server startup has no Transformer model load; embedding startup is reported in section 6.");
    return samples;
  } catch (error) {
    skips.push(`MCP round trip: ${errorMessage(error)}`);
    printSection("5. MCP stdio round trips", []);
    return [];
  } finally {
    child.kill("SIGTERM");
  }
}

async function main() {
  console.log("ossfind performance benchmark (reporting only)");
  console.log(`Node ${process.version}; ${new Date().toISOString()}`);
  const embedding = await measureEmbeddingStartup();
  const fixtureRows = await measureFixtureEndToEnd();
  await measureLocalIndex(embedding.provider);
  await measureLiveCache();
  await measureLimiterBurst();
  await measureMcpRoundTrip();
  printSection("6. Embedding startup (one-shot)", embedding.rows);

  const allFixture = fixtureRows.find((result) => result.name.startsWith("fixture E2E all"));
  if (allFixture) console.log(`\nSummary: fixture all-ecosystem p50 ${milliseconds(allFixture.p50)}.${concerns.length ? ` ${concerns.join("; ")}.` : " No material outlier crossed the harness reporting threshold."}`);
  if (skips.length) {
    console.log("\nSkipped / unavailable:");
    for (const reason of skips) console.log(`- ${reason}`);
  }
}

main().catch((error) => {
  console.error(`Benchmark harness failed unexpectedly: ${errorMessage(error)}`);
  process.exitCode = 1;
});
