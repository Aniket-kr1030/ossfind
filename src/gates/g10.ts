import { buildScaffold } from "../api/scaffold.js";
import type { ApiSurface } from "../contracts/api-surface.js";
import type { IntegrationManifest } from "../contracts/integration-manifest.js";
import { ScaffoldSchema, type Scaffold } from "../contracts/scaffold.js";
import type { Result } from "./types.js";

export const id = "G10";
export const description =
  "Scaffold snippet integrity: provenance, syntax, and binding safety";

function baseJsSurface(overrides?: Partial<ApiSurface>): ApiSurface {
  return {
    id: "npm:my-pkg",
    version: "1.0.0",
    typesAvailable: "own",
    typesSource: "index.d.ts",
    exports: [{ name: "run", kind: "function", signature: "run(): void" }],
    truncated: false,
    notes: [],
    ...overrides,
  };
}

function baseJsManifest(overrides?: Partial<IntegrationManifest>): IntegrationManifest {
  return {
    id: "npm:my-pkg",
    version: "1.0.0",
    install: { command: "npm install my-pkg" },
    importForm: {
      moduleType: "esm",
      esm: 'import myPkg from "my-pkg";',
      cjs: null,
      typesPackage: null,
    },
    runtime: { engines: {}, os: null, cpu: null },
    peerDependencies: {},
    prerequisites: [],
    hasInstallScript: false,
    notes: [],
    ...overrides,
  };
}

function basePySurface(overrides?: Partial<ApiSurface>): ApiSurface {
  return {
    id: "pypi:my-py-pkg",
    version: "1.0.0",
    typesAvailable: "own",
    typesSource: "my_py_pkg/__init__.pyi",
    exports: [{ name: "safe_load", kind: "function", signature: "safe_load(stream: Any) -> Any" }],
    truncated: false,
    notes: [],
    ...overrides,
  };
}

function basePyManifest(overrides?: Partial<IntegrationManifest>): IntegrationManifest {
  return {
    id: "pypi:my-py-pkg",
    version: "1.0.0",
    install: { command: "pip install my-py-pkg" },
    importForm: {
      moduleType: "unknown",
      esm: null,
      cjs: null,
      typesPackage: null,
      python: {
        importName: "my_py_pkg",
        statements: ["import my_py_pkg"],
        confidence: "verified",
        evidence: "verified",
      },
    },
    runtime: { engines: {}, os: null, cpu: null },
    peerDependencies: {},
    prerequisites: [],
    hasInstallScript: false,
    notes: [],
    ...overrides,
  };
}

