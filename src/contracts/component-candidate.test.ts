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

  it("rejects an unsupported ecosystem prefix", () => {
    expect(ComponentCandidateSchema.safeParse({
      id: "rubygems:rails",
      name: "rails",
      ecosystem: "rubygems",
      description: "Web framework",
    }).success).toBe(false);
  });
});
