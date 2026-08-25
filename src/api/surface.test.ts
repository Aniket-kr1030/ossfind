import { describe, expect, it } from "vitest";
import { ApiSurfaceSchema } from "../contracts/api-surface.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import type { HttpClient } from "../http/client.js";
import { ApiSurfaceExtractor } from "./surface.js";

function fixtureExtractor(): ApiSurfaceExtractor {
  return new ApiSurfaceExtractor(createFixtureHttpClient());
}

function expectValidSurface(surface: unknown): void {
  expect(ApiSurfaceSchema.parse(surface)).toEqual(surface);
}

describe("ApiSurfaceExtractor", () => {
  it("extracts verifiable own declarations from axios, including compact function signatures", async () => {
    const surface = await fixtureExtractor().extract("axios");

    expectValidSurface(surface);
    expect(surface).toMatchObject({
      id: "npm:axios",
      version: "1.19.0",
      typesAvailable: "own",
      truncated: false,
    });
    expect(surface.exports.length).toBeGreaterThan(0);
    expect(surface.exports).toContainEqual(expect.objectContaining({
      name: "formToJSON",
      kind: "function",
      signature: expect.stringMatching(/^formToJSON\(/),
    }));
  });

  it("follows zod's declaration re-export instead of treating its stub index as a complete surface", async () => {
    const surface = await fixtureExtractor().extract("zod");

    expectValidSurface(surface);
    expect(surface).toMatchObject({ id: "npm:zod", typesAvailable: "own" });
    expect(surface.exports.length).toBeGreaterThan(1);
    // These are declared by zod's re-export targets, not its tiny root stub.
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "core", kind: "namespace" }));
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "ZodString" }));
    // The frozen capture deliberately contains one target; unavailable deeper
    // re-exports stay explicit rather than becoming invented exports.
    expect(surface.notes.join(" ")).toMatch(/unresolved re-export/i);
    expect(surface.truncated).toBe(true);
  });

  it("uses DefinitelyTyped when express has no bundled declarations and expands merged namespace members", async () => {
    const surface = await fixtureExtractor().extract("express");

    expectValidSurface(surface);
    expect(surface).toMatchObject({
      id: "npm:express",
      typesAvailable: "definitely-typed",
      typesSource: "@types/express",
      truncated: false,
    });
    expect(surface.exports.length).toBe(30);
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "Request", kind: "interface" }));
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "Response", kind: "interface" }));
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "RequestHandler", kind: "interface" }));
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "Application", kind: "interface" }));
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "Router", kind: "function" }));
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "NextFunction", kind: "interface" }));
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "default", kind: "default" }));
  });

  it("reports left-pad's small bundled declaration without inventing an unknown surface", async () => {
    const surface = await fixtureExtractor().extract("left-pad");

    expectValidSurface(surface);
    expect(surface).toMatchObject({
      id: "npm:left-pad",
      version: "1.3.0",
      typesAvailable: "own",
      truncated: false,
    });
    expect(surface.exports.length).toBeGreaterThan(0);
    expect(surface.exports.some((entry) => entry.name === "leftPad" || entry.kind === "default")).toBe(true);
  });

  it("fails closed for a package that has neither bundled nor DefinitelyTyped declarations", async () => {
    const surface = await fixtureExtractor().extract("not-a-real-package");

    expectValidSurface(surface);
    expect(surface).toMatchObject({
      id: "npm:not-a-real-package",
      version: null,
      typesAvailable: "none",
      typesSource: null,
      exports: [],
      truncated: false,
    });
    expect(surface.notes.length).toBeGreaterThan(0);
  });

  it("marks a declaration carrying the fixture truncation sentinel as incomplete", async () => {
    const client: HttpClient = async (url) => {
      if (url === "https://registry.npmjs.org/truncated-demo/latest") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ name: "truncated-demo", version: "1.0.0", types: "index.d.ts" }),
        };
      }
      if (url === "https://cdn.jsdelivr.net/npm/truncated-demo@1.0.0/index.d.ts") {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "export declare function partial(value: string): string;\n// [fixture truncated]\n",
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const surface = await new ApiSurfaceExtractor(client).extract("truncated-demo");

    expectValidSurface(surface);
    expect(surface).toMatchObject({
      id: "npm:truncated-demo",
      typesAvailable: "own",
      truncated: true,
    });
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "partial", kind: "function" }));
  });

  it("is deterministic for repeated offline extraction", async () => {
    const extractor = fixtureExtractor();
    const [first, second] = await Promise.all([extractor.extract("axios"), extractor.extract("axios")]);

    expectValidSurface(first);
    expectValidSurface(second);
    expect(second).toEqual(first);
  });
});
