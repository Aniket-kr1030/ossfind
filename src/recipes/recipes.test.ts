import { describe, expect, it } from "vitest";
import { type ScoredComponent } from "../contracts/scored-component.js";
import { RecipeSchema, ResolvedRecipeSchema, type Recipe } from "../contracts/recipe.js";
import { RECIPE_CATALOG } from "./catalog.js";
import { getRecipe, listRecipes } from "./index.js";
import { resolveRecipe, type RecipeFillFn } from "./resolve.js";

function mockComponent(
  id: string,
  verdict: "ship" | "caution" | "avoid",
  overall: number = 85,
): ScoredComponent {
  const name = id.replace(/^(npm|pypi|github|huggingface):/, "");
  return {
    id,
    name,
    repoUrl: `https://github.com/example/${name}`,
    scores: {
      fit: 0.9,
      license: verdict === "avoid" ? 0.2 : 1.0,
      security: verdict === "avoid" ? 0.1 : 0.95,
      health: 0.9,
      effort: 0.85,
    },
    overall,
    verdict,
    reasons: [`Component verdict is ${verdict}`],
    badges: {
      license: verdict === "avoid" ? "GPL-3.0" : "MIT",
      cveCount: verdict === "avoid" ? 3 : 0,
      scorecard: 8.5,
    },
  };
}

