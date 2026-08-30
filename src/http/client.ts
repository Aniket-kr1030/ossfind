import type { UsageCollector } from "../telemetry/collector.js";

/** The small response surface used by network adapters and offline tests. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Optional to retain compatibility with existing JSON-only injected clients. */
  text?(): Promise<string>;
  /** Optional fetch-compatible header access used for rate-limit accounting. */
  headers?: { get(name: string): string | null };
}

/** Injectable HTTP boundary.  The production default is Node's global fetch. */
export type HttpClient = (url: string, init?: RequestInit) => Promise<HttpResponse>;

export const defaultHttpClient: HttpClient = (url, init) => fetch(url, init);

/**
 * Adds aggregate-only accounting to an uncached HTTP boundary. Passing no
 * collector returns the original client, preserving disabled behavior exactly.
 */
export function withUsageCollector(inner: HttpClient, collector?: UsageCollector): HttpClient {
  if (!collector) return inner;
  return async (url, init) => {
    try {
      const response = await inner(url, init);
      collector.recordHttpResponse(url, "miss", response);
      return response;
    } catch (error) {
      collector.recordHttpError(url, "miss");
      throw error;
    }
  };
}
