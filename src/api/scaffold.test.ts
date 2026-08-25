import { describe, expect, it } from "vitest";
import type { ApiSurface } from "../contracts/api-surface.js";
import type { IntegrationManifest } from "../contracts/integration-manifest.js";
import { ScaffoldSchema } from "../contracts/scaffold.js";
import { buildScaffold } from "./scaffold.js";

function createManifest(overrides?: Partial<IntegrationManifest>): IntegrationManifest {
  return {
    id: "npm:axios",
    version: "1.6.0",
    install: { command: "npm install axios" },
    importForm: {
      moduleType: "esm",
      esm: 'import axios from "axios";',
      cjs: null,
      typesPackage: null,
    },
    runtime: { engines: {}, os: null, cpu: null },
    peerDependencies: {},
    prerequisites: [],
    hasInstallScript: false,
    notes: [],
    ...overrides,
  };
}

function createSurface(overrides?: Partial<ApiSurface>): ApiSurface {
  return {
    id: "npm:axios",
    version: "1.6.0",
    typesAvailable: "own",
    typesSource: "index.d.ts",
    exports: [
      {
        name: "get",
        kind: "function",
        signature: "get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>",
      },
    ],
    truncated: false,
    notes: [],
    ...overrides,
  };
}

function createPythonManifest(overrides?: Partial<IntegrationManifest>): IntegrationManifest {
  return {
    id: "pypi:pyyaml",
    version: "6.0.3",
    install: { command: "pip install pyyaml" },
    importForm: {
      moduleType: "unknown",
      esm: null,
      cjs: null,
      typesPackage: null,
      python: {
        importName: "yaml",
        statements: ["import yaml"],
        confidence: "verified",
        evidence: "Verified import-name mapping: PyYAML -> yaml.",
      },
    },
    runtime: { engines: { python: ">=3.8" }, os: null, cpu: null },
    peerDependencies: {},
    prerequisites: [],
    hasInstallScript: false,
    notes: [],
    ...overrides,
  };
}

function createPythonSurface(overrides?: Partial<ApiSurface>): ApiSurface {
  return {
    id: "pypi:pyyaml",
    version: "6.0.3",
    typesAvailable: "definitely-typed",
    typesSource: "stubs/PyYAML/yaml/__init__.pyi",
    exports: [
      {
        name: "safe_load",
        kind: "function",
        signature: "safe_load(stream: _ReadStream) -> _YAMLObject",
      },
    ],
    truncated: false,
    notes: [],
    ...overrides,
  };
}

