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

/** Validates whether a candidate object contains required fields for sorting and selection. */
function isValidCandidate(c: unknown): c is ScoredComponent {
  if (!c || typeof c !== "object") return false;
  const cand = c as Partial<ScoredComponent>;
  return (
    typeof cand.id === "string" &&
    cand.id.length > 0 &&
    typeof cand.overall === "number" &&
    !Number.isNaN(cand.overall) &&
    (cand.verdict === "ship" || cand.verdict === "caution" || cand.verdict === "avoid")
  );
}

/** Sanitizes error messages to short single-line strings without stack traces or sensitive internals. */
function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message.replace(/[\r\n\t]+/g, " ").slice(0, 120).trim() || "unknown error";
  }
  return String(err).replace(/[\r\n\t]+/g, " ").slice(0, 120).trim() || "unknown error";
}

/** Selects the best safe component for a role, prioritizing 'ship' over 'caution' and highest score. */
function selectBestCandidate(candidates: readonly unknown[]): ScoredComponent | undefined {
  const safeCandidates: ScoredComponent[] = [];

  for (const c of candidates) {
    if (isValidCandidate(c) && (c.verdict === "ship" || c.verdict === "caution")) {
      safeCandidates.push(c);
    }
  }

  if (safeCandidates.length === 0) {
    return undefined;
  }

  // Sort: 'ship' > 'caution', then highest overall, then stable code-unit comparison
  const sorted = [...safeCandidates].sort((a, b) => {
    if (a.verdict === "ship" && b.verdict !== "ship") return -1;
    if (a.verdict !== "ship" && b.verdict === "ship") return 1;
    if (b.overall !== a.overall) return b.overall - a.overall;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return sorted[0];
}

/** Resolves an individual role against candidate components. */
async function resolveRole(
  role: RecipeRole,
  fill: RecipeFillFn,
): Promise<FilledRole> {
  let candidates: unknown[];
  try {
    const raw = await fill(role.candidateQuery);
    if (!Array.isArray(raw)) {
      return {
        role: role.role,
        component: null,
        verdict: null,
        reason: `Candidate search failed for query '${role.candidateQuery}': returned non-array result.`,
      };
    }
    candidates = raw;
  } catch (err: unknown) {
    const message = sanitizeErrorMessage(err);
    return {
      role: role.role,
      component: null,
      verdict: null,
      reason: `Candidate search threw an error for query '${role.candidateQuery}': ${message}.`,
    };
  }

  const best = selectBestCandidate(candidates);

  if (best) {
    return {
      role: role.role,
      component: best.id,
      verdict: best.verdict,
      reason: `Selected '${best.id}' with '${best.verdict}' verdict (overall: ${best.overall}).`,
    };
  }

  const validCandidates = candidates.filter(isValidCandidate);
  let reason: string;
  if (validCandidates.length > 0) {
    reason = `All candidate(s) (${validCandidates.map((c) => `'${c.id}' [${c.verdict}]`).join(", ")}) were rejected due to 'avoid' safety verdict.`;
  } else if (candidates.length > 0) {
    reason = `All candidate(s) returned for query '${role.candidateQuery}' were malformed or invalid.`;
  } else {
    reason = `No candidate components returned for query '${role.candidateQuery}'.`;
  }

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
  let hasShipComponent = false;

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
    } else {
      if (res.verdict === "ship") {
        hasShipComponent = true;
      } else if (res.verdict === "caution") {
        notes.push(`Role '${role.role}' is filled with caution-grade component '${res.component}'. Review before production use.`);
      }
    }
  }

  if (recipe.roles.length === 0) {
    notes.push("Recipe contains no roles to resolve.");
  }

  let status: "ready" | "partial" | "blocked";
  if (hasUnfilledRequired) {
    status = "blocked";
  } else if (hasUnfilledOptional) {
    status = "partial";
  } else if (recipe.roles.length > 0 && !hasShipComponent) {
    status = "partial";
    notes.push("All filled components are caution-grade; recipe is marked 'partial' due to unverified security evidence.");
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