describe("Recipe Catalog & Index", () => {
  it("contains hand-written, valid composition recipes across npm and PyPI", () => {
    const recipes = listRecipes();
    expect(recipes.length).toBeGreaterThanOrEqual(8);
    expect(recipes.length).toBeLessThanOrEqual(12);

    const ecosystems = new Set(recipes.map((r) => r.ecosystem));
    expect(ecosystems.has("npm")).toBe(true);
    expect(ecosystems.has("pypi")).toBe(true);

    for (const recipe of recipes) {
      expect(RecipeSchema.parse(recipe)).toEqual(recipe);
      expect(recipe.roles.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("has unique IDs for all catalog recipes", () => {
    const ids = RECIPE_CATALOG.map((r) => r.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("retrieves recipes by id via getRecipe", () => {
    const videoRecipe = getRecipe("node-video-transcode");
    expect(videoRecipe).toBeDefined();
    expect(videoRecipe?.id).toBe("node-video-transcode");

    const pyVideoRecipe = getRecipe("python-video-processing");
    expect(pyVideoRecipe).toBeDefined();
    expect(pyVideoRecipe?.id).toBe("python-video-processing");
    expect(pyVideoRecipe?.ecosystem).toBe("pypi");

    const nonExistent = getRecipe("non-existent-recipe");
    expect(nonExistent).toBeUndefined();
  });
});

describe("resolveRecipe", () => {
  const testRecipe: Recipe = {
    id: "test-transcode-stack",
    goal: "Transcode video and display progress",
    ecosystem: "npm",
    roles: [
      {
        role: "ffmpeg-wrapper",
        purpose: "CLI wrapper for ffmpeg",
        required: true,
        candidateQuery: "fluent-ffmpeg",
        externalPrerequisite: "FFmpeg binary must be installed on system PATH",
      },
      {
        role: "progress-reporter",
        purpose: "Progress indicator",
        required: false,
        candidateQuery: "cli-progress",
      },
    ],
    notes: ["Integration test recipe note."],
  };

  it("all roles filled with 'ship' components -> status: 'ready'", async () => {
    const fakeFill: RecipeFillFn = async (query: string) => {
      if (query === "fluent-ffmpeg") {
        return [mockComponent("npm:fluent-ffmpeg", "ship", 95)];
      }
      if (query === "cli-progress") {
        return [mockComponent("npm:cli-progress", "ship", 88)];
      }
      return [];
    };

    const resolved = await resolveRecipe(testRecipe, fakeFill);

    expect(resolved.status).toBe("ready");
    expect(resolved.filled).toHaveLength(2);
    expect(resolved.filled[0]).toEqual({
      role: "ffmpeg-wrapper",
      component: "npm:fluent-ffmpeg",
      verdict: "ship",
      reason: "Selected 'npm:fluent-ffmpeg' with 'ship' verdict (overall: 95).",
    });
    expect(resolved.filled[1]).toEqual({
      role: "progress-reporter",
      component: "npm:cli-progress",
      verdict: "ship",
      reason: "Selected 'npm:cli-progress' with 'ship' verdict (overall: 88).",
    });
    expect(ResolvedRecipeSchema.parse(resolved)).toEqual(resolved);
  });

  it("fail-closed rule: required role whose only candidates are 'avoid' -> status: 'blocked' and unsafe component NOT selected", async () => {
    const fakeFill: RecipeFillFn = async (query: string) => {
      if (query === "fluent-ffmpeg") {
        // Only return an unsafe component with 'avoid' verdict
        return [mockComponent("npm:vulnerable-ffmpeg", "avoid", 20)];
      }
      if (query === "cli-progress") {
        return [mockComponent("npm:cli-progress", "ship", 90)];
      }
      return [];
    };

    const resolved = await resolveRecipe(testRecipe, fakeFill);

    // Must be blocked because required role was not safely filled
    expect(resolved.status).toBe("blocked");

    // Unsafe component must NEVER be selected
    const requiredFilled = resolved.filled.find((f) => f.role === "ffmpeg-wrapper");
    expect(requiredFilled).toBeDefined();
    expect(requiredFilled?.component).toBeNull();
    expect(requiredFilled?.verdict).toBeNull();
    expect(requiredFilled?.reason).toContain("'avoid'");
    expect(requiredFilled?.reason).not.toContain("Selected");

    // Notes must document the blocked required role
    expect(resolved.notes.some((n) => n.includes("Required role 'ffmpeg-wrapper' cannot be safely filled"))).toBe(true);

    expect(ResolvedRecipeSchema.parse(resolved)).toEqual(resolved);
  });

  it("optional role unfilled -> status: 'partial', not 'blocked'", async () => {
    const fakeFill: RecipeFillFn = async (query: string) => {
      if (query === "fluent-ffmpeg") {
        return [mockComponent("npm:fluent-ffmpeg", "ship", 92)];
      }
      if (query === "cli-progress") {
        // No candidates available for optional role
        return [];
      }
      return [];
    };

    const resolved = await resolveRecipe(testRecipe, fakeFill);

    expect(resolved.status).toBe("partial");
    expect(resolved.filled[0]?.component).toBe("npm:fluent-ffmpeg");
    expect(resolved.filled[1]?.component).toBeNull();
    expect(resolved.filled[1]?.reason).toBe("No candidate components returned for query 'cli-progress'.");
    expect(resolved.notes.some((n) => n.includes("Optional role 'progress-reporter' is unfilled"))).toBe(true);

    expect(ResolvedRecipeSchema.parse(resolved)).toEqual(resolved);
  });

  it("optional role with only 'avoid' candidates -> status: 'partial' and unsafe component NOT selected", async () => {
    const fakeFill: RecipeFillFn = async (query: string) => {
      if (query === "fluent-ffmpeg") {
        return [mockComponent("npm:fluent-ffmpeg", "ship", 92)];
      }
      if (query === "cli-progress") {
        return [mockComponent("npm:unsafe-progress", "avoid", 15)];
      }
      return [];
    };

    const resolved = await resolveRecipe(testRecipe, fakeFill);

    expect(resolved.status).toBe("partial");
    expect(resolved.filled[1]?.component).toBeNull();
    expect(resolved.filled[1]?.verdict).toBeNull();
    expect(resolved.notes.some((n) => n.includes("Optional role 'progress-reporter' is unfilled"))).toBe(true);

    expect(ResolvedRecipeSchema.parse(resolved)).toEqual(resolved);
  });

  it("recipe carrying externalPrerequisite surfaces it into warnings", async () => {
    const fakeFill: RecipeFillFn = async () => [mockComponent("npm:pkg", "ship", 90)];

    const resolved = await resolveRecipe(testRecipe, fakeFill);

    expect(resolved.warnings).toContain("FFmpeg binary must be installed on system PATH");
  });

  it("prefers 'ship' over 'caution' candidate regardless of ordering", async () => {
    const fakeFill: RecipeFillFn = async () => [
      mockComponent("npm:caution-pkg", "caution", 99),
      mockComponent("npm:ship-pkg", "ship", 85),
    ];

    const singleRoleRecipe: Recipe = {
      id: "single-role",
      goal: "Test preference",
      ecosystem: "npm",
      roles: [
        {
          role: "worker",
          purpose: "Worker role",
          required: true,
          candidateQuery: "worker-pkg",
        },
      ],
      notes: [],
    };

    const resolved = await resolveRecipe(singleRoleRecipe, fakeFill);

    expect(resolved.status).toBe("ready");
    expect(resolved.filled[0]?.component).toBe("npm:ship-pkg");
    expect(resolved.filled[0]?.verdict).toBe("ship");
  });

  it("records note when caution-grade component is selected", async () => {
    const fakeFill: RecipeFillFn = async () => [
      mockComponent("npm:caution-only-pkg", "caution", 70),
    ];

    const singleRoleRecipe: Recipe = {
      id: "caution-role",
      goal: "Test caution note",
      ecosystem: "npm",
      roles: [
        {
          role: "worker",
          purpose: "Worker role",
          required: true,
          candidateQuery: "worker-pkg",
        },
      ],
      notes: [],
    };

    const resolved = await resolveRecipe(singleRoleRecipe, fakeFill);

    expect(resolved.status).toBe("partial");
    expect(resolved.filled[0]?.component).toBe("npm:caution-only-pkg");
    expect(resolved.notes.some((n) => n.includes("Role 'worker' is filled with caution-grade component"))).toBe(true);
    expect(resolved.notes.some((n) => n.includes("All filled components are caution-grade"))).toBe(true);
  });

  it("is strictly deterministic (same inputs twice -> deep-equal output)", async () => {
    const fakeFill: RecipeFillFn = async (query: string) => [
      mockComponent(`npm:${query}-primary`, "ship", 90),
      mockComponent(`npm:${query}-fallback`, "caution", 75),
    ];

    const run1 = await resolveRecipe(testRecipe, fakeFill);
    const run2 = await resolveRecipe(testRecipe, fakeFill);

    expect(run1).toEqual(run2);
  });

  it("breaks candidate score ties deterministically using ASCII code-unit order", async () => {
    const singleRoleRecipe: Recipe = {
      id: "tiebreak-recipe",
      goal: "Test code-unit tiebreak",
      ecosystem: "npm",
      roles: [
        {
          role: "client",
          purpose: "HTTP client",
          required: true,
          candidateQuery: "client-pkg",
        },
      ],
      notes: [],
    };

    const fakeFill: RecipeFillFn = async () => [
      mockComponent("npm:b-pkg", "ship", 90),
      mockComponent("npm:a-pkg", "ship", 90),
    ];

    const resolved = await resolveRecipe(singleRoleRecipe, fakeFill);
    expect(resolved.filled[0]?.component).toBe("npm:a-pkg");
  });

  it("handles throwing fill function by failing closed with 'blocked' status and honest note", async () => {
    const throwingFill: RecipeFillFn = async () => {
      throw new Error("network down: connection timed out");
    };

    const resolved = await resolveRecipe(testRecipe, throwingFill);

    expect(resolved.status).toBe("blocked");
    expect(resolved.filled[0]?.component).toBeNull();
    expect(resolved.filled[0]?.verdict).toBeNull();
    expect(resolved.filled[0]?.reason).toContain("network down");
    expect(resolved.notes.some((n) => n.includes("network down"))).toBe(true);
    expect(ResolvedRecipeSchema.parse(resolved)).toEqual(resolved);
  });

  it("handles null or non-array fill return by failing closed with 'blocked' status", async () => {
    const nullFill: RecipeFillFn = async () => null as any;

    const resolved = await resolveRecipe(testRecipe, nullFill);

    expect(resolved.status).toBe("blocked");
    expect(resolved.filled[0]?.component).toBeNull();
    expect(resolved.filled[0]?.verdict).toBeNull();
    expect(resolved.filled[0]?.reason).toContain("returned non-array result");
    expect(ResolvedRecipeSchema.parse(resolved)).toEqual(resolved);
  });

  it("skips malformed candidates safely without throwing", async () => {
    const malformedFill: RecipeFillFn = async () => [
      { id: "npm:malformed-1" } as any,
      null as any,
      { id: "npm:valid-ship", verdict: "ship", overall: 85 } as any,
    ];

    const singleRoleRecipe: Recipe = {
      id: "malformed-test",
      goal: "Test malformed candidate handling",
      ecosystem: "npm",
      roles: [
        {
          role: "worker",
          purpose: "Worker role",
          required: true,
          candidateQuery: "worker-pkg",
        },
      ],
      notes: [],
    };

    const resolved = await resolveRecipe(singleRoleRecipe, malformedFill);

    expect(resolved.status).toBe("ready");
    expect(resolved.filled[0]?.component).toBe("npm:valid-ship");
    expect(ResolvedRecipeSchema.parse(resolved)).toEqual(resolved);
  });

  it("handles empty-role recipe by adding an honest note", async () => {
    const emptyRecipe: Recipe = {
      id: "empty-recipe",
      goal: "No-op recipe",
      ecosystem: "npm",
      roles: [],
      notes: [],
    };

    const fakeFill: RecipeFillFn = async () => [];
    const resolved = await resolveRecipe(emptyRecipe, fakeFill);

    expect(resolved.status).toBe("ready");
    expect(resolved.notes).toContain("Recipe contains no roles to resolve.");
    expect(ResolvedRecipeSchema.parse(resolved)).toEqual(resolved);
  });

  it("successfully resolves all catalog recipes with a valid mock filler", async () => {
    for (const recipe of RECIPE_CATALOG) {
      const fakeFill: RecipeFillFn = async (query: string) => [
        mockComponent(`${recipe.ecosystem}:${query}`, "ship", 90),
      ];
      const resolved = await resolveRecipe(recipe, fakeFill);
      expect(resolved.status).toBe("ready");
      expect(resolved.filled.length).toBe(recipe.roles.length);
      expect(ResolvedRecipeSchema.parse(resolved)).toEqual(resolved);
    }
  });

  it("resolves PyPI recipes and correctly surfaces external prerequisites into warnings", async () => {
    const videoRecipe = getRecipe("python-video-processing");
    expect(videoRecipe).toBeDefined();

    const fakeFill: RecipeFillFn = async (query: string) => {
      if (query === "moviepy") return [mockComponent("pypi:moviepy", "ship", 95)];
      if (query === "tqdm") return [mockComponent("pypi:tqdm", "ship", 90)];
      return [];
    };

    const resolved = await resolveRecipe(videoRecipe!, fakeFill);

    expect(resolved.status).toBe("ready");
    expect(resolved.recipe.ecosystem).toBe("pypi");
    expect(resolved.filled).toHaveLength(2);
    expect(resolved.filled[0]?.component).toBe("pypi:moviepy");
    expect(resolved.filled[1]?.component).toBe("pypi:tqdm");
    expect(resolved.warnings).toContain("FFmpeg binary must be installed on the system PATH");
    expect(ResolvedRecipeSchema.parse(resolved)).toEqual(resolved);
  });

  it("surfaces external prerequisites for python-image-processing", async () => {
    const imageRecipe = getRecipe("python-image-processing");
    expect(imageRecipe).toBeDefined();

    const fakeFill: RecipeFillFn = async (query: string) => {
      if (query === "pillow") return [mockComponent("pypi:pillow", "ship", 96)];
      if (query === "piexif") return [mockComponent("pypi:piexif", "ship", 85)];
      return [];
    };

    const resolved = await resolveRecipe(imageRecipe!, fakeFill);

    expect(resolved.status).toBe("ready");
    expect(resolved.warnings).toContain("libjpeg and zlib system development libraries");
    expect(resolved.filled[0]?.component).toBe("pypi:pillow");
  });

  it("enforces fail-closed safety for PyPI recipes with unsafe candidates", async () => {
    const httpRecipe = getRecipe("python-resilient-http");
    expect(httpRecipe).toBeDefined();

    const fakeFill: RecipeFillFn = async (query: string) => {
      if (query === "httpx") {
        return [mockComponent("pypi:vulnerable-httpx", "avoid", 20)];
      }
      if (query === "tenacity") {
        return [mockComponent("pypi:tenacity", "ship", 90)];
      }
      return [];
    };

    const resolved = await resolveRecipe(httpRecipe!, fakeFill);

    expect(resolved.status).toBe("blocked");
    const requiredRole = resolved.filled.find((f) => f.role === "http-client");
    expect(requiredRole?.component).toBeNull();
    expect(requiredRole?.verdict).toBeNull();
    expect(requiredRole?.reason).toContain("'avoid'");
    expect(ResolvedRecipeSchema.parse(resolved)).toEqual(resolved);
  });
});
