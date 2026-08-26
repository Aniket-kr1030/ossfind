import { resolveRecipe, type RecipeFillFn } from "../recipes/resolve.js";
import { type Recipe, ResolvedRecipeSchema } from "../contracts/recipe.js";
import { type ScoredComponent } from "../contracts/scored-component.js";
import type { Result } from "./types.js";

export const id = "G12";
export const description =
  "Recipe resolution honesty: fails closed on errors/null/malformed input, rejects avoid components, and withholds unqualified ready for caution-only stacks";

function mockComponent(
  id: string,
  verdict: "ship" | "caution" | "avoid",
  overall: number = 80,
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

const sampleRecipe: Recipe = {
  id: "g12-test-recipe",
  goal: "Test recipe resolution honesty",
  ecosystem: "npm",
  roles: [
    {
      role: "core",
      purpose: "Core component",
      required: true,
      candidateQuery: "core-lib",
    },
  ],
  notes: [],
};

export async function hasRecipeResolutionHonestyFact(
  resolver: typeof resolveRecipe = resolveRecipe,
): Promise<boolean> {
  // 1. Throwing fill must fail closed into a valid blocked ResolvedRecipe (never throw)
  try {
    const resThrow = await resolver(sampleRecipe, async () => {
      throw new Error("network down: connection timeout");
    });
    ResolvedRecipeSchema.parse(resThrow);
    if (
      resThrow.status !== "blocked" ||
      resThrow.filled[0]?.component !== null ||
      resThrow.filled[0]?.verdict !== null
    ) {
      return false;
    }
  } catch {
    return false;
  }

  // 2. Null-returning fill must fail closed into a valid blocked ResolvedRecipe (never throw)
  try {
    const resNull = await resolver(sampleRecipe, async () => null as any);
    ResolvedRecipeSchema.parse(resNull);
    if (
      resNull.status !== "blocked" ||
      resNull.filled[0]?.component !== null ||
      resNull.filled[0]?.verdict !== null
    ) {
      return false;
    }
  } catch {
    return false;
  }

  // 3. Malformed candidates must be safely skipped and fail closed into blocked
  try {
    const resMalformed = await resolver(sampleRecipe, async () => [
      { id: "npm:malformed-no-verdict" } as any,
    ]);
    ResolvedRecipeSchema.parse(resMalformed);
    if (
      resMalformed.status !== "blocked" ||
      resMalformed.filled[0]?.component !== null ||
      resMalformed.filled[0]?.verdict !== null
    ) {
      return false;
    }
  } catch {
    return false;
  }

  // 4. Avoid-only candidates must NEVER be selected; role must remain blocked
  try {
    const resAvoid = await resolver(sampleRecipe, async () => [
      mockComponent("npm:unsafe-pkg", "avoid", 99),
    ]);
    ResolvedRecipeSchema.parse(resAvoid);
    if (
      resAvoid.status !== "blocked" ||
      resAvoid.filled[0]?.component !== null ||
      resAvoid.filled[0]?.verdict !== null
    ) {
      return false;
    }
  } catch {
    return false;
  }

  // 5. Caution-only stack must NOT return unqualified 'ready' status
  try {
    const resCaution = await resolver(sampleRecipe, async () => [
      mockComponent("npm:caution-pkg", "caution", 80),
    ]);
    ResolvedRecipeSchema.parse(resCaution);
    if (resCaution.status === "ready") {
      return false;
    }
    if (
      resCaution.filled[0]?.component !== "npm:caution-pkg" ||
      resCaution.filled[0]?.verdict !== "caution"
    ) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}

export async function check(): Promise<Result> {
  try {
    const ok = await hasRecipeResolutionHonestyFact();
    return ok
      ? { status: "pass" }
      : {
          status: "fail",
          message:
            "Recipe resolution honesty violated: fill failure threw, avoid candidate selected, or caution stack returned ready",
        };
  } catch (error: unknown) {
    return {
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function proveFailure(): Promise<Result> {
  // Mutant 1: Throws uncaught error on fill failure
  const mutantThrow = async (recipe: Recipe, fill: RecipeFillFn) => {
    const raw = await fill(recipe.roles[0]!.candidateQuery);
    return resolveRecipe(recipe, async () => raw);
  };
  const throwDetected = !(await hasRecipeResolutionHonestyFact(mutantThrow));

  // Mutant 2: Crashes on null fill without validation
  const mutantNull = async (recipe: Recipe, fill: RecipeFillFn) => {
    const raw = await fill(recipe.roles[0]!.candidateQuery);
    (raw as any).map((c: any) => c.id);
    return resolveRecipe(recipe, async () => raw);
  };
  const nullDetected = !(await hasRecipeResolutionHonestyFact(mutantNull));

  // Mutant 3: Grants unqualified "ready" to all-caution stack
  const mutantCautionReady = async (recipe: Recipe, fill: RecipeFillFn) => {
    const res = await resolveRecipe(recipe, fill);
    if (res.status === "partial" && res.filled.every((f) => f.component !== null)) {
      return { ...res, status: "ready" as const };
    }
    return res;
  };
  const cautionReadyDetected = !(await hasRecipeResolutionHonestyFact(mutantCautionReady));

  // Mutant 4: Falsely selects avoid candidate
  const mutantAvoidSelect = async (recipe: Recipe, fill: RecipeFillFn) => {
    const res = await resolveRecipe(recipe, fill);
    return {
      ...res,
      status: "ready" as const,
      filled: res.filled.map((f) => ({
        ...f,
        component: "npm:avoid-pkg",
        verdict: "avoid",
        reason: "Selected avoid candidate",
      })),
    };
  };
  const avoidSelectDetected = !(await hasRecipeResolutionHonestyFact(mutantAvoidSelect));

  if (throwDetected && nullDetected && cautionReadyDetected && avoidSelectDetected) {
    return { status: "detected" };
  }

  return {
    status: "undetected",
    message: `G12 mutants were not all detected: throw=${throwDetected}, null=${nullDetected}, cautionReady=${cautionReadyDetected}, avoidSelect=${avoidSelectDetected}`,
  };
}