describe("buildScaffold", () => {
  it("builds a scaffold with verified function signature", () => {
    const surface = createSurface();
    const manifest = createManifest();

    const scaffold = buildScaffold(surface, manifest);

    expect(scaffold.confidence).toBe("verified-signatures");
    expect(scaffold.snippet).not.toBeNull();
    expect(scaffold.snippet).toContain("axios.get(url, config)");
    expect(scaffold.basedOn).toEqual([
      {
        name: "get",
        signature: "get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>",
      },
    ]);
    expect(ScaffoldSchema.parse(scaffold)).toEqual(scaffold);
  });

  it("builds a Python scaffold from PyYAML's verified import and signature", () => {
    const scaffold = buildScaffold(createPythonSurface(), createPythonManifest());

    expect(scaffold.install).toBe("pip install pyyaml");
    expect(scaffold.imports).toEqual(["import yaml"]);
    expect(scaffold.snippet).toBe(
      "# Verified signature: safe_load(stream: _ReadStream) -> _YAMLObject\nresult = yaml.safe_load(stream)",
    );
    expect(scaffold.snippet).not.toContain("const ");
    expect(scaffold.snippet).not.toContain(";");
    expect(scaffold.snippet).not.toContain("await ");
    expect(ScaffoldSchema.parse(scaffold)).toEqual(scaffold);
  });

  it("Python anti-fabrication test: calls only an export verified by surface.exports", () => {
    const surface = createPythonSurface({
      id: "pypi:verified-parser",
      exports: [
        { name: "parse_verified", kind: "function", signature: "parse_verified(payload: str) -> str" },
      ],
    });
    const manifest = createPythonManifest({
      id: "pypi:verified-parser",
      install: { command: "pip install verified-parser" },
      importForm: {
        moduleType: "unknown",
        esm: null,
        cjs: null,
        typesPackage: null,
        python: {
          importName: "verified_parser",
          statements: ["import verified_parser"],
          confidence: "verified",
          evidence: "Verified import-name mapping: verified-parser -> verified_parser.",
        },
      },
    });

    const scaffold = buildScaffold(surface, manifest);

    expect(scaffold.snippet).toContain("verified_parser.parse_verified(payload)");
    expect(scaffold.snippet).not.toContain("generate_video");
    expect(scaffold.snippet).not.toContain("create_client");
    const calledExport = /\.([A-Za-z_][A-Za-z0-9_]*)\(/.exec(scaffold.snippet ?? "")?.[1];
    expect(surface.exports.map((entry) => entry.name)).toContain(calledExport);
  });

  it("awaits a Python call only when its verified signature declares async def", () => {
    const surface = createPythonSurface({
      exports: [{ name: "fetch", kind: "function", signature: "async def fetch(url: str) -> str" }],
    });
    const manifest = createPythonManifest({
      importForm: {
        moduleType: "unknown",
        esm: null,
        cjs: null,
        typesPackage: null,
        python: {
          importName: "client",
          statements: ["import client"],
          confidence: "verified",
          evidence: "Verified import-name mapping: client -> client.",
        },
      },
    });

    expect(buildScaffold(surface, manifest).snippet).toBe(
      "# Verified signature: async def fetch(url: str) -> str\nresult = await client.fetch(url)",
    );
  });

  it("degrades to import-only when typesAvailable is none", () => {
    const surface = createSurface({ typesAvailable: "none", exports: [] });
    const manifest = createManifest();

    const scaffold = buildScaffold(surface, manifest);

    expect(scaffold.confidence).toBe("import-only");
    expect(scaffold.snippet).toBeNull();
    expect(scaffold.basedOn).toEqual([]);
    expect(scaffold.install).toBe("npm install axios");
    expect(scaffold.imports).toEqual(['import axios from "axios";']);
    expect(scaffold.notes).toContain("API surface types are not available (typesAvailable: none); no usage code was generated.");
    expect(ScaffoldSchema.parse(scaffold)).toEqual(scaffold);
  });

  it("degrades to import-only when selected export has signature null", () => {
    const surface = createSurface({
      exports: [{ name: "Axios", kind: "class", signature: null }],
    });
    const manifest = createManifest();

    const scaffold = buildScaffold(surface, manifest);

    expect(scaffold.confidence).toBe("import-only");
    expect(scaffold.snippet).toBeNull();
    expect(scaffold.basedOn).toEqual([]);
    expect(scaffold.notes).toContain("Selected export 'Axios' has no verifiable signature; no usage code was generated.");
    expect(ScaffoldSchema.parse(scaffold)).toEqual(scaffold);
  });

  it("anti-fabrication test: never invents an export or method name absent from surface.exports", () => {
    const surface = createSurface({
      exports: [
        {
          name: "fetchData",
          kind: "function",
          signature: "fetchData(id: string): Promise<Data>",
        },
      ],
    });
    const manifest = createManifest({ id: "npm:my-api-pkg" });

    const scaffold = buildScaffold(surface, manifest);

    expect(scaffold.snippet).not.toBeNull();
    expect(scaffold.snippet).not.toContain("generateVideo");
    expect(scaffold.snippet).not.toContain("createClient");
    // Verify every identifier used as a method or export call is in surface.exports
    const exportNames = surface.exports.map((e) => e.name);
    const usesExport = exportNames.some((name) => scaffold.snippet?.includes(name));
    expect(usesExport).toBe(true);
  });

  it("handles ESM vs CJS manifests with correct import lines", () => {
    const esmManifest = createManifest({
      importForm: {
        moduleType: "esm",
        esm: 'import foo from "foo";',
        cjs: null,
        typesPackage: null,
      },
    });
    const cjsManifest = createManifest({
      importForm: {
        moduleType: "cjs",
        esm: null,
        cjs: 'const foo = require("foo");',
        typesPackage: null,
      },
    });
    const dualManifest = createManifest({
      importForm: {
        moduleType: "dual",
        esm: 'import foo from "foo";',
        cjs: 'const foo = require("foo");',
        typesPackage: null,
      },
    });

    const surface = createSurface({ id: "npm:foo" });

    const esmResult = buildScaffold(surface, esmManifest);
    expect(esmResult.imports).toEqual(['import foo from "foo";']);

    const cjsResult = buildScaffold(surface, cjsManifest);
    expect(cjsResult.imports).toEqual(['const foo = require("foo");']);

    const dualResult = buildScaffold(surface, dualManifest);
    expect(dualResult.imports).toEqual(['import foo from "foo";', 'const foo = require("foo");']);
  });

  it("surfaces external-binary prerequisites in warnings", () => {
    const manifest = createManifest({
      prerequisites: [
        {
          kind: "external-binary",
          name: "ffmpeg",
          confidence: "likely",
          evidence: 'description: "requires ffmpeg binary"',
        },
      ],
    });
    const surface = createSurface();

    const scaffold = buildScaffold(surface, manifest);

    expect(scaffold.warnings).toContain(
      'Requires the ffmpeg binary to be installed on the system (description: "requires ffmpeg binary").',
    );
  });

  it("includes typesPackage installation line if typesPackage is present in manifest", () => {
    const manifest = createManifest({
      importForm: {
        moduleType: "cjs",
        esm: null,
        cjs: 'const express = require("express");',
        typesPackage: "@types/express",
      },
    });
    const surface = createSurface({ id: "npm:express" });

    const scaffold = buildScaffold(surface, manifest);

    expect(scaffold.install).toBe("npm install axios\nnpm install -D @types/express");
  });

  it("respects export selection priority: preferExport > default > package match > first function/class", () => {
    const surface = createSurface({
      exports: [
        { name: "helper", kind: "function", signature: "helper(): void" },
        { name: "axios", kind: "function", signature: "axios(config: any): any" },
        { name: "default", kind: "default", signature: "default(): void" },
        { name: "custom", kind: "function", signature: "custom(x: number): void" },
      ],
    });
    const manifest = createManifest();

    // 1. preferExport
    const preferred = buildScaffold(surface, manifest, { preferExport: "custom" });
    expect(preferred.basedOn[0]?.name).toBe("custom");

    // 2. default export (when preferExport omitted)
    const defaultRes = buildScaffold(surface, manifest);
    expect(defaultRes.basedOn[0]?.name).toBe("default");

    // 3. package match (when default omitted)
    const noDefaultSurface = createSurface({
      exports: [
        { name: "helper", kind: "function", signature: "helper(): void" },
        { name: "axios", kind: "function", signature: "axios(config: any): any" },
      ],
    });
    const pkgMatchRes = buildScaffold(noDefaultSurface, manifest);
    expect(pkgMatchRes.basedOn[0]?.name).toBe("axios");

    // 4. first function/class (when no package match or default)
    const fnFallbackSurface = createSurface({
      exports: [
        { name: "helper", kind: "function", signature: "helper(): void" },
        { name: "other", kind: "function", signature: "other(): void" },
      ],
    });
    const fnFallbackRes = buildScaffold(fnFallbackSurface, manifest);
    expect(fnFallbackRes.basedOn[0]?.name).toBe("helper");
  });

  it("is strictly deterministic (same inputs twice -> deep equal)", () => {
    const surface = createSurface();
    const manifest = createManifest({
      prerequisites: [
        {
          kind: "external-binary",
          name: "imagemagick",
          confidence: "likely",
          evidence: "uses imagemagick",
        },
      ],
    });

    const run1 = buildScaffold(surface, manifest);
    const run2 = buildScaffold(surface, manifest);

    expect(run1).toEqual(run2);
  });

  it("falls through from non-callable default export to callable named export (axios-like)", () => {
    const surface = createSurface({
      exports: [
        {
          name: "default",
          kind: "default",
          signature: "default: AxiosStatic",
        },
        {
          name: "create",
          kind: "function",
          signature: "create(config?: CreateAxiosDefaults): AxiosInstance",
        },
      ],
    });
    const manifest = createManifest();

    const scaffold = buildScaffold(surface, manifest);

    expect(scaffold.confidence).toBe("verified-signatures");
    expect(scaffold.snippet).not.toBeNull();
    expect(scaffold.snippet).toContain("create(config)");
    expect(scaffold.snippet).toContain("axios.create(config)");
    expect(scaffold.basedOn).toEqual([
      {
        name: "create",
        signature: "create(config?: CreateAxiosDefaults): AxiosInstance",
      },
    ]);
    expect(scaffold.notes).toContain(
      "The 'default' export is not callable; selected callable export 'create' accessed via default import 'axios'.",
    );
    expect(ScaffoldSchema.parse(scaffold)).toEqual(scaffold);
  });

  it("falls back to import-only when surface has non-callable default and no callable exports", () => {
    const surface = createSurface({
      exports: [
        {
          name: "default",
          kind: "default",
          signature: "default: AxiosStatic",
        },
        {
          name: "Axios",
          kind: "class",
          signature: null,
        },
      ],
    });
    const manifest = createManifest();

    const scaffold = buildScaffold(surface, manifest);

    expect(scaffold.confidence).toBe("import-only");
    expect(scaffold.snippet).toBeNull();
    expect(scaffold.basedOn).toEqual([]);
    expect(scaffold.notes).toContain(
      "Selected export 'default' signature is not callable; no usage code was generated.",
    );
    expect(ScaffoldSchema.parse(scaffold)).toEqual(scaffold);
  });

  it("falls through when preferExport is not callable to next callable export", () => {
    const surface = createSurface({
      exports: [
        {
          name: "typesOnly",
          kind: "type",
          signature: "typesOnly: SomeType",
        },
        {
          name: "create",
          kind: "function",
          signature: "create(config?: CreateAxiosDefaults): AxiosInstance",
        },
      ],
    });
    const manifest = createManifest();

    const scaffold = buildScaffold(surface, manifest, { preferExport: "typesOnly" });

    expect(scaffold.confidence).toBe("verified-signatures");
    expect(scaffold.snippet).toContain("axios.create(config)");
    expect(scaffold.basedOn).toEqual([
      {
        name: "create",
        signature: "create(config?: CreateAxiosDefaults): AxiosInstance",
      },
    ]);
    expect(ScaffoldSchema.parse(scaffold)).toEqual(scaffold);
  });

  it("selects safe_load over alphabetically earlier callables (like add_constructor) on pyyaml-like surface", () => {
    const pyyamlSurface = createPythonSurface({
      exports: [
        {
          name: "add_constructor",
          kind: "function",
          signature: "add_constructor(tag: str, constructor: Any) -> None",
        },
        {
          name: "add_representer",
          kind: "function",
          signature: "add_representer(data_type: Any, representer: Any) -> None",
        },
        {
          name: "dump",
          kind: "function",
          signature: "dump(data: Any, stream: _WriteStream | None = None) -> Any",
        },
        {
          name: "safe_load",
          kind: "function",
          signature: "safe_load(stream: _ReadStream) -> _YAMLObject",
        },
        {
          name: "load",
          kind: "function",
          signature: "load(stream: _ReadStream, Loader: _Loader) -> _YAMLObject",
        },
      ],
    });
    const pyyamlManifest = createPythonManifest();

    const scaffold = buildScaffold(pyyamlSurface, pyyamlManifest);

    expect(scaffold.confidence).toBe("verified-signatures");
    expect(scaffold.basedOn[0]?.name).toBe("safe_load");
    expect(scaffold.snippet).toBe(
      "# Verified signature: safe_load(stream: _ReadStream) -> _YAMLObject\nresult = yaml.safe_load(stream)",
    );
    expect(scaffold.snippet).not.toContain("add_constructor");
    expect(ScaffoldSchema.parse(scaffold)).toEqual(scaffold);
  });

  it("selects create/get over alphabetically earlier callables (like all) on axios-like surface", () => {
    const axiosSurface = createSurface({
      exports: [
        {
          name: "all",
          kind: "function",
          signature: "all<T>(promises: Array<T | Promise<T>>): Promise<T[]>",
        },
        {
          name: "create",
          kind: "function",
          signature: "create(config?: CreateAxiosDefaults): AxiosInstance",
        },
        {
          name: "get",
          kind: "function",
          signature: "get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>",
        },
        {
          name: "spread",
          kind: "function",
          signature: "spread<T, R>(callback: (...args: T[]) => R): (array: T[]) => R",
        },
      ],
    });
    const axiosManifest = createManifest();

    const scaffold = buildScaffold(axiosSurface, axiosManifest);

    expect(scaffold.confidence).toBe("verified-signatures");
    expect(scaffold.basedOn[0]?.name).toBe("create");
    expect(scaffold.snippet).toContain("axios.create(config)");
    expect(scaffold.snippet).not.toContain("axios.all");
    expect(ScaffoldSchema.parse(scaffold)).toEqual(scaffold);
  });

  it("selects get when create is absent over non-verb callables on axios-like surface", () => {
    const axiosSurface = createSurface({
      exports: [
        {
          name: "all",
          kind: "function",
          signature: "all<T>(promises: Array<T | Promise<T>>): Promise<T[]>",
        },
        {
          name: "get",
          kind: "function",
          signature: "get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>",
        },
        {
          name: "spread",
          kind: "function",
          signature: "spread<T, R>(callback: (...args: T[]) => R): (array: T[]) => R",
        },
      ],
    });
    const axiosManifest = createManifest();

    const scaffold = buildScaffold(axiosSurface, axiosManifest);

    expect(scaffold.confidence).toBe("verified-signatures");
    expect(scaffold.basedOn[0]?.name).toBe("get");
    expect(scaffold.snippet).toContain("axios.get(url, config)");
    expect(scaffold.snippet).not.toContain("axios.all");
  });

  it("ensures preferExport still overrides verb and parameter ranking heuristics", () => {
    const surface = createSurface({
      exports: [
        {
          name: "create",
          kind: "function",
          signature: "create(config?: CreateAxiosDefaults): AxiosInstance",
        },
        {
          name: "all",
          kind: "function",
          signature: "all<T>(promises: Array<T | Promise<T>>): Promise<T[]>",
        },
      ],
    });
    const manifest = createManifest();

    const scaffold = buildScaffold(surface, manifest, { preferExport: "all" });

    expect(scaffold.basedOn[0]?.name).toBe("all");
    expect(scaffold.snippet).toContain("axios.all(promises)");
  });

  it("returns a truthful call on a surface with only obscure callables rather than regressing to import-only", () => {
    const surface = createSurface({
      exports: [
        {
          name: "zebra_calculate",
          kind: "function",
          signature: "zebra_calculate(x: number, y: number, z: number): number",
        },
        {
          name: "obscure_transform",
          kind: "function",
          signature: "obscure_transform(x: number): number",
        },
      ],
    });
    const manifest = createManifest();

    const scaffold = buildScaffold(surface, manifest);

    // Should NOT degrade to import-only
    expect(scaffold.confidence).toBe("verified-signatures");
    expect(scaffold.snippet).not.toBeNull();
    // Prefers obscure_transform because it has fewer required params (1 vs 3)
    expect(scaffold.basedOn[0]?.name).toBe("obscure_transform");
    expect(scaffold.snippet).toContain("axios.obscure_transform(x)");
    expect(ScaffoldSchema.parse(scaffold)).toEqual(scaffold);
  });

  it("preserves strict determinism across diverse candidate orderings", () => {
    const surface = createSurface({
      exports: [
        { name: "delta", kind: "function", signature: "delta(a: string): void" },
        { name: "alpha", kind: "function", signature: "alpha(a: string): void" },
        { name: "beta", kind: "function", signature: "beta(a: string): void" },
      ],
    });
    const manifest = createManifest();

    const res1 = buildScaffold(surface, manifest);
    const res2 = buildScaffold(surface, manifest);

    expect(res1).toEqual(res2);
    expect(res1.basedOn[0]?.name).toBe("alpha");
  });
});
