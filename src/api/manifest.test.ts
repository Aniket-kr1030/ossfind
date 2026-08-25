import { describe, expect, it } from "vitest";
import { IntegrationManifestSchema } from "../contracts/integration-manifest.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import type { HttpClient } from "../http/client.js";
import { IntegrationManifestBuilder } from "./manifest.js";

function fixtureBuilder(): IntegrationManifestBuilder {
  return new IntegrationManifestBuilder(createFixtureHttpClient());
}

function expectValidManifest(manifest: unknown): void {
  expect(IntegrationManifestSchema.parse(manifest)).toEqual(manifest);
}

describe("IntegrationManifestBuilder", () => {
  it("reports chalk's ESM-only import form from its package metadata", async () => {
    const manifest = await fixtureBuilder().build("chalk");

    expectValidManifest(manifest);
    expect(manifest).toMatchObject({
      id: "npm:chalk",
      version: "6.0.0",
      install: { command: "npm install chalk" },
      importForm: {
        moduleType: "esm",
        esm: 'import chalk from "chalk";',
        cjs: null,
        typesPackage: null,
      },
      runtime: { engines: { node: ">=22" } },
    });
  });

  it("uses verified DefinitelyTyped metadata for express and retains its CJS form", async () => {
    const manifest = await fixtureBuilder().build("express");

    expectValidManifest(manifest);
    expect(manifest).toMatchObject({
      id: "npm:express",
      importForm: {
        moduleType: "cjs",
        esm: null,
        cjs: 'const express = require("express");',
        typesPackage: "@types/express",
      },
    });
  });

  it("detects sharp's platform optional dependencies as verified prebuilt-native prerequisites", async () => {
    const manifest = await fixtureBuilder().build("sharp");

    expectValidManifest(manifest);
    expect(manifest.runtime.engines).toMatchObject({ node: ">=20.9.0" });
    expect(manifest.prerequisites).toContainEqual(expect.objectContaining({
      kind: "prebuilt-native",
      name: "@img/sharp-darwin-arm64",
      confidence: "verified",
      evidence: expect.stringContaining("optionalDependencies"),
    }));
  });

  it("keeps fluent-ffmpeg's prose-derived binary prerequisite explicitly non-verified", async () => {
    const manifest = await fixtureBuilder().build("fluent-ffmpeg");

    expectValidManifest(manifest);
    const ffmpeg = manifest.prerequisites.find((prerequisite) => prerequisite.kind === "external-binary" && prerequisite.name === "ffmpeg");
    expect(ffmpeg).toMatchObject({
      confidence: "likely",
      evidence: expect.stringContaining('"A fluent API to FFMPEG (http://www.ffmpeg.org)"'),
    });
    expect(ffmpeg?.confidence).not.toBe("verified");
  });

  it("does not fabricate prerequisites where metadata and allowlisted prose contain none", async () => {
    const manifest = await fixtureBuilder().build("left-pad");

    expectValidManifest(manifest);
    expect(manifest.prerequisites).toEqual([]);
  });

  it("is deterministic for repeated offline builds", async () => {
    const builder = fixtureBuilder();
    const [first, second] = await Promise.all([builder.build("sharp"), builder.build("sharp")]);

    expectValidManifest(first);
    expectValidManifest(second);
    expect(second).toEqual(first);
  });

  it("fails closed to a valid unknown manifest when registry retrieval fails", async () => {
    const failingClient: HttpClient = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const manifest = await new IntegrationManifestBuilder(failingClient).build("missing-package");

    expectValidManifest(manifest);
    expect(manifest).toMatchObject({
      id: "npm:missing-package",
      version: null,
      install: { command: "npm install missing-package" },
      importForm: { moduleType: "unknown", esm: null, cjs: null, typesPackage: null },
      prerequisites: [],
    });
    expect(manifest.notes.join(" ")).toMatch(/could not fetch/i);
  });
});
