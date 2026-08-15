import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPipeline } from "../mcp/pipeline.js";
import { searchComponents } from "../pipeline/orchestrator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../../public");

export function createWebServer(): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || "localhost";
      const url = new URL(req.url || "", `http://${host}`);
      const pathname = url.pathname;

      // Handle JSON API
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
        const ecosystem = requestedEcosystem === "pypi" || requestedEcosystem === "github" || requestedEcosystem === "all"
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
          const results = await searchComponents(q, pipeline, { limit });

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

// Start the server if this file is run directly
const runtimeProcess = (globalThis as unknown as {
  process?: { argv: string[]; exitCode?: number };
}).process;

if (runtimeProcess?.argv[1] && import.meta.url === new URL(`file://${runtimeProcess.argv[1]}`).href) {
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8787;
  const server = createWebServer();
  server.listen(PORT, () => {
    console.log(`Server listening at http://localhost:${PORT}`);
  });
}
