import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PipelineDependencies } from "../pipeline/interfaces.js";
import { searchComponents } from "../pipeline/orchestrator.js";
import { UsageCollector } from "./collector.js";
import {
  TelemetryEmitter,
  formatUsageSummary,
  getOrCreateInstallId,
  TOOL_VERSION,
  type TelemetryPayload,
} from "./emitter.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("TelemetryEmitter", () => {
  describe("Opt-in and Configuration Switches", () => {
    it("is off by default when no environment variables are set", async () => {
      const fetchSpy = vi.fn();
      const emitter = new TelemetryEmitter({
        fetch: fetchSpy as unknown as typeof fetch,
      });

      expect(emitter.canTransmit()).toBe(false);
      const collector = new UsageCollector();
      const result = await emitter.emit(collector);

      expect(result).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("makes zero network calls when only OSSFIND_TELEMETRY=1 is set without URL", async () => {
      vi.stubEnv("OSSFIND_TELEMETRY", "1");
      vi.stubEnv("OSSFIND_TELEMETRY_URL", "");
      try {
        const fetchSpy = vi.fn();
        const emitter = new TelemetryEmitter({ fetch: fetchSpy as unknown as typeof fetch });

        expect(emitter.canTransmit()).toBe(false);
        await emitter.emit(new UsageCollector());
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("makes zero network calls when only OSSFIND_TELEMETRY_URL is set without OSSFIND_TELEMETRY=1", async () => {
      vi.stubEnv("OSSFIND_TELEMETRY", "0");
      vi.stubEnv("OSSFIND_TELEMETRY_URL", "https://telemetry.ossfind.dev/v1/metrics");
      try {
        const fetchSpy = vi.fn();
        const emitter = new TelemetryEmitter({ fetch: fetchSpy as unknown as typeof fetch });

        expect(emitter.canTransmit()).toBe(false);
        await emitter.emit(new UsageCollector());
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("strictly rejects http:// URLs and makes zero network calls", async () => {
      vi.stubEnv("OSSFIND_TELEMETRY", "1");
      vi.stubEnv("OSSFIND_TELEMETRY_URL", "http://insecure-telemetry.example.com/v1/metrics");
      try {
        const fetchSpy = vi.fn();
        const emitter = new TelemetryEmitter({ fetch: fetchSpy as unknown as typeof fetch });

        expect(emitter.canTransmit()).toBe(false);
        await emitter.emit(new UsageCollector());
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("remains inert when OSSFIND_FIXTURES=1 even if telemetry env vars are set", async () => {
      vi.stubEnv("OSSFIND_FIXTURES", "1");
      vi.stubEnv("OSSFIND_TELEMETRY", "1");
      vi.stubEnv("OSSFIND_TELEMETRY_URL", "https://telemetry.ossfind.dev/v1/metrics");
      try {
        const fetchSpy = vi.fn();
        const emitter = new TelemetryEmitter({ fetch: fetchSpy as unknown as typeof fetch });

        expect(emitter.canTransmit()).toBe(false);
        await emitter.emit(new UsageCollector());
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("Payload Transmission and Privacy", () => {
    it("transmits aggregate payload over HTTPS when both switches are set", async () => {
      const endpoint = "https://telemetry.ossfind.dev/v1/events";
      let capturedUrl = "";
      let capturedInit: RequestInit | undefined;

      const fetchSpy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = url.toString();
        capturedInit = init;
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      });

      const collector = new UsageCollector({ now: () => 1700000000000 });
      const started = collector.beginSearch();
      collector.recordSearchSuccess(started, [
        { id: "npm:express", verdict: "ship" },
        { id: "pypi:fastapi", verdict: "caution" },
      ]);

      const emitter = new TelemetryEmitter({
        enabled: true,
        endpoint,
        fetch: fetchSpy as unknown as typeof fetch,
        now: () => 1700000001000,
      });

      expect(emitter.canTransmit()).toBe(true);
      const success = await emitter.emit(collector);

      expect(success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(capturedUrl).toBe(endpoint);
      expect(capturedInit?.method).toBe("POST");
      expect((capturedInit?.headers as Record<string, string>)?.["Content-Type"]).toBe("application/json");
      expect((capturedInit?.headers as Record<string, string>)?.["User-Agent"]).toContain("ossfind/");

      const body = JSON.parse(capturedInit?.body as string) as TelemetryPayload;
      expect(body).toMatchObject({
        installId: expect.stringMatching(UUID_REGEX),
        version: TOOL_VERSION,
        timestamp: "2023-11-14T22:13:21.000Z",
      });
      expect(body.snapshot.operations).toMatchObject({
        searchesServed: 1,
        ecosystems: { npm: 1, pypi: 1, github: 0, huggingface: 0 },
        verdicts: { ship: 1, caution: 1, avoid: 0 },
      });
    });

    it("never includes raw query strings, package names, or paths in the transmitted payload", async () => {
      let capturedBody = "";
      const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response("{}", { status: 200 });
      });

      const collector = new UsageCollector();
      const secretQuery = "SUPERSECRET_PROPRIETARY_AUTH_TOKEN_QUERY_98765";
      const secretPkg = "INTERNAL_SECRET_PACKAGE_XYZ";

      const deps = {
        discoverer: { discover: async () => [{ id: `npm:${secretPkg}`, name: secretPkg, ecosystem: "npm" as const, description: "desc" }] },
        enricher: { enrich: async () => ({ license: { spdxId: "MIT" } }) },
        fitScorer: { fit: async () => [{ id: `npm:${secretPkg}`, fitScore: 0.9 }] },
        ranker: { rank: () => [{ id: `npm:${secretPkg}`, name: secretPkg, verdict: "ship" as const, overall: 90, badges: [], reasons: [] }] },
      } as unknown as PipelineDependencies;

      await searchComponents(secretQuery, deps, { collector });

      const emitter = new TelemetryEmitter({
        enabled: true,
        endpoint: "https://telemetry.example.com/v1/sink",
        fetch: fetchSpy as unknown as typeof fetch,
      });

      await emitter.emit(collector);

      expect(capturedBody).not.toHaveLength(0);
      expect(capturedBody).not.toContain(secretQuery);
      expect(capturedBody).not.toContain(secretPkg);
      expect(capturedBody).not.toContain("SUPERSECRET");
      expect(capturedBody).not.toContain("INTERNAL_SECRET");
    });
  });

  describe("Fail-open Resilience", () => {
    it("swallows DNS / network exceptions without throwing", async () => {
      const fetchSpy = vi.fn(async () => {
        throw new TypeError("fetch failed: ENOTFOUND telemetry.example.com");
      });

      const emitter = new TelemetryEmitter({
        enabled: true,
        endpoint: "https://telemetry.example.com/sink",
        fetch: fetchSpy as unknown as typeof fetch,
      });

      const collector = new UsageCollector();
      const result = await emitter.emit(collector);

      expect(result).toBe(false);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("swallows HTTP 500 / 4xx error responses without throwing", async () => {
      const fetchSpy = vi.fn(async () => {
        return new Response("Internal Server Error", { status: 500 });
      });

      const emitter = new TelemetryEmitter({
        enabled: true,
        endpoint: "https://telemetry.example.com/sink",
        fetch: fetchSpy as unknown as typeof fetch,
      });

      const result = await emitter.emit(new UsageCollector());
      expect(result).toBe(true);
    });

    it("allows pipeline searches to succeed normally even if telemetry throws/times out", async () => {
      const fetchSpy = vi.fn(async () => {
        throw new Error("Connection timeout after 2000ms");
      });

      const emitter = new TelemetryEmitter({
        enabled: true,
        endpoint: "https://telemetry.example.com/sink",
        fetch: fetchSpy as unknown as typeof fetch,
      });

      const collector = new UsageCollector();
      const deps = {
        discoverer: { discover: async () => [{ id: "npm:axios", name: "axios", ecosystem: "npm" as const, description: "" }] },
        enricher: { enrich: async () => ({ license: { spdxId: "MIT" } }) },
        fitScorer: { fit: async () => [{ id: "npm:axios", fitScore: 0.8 }] },
        ranker: { rank: () => [{ id: "npm:axios", name: "axios", verdict: "ship" as const, overall: 90, badges: [], reasons: [] }] },
      } as unknown as PipelineDependencies;

      // Executing searchComponents and non-blocking emit
      const results = await searchComponents("axios", deps, { collector });
      expect(results).toHaveLength(1);

      // Async emit should swallow the error without affecting the caller
      emitter.emitAsync(collector);
      expect(results[0].name).toBe("axios");
    });

    it("caps payload size and refuses to transmit oversize payloads", async () => {
      const fetchSpy = vi.fn();
      const emitter = new TelemetryEmitter({
        enabled: true,
        endpoint: "https://telemetry.example.com/sink",
        maxPayloadBytes: 50, // artificially low limit
        fetch: fetchSpy as unknown as typeof fetch,
      });

      const result = await emitter.emit(new UsageCollector());
      expect(result).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("Anonymous Install ID Management", () => {
    it("generates a valid UUID v4 format and persists it", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ossfind-install-id-test-"));
      const installIdFile = path.join(tempDir, "install-id");

      const id1 = getOrCreateInstallId({ installIdPath: installIdFile });
      expect(id1).toMatch(UUID_REGEX);
      expect(fs.existsSync(installIdFile)).toBe(true);

      const id2 = getOrCreateInstallId({ installIdPath: installIdFile });
      expect(id2).toBe(id1);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("uses explicitly provided installId if valid UUID", () => {
      const customId = "12345678-1234-4234-8234-123456789abc";
      const resolved = getOrCreateInstallId({ installId: customId });
      expect(resolved).toBe(customId);
    });
  });

  describe("formatUsageSummary", () => {
    it("formats an empty collector snapshot cleanly", () => {
      const collector = new UsageCollector();
      const summary = formatUsageSummary(collector.snapshot());

      expect(summary).toContain("Usage Statistics:");
      expect(summary).toContain("Searches served: 0");
      expect(summary).toContain("Top suppliers: No supplier requests recorded.");
      expect(summary).toContain("Cache hit rate: 0.0%");
      expect(summary).toContain("Rate limits: All suppliers within normal headroom.");
      expect(summary).toContain("p50: 0ms, p95: 0ms");
    });

    it("formats active suppliers, hit rate, and rate-limit alerts", () => {
      const collector = new UsageCollector();
      collector.recordHttpResponse("https://api.github.com/repos", "miss", {
        ok: true,
        status: 200,
        json: async () => ({}),
        headers: {
          get: (h) => (h === "x-ratelimit-remaining" ? "3" : h === "x-ratelimit-limit" ? "60" : null),
        },
      });
      collector.recordHttpResponse("https://registry.npmjs.org/express", "hit", {
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      const summary = formatUsageSummary(collector.snapshot());
      expect(summary).toContain("api.github.com");
      expect(summary).toContain("registry.npmjs.org");
      expect(summary).toContain("Cache hit rate: 50.0% (1/2 requests cached)");
      expect(summary).toContain("Rate-limit alerts: api.github.com (3/60 remaining)");
    });
  });
});
