import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { UsageCollector, UsageSnapshot } from "./collector.js";

export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB
export const DEFAULT_TELEMETRY_TIMEOUT_MS = 2000;
export const TOOL_VERSION = "0.1.0";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveInstallIdPath(customPath?: string): string {
  if (customPath) return customPath;
  const baseDir = process.env.OSSFIND_CACHE_DIR ?? path.join(process.cwd(), ".cache");
  return path.join(baseDir, "telemetry", "install-id");
}

/**
 * Returns an anonymous random UUID v4.
 * Never derived from hostname, username, MAC, or any hardware/system fingerprint.
 */
export function getOrCreateInstallId(options: { installId?: string; installIdPath?: string } = {}): string {
  if (options.installId && UUID_REGEX.test(options.installId)) {
    return options.installId;
  }

  const filePath = resolveInstallIdPath(options.installIdPath);

  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8").trim();
      if (UUID_REGEX.test(content)) {
        return content;
      }
    }
  } catch {
    // Ignore filesystem read errors, proceed to generate
  }

  const newId = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, newId, "utf8");
  } catch {
    // Ignore filesystem write errors (e.g. read-only filesystem), proceed with generated UUID
  }

  return newId;
}

export interface TelemetryPayload {
  installId: string;
  version: string;
  timestamp: string;
  snapshot: UsageSnapshot;
}

export interface TelemetryEmitterOptions {
  /** Explicit opt-in override; defaults to process.env.OSSFIND_TELEMETRY === "1" */
  enabled?: boolean;
  /** HTTPS telemetry ingestion URL; defaults to process.env.OSSFIND_TELEMETRY_URL */
  endpoint?: string;
  /** Optional explicit anonymous install ID (must be a valid UUID) */
  installId?: string;
  /** Optional path to store/load the anonymous install ID */
  installIdPath?: string;
  /** Application version; defaults to "0.1.0" */
  version?: string;
  /** Injectable fetch implementation for tests and custom networking */
  fetch?: typeof fetch;
  /** Injectable clock function */
  now?: () => number;
  /** Maximum allowable JSON payload size in bytes; defaults to 64KB */
  maxPayloadBytes?: number;
  /** Request timeout in milliseconds; defaults to 2000ms */
  timeoutMs?: number;
}

/**
 * Client-side opt-in telemetry emitter.
 * Transmits only aggregate numeric counters and anonymous install ID.
 * Strictly fails open (swallows all network/parsing errors without affecting application logic).
 */
export class TelemetryEmitter {
  private readonly enabled: boolean;
  private readonly endpoint?: string;
  private readonly installId: string;
  private readonly version: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly maxPayloadBytes: number;
  private readonly timeoutMs: number;

  constructor(options: TelemetryEmitterOptions = {}) {
    const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    const isFixtureMode = env.OSSFIND_FIXTURES === "1";

    if (options.enabled !== undefined) {
      this.enabled = options.enabled;
    } else if (isFixtureMode) {
      this.enabled = false;
    } else {
      this.enabled = env.OSSFIND_TELEMETRY === "1";
    }

    this.endpoint = options.endpoint !== undefined ? options.endpoint : env.OSSFIND_TELEMETRY_URL;
    this.installId = getOrCreateInstallId({
      installId: options.installId,
      installIdPath: options.installIdPath,
    });
    this.version = options.version ?? TOOL_VERSION;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TELEMETRY_TIMEOUT_MS;
  }

  /**
   * Evaluates if telemetry is strictly configured to transmit:
   * 1. Enabled switch is true
   * 2. Endpoint is set and uses https: protocol
   */
  canTransmit(): boolean {
    if (!this.enabled || !this.endpoint) return false;
    try {
      const url = new URL(this.endpoint);
      return url.protocol === "https:";
    } catch {
      return false;
    }
  }

  getInstallId(): string {
    return this.installId;
  }

  buildPayload(snapshot: UsageSnapshot): TelemetryPayload {
    return {
      installId: this.installId,
      version: this.version,
      timestamp: new Date(this.now()).toISOString(),
      snapshot,
    };
  }

