import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createWebServer,
  isLoopbackHost,
  timingSafeEqualStr,
  verifyBearerToken,
  resolveServerConfig,
  startWebServer,
} from "./server.js";
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

  it("should route ecosystem=pypi to the PyPI fixture pipeline", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=video editing&ecosystem=pypi`);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    const ids = body.results.map((component) => ScoredComponentSchema.parse(component).id);
    expect(ids).toContain("pypi:moviepy");
  });

  it("should route ecosystem=github to the GitHub fixture pipeline", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=video generation&ecosystem=github`);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    const ids = body.results.map((component) => ScoredComponentSchema.parse(component).id);
    expect(ids).toContain("github:huggingface/diffusers");
  });

  it("should route ecosystem=huggingface to the Hugging Face fixture pipeline", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=video generation&ecosystem=huggingface`);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    const ids = body.results.map((component) => ScoredComponentSchema.parse(component).id);
    expect(ids.some((id) => id.startsWith("huggingface:"))).toBe(true);
  });

  it("should route ecosystem=cargo to the Cargo fixture pipeline", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=http client&ecosystem=cargo`);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    const ids = body.results.map((component) => ScoredComponentSchema.parse(component).id);
    expect(ids.some((id) => id.startsWith("cargo:"))).toBe(true);
  });

  it("should route ecosystem=rubygems to the RubyGems fixture pipeline", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=http client&ecosystem=rubygems`);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    const ids = body.results.map((component) => ScoredComponentSchema.parse(component).id);
    expect(ids.some((id) => id.startsWith("rubygems:"))).toBe(true);
  });

  it("should route ecosystem=all to the federated fixture pipeline", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=http client&ecosystem=all`);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    const ids = body.results.map((component) => ScoredComponentSchema.parse(component).id);

    expect(ids.some((id) => id.startsWith("pypi:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("npm:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("cargo:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("rubygems:"))).toBe(true);
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

  it("should return usage stats JSON from /api/usage", async () => {
    const res = await fetch(`${baseUrl}/api/usage`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const snapshot = await res.json() as any;
    expect(snapshot).toHaveProperty("suppliers");
    expect(snapshot).toHaveProperty("operations");
    expect(snapshot.operations.searchesServed).toBeGreaterThan(0);
  });

  it("should return 405 Method Not Allowed for non-GET /api/usage", async () => {
    const res = await fetch(`${baseUrl}/api/usage`, { method: "POST" });
    expect(res.status).toBe(405);
    const body = await res.json() as any;
    expect(body).toEqual({ error: "Method Not Allowed" });
  });

  it("should serve static files successfully", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("ossfind");
    expect(text).toContain('<option value="cargo">Rust (crates.io)</option>');
    expect(text).toContain('<option value="rubygems">RubyGems</option>');
  });
});

describe("Server Security & Host Configuration", () => {
  describe("isLoopbackHost", () => {
    it("identifies standard loopback addresses", () => {
      expect(isLoopbackHost("127.0.0.1")).toBe(true);
      expect(isLoopbackHost("127.0.0.2")).toBe(true);
      expect(isLoopbackHost("127.255.255.255")).toBe(true);
      expect(isLoopbackHost("localhost")).toBe(true);
      expect(isLoopbackHost("::1")).toBe(true);
      expect(isLoopbackHost("[::1]")).toBe(true);
      expect(isLoopbackHost("127.0.0.1 ")).toBe(true);
    });

    it("identifies non-loopback addresses", () => {
      expect(isLoopbackHost("0.0.0.0")).toBe(false);
      expect(isLoopbackHost("::")).toBe(false);
      expect(isLoopbackHost("192.168.1.1")).toBe(false);
      expect(isLoopbackHost("10.0.0.1")).toBe(false);
      expect(isLoopbackHost("example.com")).toBe(false);
      expect(isLoopbackHost("")).toBe(false);
      expect(isLoopbackHost("128.0.0.1")).toBe(false);
    });
  });

  describe("timingSafeEqualStr & verifyBearerToken", () => {
    it("compares strings in timing-safe manner", () => {
      expect(timingSafeEqualStr("secret-token", "secret-token")).toBe(true);
      expect(timingSafeEqualStr("secret-token", "wrong-token")).toBe(false);
      expect(timingSafeEqualStr("short", "longer-string")).toBe(false);
    });

    it("verifies bearer authorization header correctly", () => {
      const token = "super-secret-12345";
      expect(verifyBearerToken(`Bearer ${token}`, token)).toBe(true);
      expect(verifyBearerToken(`bearer ${token}`, token)).toBe(true);
      expect(verifyBearerToken("Bearer wrong-secret", token)).toBe(false);
      expect(verifyBearerToken("Basic user:pass", token)).toBe(false);
      expect(verifyBearerToken(undefined, token)).toBe(false);
      expect(verifyBearerToken("", token)).toBe(false);
      expect(verifyBearerToken(`Bearer ${token}`, "")).toBe(false);
    });
  });

  describe("resolveServerConfig", () => {
    it("defaults to 127.0.0.1 loopback bind without auth", () => {
      const config = resolveServerConfig();
      expect(config.host).toBe("127.0.0.1");
      expect(config.port).toBe(8787);
      expect(config.token).toBeUndefined();
    });

    it("accepts custom loopback host and port", () => {
      const config = resolveServerConfig({ host: "localhost", port: 9000 });
      expect(config.host).toBe("localhost");
      expect(config.port).toBe(9000);
    });

    it("refuses non-loopback host when no token is provided", () => {
      expect(() => resolveServerConfig({ host: "0.0.0.0" })).toThrow(
        /Refusing to bind to non-loopback host "0\.0\.0\.0" without authentication/
      );
      expect(() => resolveServerConfig({ host: "192.168.1.100" })).toThrow(
        /Refusing to bind to non-loopback host "192\.168\.1\.100" without authentication/
      );
    });

    it("allows non-loopback host when token is provided", () => {
      const config = resolveServerConfig({ host: "0.0.0.0", token: "secret-token" });
      expect(config.host).toBe("0.0.0.0");
      expect(config.token).toBe("secret-token");
    });
  });

  describe("startWebServer execution", () => {
    it("binds loopback by default and reports actual address", async () => {
      const serverInstance = startWebServer({ port: 0, host: "127.0.0.1" });
      await new Promise<void>((resolve) => {
        if (serverInstance.listening) resolve();
        else serverInstance.on("listening", () => resolve());
      });

      const addr = serverInstance.address() as AddressInfo;
      expect(addr.address).toBe("127.0.0.1");
      expect(isLoopbackHost(addr.address)).toBe(true);

      await new Promise<void>((resolve, reject) => {
        serverInstance.close((err) => (err ? reject(err) : resolve()));
      });
    });

    it("refuses to start on non-loopback host without token", () => {
      expect(() => startWebServer({ host: "0.0.0.0", port: 0 })).toThrow(
        /Refusing to bind to non-loopback host "0\.0\.0\.0" without authentication/
      );
    });
  });

  describe("Authenticated Endpoints", () => {
    const SECRET_TOKEN = "test-auth-token-xyz-987";
    let authServer: ReturnType<typeof createWebServer>;
    let authBaseUrl: string;

    beforeAll(async () => {
      process.env.OSSFIND_FIXTURES = "1";
      authServer = createWebServer({ token: SECRET_TOKEN });
      await new Promise<void>((resolve) => {
        authServer.listen(0, "127.0.0.1", () => {
          const address = authServer.address() as AddressInfo;
          authBaseUrl = `http://127.0.0.1:${address.port}`;
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        authServer.close((err) => (err ? reject(err) : resolve()));
      });
    });

    it("rejects API request with 401 when no token is provided", async () => {
      const res = await fetch(`${authBaseUrl}/api/search?q=http client`);
      expect(res.status).toBe(401);
      const text = await res.text();
      const body = JSON.parse(text);
      expect(body).toEqual({ error: "Unauthorized" });
      expect(text).not.toContain(SECRET_TOKEN);
    });

    it("rejects API request with 401 when incorrect token is provided", async () => {
      const res = await fetch(`${authBaseUrl}/api/search?q=http client`, {
        headers: {
          Authorization: "Bearer wrong-token-12345",
        },
      });
      expect(res.status).toBe(401);
      const text = await res.text();
      const body = JSON.parse(text);
      expect(body).toEqual({ error: "Unauthorized" });
      expect(text).not.toContain(SECRET_TOKEN);
      expect(text).not.toContain("wrong-token-12345");
    });

    it("allows API request with 200 when valid bearer token is provided", async () => {
      const res = await fetch(`${authBaseUrl}/api/search?q=http client`, {
        headers: {
          Authorization: `Bearer ${SECRET_TOKEN}`,
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toHaveProperty("query", "http client");
      expect(body).toHaveProperty("results");
      const text = JSON.stringify(body);
      expect(text).not.toContain(SECRET_TOKEN);
    });

    it("rejects /api/usage with 401 when no token is provided", async () => {
      const res = await fetch(`${authBaseUrl}/api/usage`);
      expect(res.status).toBe(401);
      const body = await res.json() as any;
      expect(body).toEqual({ error: "Unauthorized" });
    });

    it("allows /api/usage with 200 when valid bearer token is provided", async () => {
      const res = await fetch(`${authBaseUrl}/api/usage`, {
        headers: {
          Authorization: `Bearer ${SECRET_TOKEN}`,
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toHaveProperty("suppliers");
      expect(body).toHaveProperty("operations");
    });

    it("still serves static files without requiring bearer token", async () => {
      const res = await fetch(`${authBaseUrl}/`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("ossfind");
      expect(text).not.toContain(SECRET_TOKEN);
    });
  });
});
