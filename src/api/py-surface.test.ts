import { describe, expect, it } from "vitest";
import { ApiSurfaceSchema } from "../contracts/api-surface.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import type { HttpClient } from "../http/client.js";
import { PyApiSurfaceExtractor } from "./py-surface.js";

function fixtureExtractor(): PyApiSurfaceExtractor {
  return new PyApiSurfaceExtractor(createFixtureHttpClient());
}

function expectValidSurface(surface: unknown): void {
  expect(ApiSurfaceSchema.parse(surface)).toEqual(surface);
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
