import { type ScoredComponent } from "../contracts/scored-component.js";
import {
  type Recipe,
  type RecipeRole,
  type FilledRole,
  type ResolvedRecipe,
  ResolvedRecipeSchema,
} from "../contracts/recipe.js";

/** Injectable search/fill function type. */
export type RecipeFillFn = (query: string) => Promise<ScoredComponent[]>;

/** Selects the best safe component for a role, prioritizing 'ship' over 'caution' and highest score. */
function selectBestCandidate(candidates: readonly ScoredComponent[]): ScoredComponent | undefined {
  const safeCandidates = candidates.filter(
    (c) => c.verdict === "ship" || c.verdict === "caution",
  );

  if (safeCandidates.length === 0) {
    return undefined;
  }

  // Sort: 'ship' > 'caution', then highest overall, then stable id
  const sorted = [...safeCandidates].sort((a, b) => {
    if (a.verdict === "ship" && b.verdict !== "ship") return -1;
    if (a.verdict !== "ship" && b.verdict === "ship") return 1;
    if (b.overall !== a.overall) return b.overall - a.overall;
    return a.id.localeCompare(b.id);
  });

  return sorted[0];
}

/** Resolves an individual role against candidate components. */
async function resolveRole(
  role: RecipeRole,
  fill: RecipeFillFn,
): Promise<FilledRole> {
  const candidates = await fill(role.candidateQuery);
  const best = selectBestCandidate(candidates);

  if (best) {
    return {
      role: role.role,
      component: best.id,
      verdict: best.verdict,
      reason: `Selected '${best.id}' with '${best.verdict}' verdict (overall: ${best.overall}).`,
    };
  }

  const reason =
    candidates.length > 0
      ? `All candidate(s) (${candidates.map((c) => `'${c.id}' [${c.verdict}]`).join(", ")}) were rejected due to 'avoid' safety verdict.`
      : `No candidate components returned for query '${role.candidateQuery}'.`;

  return {
    role: role.role,
    component: null,
    verdict: null,
    reason,
  };
}

/**
 * Resolves a composition recipe by filling each required and optional role
 * using the provided candidate filler function.
 *
 * Enforces the fail-closed rule: a recipe is 'blocked' if any required role cannot
 * be safely filled. Unsafe ('avoid') components are never selected.
 *
 * Pure function with zero I/O.
 */
export async function resolveRecipe(
  recipe: Recipe,
  fill: RecipeFillFn,
): Promise<ResolvedRecipe> {
  const filled: FilledRole[] = [];
  const warnings: string[] = [];
  const notes: string[] = [...recipe.notes];

  // 1. Surface all external prerequisites from roles into warnings
  for (const role of recipe.roles) {
    if (role.externalPrerequisite && role.externalPrerequisite.trim()) {
      warnings.push(role.externalPrerequisite.trim());
    }
  }

  // 2. Resolve each role sequentially for deterministic execution
  for (const role of recipe.roles) {
    const filledRole = await resolveRole(role, fill);
    filled.push(filledRole);
  }

  // 3. Determine status and record relevant safety notes
  let hasUnfilledRequired = false;
  let hasUnfilledOptional = false;

  for (let i = 0; i < recipe.roles.length; i++) {
    const role = recipe.roles[i]!;
    const res = filled[i]!;

    if (res.component === null) {
      if (role.required) {
        hasUnfilledRequired = true;
        notes.push(`Required role '${role.role}' cannot be safely filled: ${res.reason}`);
      } else {
        hasUnfilledOptional = true;
        notes.push(`Optional role '${role.role}' is unfilled: ${res.reason}`);
      }
    } else if (res.verdict === "caution") {
      notes.push(`Role '${role.role}' is filled with caution-grade component '${res.component}'. Review before production use.`);
    }
  }

  let status: "ready" | "partial" | "blocked";
  if (hasUnfilledRequired) {
    status = "blocked";
  } else if (hasUnfilledOptional) {
    status = "partial";
  } else {
    status = "ready";
  }

  const result: ResolvedRecipe = {
    recipe,
    status,
    filled,
    warnings,
    notes,
  };

  return ResolvedRecipeSchema.parse(result);
}
