import { type ApiSurface } from "../contracts/api-surface.js";
import { type IntegrationManifest } from "../contracts/integration-manifest.js";
import { ScaffoldSchema, type Scaffold } from "../contracts/scaffold.js";

type ApiExport = ApiSurface["exports"][number];

const JS_RESERVED_WORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally",
  "for", "function", "if", "import", "in", "instanceof", "new", "null",
  "return", "super", "switch", "this", "throw", "true", "try", "typeof",
  "var", "void", "while", "with", "yield", "await", "async", "let",
  "static", "implements", "interface", "package", "private", "protected", "public",
]);

const PYTHON_RESERVED_WORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await",
  "break", "class", "continue", "def", "del", "elif", "else", "except",
  "finally", "for", "from", "global", "if", "import", "in", "is",
  "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
  "while", "with", "yield",
]);

export function isValidJsIdentifier(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false;
  if (JS_RESERVED_WORDS.has(name) && name !== "default") return false;
  return true;
}

export function isValidPythonIdentifier(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  if (PYTHON_RESERVED_WORDS.has(name)) return false;
  return true;
}

function isValidExportName(name: string, isPython: boolean): boolean {
  return isPython ? isValidPythonIdentifier(name) : isValidJsIdentifier(name);
}

function isCallableKind(kind: string): boolean {
  return kind === "function" || kind === "class" || kind === "default" || kind === "const";
}

function hasBalancedDelimiters(str: string): boolean {
  let paren = 0;
  let angle = 0;
  let curly = 0;
  let square = 0;

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "(") paren++;
    else if (c === ")") { paren--; if (paren < 0) return false; }
    else if (c === "<") angle++;
    else if (c === ">") {
      if (!(i > 0 && (str[i - 1] === "-" || str[i - 1] === "="))) {
        angle--;
        if (angle < 0) return false;
      }
    }
    else if (c === "{") curly++;
    else if (c === "}") { curly--; if (curly < 0) return false; }
    else if (c === "[") square++;
    else if (c === "]") { square--; if (square < 0) return false; }
  }
  return paren === 0 && angle === 0 && curly === 0 && square === 0;
}

function extractPackageRawName(id: string): string {
  return id.replace(/^[a-z]+:/, "");
}

