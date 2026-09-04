import { describe, expect, it } from "vitest";
import { reconcileImportForm } from "./import-form.js";
import type { ApiSurface } from "../contracts/api-surface.js";
import type { IntegrationManifest } from "../contracts/integration-manifest.js";

function surface(over: Partial<ApiSurface> = {}): ApiSurface {
  return { id: "npm:x", version: "1.0.0", typesAvailable: "own", typesSource: "t", exports: [], truncated: false, notes: [], ...over };
}

function manifest(esm: string | null, cjs: string | null = null): IntegrationManifest {
  return {
    id: "npm:x", version: "1.0.0", install: { command: "npm install x" },
    importForm: { moduleType: esm && cjs ? "dual" : esm ? "esm" : "cjs", esm, cjs, typesPackage: null },
    runtime: { engines: {}, os: null, cpu: null }, peerDependencies: {},
    prerequisites: [], hasInstallScript: false, notes: [],
  };
}

describe("reconcileImportForm", () => {
  // Regression: shipped guidance was `import marked from "marked"`, which throws at load.
  it("replaces a guessed default import when the package declares only named exports", () => {
    const result = reconcileImportForm("marked", manifest('import marked from "marked";'), surface({
      exports: [
        { name: "Lexer", kind: "class", signature: null },
        { name: "marked", kind: "function", signature: "marked(src:string): string" },
      ],
    }));
    expect(result.importForm.esm).toBe('import { marked } from "marked";');
    expect(result.notes.at(-1)).toContain("no default export");
  });

  it("prefers the package-named export over an earlier unrelated one", () => {
    const result = reconcileImportForm("sanitize-html", manifest('import sanitizeHtml from "sanitize-html";'), surface({
      exports: [
        { name: "Attributes", kind: "interface", signature: null },
        { name: "defaults", kind: "const", signature: null },
        { name: "sanitizeHtml", kind: "function", signature: null },
      ],
    }));
    expect(result.importForm.esm).toBe('import { sanitizeHtml } from "sanitize-html";');
  });

  it.each([
    ["kind", { name: "MiniSearch", kind: "default" as const, signature: null }],
    ["name", { name: "default", kind: "class" as const, signature: null }],
  ])("leaves a real default export alone when the extractor reports it by %s", (_label, entry) => {
    const original = manifest('import minisearch from "minisearch";');
    expect(reconcileImportForm("minisearch", original, surface({ exports: [entry] }))).toBe(original);
  });

  it("never rewrites the CJS line, which takes the whole module object", () => {
    const result = reconcileImportForm("yaml", manifest(null, 'const yaml = require("yaml");'), surface({
      exports: [{ name: "Alias", kind: "class", signature: null }],
    }));
    expect(result.importForm.cjs).toBe('const yaml = require("yaml");');
  });

  it.each([
    ["truncated surface", surface({ truncated: true, exports: [{ name: "a", kind: "function" as const, signature: null }] })],
    ["no declarations", surface({ typesAvailable: "none" })],
    ["empty export list", surface({ exports: [] })],
  ])("leaves the guess untouched on incomplete evidence: %s", (_label, unusable) => {
    const original = manifest('import pkg from "pkg";');
    expect(reconcileImportForm("pkg", original, unusable)).toBe(original);
  });

  it("falls back to a namespace import when every export is type-only", () => {
    const result = reconcileImportForm("shapes", manifest('import shapes from "shapes";'), surface({
      exports: [{ name: "Shape", kind: "interface", signature: null }],
    }));
    expect(result.importForm.esm).toBe('import * as shapes from "shapes";');
  });
});
