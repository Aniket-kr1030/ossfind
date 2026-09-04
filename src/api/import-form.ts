import type { ApiSurface } from "../contracts/api-surface.js";
import type { IntegrationManifest } from "../contracts/integration-manifest.js";

/**
 * The manifest builder derives its import statement from package.json alone, so it
 * can only guess `import <name> from "pkg"`. When a package publishes named exports
 * but no default export, that guess throws at load time
 * (`does not provide an export named 'default'`) — exactly the fabricated-code class
 * the API layer exists to prevent. This reconciles the guess against the extracted
 * declarations, which are the only grounded evidence of what a package really exports.
 */

/** Kinds that exist at runtime. Interfaces and types vanish after compilation. */
const VALUE_KINDS = new Set<ApiSurface["exports"][number]["kind"]>(["function", "class", "const", "enum", "namespace"]);

function identifierFor(packageName: string): string {
  const words = packageName.replace(/^@/, "").split(/[/_-]+/).filter(Boolean);
  const candidate = words
    .map((word, index) => (index === 0 ? word : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`))
    .join("");
  return candidate && /^[A-Za-z_$]/.test(candidate) ? candidate : "packageApi";
}

/** Pick the binding an integrator most likely wants: the package-named export, else the first value export. */
function primaryBinding(packageName: string, surface: ApiSurface): string | null {
  const values = surface.exports.filter((entry) => VALUE_KINDS.has(entry.kind));
  if (values.length === 0) return null;
  const preferred = identifierFor(packageName).toLowerCase();
  const named = values.find((entry) => entry.name.toLowerCase() === preferred);
  return (named ?? values[0]!).name;
}

/**
 * Rewrite a manifest's import statements to match the package's verified exports.
 * Returns the manifest unchanged when there is no evidence to reconcile against —
 * an unverified guess is never silently upgraded to a verified-looking one.
 */
export function reconcileImportForm(
  packageName: string,
  manifest: IntegrationManifest,
  surface: ApiSurface,
): IntegrationManifest {
  // A truncated surface may be hiding the default export; incomplete evidence never rewrites.
  if (surface.truncated) return manifest;
  if (surface.typesAvailable === "none" || surface.exports.length === 0) return manifest;
  // `export default class X` surfaces as kind "class" named "default"; either shape counts.
  if (surface.exports.some((entry) => entry.kind === "default" || entry.name === "default")) return manifest;

  // Only ESM can fail on a missing default. `require("pkg")` returns the whole module
  // object whatever it exports, so the CJS line is left exactly as the builder wrote it.
  const { esm } = manifest.importForm;
  if (esm === null) return manifest;

  const binding = primaryBinding(packageName, surface);
  const esmForm = binding
    ? `import { ${binding} } from "${packageName}";`
    : `import * as ${identifierFor(packageName)} from "${packageName}";`;

  if (esm === esmForm) return manifest;

  return {
    ...manifest,
    importForm: { ...manifest.importForm, esm: esmForm },
    notes: [
      ...manifest.notes,
      `Import form corrected against declared exports: ${packageName} publishes no default export, so a default import fails at load time.`,
    ],
  };
}
