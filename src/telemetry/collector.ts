import type { HttpResponse } from "../http/client.js";

/**
 * Privacy rule: this in-process collector records only approved supplier hosts
 * and aggregate numeric metrics. Never add queries, package names, paths,
 * credentials, request bodies, response bodies, or full URLs to its state.
 */

export const SUPPLIER_HOSTS = [
  "registry.npmjs.org",
  "api.github.com",
  "huggingface.co",
  "pypi.org",
  "api.deps.dev",
  "api.osv.dev",
  "packages.ecosyste.ms",
  "libraries.io",
  "cdn.jsdelivr.net",
  "files.pythonhosted.org",
] as const;

export type SupplierHost = typeof SUPPLIER_HOSTS[number];
export type CacheOutcome = "hit" | "miss";
export type Verdict = "ship" | "caution" | "avoid";

export interface UsageCollectorOptions {
  /** Injectable clock for deterministic latency measurements. */
  now?: () => number;
  /** Maximum retained latency samples. Defaults to 256. */
  reservoirSize?: number;
}

export interface RateLimitHeadroom {
  remaining?: number;
  limit?: number;
  reset?: number;
  retryAfter?: number;
}

export interface SupplierUsage {
  requests: number;
  cacheHits: number;
  cacheMisses: number;
  statusClasses: Record<"1xx" | "2xx" | "3xx" | "4xx" | "5xx", number>;
  rateLimited429: number;
  errors: number;
  rateLimit: RateLimitHeadroom;
}

export interface UsageSnapshot {
  suppliers: Record<SupplierHost, SupplierUsage>;
  operations: {
    searchesServed: number;
    ecosystems: Record<"npm" | "pypi" | "github" | "huggingface", number>;
    verdicts: Record<Verdict, number>;
    results: { count: number; total: number; min: number; max: number; mean: number };
    errors: number;
    latency: { count: number; p50: number; p95: number; reservoirSize: number };
  };
}

const supplierAliases: Readonly<Record<string, SupplierHost>> = {
  "data.jsdelivr.com": "cdn.jsdelivr.net",
};

function emptySupplierUsage(): SupplierUsage {
  return {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    statusClasses: { "1xx": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
    rateLimited429: 0,
    errors: 0,
    rateLimit: {},
  };
}

function isSupplierHost(host: string): host is SupplierHost {
  return (SUPPLIER_HOSTS as readonly string[]).includes(host);
}

/** Extracts an approved host only; the input URL is immediately discarded. */
export function supplierHostFor(url: string): SupplierHost | undefined {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return isSupplierHost(hostname) ? hostname : supplierAliases[hostname];
  } catch {
    return undefined;
  }
}

