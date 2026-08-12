import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createWebServer } from "./server.js";
import { ScoredComponentSchema } from "../contracts/scored-component.js";
import type { AddressInfo } from "node:net";

describe("Web Server", () => {
  let server: ReturnType<typeof createWebServer>;
  let baseUrl: string;

  beforeAll(async () => {
    // Set environment variable OSSFIND_FIXTURES=1
    process.env.OSSFIND_FIXTURES = "1";

    server = createWebServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  it("should search components successfully and return schema-valid results", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=http client`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toHaveProperty("query", "http client");
    expect(body).toHaveProperty("results");
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);

    // Validate the components with the zod schema
    for (const component of body.results) {
      const parsed = ScoredComponentSchema.safeParse(component);
      if (!parsed.success) {
        console.error(parsed.error);
      }
      expect(parsed.success).toBe(true);
    }
  });

  it("should return a 400 error for an empty query parameter", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=`);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body).toHaveProperty("error");
    expect(typeof body.error).toBe("string");
  });

  it("should return a 400 error for a missing query parameter", async () => {
    const res = await fetch(`${baseUrl}/api/search`);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body).toHaveProperty("error");
    expect(typeof body.error).toBe("string");
  });

  it("should serve static files successfully", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("ossfind");
  });
});
