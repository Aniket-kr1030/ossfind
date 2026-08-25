import { type Recipe } from "../contracts/recipe.js";
import { RECIPE_CATALOG } from "./catalog.js";

export { RECIPE_CATALOG } from "./catalog.js";
export { resolveRecipe, type RecipeFillFn } from "./resolve.js";
export {
  type Recipe,
  type RecipeRole,
  type FilledRole,
  type ResolvedRecipe,
  RecipeSchema,
  RecipeRoleSchema,
  FilledRoleSchema,
  ResolvedRecipeSchema,
} from "../contracts/recipe.js";

/** Returns all recipes available in the curated catalog. */
export function listRecipes(): readonly Recipe[] {
  return RECIPE_CATALOG;
}

/** Looks up a catalog recipe by unique identifier. */
export function getRecipe(id: string): Recipe | undefined {
  return RECIPE_CATALOG.find((r) => r.id === id);
}
