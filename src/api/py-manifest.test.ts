import { describe, expect, it } from "vitest";
import { IntegrationManifestSchema } from "../contracts/integration-manifest.js";
import type { HttpClient } from "../http/client.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import { PyIntegrationManifestBuilder } from "./py-manifest.js";

function fixtureBuilder(): PyIntegrationManifestBuilder {
  return new PyIntegrationManifestBuilder(createFixtureHttpClient());
}

function expectValidManifest(manifest: unknown): void {
  expect(IntegrationManifestSchema.parse(manifest)).toEqual(manifest);
}

function requiredRuntimeNames(manifest: Awaited<ReturnType<PyIntegrationManifestBuilder["build"]>>): string[] {
  return manifest.prerequisites
    .filter((prerequisite) => prerequisite.kind === "peer-dependency")
    .map((prerequisite) => prerequisite.name);
}

describe("PyIntegrationManifestBuilder", () => {
  it("keeps PyYAML's distribution and verified yaml import name separate", async () => {
    const manifest = await fixtureBuilder().build("pyyaml");

    expectValidManifest(manifest);
    expect(manifest).toMatchObject({
      id: "pypi:pyyaml",
      version: "6.0.3",
      install: { command: "pip install pyyaml" },
      importForm: {
        moduleType: "unknown",
        esm: null,
        cjs: null,
        python: {
          importName: "yaml",
          statements: ["import yaml"],
          confidence: "verified",
        },
      },
      runtime: { engines: { python: ">=3.8" } },
    });
    expect(manifest.importForm.python?.statements).not.toContain("import pyyaml");
  });

  it("records requests' unmarked PyPI runtime requirements and omits its extras", async () => {
    const builder = fixtureBuilder();
    const [manifest, withSocksExtra] = await Promise.all([
      builder.build("requests"),
      builder.build("requests[socks]"),
    ]);

    expectValidManifest(manifest);
    expectValidManifest(withSocksExtra);
    expect(withSocksExtra).toMatchObject({
      id: "pypi:requests",
      version: "2.34.2",
      install: { command: "pip install requests[socks]" },
    });
    expect(manifest.peerDependencies).toEqual({});
    expect(requiredRuntimeNames(manifest)).toEqual(["certifi", "charset_normalizer", "idna", "urllib3"]);
    expect(manifest.prerequisites).toContainEqual(expect.objectContaining({
      kind: "peer-dependency",
      name: "urllib3",
      confidence: "verified",
      evidence: 'info.requires_dist: "urllib3<3,>=1.26".',
    }));
    expect(requiredRuntimeNames(manifest)).not.toContain("PySocks");
    expect(requiredRuntimeNames(manifest)).not.toContain("chardet");
  });

  it("reports ffmpeg-python's prose-derived binary requirement only as likely", async () => {
    const manifest = await fixtureBuilder().build("ffmpeg-python");

    expectValidManifest(manifest);
    const ffmpeg = manifest.prerequisites.find((prerequisite) =>
      prerequisite.kind === "external-binary" && prerequisite.name === "ffmpeg");
    expect(ffmpeg).toMatchObject({
      confidence: "likely",
      evidence: expect.stringContaining('info.summary: "Python bindings for FFmpeg'),
    });
    expect(ffmpeg?.confidence).not.toBe("verified");
    expect(requiredRuntimeNames(manifest)).toEqual(["future"]);
  });

  it("does not present moviepy's marker-qualified extras as required runtime dependencies", async () => {
    const manifest = await fixtureBuilder().build("moviepy");

    expectValidManifest(manifest);
    expect(requiredRuntimeNames(manifest)).toEqual([
      "decorator",
      "imageio",
      "imageio_ffmpeg",
      "numpy",
      "pillow",
      "proglog",
      "python-dotenv",
    ]);
    expect(requiredRuntimeNames(manifest)).not.toEqual(expect.arrayContaining([
      "numpydoc",
      "pytest",
      "black",
    ]));
  });

  it("is deterministic for repeated offline builds", async () => {
    const builder = fixtureBuilder();
    const [first, second] = await Promise.all([builder.build("pyyaml"), builder.build("pyyaml")]);

    expectValidManifest(first);
    expectValidManifest(second);
    expect(second).toEqual(first);
  });

  it("fails closed to a valid unknown Python import form when PyPI retrieval fails", async () => {
    const failingClient: HttpClient = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const manifest = await new PyIntegrationManifestBuilder(failingClient).build("missing-package");

    expectValidManifest(manifest);
    expect(manifest).toMatchObject({
      id: "pypi:missing-package",
      version: null,
      install: { command: "pip install missing-package" },
      importForm: {
        moduleType: "unknown",
        esm: null,
        cjs: null,
        typesPackage: null,
        python: { importName: null, statements: [], confidence: "unknown" },
      },
      prerequisites: [],
    });
    expect(manifest.notes.join(" ")).toMatch(/could not fetch/i);
  });
});
