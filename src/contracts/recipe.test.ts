import { describe, expect, it } from "vitest";
import { RecipeSchema, ResolvedRecipeSchema } from "./recipe.js";

describe("RecipeSchema", () => {
  it("validates a valid recipe definition", () => {
    const recipe = {
      id: "node-video-transcode",
      goal: "Transcode video files in Node.js",
      ecosystem: "npm",
      roles: [
        {
          role: "ffmpeg-wrapper",
          purpose: "Fluent API for FFmpeg invocation",
          required: true,
          candidateQuery: "fluent-ffmpeg",
          externalPrerequisite: "FFmpeg binary must be installed on system PATH",
        },
        {
          role: "progress-reporter",
          purpose: "CLI progress indicator",
          required: false,
          candidateQuery: "cli-progress",
        },
      ],
      notes: ["Requires FFmpeg binary on host system."],
    };

    expect(RecipeSchema.parse(recipe)).toEqual(recipe);
  });

  it("rejects recipe missing required fields", () => {
    const invalid = {
      id: "incomplete-recipe",
      goal: "Missing ecosystem and roles",
    };
    expect(() => RecipeSchema.parse(invalid)).toThrow();
  });
});

describe("ResolvedRecipeSchema", () => {
  it("validates a resolved recipe with ready status", () => {
    const resolved = {
      recipe: {
        id: "node-video-transcode",
        goal: "Transcode video files in Node.js",
        ecosystem: "npm",
        roles: [
          {
            role: "ffmpeg-wrapper",
            purpose: "Fluent API for FFmpeg invocation",
            required: true,
            candidateQuery: "fluent-ffmpeg",
            externalPrerequisite: "FFmpeg binary must be installed on system PATH",
          },
        ],
        notes: [],
      },
      status: "ready" as const,
      filled: [
        {
          role: "ffmpeg-wrapper",
          component: "npm:fluent-ffmpeg",
          verdict: "ship",
          reason: "Selected 'npm:fluent-ffmpeg' with 'ship' verdict (overall: 92).",
        },
      ],
      warnings: ["FFmpeg binary must be installed on system PATH"],
      notes: [],
    };

    expect(ResolvedRecipeSchema.parse(resolved)).toEqual(resolved);
  });

  it("validates a resolved recipe with blocked status and null component", () => {
    const resolved = {
      recipe: {
        id: "node-video-transcode",
        goal: "Transcode video files in Node.js",
        ecosystem: "npm",
        roles: [
          {
            role: "ffmpeg-wrapper",
            purpose: "Fluent API for FFmpeg invocation",
            required: true,
            candidateQuery: "fluent-ffmpeg",
          },
        ],
        notes: [],
      },
      status: "blocked" as const,
      filled: [
        {
          role: "ffmpeg-wrapper",
          component: null,
          verdict: null,
          reason: "No safe component available; all candidates had 'avoid' verdict.",
        },
      ],
      warnings: [],
      notes: ["Required role 'ffmpeg-wrapper' could not be filled with a safe component."],
    };

    expect(ResolvedRecipeSchema.parse(resolved)).toEqual(resolved);
  });

  it("rejects invalid status", () => {
    const invalid = {
      recipe: {
        id: "node-video-transcode",
        goal: "Transcode video files",
        ecosystem: "npm",
        roles: [],
        notes: [],
      },
      status: "invalid_status",
      filled: [],
      warnings: [],
      notes: [],
    };
    expect(() => ResolvedRecipeSchema.parse(invalid)).toThrow();
  });
});
