import { describe, expect, it } from "vitest";
import { ComponentCandidateSchema } from "./component-candidate.js";

describe("ComponentCandidateSchema", () => {
  it("accepts a strict pypi package id", () => {
    expect(ComponentCandidateSchema.parse({
      id: "pypi:moviepy",
      name: "moviepy",
      ecosystem: "pypi",
      description: "Video editing with Python",
    }).id).toBe("pypi:moviepy");
  });

  it("accepts GitHub repository ids and an optional SPDX license hint", () => {
    expect(ComponentCandidateSchema.parse({
      id: "github:huggingface/diffusers",
      name: "huggingface/diffusers",
      ecosystem: "github",
      description: "Diffusion models",
      license: "Apache-2.0",
    })).toMatchObject({ id: "github:huggingface/diffusers", license: "Apache-2.0" });
  });

  it("accepts Hugging Face model ids", () => {
    expect(ComponentCandidateSchema.parse({
      id: "huggingface:owner/model",
      name: "owner/model",
      ecosystem: "huggingface",
      description: "text-to-video model",
    }).id).toBe("huggingface:owner/model");
  });

  it.each([
    ["cargo:serde", "serde", "cargo"],
    ["rubygems:rails", "rails", "rubygems"],
  ] as const)("accepts %s", (id, name, ecosystem) => {
    expect(ComponentCandidateSchema.parse({ id, name, ecosystem, description: "fixture package" }).id).toBe(id);
  });

  it.each([
    ["npm:not-real", "github"],
    ["pypi:github", "npm"],
    ["github:owner/repo", "huggingface"],
    ["huggingface:owner/model", "github"],
    ["cargo:serde", "rubygems"],
    ["rubygems:rails", "cargo"],
  ] as const)("rejects id %s when its declared ecosystem is %s", (id, ecosystem) => {
    const result = ComponentCandidateSchema.safeParse({
      id,
      name: "contradictory",
      ecosystem,
      description: "contradictory identity",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: ["id"],
        message: "id prefix must match ecosystem",
      }));
    }
  });
});