function finiteHeader(response: HttpResponse, name: string): number | undefined {
  const value = response.headers?.get(name);
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function retryAfterHeader(response: HttpResponse): number | undefined {
  const value = response.headers?.get("retry-after");
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : undefined;
}

function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

/** In-memory, aggregate-only usage accounting. It never performs I/O. */
export class UsageCollector {
  private readonly now: () => number;
  private readonly maxSamples: number;
  private suppliers = this.createSuppliers();
  private searchesServed = 0;
  private ecosystems: UsageSnapshot["operations"]["ecosystems"] = {
    npm: 0, pypi: 0, github: 0, huggingface: 0,
  };
  private verdicts: Record<Verdict, number> = { ship: 0, caution: 0, avoid: 0 };
  private resultCount = 0;
  private resultTotal = 0;
  private resultMin = 0;
  private resultMax = 0;
  private operationErrors = 0;
  private latencyCount = 0;
  private latencySamples: number[] = [];
  private nextSample = 0;

  constructor(options: UsageCollectorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxSamples = Math.max(1, Math.floor(options.reservoirSize ?? 256));
  }

  /** Records a clock value without retaining any request or search input. */
  beginSearch(): number {
    return this.now();
  }

  recordHttpResponse(url: string, cache: CacheOutcome, response: HttpResponse): void {
    const supplier = supplierHostFor(url);
    if (!supplier) return;
    const usage = this.suppliers[supplier];
    usage.requests += 1;
    if (cache === "hit") usage.cacheHits += 1;
    else usage.cacheMisses += 1;
    const statusClass = `${Math.floor(response.status / 100)}xx` as keyof SupplierUsage["statusClasses"];
    if (statusClass in usage.statusClasses) usage.statusClasses[statusClass] += 1;
    if (response.status === 429) usage.rateLimited429 += 1;
    this.recordRateLimit(usage, response);
  }

  recordHttpError(url: string, cache: CacheOutcome): void {
    const supplier = supplierHostFor(url);
    if (!supplier) return;
    const usage = this.suppliers[supplier];
    usage.requests += 1;
    if (cache === "hit") usage.cacheHits += 1;
    else usage.cacheMisses += 1;
    usage.errors += 1;
  }

  recordSearchSuccess(startedAt: number, results: ReadonlyArray<{ id: string; verdict: Verdict }>): void {
    this.searchesServed += 1;
    this.recordLatency(startedAt);
    const count = results.length;
    this.resultCount += 1;
    this.resultTotal += count;
    this.resultMin = this.resultCount === 1 ? count : Math.min(this.resultMin, count);
    this.resultMax = Math.max(this.resultMax, count);
    for (const result of results) {
      const ecosystem = result.id.slice(0, result.id.indexOf(":"));
      if (ecosystem === "npm" || ecosystem === "pypi" || ecosystem === "github" || ecosystem === "huggingface") {
        this.ecosystems[ecosystem] += 1;
      }
      this.verdicts[result.verdict] += 1;
    }
  }

  recordSearchError(startedAt: number): void {
    this.operationErrors += 1;
    this.recordLatency(startedAt);
  }

  snapshot(): UsageSnapshot {
    const samples = this.latencySamples;
    return {
      suppliers: Object.fromEntries(SUPPLIER_HOSTS.map((host) => [host, {
        ...this.suppliers[host],
        statusClasses: { ...this.suppliers[host].statusClasses },
        rateLimit: { ...this.suppliers[host].rateLimit },
      }])) as UsageSnapshot["suppliers"],
      operations: {
        searchesServed: this.searchesServed,
        ecosystems: { ...this.ecosystems },
        verdicts: { ...this.verdicts },
        results: {
          count: this.resultCount,
          total: this.resultTotal,
          min: this.resultMin,
          max: this.resultMax,
          mean: this.resultCount === 0 ? 0 : this.resultTotal / this.resultCount,
        },
        errors: this.operationErrors,
        latency: {
          count: this.latencyCount,
          p50: percentile(samples, 0.5),
          p95: percentile(samples, 0.95),
          reservoirSize: samples.length,
        },
      },
    };
  }

  reset(): void {
    this.suppliers = this.createSuppliers();
    this.searchesServed = 0;
    this.ecosystems = { npm: 0, pypi: 0, github: 0, huggingface: 0 };
    this.verdicts = { ship: 0, caution: 0, avoid: 0 };
    this.resultCount = 0;
    this.resultTotal = 0;
    this.resultMin = 0;
    this.resultMax = 0;
    this.operationErrors = 0;
    this.latencyCount = 0;
    this.latencySamples = [];
    this.nextSample = 0;
  }

  private createSuppliers(): Record<SupplierHost, SupplierUsage> {
    return Object.fromEntries(SUPPLIER_HOSTS.map((host) => [host, emptySupplierUsage()])) as Record<SupplierHost, SupplierUsage>;
  }

  private recordRateLimit(usage: SupplierUsage, response: HttpResponse): void {
    const headers: Array<[Exclude<keyof RateLimitHeadroom, "retryAfter">, string]> = [
      ["remaining", "x-ratelimit-remaining"],
      ["limit", "x-ratelimit-limit"],
      ["reset", "x-ratelimit-reset"],
    ];
    for (const [key, header] of headers) {
      const value = finiteHeader(response, header);
      if (value !== undefined) usage.rateLimit[key] = value;
    }
    const retryAfter = retryAfterHeader(response);
    if (retryAfter !== undefined) usage.rateLimit.retryAfter = retryAfter;
  }

  private recordLatency(startedAt: number): void {
    const elapsed = Math.max(0, this.now() - startedAt);
    this.latencyCount += 1;
    if (this.latencySamples.length < this.maxSamples) this.latencySamples.push(elapsed);
    else {
      this.latencySamples[this.nextSample] = elapsed;
      this.nextSample = (this.nextSample + 1) % this.maxSamples;
    }
  }
}
