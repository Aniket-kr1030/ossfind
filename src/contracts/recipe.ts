import { z } from "zod";

/** Individual role specification within a composition recipe. */
export const RecipeRoleSchema = z.object({
  role: z.string().min(1),
  purpose: z.string().min(1),
  required: z.boolean(),
  candidateQuery: z.string().min(1),
  externalPrerequisite: z.string().min(1).optional(),
});

export type RecipeRole = z.infer<typeof RecipeRoleSchema>;

/** Composition recipe specifying roles and prerequisites for achieving a multi-component goal. */
export const RecipeSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  ecosystem: z.string().min(1),
  roles: z.array(RecipeRoleSchema),
  notes: z.array(z.string()),
});

export type Recipe = z.infer<typeof RecipeSchema>;

/** A role that has been resolved (filled or unfilled). */
export const FilledRoleSchema = z.object({
  role: z.string().min(1),
  component: z.string().nullable(),
  verdict: z.string().nullable(),
  reason: z.string().min(1),
});

export type FilledRole = z.infer<typeof FilledRoleSchema>;

/** Fully resolved recipe with safety checks, filled roles, and external prerequisite warnings. */
export const ResolvedRecipeSchema = z.object({
  recipe: RecipeSchema,
  status: z.enum(["ready", "partial", "blocked"]),
  filled: z.array(FilledRoleSchema),
  warnings: z.array(z.string()),
  notes: z.array(z.string()),
});

export type ResolvedRecipe = z.infer<typeof ResolvedRecipeSchema>;
