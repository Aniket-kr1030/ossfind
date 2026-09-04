import { reconcileImportForm } from "../api/import-form.js";
import type { ApiSurface } from "../contracts/api-surface.js";
import type { IntegrationManifest } from "../contracts/integration-manifest.js";
import type { Result } from "./types.js";

export const id = "G15";
export const description = "Suggested ESM import matches the package's declared exports";

/**
 * Spawned by a defect found while building a real project against ossfind:
 * `inspect_component("marked")` suggested `import marked from "marked"`, guessed from
 * the package name alone. marked publishes no default export, so that line throws
 * `does not provide an export named 'default'` before a single statement runs — the
 * exact fabricated-code failure the verified-API layer exists to prevent.
 */

type Reconciler = typeof reconcileImportForm;

function surface(over: Partial<ApiSurface> = {}): ApiSurface {
  return {
    id: "npm:fixture",
    version: "1.0.0",
    typesAvailable: "own",
    typesSource: "fixture",
    exports: [],
    truncated: false,
    notes: [],
    ...over,
  };
}

function manifest(esm: string | null, cjs: string | null): IntegrationManifest {
  return {
    id: "npm:fixture",
    version: "1.0.0",
    install: { command: "npm install fixture" },
    importForm: { moduleType: esm && cjs ? "dual" : esm ? "esm" : "cjs", esm, cjs, typesPackage: null },
    runtime: { engines: {}, os: null, cpu: null },
    peerDependencies: {},
    prerequisites: [],
    hasInstallScript: false,
    notes: [],
  };
}

export function hasGroundedImportFormFact(reconcile: Reconciler = reconcileImportForm): boolean {
  // 1. Named-only exports: the default guess must be replaced by the real binding.
  const namedOnly = reconcile("marked", manifest('import marked from "marked";', null), surface({
    exports: [
      { name: "Lexer", kind: "class", signature: null },
      { name: "marked", kind: "function", signature: "marked(src:string): string" },
      { name: "MarkedOptions", kind: "interface", signature: null },
    ],
  }));
  if (namedOnly.importForm.esm !== 'import { marked } from "marked";') return false;
  if (!namedOnly.notes.some((note) => note.includes("no default export"))) return false;

  // 2. A real default export is left alone, however the extractor spelled it.
  for (const entry of [
    { name: "default", kind: "class" as const, signature: null },
    { name: "default", kind: "default" as const, signature: null },
  ]) {
    const withDefault = reconcile("minisearch", manifest('import minisearch from "minisearch";', null), surface({
      exports: [entry, { name: "SearchOptions", kind: "interface", signature: null }],
    }));
    if (withDefault.importForm.esm !== 'import minisearch from "minisearch";') return false;
    if (withDefault.notes.length !== 0) return false;
  }

  // 3. CJS require() takes the whole module object; that line is never rewritten.
  const cjsOnly = reconcile("yaml", manifest(null, 'const yaml = require("yaml");'), surface({
    exports: [{ name: "Alias", kind: "class", signature: null }],
  }));
  if (cjsOnly.importForm.cjs !== 'const yaml = require("yaml");') return false;

  // 4. Incomplete evidence never rewrites: a truncated or untyped surface is left as found.
  for (const unusable of [surface({ truncated: true, exports: [{ name: "a", kind: "function", signature: null }] }),
                          surface({ typesAvailable: "none" }),
                          surface({ exports: [] })]) {
    const untouched = reconcile("pkg", manifest('import pkg from "pkg";', null), unusable);
    if (untouched.importForm.esm !== 'import pkg from "pkg";' || untouched.notes.length !== 0) return false;
  }

  // 5. Type-only exports vanish at runtime, so they can never become the binding.
  const typesOnly = reconcile("shapes", manifest('import shapes from "shapes";', null), surface({
    exports: [{ name: "Shape", kind: "interface", signature: null }, { name: "Kind", kind: "type", signature: null }],
  }));
  return typesOnly.importForm.esm === 'import * as shapes from "shapes";';
}

/** Mutant restoring the original defect: derive the import from the package name alone. */
const nameOnlyReconciler: Reconciler = (_packageName, builtManifest) => builtManifest;

export async function check(): Promise<Result> {
  try {
    return hasGroundedImportFormFact()
      ? { status: "pass" }
      : { status: "fail", message: "Suggested import form did not match the declared exports" };
  } catch (error: unknown) {
    return { status: "fail", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function proveFailure(): Promise<Result> {
  try {
    return !hasGroundedImportFormFact(nameOnlyReconciler)
      ? { status: "detected" }
      : { status: "undetected", message: "G15 did not detect an import form guessed from the package name" };
  } catch (error: unknown) {
    return { status: "detected", message: error instanceof Error ? error.message : String(error) };
  }
}
