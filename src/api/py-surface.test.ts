import { describe, expect, it } from "vitest";
import { ApiSurfaceSchema } from "../contracts/api-surface.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import type { HttpClient, HttpResponse } from "../http/client.js";
import { PyApiSurfaceExtractor } from "./py-surface.js";

function fixtureExtractor(): PyApiSurfaceExtractor {
  return new PyApiSurfaceExtractor(createFixtureHttpClient());
}

function expectValidSurface(surface: unknown): void {
  expect(ApiSurfaceSchema.parse(surface)).toEqual(surface);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/** Creates a minimal stored ZIP; the reader intentionally does not require CRCs. */
function storedZip(files: Array<{ name: string; content: string | Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const content = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
    const local = new Uint8Array(30 + name.byteLength + content.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(18, content.byteLength, true);
    localView.setUint32(22, content.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(content, 30 + name.byteLength);
    localParts.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(20, content.byteLength, true);
    centralView.setUint32(24, content.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.byteLength;
  }

  const centralDirectory = concatBytes(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralDirectory.byteLength, true);
  endView.setUint32(16, offset, true);
  return concatBytes([...localParts, centralDirectory, end]);
}

function binaryResponse(bytes: Uint8Array, status: number, headers: Record<string, string> = {}): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    text: async () => "",
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as HttpResponse;
}

function rangeResponse(wheel: Uint8Array, range: string): { body: Uint8Array; start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  const start = match[1] ? Number(match[1]) : Math.max(0, wheel.byteLength - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(wheel.byteLength - 1, Number(match[2])) : wheel.byteLength - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= wheel.byteLength) return undefined;
  return { body: wheel.subarray(start, end + 1), start, end };
}

describe("PyApiSurfaceExtractor", () => {
  it("extracts real re-exported public API names from requests", async () => {
    const surface = await fixtureExtractor().extract("requests");

    expectValidSurface(surface);
    expect(surface).toMatchObject({
      id: "pypi:requests",
      version: "2.34.2",
      typesAvailable: "definitely-typed",
      typesSource: "stubs/requests/requests/__init__.pyi",
      truncated: false,
    });

    expect(surface.exports.length).toBe(38);
    // Verified PEP 484 re-exported names are captured
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "get", kind: "function" }));
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "post", kind: "function" }));
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "Session", kind: "class" }));
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "Response", kind: "class" }));
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "codes" }));
    // Direct declarations
    expect(surface.exports).toContainEqual(expect.objectContaining({
      name: "check_compatibility",
      kind: "function",
      signature: expect.stringMatching(/^check_compatibility\(/),
    }));
    expect(surface.exports).toContainEqual(expect.objectContaining({ name: "__version__", kind: "const" }));

    // Unresolved sibling stubs produce honest notes rather than fabricated exports
    expect(surface.notes.join(" ")).toMatch(/could not verify re-export/i);
  });

  it("extracts real parsed functions with full signatures from pyyaml", async () => {
    const surface = await fixtureExtractor().extract("pyyaml");

    expectValidSurface(surface);
    expect(surface).toMatchObject({
      id: "pypi:pyyaml",
      version: "6.0.3",
      typesAvailable: "definitely-typed",
      typesSource: "stubs/PyYAML/yaml/__init__.pyi",
      truncated: false,
    });

    expect(surface.exports.length).toBe(31);
    expect(surface.exports).toContainEqual(expect.objectContaining({
      name: "load",
      kind: "function",
      signature: "load(stream: _ReadStream, Loader: type[_Loader | _CLoader]) -> _YAMLObject",
    }));
    expect(surface.exports).toContainEqual(expect.objectContaining({
      name: "safe_load",
      kind: "function",
      signature: "safe_load(stream: _ReadStream) -> _YAMLObject",
    }));
    expect(surface.exports).toContainEqual(expect.objectContaining({
      name: "scan",
      kind: "function",
      signature: expect.stringMatching(/^scan\(/),
    }));
    expect(surface.exports).toContainEqual(expect.objectContaining({
      name: "dump",
      kind: "function",
    }));
    expect(surface.exports).toContainEqual(expect.objectContaining({
      name: "YAMLObject",
      kind: "class",
    }));
    expect(surface.exports).toContainEqual(expect.objectContaining({
      name: "__version__",
      kind: "const",
      signature: "__version__: Final[str]",
    }));
  });

  it("fails closed when typeshed has no stub (numpy 404)", async () => {
    const surface = await fixtureExtractor().extract("numpy");

    expectValidSurface(surface);
    expect(surface).toMatchObject({
      id: "pypi:numpy",
      version: "2.5.2",
      typesAvailable: "none",
      typesSource: null,
      exports: [],
      truncated: false,
    });
    expect(surface.notes.join(" ")).toMatch(/no typeshed stubs found/i);
  });

  it("extracts an own typed surface from the frozen attrs PEP 561 wheel", async () => {
    const attrs = await fixtureExtractor().extract("attrs");

    expectValidSurface(attrs);
    expect(attrs).toMatchObject({
      id: "pypi:attrs",
      version: "26.1.0",
      typesAvailable: "own",
      truncated: false,
    });
    expect(attrs.typesSource).toBe("attrs-26.1.0-py3-none-any.whl:attr/__init__.pyi");
    expect(attrs.exports.length).toBeGreaterThan(0);
    expect(attrs.exports).toContainEqual(expect.objectContaining({ name: "Attribute", kind: "class" }));
    expect(attrs.exports).toContainEqual(expect.objectContaining({ name: "attrib", kind: "function" }));
    expect(attrs.notes.join(" ")).toMatch(/HTTP byte ranges/i);
  });

  it("resolves high-value public wheel re-exports within bounded range reads", async () => {
    const verifiedNames = Array.from({ length: 229 }, (_, index) => `verified_${index}`);
    const highValueNames = ["array", "zeros", "empty", ...Array.from({ length: 108 }, (_, index) => `multi_${index}`)];
    const moduleNames = [
      "numpy._core.multiarray",
      ...Array.from({ length: 16 }, (_, index) => `numpy._a${String(index).padStart(2, "0")}`),
      ...Array.from({ length: 20 }, (_, index) => `numpy.z${String(index).padStart(2, "0")}`),
    ];
    const lowValueGroups = moduleNames.slice(1).map((module, moduleIndex) => ({
      module,
      names: Array.from({ length: 6 }, (_, nameIndex) => `value_${moduleIndex}_${nameIndex}`),
    }));
    const allNames = [...verifiedNames, ...highValueNames, ...lowValueGroups.flatMap((group) => group.names)];
    expect(allNames).toHaveLength(556);

    const root = [
      `__all__ = [${allNames.map((name) => JSON.stringify(name)).join(", ")}]`,
      `from numpy._core.multiarray import (${highValueNames.join(", ")})`,
      ...lowValueGroups.map((group) => `from ${group.module} import (${group.names.join(", ")})`),
      ...verifiedNames.map((name) => `def ${name}() -> int: ...`),
    ].join("\n");
    const childSource = (names: string[]) => names.map((name) => {
      if (name === "array") return "def array(object: object, dtype: DTypeLike = None) -> ndarray: ...";
      if (name === "zeros") return "def zeros(shape: ShapeLike, dtype: DTypeLike = None) -> ndarray: ...";
      return `def ${name}() -> int: ...`;
    }).join("\n");
    const childFiles = lowValueGroups.map((group, index) => {
      const base = group.module.replace(/\./g, "/");
      // Exercise the documented package-stub and source fallbacks while these
      // two low-priority modules remain inside the 15-module fetch cap.
      const name = index === 0
        ? `${base}/__init__.pyi`
        : index === 1
          ? `${base}.py`
          : `${base}.pyi`;
      return { name, content: childSource(group.names) };
    });
    const wheel = storedZip([
      { name: "numpy/__init__.pyi", content: root },
      { name: "numpy/_core/multiarray.pyi", content: childSource(highValueNames) },
      ...childFiles,
      // An unreferenced stored entry proves range extraction does not download
      // the whole wheel when resolving sibling stubs.
      { name: "numpy/_padding.bin", content: new Uint8Array(5 * 1024 * 1024) },
    ]);
    const wheelUrl = "https://files.pythonhosted.org/packages/numpy-range-fixture.whl";
    const rangeRequests: Array<{ header: string; bytes: number }> = [];
    const client: HttpClient = async (url, init) => {
      if (url === "https://pypi.org/pypi/numpy/json") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            info: { name: "numpy", version: "2.5.2" },
            urls: [{ filename: "numpy-range-fixture.whl", url: wheelUrl, size: wheel.byteLength, packagetype: "bdist_wheel" }],
          }),
        };
      }
      if (url === wheelUrl) {
        const header = new Headers(init?.headers).get("range");
        if (!header) return binaryResponse(new Uint8Array(), 500);
        const response = rangeResponse(wheel, header);
        if (!response) return binaryResponse(new Uint8Array(), 416);
        rangeRequests.push({ header, bytes: response.body.byteLength });
        return binaryResponse(response.body, 206, {
          "accept-ranges": "bytes",
          "content-range": `bytes ${response.start}-${response.end}/${wheel.byteLength}`,
        });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const extractor = new PyApiSurfaceExtractor(client);
    const first = await extractor.extract("numpy");

    expectValidSurface(first);
    expect(first.typesAvailable).toBe("own");
    expect(first.exports).toHaveLength(556);
    expect(first.exports.filter((entry) => entry.signature !== null)).toHaveLength(424);
    expect(first.exports).toContainEqual(expect.objectContaining({
      name: "array",
      signature: "array(object: object, dtype: DTypeLike = None) -> ndarray",
    }));
    expect(first.exports).toContainEqual(expect.objectContaining({
      name: "zeros",
      signature: "zeros(shape: ShapeLike, dtype: DTypeLike = None) -> ndarray",
    }));
    expect(first.exports).toContainEqual(expect.objectContaining({ name: "value_15_0", signature: null }));
    expect(first.notes.join(" ")).toMatch(/Resolved 195 public re-export signatures.*132 remained unresolved.*15 submodules.*4194304 range bytes.*depth 2/i);
    expect(rangeRequests).toHaveLength(33);
    expect(rangeRequests.every((request) => request.header.length > 0)).toBe(true);
    expect(rangeRequests.reduce((total, request) => total + request.bytes, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(rangeRequests.reduce((total, request) => total + request.bytes, 0)).toBeLessThan(wheel.byteLength);

    rangeRequests.length = 0;
    const second = await extractor.extract("numpy");
    expectValidSurface(second);
    expect(second).toEqual(first);
  });

  it("prefers the smallest eligible wheel in PyPI metadata", async () => {
    const fixture = createFixtureHttpClient();
    const smallWheelUrl = "https://files.pythonhosted.org/packages/attrs-26.1.0-py3-none-any.whl";
    const requestedWheelUrls: string[] = [];
    const client: HttpClient = async (url, init) => {
      if (url === "https://pypi.org/pypi/attrs/json") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            info: { name: "attrs", version: "26.1.0" },
            urls: [
              {
                filename: "attrs-large.whl",
                url: "https://files.pythonhosted.org/packages/attrs-large.whl",
                size: 4_000_000,
                packagetype: "bdist_wheel",
              },
              {
                filename: "attrs-26.1.0-py3-none-any.whl",
                url: smallWheelUrl,
                size: 67_548,
                packagetype: "bdist_wheel",
              },
            ],
          }),
        };
      }
      if (url.startsWith("https://files.pythonhosted.org/")) requestedWheelUrls.push(url);
      return fixture(url, init);
    };

    const attrs = await new PyApiSurfaceExtractor(client).extract("attrs");

    expectValidSurface(attrs);
    expect(attrs.typesAvailable).toBe("own");
    expect([...new Set(requestedWheelUrls)]).toEqual([smallWheelUrl]);
  });

  it("uses the bounded full-download fallback only when a wheel server ignores Range", async () => {
    const fixture = createFixtureHttpClient();
    const ignoresRange: HttpClient = async (url) => fixture(url);

    const attrs = await new PyApiSurfaceExtractor(ignoresRange).extract("attrs");

    expectValidSurface(attrs);
    expect(attrs.typesAvailable).toBe("own");
    expect(attrs.notes.join(" ")).toMatch(/bounded full-download fallback/i);
  });

  it("fails closed when no own wheel can be extracted", async () => {
    const extractor = fixtureExtractor();
    const [moviepy, ffmpeg] = await Promise.all([
      extractor.extract("moviepy"),
      extractor.extract("ffmpeg-python"),
    ]);

    expectValidSurface(moviepy);
    expect(moviepy).toMatchObject({
      id: "pypi:moviepy",
      typesAvailable: "none",
      exports: [],
    });
    expect(moviepy.notes.join(" ")).toMatch(/wheel/i);

    expectValidSurface(ffmpeg);
    expect(ffmpeg).toMatchObject({
      id: "pypi:ffmpeg-python",
      typesAvailable: "none",
      exports: [],
    });
  });

  it("fails closed for non-existent package", async () => {
    const surface = await fixtureExtractor().extract("non-existent-python-package-xyz");

    expectValidSurface(surface);
    expect(surface).toMatchObject({
      id: "pypi:non-existent-python-package-xyz",
      version: null,
      typesAvailable: "none",
      typesSource: null,
      exports: [],
      truncated: false,
    });
    expect(surface.notes.length).toBeGreaterThan(0);
  });

  it("resolves sibling stubs and recovers full signatures when available", async () => {
    const mockClient: HttpClient = async (url) => {
      if (url === "https://pypi.org/pypi/mockpkg/json") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ info: { name: "mockpkg", version: "1.0.0" } }),
        };
      }
      if (url === "https://cdn.jsdelivr.net/gh/python/typeshed@main/stubs/mockpkg/mockpkg/__init__.pyi") {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "from .sub import helper as helper\ndef root_fn() -> None: ...\n",
        };
      }
      if (url === "https://cdn.jsdelivr.net/gh/python/typeshed@main/stubs/mockpkg/mockpkg/sub.pyi") {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "def helper(val: int) -> str: ...\n",
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const surface = await new PyApiSurfaceExtractor(mockClient).extract("mockpkg");

    expectValidSurface(surface);
    expect(surface).toMatchObject({
      id: "pypi:mockpkg",
      typesAvailable: "definitely-typed",
    });
    expect(surface.exports).toContainEqual({
      name: "helper",
      kind: "function",
      signature: "helper(val: int) -> str",
    });
    expect(surface.exports).toContainEqual({
      name: "root_fn",
      kind: "function",
      signature: "root_fn() -> None",
    });
  });

  it("marks a declaration carrying fixture truncation sentinel as truncated", async () => {
    const mockClient: HttpClient = async (url) => {
      if (url === "https://pypi.org/pypi/trunc-demo/json") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ info: { name: "trunc-demo", version: "0.1.0" } }),
        };
      }
      if (url === "https://cdn.jsdelivr.net/gh/python/typeshed@main/stubs/trunc-demo/trunc_demo/__init__.pyi") {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "def partial() -> None: ...\n# [fixture truncated]\n",
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const surface = await new PyApiSurfaceExtractor(mockClient).extract("trunc-demo");

    expectValidSurface(surface);
    expect(surface).toMatchObject({
      id: "pypi:trunc-demo",
      typesAvailable: "definitely-typed",
      truncated: true,
    });
  });

  it("detects and breaks re-export cycles gracefully", async () => {
    const mockClient: HttpClient = async (url) => {
      if (url === "https://pypi.org/pypi/cyclic-pkg/json") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ info: { name: "cyclic-pkg", version: "1.0.0" } }),
        };
      }
      if (url === "https://cdn.jsdelivr.net/gh/python/typeshed@main/stubs/cyclic-pkg/cyclic_pkg/__init__.pyi") {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "from .cycle_a import a as a\n",
        };
      }
      if (url === "https://cdn.jsdelivr.net/gh/python/typeshed@main/stubs/cyclic-pkg/cyclic_pkg/cycle_a.pyi") {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "from .cycle_b import b as b\ndef a(): ...\n",
        };
      }
      if (url === "https://cdn.jsdelivr.net/gh/python/typeshed@main/stubs/cyclic-pkg/cyclic_pkg/cycle_b.pyi") {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "from .cycle_a import a as a\ndef b(): ...\n",
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const surface = await new PyApiSurfaceExtractor(mockClient).extract("cyclic-pkg");

    expectValidSurface(surface);
    expect(surface.id).toBe("pypi:cyclic-pkg");
    expect(surface.notes.join(" ")).toMatch(/cycle/i);
  });

  it("is deterministic for repeated offline extraction", async () => {
    const extractor = fixtureExtractor();
    const [firstReq, secondReq] = await Promise.all([
      extractor.extract("requests"),
      extractor.extract("requests"),
    ]);

    expectValidSurface(firstReq);
    expectValidSurface(secondReq);
    expect(secondReq).toEqual(firstReq);

    const [firstAttrs, secondAttrs] = await Promise.all([
      extractor.extract("attrs"),
      extractor.extract("attrs"),
    ]);

    expectValidSurface(firstAttrs);
    expectValidSurface(secondAttrs);
    expect(secondAttrs).toEqual(firstAttrs);
  });
});