  /**
   * Transmits aggregate usage statistics to the configured endpoint.
   * Completely non-throwing (fails silently and open on any error).
   */
  async emit(collectorOrSnapshot: UsageCollector | UsageSnapshot): Promise<boolean> {
    if (!this.canTransmit() || !this.endpoint) {
      return false;
    }

    try {
      const snapshot =
        "snapshot" in collectorOrSnapshot && typeof collectorOrSnapshot.snapshot === "function"
          ? collectorOrSnapshot.snapshot()
          : (collectorOrSnapshot as UsageSnapshot);

      const payload = this.buildPayload(snapshot);
      const json = JSON.stringify(payload);

      if (Buffer.byteLength(json, "utf8") > this.maxPayloadBytes) {
        return false;
      }

      const signal = AbortSignal.timeout(this.timeoutMs);
      await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `ossfind/${this.version}`,
        },
        body: json,
        signal,
      });
      return true;
    } catch {
      // Swallowed completely and silently - fail open
      return false;
    }
  }

  /**
   * Non-blocking fire-and-forget emit that swallows all rejections.
   */
  emitAsync(collectorOrSnapshot: UsageCollector | UsageSnapshot): void {
    if (!this.canTransmit()) return;
    this.emit(collectorOrSnapshot).catch(() => {
      // Swallowed silently
    });
  }
}

/**
 * Format a human-readable text summary of usage metrics for display in MCP tools / CLI.
 */
export function formatUsageSummary(snapshot: UsageSnapshot): string {
  const lines: string[] = ["Usage Statistics:"];

  // 1. Searches & Ecosystems
  const { searchesServed, ecosystems, verdicts, latency, errors } = snapshot.operations;
  lines.push(
    `• Searches served: ${searchesServed} (npm: ${ecosystems.npm}, pypi: ${ecosystems.pypi}, github: ${ecosystems.github}, huggingface: ${ecosystems.huggingface})` +
      (errors > 0 ? ` [${errors} error(s)]` : ""),
  );

  // 2. Top suppliers by requests
  const activeSuppliers = Object.entries(snapshot.suppliers)
    .filter(([_, usage]) => usage.requests > 0)
    .sort((a, b) => b[1].requests - a[1].requests);

  if (activeSuppliers.length === 0) {
    lines.push("• Top suppliers: No supplier requests recorded.");
  } else {
    lines.push("• Top suppliers by requests:");
    for (const [host, usage] of activeSuppliers.slice(0, 5)) {
      lines.push(
        `  - ${host}: ${usage.requests} reqs (${usage.cacheHits} hits, ${usage.cacheMisses} misses` +
          (usage.rateLimited429 > 0 ? `, ${usage.rateLimited429} 429s` : "") +
          (usage.errors > 0 ? `, ${usage.errors} errs` : "") +
          `)`,
      );
    }
  }

  // 3. Cache hit rate
  let totalRequests = 0;
  let totalHits = 0;
  for (const usage of Object.values(snapshot.suppliers)) {
    totalRequests += usage.requests;
    totalHits += usage.cacheHits;
  }
  if (totalRequests > 0) {
    const hitRatePct = ((totalHits / totalRequests) * 100).toFixed(1);
    lines.push(`• Cache hit rate: ${hitRatePct}% (${totalHits}/${totalRequests} requests cached)`);
  } else {
    lines.push("• Cache hit rate: 0.0% (0 requests)");
  }

  // 4. Rate-limit headroom
  const lowHeadroomSuppliers: string[] = [];
  for (const [host, usage] of Object.entries(snapshot.suppliers)) {
    const remaining = usage.rateLimit.remaining;
    const limit = usage.rateLimit.limit;
    if (usage.rateLimited429 > 0) {
      lowHeadroomSuppliers.push(`${host} (hit 429 rate limit ${usage.rateLimited429}x)`);
    } else if (remaining !== undefined) {
      if (remaining <= 10 || (limit !== undefined && limit > 0 && remaining / limit <= 0.1)) {
        lowHeadroomSuppliers.push(`${host} (${remaining}${limit ? `/${limit}` : ""} remaining)`);
      }
    }
  }
  if (lowHeadroomSuppliers.length > 0) {
    lines.push(`• Rate-limit alerts: ${lowHeadroomSuppliers.join(", ")}`);
  } else {
    lines.push("• Rate limits: All suppliers within normal headroom.");
  }

  // 5. Latency percentiles
  lines.push(`• Latency: p50: ${latency.p50}ms, p95: ${latency.p95}ms (${latency.count} searches recorded)`);

  // 6. Verdict distribution
  lines.push(`• Verdict distribution: ship: ${verdicts.ship}, caution: ${verdicts.caution}, avoid: ${verdicts.avoid}`);

  return lines.join("\n");
}
