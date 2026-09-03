import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildPipeline } from "../mcp/pipeline.js";
import { searchComponents } from "../pipeline/orchestrator.js";
import { UsageCollector } from "../telemetry/collector.js";
import { TelemetryEmitter } from "../telemetry/emitter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../../public");

export interface WebServerOptions {
  token?: string;
  collector?: UsageCollector;
  telemetryEmitter?: TelemetryEmitter;
}

export interface StartServerOptions {
  port?: number;
  host?: string;
  token?: string;
  collector?: UsageCollector;
  telemetryEmitter?: TelemetryEmitter;
}

/**
 * Checks whether a given host string resolves to a local loopback interface.
 */
export function isLoopbackHost(host: string): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  const parts = normalized.split(".");
  if (parts.length === 4 && parts[0] === "127") {
    return parts.every((p) => {
      if (!/^\d+$/.test(p)) return false;
      const num = parseInt(p, 10);
      return num >= 0 && num <= 255;
    });
  }
  return false;
}

/**
 * Timing-safe string comparison to prevent timing attacks on authentication tokens.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies the Bearer token in the Authorization header against the expected token.
 */
export function verifyBearerToken(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader || !expectedToken) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return false;
  const providedToken = match[1].trim();
  return timingSafeEqualStr(providedToken, expectedToken);
}

/**
 * Resolves and validates the server host, port, and token configuration.
 * Refuses to bind to a non-loopback host unless an authentication token is provided.
 */
export function resolveServerConfig(options: StartServerOptions = {}): {
  port: number;
  host: string;
  token?: string;
} {
  const port = options.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 8787);
  const host = options.host ?? (process.env.HOST || "127.0.0.1");
  const token = options.token !== undefined ? options.token : process.env.OSSFIND_WEB_TOKEN;

  if (!isLoopbackHost(host) && !token) {
    throw new Error(
      `Refusing to bind to non-loopback host "${host}" without authentication. ` +
      `Set OSSFIND_WEB_TOKEN=<secret> to enable bearer-token auth, or bind to loopback (HOST=127.0.0.1).`
    );
  }

  return { port, host, token: token || undefined };
}

export function createWebServer(options: WebServerOptions = {}): http.Server {
  const token = options.token !== undefined ? options.token : process.env.OSSFIND_WEB_TOKEN;
  const collector = options.collector ?? new UsageCollector();
  const emitter = options.telemetryEmitter ?? new TelemetryEmitter();

  return http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || "localhost";
      const url = new URL(req.url || "", `http://${host}`);
      const pathname = url.pathname;

      // Optional bearer-token authentication for /api/* routes
      if (pathname.startsWith("/api/")) {
        if (token && !verifyBearerToken(req.headers.authorization, token)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }

      // Handle JSON API: /api/usage
      if (pathname === "/api/usage") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return;
        }

        const snapshot = collector.snapshot();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        if (req.method === "HEAD") {
          res.end();
        } else {
          res.end(JSON.stringify(snapshot));
        }
        return;
      }

      // Handle JSON API: /api/search
      if (pathname === "/api/search") {
        if (req.method !== "GET") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return;
        }

        const q = url.searchParams.get("q");
        if (!q || q.trim() === "") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Query parameter 'q' is required and cannot be empty." }));
          return;
        }

        const projectLicense = url.searchParams.get("projectLicense") || undefined;
        const requestedEcosystem = url.searchParams.get("ecosystem");
        const ecosystem = requestedEcosystem === "pypi" || requestedEcosystem === "github"
          || requestedEcosystem === "huggingface" || requestedEcosystem === "cargo"
          || requestedEcosystem === "rubygems" || requestedEcosystem === "all"
          ? requestedEcosystem
          : "npm";
        const limitStr = url.searchParams.get("limit");
        let limit: number | undefined = undefined;
        if (limitStr) {
          const parsed = parseInt(limitStr, 10);
          if (!isNaN(parsed)) {
            limit = parsed;
          }
        }

        try {
          const pipeline = buildPipeline({
            fixtures: process.env.OSSFIND_FIXTURES === "1",
            projectLicense,
            ecosystem,
          });
          const results = await searchComponents(q, pipeline, { limit, collector });
          emitter.emitAsync(collector);

          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ query: q, results }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err?.message || "Internal Server Error" }));
        }
        return;
      }

      // Serve static files
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }

      const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
      const filePath = path.join(PUBLIC_DIR, relativePath);

      // Path traversal check
      if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }

      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile()) {
          const ext = path.extname(filePath).toLowerCase();
          let contentType = "application/octet-stream";
          if (ext === ".html") {
            contentType = "text/html; charset=utf-8";
          } else if (ext === ".js") {
            contentType = "application/javascript; charset=utf-8";
          } else if (ext === ".css") {
            contentType = "text/css; charset=utf-8";
          } else if (ext === ".json") {
            contentType = "application/json; charset=utf-8";
          }

          res.writeHead(200, { "Content-Type": contentType });
          if (req.method === "HEAD") {
            res.end();
          } else {
            const content = await fs.readFile(filePath);
            res.end(content);
          }
          return;
        }
      } catch {
        // Fall through to 404
      }

      // Not Found
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));

    } catch (globalErr: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: globalErr?.message || "Internal Server Error" }));
    }
  });
}

export function startWebServer(options: StartServerOptions = {}): http.Server {
  const { port, host, token } = resolveServerConfig(options);
  const server = createWebServer({
    token,
    collector: options.collector,
    telemetryEmitter: options.telemetryEmitter,
  });
  server.listen(port, host, () => {
    const authStatus = token ? "enabled" : "disabled";
    console.log(`Server listening at http://${host}:${port} (auth: ${authStatus})`);
  });
  return server;
}

// Start the server if this file is run directly
const runtimeProcess = (globalThis as unknown as {
  process?: { argv: string[]; exitCode?: number };
}).process;

if (runtimeProcess?.argv[1] && import.meta.url === new URL(`file://${runtimeProcess.argv[1]}`).href) {
  try {
    startWebServer();
  } catch (err: any) {
    console.error(err?.message || err);
    process.exit(1);
  }
}