export function hasScaffoldIntegrityFact(
  generator: typeof buildScaffold = buildScaffold,
): boolean {
  // 1. Semicolon injection attack must degrade to import-only
  const injectedSurface = baseJsSurface({
    exports: [
      {
        name: "foo; globalThis.pwn = 1; //",
        kind: "function",
        signature: "foo()",
      },
    ],
  });
  const injectedRes = generator(injectedSurface, baseJsManifest());
  if (injectedRes.confidence === "verified-signatures" || injectedRes.snippet !== null) {
    return false;
  }

  // 2. Newline signature injection must degrade to import-only
  const sigNewlineSurface = baseJsSurface({
    exports: [
      {
        name: "run",
        kind: "function",
        signature: "run(): void\nprocess.exit()",
      },
    ],
  });
  const sigNewlineRes = generator(sigNewlineSurface, baseJsManifest());
  if (sigNewlineRes.confidence === "verified-signatures" || sigNewlineRes.snippet !== null) {
    return false;
  }

  // 3. Declaration mismatch and anonymous signature must degrade to import-only
  const anonSurface = baseJsSurface({
    exports: [{ name: "run", kind: "function", signature: "() => void" }],
  });
  const anonRes = generator(anonSurface, baseJsManifest());
  if (anonRes.confidence === "verified-signatures" || anonRes.snippet !== null) {
    return false;
  }

  const mismatchSurface = baseJsSurface({
    exports: [{ name: "run", kind: "function", signature: "not_run() => void" }],
  });
  const mismatchRes = generator(mismatchSurface, baseJsManifest());
  if (mismatchRes.confidence === "verified-signatures" || mismatchRes.snippet !== null) {
    return false;
  }

  // 4. Malformed Promise< must degrade to import-only (never await)
  const malformedAwaitSurface = baseJsSurface({
    exports: [{ name: "run", kind: "function", signature: "run(): Promise<" }],
  });
  const malformedAwaitRes = generator(malformedAwaitSurface, baseJsManifest());
  if (malformedAwaitRes.confidence === "verified-signatures" || malformedAwaitRes.snippet !== null) {
    return false;
  }

  // 5. Named ESM import must call the local binding, NOT a synthesized namespace
  const namedEsmManifest = baseJsManifest({
    importForm: {
      moduleType: "esm",
      esm: 'import { get } from "my-pkg";',
      cjs: null,
      typesPackage: null,
    },
  });
  const namedEsmSurface = baseJsSurface({
    exports: [{ name: "get", kind: "function", signature: "get(): void" }],
  });
  const namedEsmRes = generator(namedEsmSurface, namedEsmManifest);
  if (namedEsmRes.confidence !== "verified-signatures" || !namedEsmRes.snippet) {
    return false;
  }
  if (!namedEsmRes.snippet.includes("get();") || namedEsmRes.snippet.includes("myPkg.get")) {
    return false;
  }

  // 6. CommonJS with async return must not emit top-level await
  const cjsManifest = baseJsManifest({
    importForm: {
      moduleType: "cjs",
      esm: null,
      cjs: 'const myPkg = require("my-pkg");',
      typesPackage: null,
    },
  });
  const asyncCjsSurface = baseJsSurface({
    exports: [{ name: "get", kind: "function", signature: "get(): Promise<string>" }],
  });
  const cjsRes = generator(asyncCjsSurface, cjsManifest);
  if (cjsRes.confidence !== "verified-signatures" || !cjsRes.snippet) {
    return false;
  }
  if (/^const \w+ = await/m.test(cjsRes.snippet)) {
    return false;
  }
  if (!cjsRes.snippet.includes("(async () => {")) {
    return false;
  }

  // 7. Dual module must emit ONE coherent import form, not both
  const dualManifest = baseJsManifest({
    importForm: {
      moduleType: "dual",
      esm: 'import myPkg from "my-pkg";',
      cjs: 'const myPkg = require("my-pkg");',
      typesPackage: null,
    },
  });
  const dualRes = generator(baseJsSurface(), dualManifest);
  if (dualRes.imports.length !== 1) {
    return false;
  }

  // 8. Non-callable kinds must degrade to import-only
  for (const kind of ["interface", "type", "namespace", "enum"] as const) {
    const nonCallableSurface = baseJsSurface({
      exports: [{ name: "Ghost", kind, signature: "Ghost(): void" }],
    });
    const nonCallableRes = generator(nonCallableSurface, baseJsManifest());
    if (nonCallableRes.confidence === "verified-signatures" || nonCallableRes.snippet !== null) {
      return false;
    }
  }

  // 9. JS self/cls parameters must not be emitted as call arguments
  const selfParamSurface = baseJsSurface({
    exports: [{ name: "run", kind: "function", signature: "run(self: Thing, cls: Other): void" }],
  });
  const selfParamRes = generator(selfParamSurface, baseJsManifest());
  if (selfParamRes.confidence === "verified-signatures") {
    const callLine = selfParamRes.snippet?.split("\n").slice(1).join("\n") ?? "";
    if (callLine.includes("(self") || callLine.includes("(cls") || callLine.includes("self,")) {
      return false;
    }
  }

  // 10. Valid baseline checks
  const pyBaseline = generator(basePySurface(), basePyManifest());
  if (pyBaseline.confidence !== "verified-signatures" || !pyBaseline.snippet?.includes("my_py_pkg.safe_load(stream)")) {
    return false;
  }

  return true;
}

