import { type ApiSurface } from "../contracts/api-surface.js";
import { type IntegrationManifest } from "../contracts/integration-manifest.js";
import { ScaffoldSchema, type Scaffold } from "../contracts/scaffold.js";

type ApiExport = ApiSurface["exports"][number];

const JS_RESERVED_WORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally",
  "for", "function", "if", "import", "in", "instanceof", "new", "null",
  "return", "super", "switch", "this", "throw", "true", "try", "typeof",
  "var", "void", "while", "with", "yield", "await", "async",
]);

function extractPackageRawName(id: string): string {
  return id.replace(/^[a-z]+:/, "");
}

function extractImportIdentifier(manifest: IntegrationManifest): string {
  const esmMatch = manifest.importForm.esm?.match(/import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from/);
  if (esmMatch?.[1]) return esmMatch[1];
  const cjsMatch = manifest.importForm.cjs?.match(/(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/);
  if (cjsMatch?.[1]) return cjsMatch[1];

  const rawName = extractPackageRawName(manifest.id).replace(/^@/, "");
  const words = rawName.split(/[\/_-]+/).filter(Boolean);
  const candidate = words.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join("");
  return candidate && /^[A-Za-z_$]/.test(candidate) ? candidate : "pkg";
}

function splitTopLevelCommas(str: string): string[] {
  const result: string[] = [];
  let current = "";
  let depthParen = 0;
  let depthAngle = 0;
  let depthCurly = 0;
  let depthSquare = 0;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === "(") depthParen++;
    else if (char === ")") depthParen--;
    else if (char === "<") depthAngle++;
    else if (char === ">") depthAngle--;
    else if (char === "{") depthCurly++;
    else if (char === "}") depthCurly--;
    else if (char === "[") depthSquare++;
    else if (char === "]") depthSquare--;

    if (char === "," && depthParen === 0 && depthAngle === 0 && depthCurly === 0 && depthSquare === 0) {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function sanitizeParamName(paramStr: string, index: number): string {
  let head = paramStr.split(/[:=]/)[0]?.trim() || "";
  head = head.replace(/^\.\.\./, "").replace(/\?$/, "").trim();

  if (head.startsWith("{") || head.startsWith("[")) {
    return "options";
  }

  head = head.replace(/[^a-zA-Z0-9_$]/g, "");

  if (!head || JS_RESERVED_WORDS.has(head)) {
    return head ? `${head}Param` : `arg${index}`;
  }

  return head;
}

function parseSignatureParams(signature: string): { params: string[]; returnType: string | null } | null {
  let startIdx = 0;

  while (startIdx < signature.length && /[a-zA-Z0-9_$]/.test(signature[startIdx] ?? "")) {
    startIdx++;
  }
  while (startIdx < signature.length && /\s/.test(signature[startIdx] ?? "")) {
    startIdx++;
  }

  if (signature[startIdx] === "<") {
    let angleDepth = 0;
    while (startIdx < signature.length) {
      if (signature[startIdx] === "<") angleDepth++;
      else if (signature[startIdx] === ">") {
        angleDepth--;
        if (angleDepth === 0) {
          startIdx++;
          break;
        }
      }
      startIdx++;
    }
  }

  while (startIdx < signature.length && /\s/.test(signature[startIdx] ?? "")) {
    startIdx++;
  }

  if (signature[startIdx] !== "(") return null;
  const parenStart = startIdx;

  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < signature.length; i++) {
    if (signature[i] === "(") parenDepth++;
    else if (signature[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        parenEnd = i;
        break;
      }
    }
  }

  if (parenEnd === -1) return null;

  const paramsText = signature.slice(parenStart + 1, parenEnd).trim();
  const rawParams = paramsText ? splitTopLevelCommas(paramsText) : [];
  const params = rawParams.map((p, idx) => sanitizeParamName(p, idx));

  const remainder = signature.slice(parenEnd + 1).trim();
  let returnType: string | null = null;
  if (remainder.startsWith(":")) {
    returnType = remainder.slice(1).trim();
  } else if (remainder.startsWith("=>")) {
    returnType = remainder.slice(2).trim();
  }

  return { params, returnType };
}

interface ParsedPythonSignature {
  args: string[];
  returnType: string | null;
  isAsync: boolean;
}

/**
 * Parses a Python declaration sufficiently to emit a call whose placeholders
 * are all taken from its verified parameter list. This deliberately does not
 * synthesize names for unparseable Python parameters.
 */
function parsePythonSignature(signature: string): ParsedPythonSignature | null {
  const source = signature.trim();
  const asyncMatch = /^(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(source);
  const bareMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(source);
  const match = asyncMatch ?? bareMatch;
  if (!match) return null;

  const parenStart = source.indexOf("(", match.index);
  if (parenStart < 0) return null;

  let parenDepth = 0;
  let parenEnd = -1;
  for (let index = parenStart; index < source.length; index++) {
    if (source[index] === "(") parenDepth++;
    else if (source[index] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        parenEnd = index;
        break;
      }
    }
  }
  if (parenEnd < 0) return null;

  let keywordOnly = false;
  const args: string[] = [];
  const paramsText = source.slice(parenStart + 1, parenEnd).trim();
  for (const rawParam of paramsText ? splitTopLevelCommas(paramsText) : []) {
    const param = rawParam.trim();
    if (param === "/") continue;
    if (param === "*") {
      keywordOnly = true;
      continue;
    }

    const prefix = param.startsWith("**") ? "**" : param.startsWith("*") ? "*" : "";
    const name = param.slice(prefix.length).split(/[:=]/)[0]?.trim();
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;

    if (prefix) {
      args.push(`${prefix}${name}`);
    } else {
      args.push(keywordOnly ? `${name}=${name}` : name);
    }
  }

  const remainder = source.slice(parenEnd + 1).trim();
  const returnType = remainder.startsWith("->") ? remainder.slice(2).trim() || null : null;
  return { args, returnType, isAsync: Boolean(asyncMatch?.[1]) };
}

function isPythonComponent(surface: ApiSurface, manifest: IntegrationManifest): boolean {
  return (manifest.id || surface.id).startsWith("pypi:");
}

/**
 * Returns a callable Python module name only when its exact import statement
 * was verified by the Python manifest. There is intentionally no package-name
 * fallback: inventing one could emit a broken or fabricated API call.
 */
function extractPythonImportIdentifier(manifest: IntegrationManifest): string | null {
  const python = manifest.importForm.python;
  if (!python?.importName) return null;
  const escaped = python.importName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const directImport = new RegExp(`^import\\s+${escaped}\\s*$`);
  return python.statements.some((statement) => directImport.test(statement.trim()))
    ? python.importName
    : null;
}

/**
 * Determines whether an API export has a genuinely callable signature with a parameter list.
 */
export function hasCallableSignature(exportItem: ApiExport): boolean {
  if (!exportItem.signature) return false;
  return parseSignatureParams(exportItem.signature) !== null || parsePythonSignature(exportItem.signature) !== null;
}

/**
 * Selects the first callable export walking preference order:
 * preferExport -> default -> package name match -> first function/class -> any callable.
 */
function selectCallableExport(
  surface: ApiSurface,
  manifest: IntegrationManifest,
  preferExport?: string,
): ApiExport | undefined {
  if (surface.exports.length === 0) return undefined;

  if (preferExport) {
    const preferred = surface.exports.find((e) => e.name === preferExport && hasCallableSignature(e));
    if (preferred) return preferred;
  }

  const defaultExport = surface.exports.find(
    (e) => (e.name === "default" || e.kind === "default") && hasCallableSignature(e),
  );
  if (defaultExport) return defaultExport;

  const rawPkgName = extractPackageRawName(manifest.id || surface.id);
  const unScopedName = rawPkgName.replace(/^@[^\/]+\//, "");
  const nameMatch = surface.exports.find((e) => {
    const lower = e.name.toLowerCase();
    return (lower === rawPkgName.toLowerCase() || lower === unScopedName.toLowerCase()) && hasCallableSignature(e);
  });
  if (nameMatch) return nameMatch;

  const fnOrClass = surface.exports.find(
    (e) => (e.kind === "function" || e.kind === "class") && hasCallableSignature(e),
  );
  if (fnOrClass) return fnOrClass;

  return surface.exports.find(hasCallableSignature);
}

/**
 * Selects candidate export irrespective of callability for fallback reporting.
 */
function selectFallbackCandidate(
  surface: ApiSurface,
  manifest: IntegrationManifest,
  preferExport?: string,
): ApiExport | undefined {
  if (surface.exports.length === 0) return undefined;

  if (preferExport) {
    const preferred = surface.exports.find((e) => e.name === preferExport);
    if (preferred) return preferred;
  }

  const defaultExport = surface.exports.find((e) => e.name === "default" || e.kind === "default");
  if (defaultExport) return defaultExport;

  const rawPkgName = extractPackageRawName(manifest.id || surface.id);
  const unScopedName = rawPkgName.replace(/^@[^\/]+\//, "");
  const nameMatch = surface.exports.find((e) => {
    const lower = e.name.toLowerCase();
    return lower === rawPkgName.toLowerCase() || lower === unScopedName.toLowerCase();
  });
  if (nameMatch) return nameMatch;

  const fnOrClass = surface.exports.find((e) => e.kind === "function" || e.kind === "class");
  if (fnOrClass) return fnOrClass;

  return surface.exports[0];
}

function generateSnippet(
  exportItem: ApiExport,
  manifest: IntegrationManifest,
): string | null {
  if (!exportItem.signature) return null;

  const parsed = parseSignatureParams(exportItem.signature);
  if (!parsed) return null;

  const { params, returnType } = parsed;
  const importId = extractImportIdentifier(manifest);
  const exportName = exportItem.name;

  const isAsync = returnType ? /Promise(?:Like)?\s*</.test(returnType) || returnType.trim() === "Promise" : false;
  const isVoid = returnType ? returnType.trim() === "void" || returnType.trim() === "never" : false;
  const isClass = exportItem.kind === "class";

  const argsStr = params.join(", ");

  let callExpr = "";
  if (exportName === "default" || exportItem.kind === "default" || exportName === importId) {
    callExpr = isClass ? `new ${importId}(${argsStr})` : `${importId}(${argsStr})`;
  } else {
    callExpr = isClass ? `new ${importId}.${exportName}(${argsStr})` : `${importId}.${exportName}(${argsStr})`;
  }

  if (isAsync) {
    callExpr = `await ${callExpr}`;
  }

  let statement = "";
  if (isVoid) {
    statement = `${callExpr};`;
  } else {
    const varName = (returnType && /Response/.test(returnType)) || exportName === "get" ? "response" : "result";
    statement = `const ${varName} = ${callExpr};`;
  }

  return `// Verified signature: ${exportItem.signature}\n${statement}`;
}

function generatePythonSnippet(
  exportItem: ApiExport,
  manifest: IntegrationManifest,
): string | null {
  if (!exportItem.signature) return null;

  const parsed = parsePythonSignature(exportItem.signature);
  const importId = extractPythonImportIdentifier(manifest);
  if (!parsed || !importId) return null;

  // exportItem is selected exclusively from surface.exports. The module name
  // comes exclusively from importForm.python's verified import statement.
  const callExpr = `${importId}.${exportItem.name}(${parsed.args.join(", ")})`;
  const awaitedCall = parsed.isAsync ? `await ${callExpr}` : callExpr;
  const isNone = parsed.returnType === "None" || parsed.returnType === "NoReturn" || parsed.returnType === "Never";
  const statement = isNone ? awaitedCall : `result = ${awaitedCall}`;

  return `# Verified signature: ${exportItem.signature}\n${statement}`;
}

/**
 * Builds a ready-to-apply integration scaffold for an AI agent.
 * Pure function with zero I/O.
 */
export function buildScaffold(
  surface: ApiSurface,
  manifest: IntegrationManifest,
  opts?: { preferExport?: string },
): Scaffold {
  const component = manifest.id || surface.id;
  const python = isPythonComponent(surface, manifest);

  let install = manifest.install.command;
  if (manifest.importForm.typesPackage) {
    install += python
      ? `\npip install ${manifest.importForm.typesPackage}`
      : `\nnpm install -D ${manifest.importForm.typesPackage}`;
  }

  const imports: string[] = [];
  if (python) {
    imports.push(...(manifest.importForm.python?.statements ?? []));
  } else {
    const { moduleType, esm, cjs } = manifest.importForm;
    if (moduleType === "esm") {
      if (esm) imports.push(esm);
    } else if (moduleType === "cjs") {
      if (cjs) imports.push(cjs);
    } else if (moduleType === "dual") {
      if (esm) imports.push(esm);
      if (cjs) imports.push(cjs);
    } else {
      if (esm) imports.push(esm);
      if (cjs) imports.push(cjs);
    }
  }

  const warnings: string[] = [];
  for (const prereq of manifest.prerequisites) {
    if (prereq.kind === "external-binary") {
      warnings.push(`Requires the ${prereq.name} binary to be installed on the system (${prereq.evidence}).`);
    }
  }

  const notes: string[] = [];

  if (surface.typesAvailable === "none") {
    notes.push("API surface types are not available (typesAvailable: none); no usage code was generated.");
    return ScaffoldSchema.parse({
      component,
      install,
      imports,
      snippet: null,
      basedOn: [],
      confidence: "import-only",
      notes: notes.sort(),
      warnings: warnings.sort(),
    });
  }

  const chosenExport = selectCallableExport(surface, manifest, opts?.preferExport);

  if (!chosenExport) {
    const fallbackCandidate = selectFallbackCandidate(surface, manifest, opts?.preferExport);
    if (!fallbackCandidate) {
      notes.push("No suitable export found in API surface; no usage code was generated.");
    } else if (!fallbackCandidate.signature) {
      notes.push(`Selected export '${fallbackCandidate.name}' has no verifiable signature; no usage code was generated.`);
    } else {
      notes.push(`Selected export '${fallbackCandidate.name}' signature is not callable; no usage code was generated.`);
    }
    return ScaffoldSchema.parse({
      component,
      install,
      imports,
      snippet: null,
      basedOn: [],
      confidence: "import-only",
      notes: notes.sort(),
      warnings: warnings.sort(),
    });
  }

  const snippet = python
    ? generatePythonSnippet(chosenExport, manifest)
    : generateSnippet(chosenExport, manifest);

  if (!snippet) {
    if (python && !extractPythonImportIdentifier(manifest)) {
      notes.push(`Selected export '${chosenExport.name}' has no verified Python import name; no usage code was generated.`);
    } else {
      notes.push(`Selected export '${chosenExport.name}' signature is not callable; no usage code was generated.`);
    }
    return ScaffoldSchema.parse({
      component,
      install,
      imports,
      snippet: null,
      basedOn: [],
      confidence: "import-only",
      notes: notes.sort(),
      warnings: warnings.sort(),
    });
  }

  const defaultExport = surface.exports.find((e) => e.name === "default" || e.kind === "default");
  if (!python && defaultExport && !hasCallableSignature(defaultExport) && chosenExport.name !== "default" && chosenExport.kind !== "default") {
    const importId = extractImportIdentifier(manifest);
    notes.push(`The 'default' export is not callable; selected callable export '${chosenExport.name}' accessed via default import '${importId}'.`);
  }

  return ScaffoldSchema.parse({
    component,
    install,
    imports,
    snippet,
    basedOn: [{ name: chosenExport.name, signature: chosenExport.signature }],
    confidence: "verified-signatures",
    notes: notes.sort(),
    warnings: warnings.sort(),
  });
}