function splitTopLevelCommas(str: string): string[] {
  const result: string[] = [];
  let current = "";
  let paren = 0;
  let angle = 0;
  let curly = 0;
  let square = 0;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === "(") paren++;
    else if (char === ")") paren--;
    else if (char === "<") angle++;
    else if (char === ">") {
      if (!(i > 0 && (str[i - 1] === "-" || str[i - 1] === "="))) {
        angle--;
      }
    }
    else if (char === "{") curly++;
    else if (char === "}") curly--;
    else if (char === "[") square++;
    else if (char === "]") square--;

    if (char === "," && paren === 0 && angle === 0 && curly === 0 && square === 0) {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

export interface ParsedJsSignature {
  declarationName: string;
  params: string[];
  returnType: string | null;
  isAsync: boolean;
  isVoid: boolean;
}

export function parseJsSignature(exportName: string, signature: string): ParsedJsSignature | null {
  if (!signature || typeof signature !== "string") return null;
  if (signature.includes("\n") || signature.includes("\r")) return null;
  if (!hasBalancedDelimiters(signature)) return null;

  const trimmed = signature.trim();

  let declName = "";
  let afterDeclIdx = 0;

  const fnPrefixMatch = /^(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed);
  if (fnPrefixMatch) {
    declName = fnPrefixMatch[1]!;
    afterDeclIdx = fnPrefixMatch[0].length;
  } else {
    const identMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed);
    if (identMatch) {
      declName = identMatch[1]!;
      afterDeclIdx = identMatch[0].length;
      const colonMatch = /^\s*:\s*/.exec(trimmed.slice(afterDeclIdx));
      if (colonMatch) {
        afterDeclIdx += colonMatch[0].length;
      }
    } else if (exportName === "default" && trimmed.startsWith("(")) {
      declName = "default";
      afterDeclIdx = 0;
    } else {
      return null;
    }
  }

  if (exportName !== "default" && declName !== exportName) {
    return null;
  }

  let rest = trimmed.slice(afterDeclIdx).trim();

  if (rest.startsWith("<")) {
    let angleDepth = 0;
    let angleEnd = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "<") angleDepth++;
      else if (rest[i] === ">") {
        angleDepth--;
        if (angleDepth === 0) {
          angleEnd = i;
          break;
        }
      }
    }
    if (angleEnd === -1) return null;
    rest = rest.slice(angleEnd + 1).trim();
  }

  if (!rest.startsWith("(")) return null;

  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "(") parenDepth++;
    else if (rest[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  if (parenEnd === -1) return null;

  const paramsText = rest.slice(1, parenEnd).trim();
  const remainder = rest.slice(parenEnd + 1).trim();

  const rawParams = paramsText ? splitTopLevelCommas(paramsText) : [];
  const params: string[] = [];

  for (let idx = 0; idx < rawParams.length; idx++) {
    const rawParam = rawParams[idx]!.trim();
    if (!rawParam) continue;

    if (rawParam.startsWith("*")) return null;
    if (rawParam.startsWith("...")) continue;

    let head = rawParam.split(/[:=]/)[0]?.trim() || "";
    head = head.replace(/\?$/, "").trim();

    if (idx === 0 && head === "this") continue;
    if (head === "self" || head === "cls") continue;

    if (head.startsWith("{") || head.startsWith("[")) {
      params.push("options");
      continue;
    }

    if (!isValidJsIdentifier(head)) {
      return null;
    }

    params.push(head);
  }

  let returnType: string | null = null;
  if (remainder.startsWith(":")) {
    returnType = remainder.slice(1).trim();
  } else if (remainder.startsWith("=>")) {
    returnType = remainder.slice(2).trim();
  } else if (remainder === "" || remainder === ";") {
    returnType = null;
  } else {
    return null;
  }

  if (returnType && !hasBalancedDelimiters(returnType)) return null;

  const isAsync = returnType
    ? /^Promise(?:Like)?\s*<[\s\S]*>$/.test(returnType) || returnType === "Promise" || returnType === "PromiseLike"
    : false;
  const isVoid = returnType ? returnType === "void" || returnType === "never" : false;

  return { declarationName: declName, params, returnType, isAsync, isVoid };
}

export interface ParsedPythonSignature {
  declarationName: string;
  args: string[];
  returnType: string | null;
  isAsync: boolean;
  isNone: boolean;
}

export function parsePythonSignature(exportName: string, signature: string): ParsedPythonSignature | null {
  if (!signature || typeof signature !== "string") return null;
  if (signature.includes("\n") || signature.includes("\r")) return null;
  if (!hasBalancedDelimiters(signature)) return null;

  const trimmed = signature.trim();

  const defMatch = /^(?:(async\s+)?def\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(trimmed);
  if (!defMatch) return null;

  const isAsync = Boolean(defMatch[1]);
  const declName = defMatch[2]!;

  if (declName !== exportName) {
    return null;
  }

  const parenStart = trimmed.indexOf("(", defMatch.index);
  if (parenStart < 0) return null;

  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < trimmed.length; i++) {
    if (trimmed[i] === "(") parenDepth++;
    else if (trimmed[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  if (parenEnd < 0) return null;

  const paramsText = trimmed.slice(parenStart + 1, parenEnd).trim();
  const rawParams = paramsText ? splitTopLevelCommas(paramsText) : [];

  let keywordOnly = false;
  const args: string[] = [];

  for (const rawParam of rawParams) {
    const param = rawParam.trim();
    if (!param || param === "/") continue;
    if (param === "*") {
      keywordOnly = true;
      continue;
    }

    if (param.startsWith("**") || param.startsWith("*")) {
      continue;
    }

    const name = param.split(/[:=]/)[0]?.trim();
    if (!name || !isValidPythonIdentifier(name)) return null;

    if (name === "self" || name === "cls") {
      continue;
    }

    args.push(keywordOnly ? `${name}=${name}` : name);
  }

  let remainder = trimmed.slice(parenEnd + 1).trim();
  remainder = remainder.replace(/^:\s*(\.\.\.|pass)?\s*$/, "").trim();

  let returnType: string | null = null;
  if (remainder.startsWith("->")) {
    returnType = remainder.slice(2).trim().replace(/:\s*(\.\.\.|pass)?\s*$/, "").trim() || null;
  } else if (remainder === "" || remainder === ":") {
    returnType = null;
  } else {
    return null;
  }

  if (returnType && !hasBalancedDelimiters(returnType)) return null;

  const isNone = returnType === "None" || returnType === "NoReturn" || returnType === "Never";

  return { declarationName: declName, args, returnType, isAsync, isNone };
}

function isTypeScriptMethodSignature(signature: string): boolean {
  if (!signature || signature.includes("\n")) return false;
  const parenStart = signature.indexOf("(");
  if (parenStart < 0) return false;
  const parenEnd = signature.indexOf(")", parenStart);
  if (parenEnd < 0) return false;
  const paramsText = signature.slice(parenStart + 1, parenEnd).trim();
  if (!paramsText) return false;
  for (const rawParam of splitTopLevelCommas(paramsText)) {
    const param = rawParam.trim();
    if (!param) continue;
    let head = param.split(/[:=]/)[0]?.trim() || "";
    head = head.replace(/^\.\.\./, "").replace(/\?$/, "").trim();
    return head === "this";
  }
  return false;
}

function isPythonMethodSignature(signature: string): boolean {
  if (!signature || signature.includes("\n")) return false;
  const parenStart = signature.indexOf("(");
  if (parenStart < 0) return false;
  const parenEnd = signature.indexOf(")", parenStart);
  if (parenEnd < 0) return false;
  const paramsText = signature.slice(parenStart + 1, parenEnd).trim();
  if (!paramsText) return false;
  for (const rawParam of splitTopLevelCommas(paramsText)) {
    const param = rawParam.trim();
    if (!param || param === "/" || param === "*") continue;
    if (param.startsWith("*") || param.startsWith("**")) continue;
    const name = param.split(/[:=]/)[0]?.trim();
    return name === "self" || name === "cls";
  }
  return false;
}

function isMethodSignature(signature: string, isPython: boolean): boolean {
  return isPython ? isPythonMethodSignature(signature) : isTypeScriptMethodSignature(signature);
}

function isPythonComponent(surface: ApiSurface, manifest: IntegrationManifest): boolean {
  return (manifest.id || surface.id).startsWith("pypi:");
}

function extractPythonImportIdentifier(manifest: IntegrationManifest): string | null {
  const python = manifest.importForm.python;
  if (!python?.importName) return null;
  const escaped = python.importName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const directImport = new RegExp(`^import\\s+${escaped}\\s*$`);
  return python.statements.some((statement) => directImport.test(statement.trim()))
    ? python.importName
    : null;
}

export interface ImportBindings {
  defaultBinding: string | null;
  namespaceBinding: string | null;
  namedBindings: Map<string, string>;
}

export function parseEsmImport(statement: string): ImportBindings | null {
  const trimmed = statement.trim();
  const match = /^import\s+([\s\S]+?)\s+from\s+['"][^'"]+['"];?$/.exec(trimmed);
  if (!match) return null;

  const importClause = match[1]!.trim();
  const bindings: ImportBindings = {
    defaultBinding: null,
    namespaceBinding: null,
    namedBindings: new Map(),
  };

  let remaining = importClause;

  const defaultMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*,\s*([\s\S]+))?$/.exec(remaining);
  if (defaultMatch) {
    if (isValidJsIdentifier(defaultMatch[1]!)) {
      bindings.defaultBinding = defaultMatch[1]!;
    }
    remaining = defaultMatch[2]?.trim() || "";
  }

  if (!remaining) return bindings;

  const nsMatch = /^\*\s*as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(remaining);
  if (nsMatch) {
    if (isValidJsIdentifier(nsMatch[1]!)) {
      bindings.namespaceBinding = nsMatch[1]!;
    }
    return bindings;
  }

  const namedMatch = /^\{([\s\S]*)\}$/.exec(remaining);
  if (namedMatch) {
    const list = splitTopLevelCommas(namedMatch[1]!.trim());
    for (const item of list) {
      const aliasMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(item.trim());
      if (aliasMatch) {
        const [, exportName, localName] = aliasMatch;
        if (exportName && localName && isValidJsIdentifier(localName)) {
          bindings.namedBindings.set(exportName, localName);
        }
      } else {
        const singleMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(item.trim());
        if (singleMatch) {
          const name = singleMatch[1]!;
          if (isValidJsIdentifier(name)) {
            bindings.namedBindings.set(name, name);
          }
        }
      }
    }
  }

  return bindings;
}

export function parseCjsRequire(statement: string): ImportBindings | null {
  const trimmed = statement.trim();
  const match = /^(?:const|let|var)\s+([\s\S]+?)\s*=\s*require\s*\(\s*['"][^'"]+['"]\s*\);?$/.exec(trimmed);
  if (!match) return null;

  const bindingClause = match[1]!.trim();
  const bindings: ImportBindings = {
    defaultBinding: null,
    namespaceBinding: null,
    namedBindings: new Map(),
  };

  const destructureMatch = /^\{([\s\S]*)\}$/.exec(bindingClause);
  if (destructureMatch) {
    const list = splitTopLevelCommas(destructureMatch[1]!.trim());
    for (const item of list) {
      const aliasMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(item.trim());
      if (aliasMatch) {
        const [, exportName, localName] = aliasMatch;
        if (exportName && localName && isValidJsIdentifier(localName)) {
          bindings.namedBindings.set(exportName, localName);
        }
      } else {
        const singleMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(item.trim());
        if (singleMatch) {
          const name = singleMatch[1]!;
          if (isValidJsIdentifier(name)) {
            bindings.namedBindings.set(name, name);
          }
        }
      }
    }
    return bindings;
  }

  if (isValidJsIdentifier(bindingClause)) {
    bindings.defaultBinding = bindingClause;
    bindings.namespaceBinding = bindingClause;
    return bindings;
  }

  return null;
}

export function resolveJsCallTarget(
  exportItem: ApiExport,
  bindings: ImportBindings,
): { target: string; isDirectCall: boolean } | null {
  const exportName = exportItem.name;

  if (exportName === "default" || exportItem.kind === "default") {
    if (bindings.namedBindings.has("default")) {
      return { target: bindings.namedBindings.get("default")!, isDirectCall: true };
    }
    if (bindings.defaultBinding) {
      return { target: bindings.defaultBinding, isDirectCall: true };
    }
    if (bindings.namespaceBinding) {
      return { target: `${bindings.namespaceBinding}.default`, isDirectCall: false };
    }
    return null;
  }

  if (bindings.namedBindings.has(exportName)) {
    return { target: bindings.namedBindings.get(exportName)!, isDirectCall: true };
  }

  if (bindings.defaultBinding === exportName) {
    return { target: bindings.defaultBinding, isDirectCall: true };
  }

  if (bindings.namespaceBinding) {
    return { target: `${bindings.namespaceBinding}.${exportName}`, isDirectCall: false };
  }

  if (bindings.defaultBinding) {
    return { target: `${bindings.defaultBinding}.${exportName}`, isDirectCall: false };
  }

  return null;
}

const ENTRY_POINT_VERBS: readonly string[] = [
  "safe_load",
  "array",
  "load",
  "create",
  "get",
  "request",
  "parse",
  "run",
  "open",
  "connect",
  "build",
  "render",
  "main",
];

interface VerbScore {
  verbIndex: number;
  isExact: boolean;
}

function scoreVerbMatch(name: string): VerbScore | null {
  const lower = name.toLowerCase();
  const normalized = lower.replace(/[-_]/g, "");

  for (let i = 0; i < ENTRY_POINT_VERBS.length; i++) {
    const verb = ENTRY_POINT_VERBS[i]!;
    const normVerb = verb.replace(/[-_]/g, "");
    if (lower === verb || normalized === normVerb) {
      return { verbIndex: i, isExact: true };
    }
  }

  for (let i = 0; i < ENTRY_POINT_VERBS.length; i++) {
    const verb = ENTRY_POINT_VERBS[i]!;
    const normVerb = verb.replace(/[-_]/g, "");
    if (lower.startsWith(verb) || normalized.startsWith(normVerb)) {
      return { verbIndex: i, isExact: false };
    }
  }

  return null;
}

function countRequiredParameters(signature: string, isPython: boolean): number {
  if (!signature || signature.includes("\n")) return 99;

  if (isPython) {
    const parenStart = signature.indexOf("(");
    if (parenStart < 0) return 99;
    const parenEnd = signature.indexOf(")", parenStart);
    if (parenEnd < 0) return 99;

    const paramsText = signature.slice(parenStart + 1, parenEnd).trim();
    if (!paramsText) return 0;

    let requiredCount = 0;
    for (const rawParam of splitTopLevelCommas(paramsText)) {
      const param = rawParam.trim();
      if (!param || param === "/" || param === "*") continue;
      if (param.startsWith("*") || param.startsWith("**")) continue;
      const name = param.split(/[:=]/)[0]?.trim();
      if (name === "self" || name === "cls") continue;
      if (param.includes("=")) continue;
      requiredCount++;
    }
    return requiredCount;
  }

  const parenStart = signature.indexOf("(");
  if (parenStart < 0) return 99;
  const parenEnd = signature.indexOf(")", parenStart);
  if (parenEnd < 0) return 99;

  const paramsText = signature.slice(parenStart + 1, parenEnd).trim();
  if (!paramsText) return 0;

  let requiredCount = 0;
  const rawParams = splitTopLevelCommas(paramsText);
  for (let idx = 0; idx < rawParams.length; idx++) {
    const param = rawParams[idx]!.trim();
    if (!param || param.startsWith("...")) continue;
    const head = param.split(/[:=]/)[0]?.trim() || "";
    if (idx === 0 && head === "this") continue;
    if (head === "self" || head === "cls") continue;
    if (head.endsWith("?")) continue;
    if (param.includes("=")) continue;
    requiredCount++;
  }
  return requiredCount;
}

export function hasCallableSignature(exportItem: ApiExport, isPython?: boolean): boolean {
  if (!exportItem.signature) return false;
  if (!isCallableKind(exportItem.kind)) return false;
  if (!isValidExportName(exportItem.name, Boolean(isPython))) return false;

  return isPython
    ? parsePythonSignature(exportItem.name, exportItem.signature) !== null
    : parseJsSignature(exportItem.name, exportItem.signature) !== null;
}

function selectCallableExport(
  surface: ApiSurface,
  manifest: IntegrationManifest,
  preferExport?: string,
): ApiExport | undefined {
  if (surface.exports.length === 0) return undefined;

  const isPython = isPythonComponent(surface, manifest);
  const callableExports = surface.exports.filter(
    (e) =>
      isValidExportName(e.name, isPython) &&
      isCallableKind(e.kind) &&
      hasCallableSignature(e, isPython) &&
      (!e.signature || !isMethodSignature(e.signature, isPython)),
  );
  if (callableExports.length === 0) return undefined;

  const rawPkgName = extractPackageRawName(manifest.id || surface.id);
  const unScopedName = rawPkgName.replace(/^@[^\/]+\//, "");
  const pythonImportId = isPython ? extractPythonImportIdentifier(manifest) : null;

  const isExplicitPreferred = (e: ApiExport) => Boolean(preferExport && e.name === preferExport);
  const isPublicExport = (e: ApiExport) => !e.name.startsWith("_");
  const isDefaultExport = (e: ApiExport) => e.name === "default" || e.kind === "default";
  const isPackageNameMatch = (e: ApiExport) => {
    const lower = e.name.toLowerCase();
    return (
      lower === rawPkgName.toLowerCase() ||
      lower === unScopedName.toLowerCase() ||
      (pythonImportId !== null && lower === pythonImportId.toLowerCase())
    );
  };

  const sorted = [...callableExports].sort((a, b) => {
    const prefA = isExplicitPreferred(a) ? 1 : 0;
    const prefB = isExplicitPreferred(b) ? 1 : 0;
    if (prefA !== prefB) return prefB - prefA;

    const pubA = isPublicExport(a) ? 1 : 0;
    const pubB = isPublicExport(b) ? 1 : 0;
    if (pubA !== pubB) return pubB - pubA;

    const defA = isDefaultExport(a) ? 1 : 0;
    const defB = isDefaultExport(b) ? 1 : 0;
    if (defA !== defB) return defB - defA;

    const pkgA = isPackageNameMatch(a) ? 1 : 0;
    const pkgB = isPackageNameMatch(b) ? 1 : 0;
    if (pkgA !== pkgB) return pkgB - pkgA;

    const verbA = scoreVerbMatch(a.name);
    const verbB = scoreVerbMatch(b.name);
    if (verbA && !verbB) return -1;
    if (!verbA && verbB) return 1;
    if (verbA && verbB) {
      if (verbA.isExact && !verbB.isExact) return -1;
      if (!verbA.isExact && verbB.isExact) return 1;
      if (verbA.verbIndex !== verbB.verbIndex) return verbA.verbIndex - verbB.verbIndex;
    }

    const reqA = countRequiredParameters(a.signature ?? "", isPython);
    const reqB = countRequiredParameters(b.signature ?? "", isPython);
    if (reqA !== reqB) return reqA - reqB;

    const kindScoreA = a.kind === "function" || a.kind === "class" ? 1 : 0;
    const kindScoreB = b.kind === "function" || b.kind === "class" ? 1 : 0;
    if (kindScoreA !== kindScoreB) return kindScoreB - kindScoreA;

    return a.name.localeCompare(b.name);
  });

  return sorted[0];
}

function selectFallbackCandidate(
  surface: ApiSurface,
  manifest: IntegrationManifest,
  preferExport?: string,
): ApiExport | undefined {
  const isPython = isPythonComponent(surface, manifest);
  const validExports = surface.exports.filter((e) => isValidExportName(e.name, isPython));
  if (validExports.length === 0) return undefined;

  if (preferExport) {
    const preferred = validExports.find((e) => e.name === preferExport);
    if (preferred) return preferred;
  }

  const defaultExport = validExports.find((e) => e.name === "default" || e.kind === "default");
  if (defaultExport) return defaultExport;

  const rawPkgName = extractPackageRawName(manifest.id || surface.id);
  const unScopedName = rawPkgName.replace(/^@[^\/]+\//, "");
  const nameMatch = validExports.find((e) => {
    const lower = e.name.toLowerCase();
    return lower === rawPkgName.toLowerCase() || lower === unScopedName.toLowerCase();
  });
  if (nameMatch) return nameMatch;

  const fnOrClass = validExports.find((e) => !e.name.startsWith("_") && (e.kind === "function" || e.kind === "class"));
  if (fnOrClass) return fnOrClass;

  const anyPublic = validExports.find((e) => !e.name.startsWith("_"));
  if (anyPublic) return anyPublic;

  const anyFnOrClass = validExports.find((e) => e.kind === "function" || e.kind === "class");
  if (anyFnOrClass) return anyFnOrClass;

  return validExports[0];
}

function generateSnippet(
  exportItem: ApiExport,
  importStatement: string,
  isCjs: boolean,
): string | null {
  if (!exportItem.signature) return null;
  const parsed = parseJsSignature(exportItem.name, exportItem.signature);
  if (!parsed) return null;

  const bindings = isCjs ? parseCjsRequire(importStatement) : parseEsmImport(importStatement);
  if (!bindings) return null;

  const callResolution = resolveJsCallTarget(exportItem, bindings);
  if (!callResolution) return null;

  const { target } = callResolution;
  const { params, isAsync, isVoid } = parsed;
  const isClass = exportItem.kind === "class";
  const argsStr = params.join(", ");

  const callExpr = isClass ? `new ${target}(${argsStr})` : `${target}(${argsStr})`;
  const varName = (parsed.returnType && /Response/.test(parsed.returnType)) || exportItem.name === "get" ? "response" : "result";

  let statement = "";
  if (isCjs) {
    if (isAsync) {
      statement = isVoid
        ? `(async () => {\n  await ${callExpr};\n})();`
        : `(async () => {\n  const ${varName} = await ${callExpr};\n})();`;
    } else {
      statement = isVoid ? `${callExpr};` : `const ${varName} = ${callExpr};`;
    }
  } else {
    if (isAsync) {
      statement = isVoid ? `await ${callExpr};` : `const ${varName} = await ${callExpr};`;
    } else {
      statement = isVoid ? `${callExpr};` : `const ${varName} = ${callExpr};`;
    }
  }

  return `// Verified signature: ${exportItem.signature}\n${statement}`;
}

function generatePythonSnippet(
  exportItem: ApiExport,
  manifest: IntegrationManifest,
): string | null {
  if (!exportItem.signature) return null;

  const parsed = parsePythonSignature(exportItem.name, exportItem.signature);
  const importId = extractPythonImportIdentifier(manifest);
  if (!parsed || !importId) return null;

  const callExpr = `${importId}.${exportItem.name}(${parsed.args.join(", ")})`;
  const awaitedCall = parsed.isAsync ? `await ${callExpr}` : callExpr;
  const statement = parsed.isNone ? awaitedCall : `result = ${awaitedCall}`;

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
  const notes: string[] = [];
  let isCjs = false;
  let activeImportStatement: string | null = null;

  if (python) {
    imports.push(...(manifest.importForm.python?.statements ?? []));
  } else {
    const { moduleType, esm, cjs } = manifest.importForm;
    if (moduleType === "esm") {
      if (esm) {
        imports.push(esm);
        activeImportStatement = esm;
        isCjs = false;
      } else if (cjs) {
        imports.push(cjs);
        activeImportStatement = cjs;
        isCjs = true;
      }
    } else if (moduleType === "cjs") {
      if (cjs) {
        imports.push(cjs);
        activeImportStatement = cjs;
        isCjs = true;
      } else if (esm) {
        imports.push(esm);
        activeImportStatement = esm;
        isCjs = false;
      }
    } else {
      if (esm) {
        imports.push(esm);
        activeImportStatement = esm;
        isCjs = false;
        if (cjs) {
          notes.push(`Dual module: ESM import emitted; CommonJS require is also supported ('${cjs}').`);
        }
      } else if (cjs) {
        imports.push(cjs);
        activeImportStatement = cjs;
        isCjs = true;
      }
    }
  }

  const warnings: string[] = [];
  for (const prereq of manifest.prerequisites) {
    if (prereq.kind === "external-binary") {
      warnings.push(`Requires the ${prereq.name} binary to be installed on the system (${prereq.evidence}).`);
    }
  }

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
    if (!fallbackCandidate || !isValidExportName(fallbackCandidate.name, python)) {
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
    : activeImportStatement
      ? generateSnippet(chosenExport, activeImportStatement, isCjs)
      : null;

  if (!snippet) {
    if (python && !extractPythonImportIdentifier(manifest)) {
      notes.push(`Selected export '${chosenExport.name}' has no verified Python import name; no usage code was generated.`);
    } else if (
      !python &&
      activeImportStatement &&
      !resolveJsCallTarget(
        chosenExport,
        (isCjs ? parseCjsRequire(activeImportStatement) : parseEsmImport(activeImportStatement)) ?? {
          defaultBinding: null,
          namespaceBinding: null,
          namedBindings: new Map(),
        },
      )
    ) {
      notes.push(`Selected export '${chosenExport.name}' is not bound by the emitted import statement; no usage code was generated.`);
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
  if (!python && defaultExport && !hasCallableSignature(defaultExport, false) && chosenExport.name !== "default" && chosenExport.kind !== "default") {
    const bindings = activeImportStatement
      ? isCjs
        ? parseCjsRequire(activeImportStatement)
        : parseEsmImport(activeImportStatement)
      : null;
    const defaultBinding = bindings?.defaultBinding;
    if (defaultBinding) {
      notes.push(`The 'default' export is not callable; selected callable export '${chosenExport.name}' accessed via default import '${defaultBinding}'.`);
    }
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