export async function check(): Promise<Result> {
  try {
    return hasScaffoldIntegrityFact()
      ? { status: "pass" }
      : {
          status: "fail",
          message:
            "Scaffold snippet integrity violated: code injection possible, unbound call binding, invalid await in CJS, or unverified signatures accepted",
        };
  } catch (error: unknown) {
    return { status: "fail", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function proveFailure(): Promise<Result> {
  // Mutant 1: Export injection mutant (the blocker bug: interpolates raw export name)
  const mutantInjection: typeof buildScaffold = (surface, manifest, opts) => {
    const first = surface.exports[0];
    if (first && first.name.includes(";")) {
      return ScaffoldSchema.parse({
        component: manifest.id,
        install: manifest.install.command,
        imports: manifest.importForm.esm ? [manifest.importForm.esm] : [],
        snippet: `// Verified signature: ${first.signature}\nconst result = pkg.${first.name}();`,
        basedOn: [{ name: first.name, signature: first.signature }],
        confidence: "verified-signatures",
        notes: [],
        warnings: [],
      });
    }
    return buildScaffold(surface, manifest, opts);
  };
  const injectionDetected = !hasScaffoldIntegrityFact(mutantInjection);

  // Mutant 2: Unbound named ESM import mutant (the blocker bug: fabricating myPkg.get instead of get)
  const mutantUnboundNamedEsm: typeof buildScaffold = (surface, manifest, opts) => {
    if (manifest.importForm.esm?.includes("{ get }")) {
      return ScaffoldSchema.parse({
        component: manifest.id,
        install: manifest.install.command,
        imports: [manifest.importForm.esm],
        snippet: `// Verified signature: get(): void\nmyPkg.get();`,
        basedOn: [{ name: "get", signature: "get(): void" }],
        confidence: "verified-signatures",
        notes: [],
        warnings: [],
      });
    }
    return buildScaffold(surface, manifest, opts);
  };
  const unboundNamedEsmDetected = !hasScaffoldIntegrityFact(mutantUnboundNamedEsm);

  // Mutant 3: Malformed await mutant (the blocker bug: emits await for unclosed Promise<)
  const mutantMalformedAwait: typeof buildScaffold = (surface, manifest, opts) => {
    const first = surface.exports[0];
    if (first?.signature?.includes("Promise<")) {
      return ScaffoldSchema.parse({
        component: manifest.id,
        install: manifest.install.command,
        imports: manifest.importForm.esm ? [manifest.importForm.esm] : [],
        snippet: `// Verified signature: ${first.signature}\nconst result = await myPkg.run();`,
        basedOn: [{ name: first.name, signature: first.signature }],
        confidence: "verified-signatures",
        notes: [],
        warnings: [],
      });
    }
    return buildScaffold(surface, manifest, opts);
  };
  const malformedAwaitDetected = !hasScaffoldIntegrityFact(mutantMalformedAwait);

  // Mutant 4: Top-level await in CommonJS mutant
  const mutantTopLevelAwaitCjs: typeof buildScaffold = (surface, manifest, opts) => {
    if (manifest.importForm.moduleType === "cjs") {
      return ScaffoldSchema.parse({
        component: manifest.id,
        install: manifest.install.command,
        imports: manifest.importForm.cjs ? [manifest.importForm.cjs] : [],
        snippet: `// Verified signature: get(): Promise<string>\nconst response = await myPkg.get();`,
        basedOn: [{ name: "get", signature: "get(): Promise<string>" }],
        confidence: "verified-signatures",
        notes: [],
        warnings: [],
      });
    }
    return buildScaffold(surface, manifest, opts);
  };
  const topLevelAwaitCjsDetected = !hasScaffoldIntegrityFact(mutantTopLevelAwaitCjs);

  // Mutant 5: Dual imports combined into one scaffold mutant
  const mutantDualImports: typeof buildScaffold = (surface, manifest, opts) => {
    if (manifest.importForm.moduleType === "dual") {
      return ScaffoldSchema.parse({
        component: manifest.id,
        install: manifest.install.command,
        imports: [manifest.importForm.esm!, manifest.importForm.cjs!],
        snippet: `// Verified signature: run(): void\nmyPkg.run();`,
        basedOn: [{ name: "run", signature: "run(): void" }],
        confidence: "verified-signatures",
        notes: [],
        warnings: [],
      });
    }
    return buildScaffold(surface, manifest, opts);
  };
  const dualImportsDetected = !hasScaffoldIntegrityFact(mutantDualImports);

  // Mutant 6: Non-callable kind verified mutant
  const mutantNonCallableKind: typeof buildScaffold = (surface, manifest, opts) => {
    const first = surface.exports[0];
    if (first && (first.kind === "interface" || first.kind === "type")) {
      return ScaffoldSchema.parse({
        component: manifest.id,
        install: manifest.install.command,
        imports: manifest.importForm.esm ? [manifest.importForm.esm] : [],
        snippet: `// Verified signature: ${first.signature}\nmyPkg.${first.name}();`,
        basedOn: [{ name: first.name, signature: first.signature }],
        confidence: "verified-signatures",
        notes: [],
        warnings: [],
      });
    }
    return buildScaffold(surface, manifest, opts);
  };
  const nonCallableKindDetected = !hasScaffoldIntegrityFact(mutantNonCallableKind);

  if (
    injectionDetected &&
    unboundNamedEsmDetected &&
    malformedAwaitDetected &&
    topLevelAwaitCjsDetected &&
    dualImportsDetected &&
    nonCallableKindDetected
  ) {
    return { status: "detected" };
  }

  return {
    status: "undetected",
    message: `G10 mutants were not all detected: injection=${injectionDetected}, unboundNamedEsm=${unboundNamedEsmDetected}, malformedAwait=${malformedAwaitDetected}, topLevelAwaitCjs=${topLevelAwaitCjsDetected}, dualImports=${dualImportsDetected}, nonCallableKind=${nonCallableKindDetected}`,
  };
}
