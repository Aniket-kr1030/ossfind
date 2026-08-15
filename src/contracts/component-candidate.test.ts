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

  it("rejects an unsupported ecosystem prefix", () => {
    expect(ComponentCandidateSchema.safeParse({
      id: "rubygems:rails",
      name: "rails",
      ecosystem: "rubygems",
      description: "Web framework",
    }).success).toBe(false);
  });
});
