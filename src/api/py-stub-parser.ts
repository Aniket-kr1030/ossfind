export interface PyExport {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "enum" | "namespace" | "default";
  signature: string | null;
}

export interface PyReExport {
  module: string;
  names?: Array<{ from: string; as: string }>;
}

export interface ParsedPyStub {
  exports: PyExport[];
  reExports: PyReExport[];
  notes?: string[];
}

const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await",
  "break", "class", "continue", "def", "del", "elif", "else", "except",
  "finally", "for", "from", "global", "if", "import", "in", "is",
  "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
  "while", "with", "yield", "match", "case", "type",
]);

function isDunderName(name: string): boolean {
  return name.startsWith("__") && name.endsWith("__") && name.length > 4;
}

function isPrivateName(name: string): boolean {
  return name.startsWith("_") && !isDunderName(name);
}

function inferKind(name: string): PyExport["kind"] {
  if (/^[A-Z\p{Lu}][\p{L}\p{N}]*$/u.test(name) && /[\p{Ll}]/u.test(name)) {
    return "class";
  }
  if (/^[A-Z0-9_\p{Lu}\p{N}]+$/u.test(name) && !/[\p{Ll}]/u.test(name)) {
    return "const";
  }
  return "function";
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface RawStatement {
  indent: number;
  text: string;
}

function extractStatements(sourceText: string): RawStatement[] {
  const rawLines = sourceText.split(/\r?\n/);
  const statements: RawStatement[] = [];

  let inTripleDouble = false;
  let inTripleSingle = false;
  let bracketDepth = 0;
  let currentIndent = 0;
  let currentParts: string[] = [];

  for (const rawLine of rawLines) {
    let commentStart = -1;
    let inSingle = false;
    let inDouble = false;
    let bracketDelta = 0;
    let startIdx = 0;

    if (inTripleDouble) {
      let closed = false;
      for (let i = 0; i < rawLine.length; i++) {
        if (rawLine[i] === "\\") {
          i++;
          continue;
        }
        if (rawLine.startsWith('"""', i)) {
          inTripleDouble = false;
          startIdx = i + 3;
          closed = true;
          break;
        }
      }
      if (!closed) {
        if (currentParts.length === 0) {
          const leading = rawLine.search(/\S/);
          currentIndent = leading >= 0 ? leading : 0;
        }
        currentParts.push(rawLine.trim());
        continue;
      }
    } else if (inTripleSingle) {
      let closed = false;
      for (let i = 0; i < rawLine.length; i++) {
        if (rawLine[i] === "\\") {
          i++;
          continue;
        }
        if (rawLine.startsWith("'''", i)) {
          inTripleSingle = false;
          startIdx = i + 3;
          closed = true;
          break;
        }
      }
      if (!closed) {
        if (currentParts.length === 0) {
          const leading = rawLine.search(/\S/);
          currentIndent = leading >= 0 ? leading : 0;
        }
        currentParts.push(rawLine.trim());
        continue;
      }
    }

    for (let i = startIdx; i < rawLine.length; i++) {
      const char = rawLine[i];
      if (char === "\\") {
        i++;
        continue;
      }

      if (inSingle) {
        if (char === "'") {
          inSingle = false;
        }
        continue;
      }

      if (inDouble) {
        if (char === '"') {
          inDouble = false;
        }
        continue;
      }

      if (char === "#") {
        commentStart = i;
        break;
      }

      if (rawLine.startsWith('"""', i)) {
        let closed = false;
        for (let j = i + 3; j < rawLine.length; j++) {
          if (rawLine[j] === "\\") {
            j++;
            continue;
          }
          if (rawLine.startsWith('"""', j)) {
            i = j + 2;
            closed = true;
            break;
          }
        }
        if (!closed) {
          inTripleDouble = true;
          break;
        }
        continue;
      }

      if (rawLine.startsWith("'''", i)) {
        let closed = false;
        for (let j = i + 3; j < rawLine.length; j++) {
          if (rawLine[j] === "\\") {
            j++;
            continue;
          }
          if (rawLine.startsWith("'''", j)) {
            i = j + 2;
            closed = true;
            break;
          }
        }
        if (!closed) {
          inTripleSingle = true;
          break;
        }
        continue;
      }

      if (char === '"') {
        inDouble = true;
        continue;
      }

      if (char === "'") {
        inSingle = true;
        continue;
      }

      if (char === "(" || char === "[" || char === "{") {
        bracketDelta++;
      } else if (char === ")" || char === "]" || char === "}") {
        bracketDelta--;
      }
    }

    const unCommented = commentStart >= 0 ? rawLine.slice(0, commentStart) : rawLine;
    const trimmed = unCommented.trim();
    if (trimmed.length === 0 && !inTripleDouble && !inTripleSingle) {
      continue;
    }

    const leadingSpaces = unCommented.search(/\S/);
    if (currentParts.length === 0) {
      currentIndent = leadingSpaces >= 0 ? leadingSpaces : 0;
    }

    currentParts.push(trimmed);
    bracketDepth += bracketDelta;
    if (bracketDepth < 0) bracketDepth = 0;

    const isBackslashContinued = trimmed.endsWith("\\");
    if (!inTripleDouble && !inTripleSingle && bracketDepth === 0 && !isBackslashContinued) {
      const combined = currentParts.join(" ").replace(/\\\s*/g, " ").trim();
      if (combined.length > 0) {
        statements.push({ indent: currentIndent, text: combined });
      }
      currentParts = [];
    }
  }

  if (currentParts.length > 0) {
    const combined = currentParts.join(" ").replace(/\\\s*/g, " ").trim();
    if (combined.length > 0) {
      statements.push({ indent: currentIndent, text: combined });
    }
  }

  return statements;
}

interface AllParseResult {
  isStatic: boolean;
  names: string[];
}

function parseStringLiteral(token: string): string | null {
  const trimmed = token.trim();
  const match = /^(?:[rRuUbB]?)(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')$/s.exec(trimmed);
  if (!match) return null;
  const raw = match[1] ?? match[2] ?? "";
  return raw.replace(/\\(.)/gs, "$1");
}

function splitByTopLevelChar(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTripleSingle = false;
  let inTripleDouble = false;
  let lastIdx = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (!inSingle && !inDouble && !inTripleSingle && !inTripleDouble) {
      if (text.startsWith('"""', i)) {
        inTripleDouble = true;
        i += 2;
        continue;
      }
      if (text.startsWith("'''", i)) {
        inTripleSingle = true;
        i += 2;
        continue;
      }
      if (char === '"') {
        inDouble = true;
        continue;
      }
      if (char === "'") {
        inSingle = true;
        continue;
      }
      if (char === "(" || char === "[" || char === "{") {
        depth++;
      } else if (char === ")" || char === "]" || char === "}") {
        if (depth > 0) depth--;
      } else if (char === separator && depth === 0) {
        parts.push(text.slice(lastIdx, i));
        lastIdx = i + 1;
      }
    } else if (inTripleDouble && text.startsWith('"""', i)) {
      inTripleDouble = false;
      i += 2;
    } else if (inTripleSingle && text.startsWith("'''", i)) {
      inTripleSingle = false;
      i += 2;
    } else if (inDouble && char === '"') {
      inDouble = false;
    } else if (inSingle && char === "'") {
      inSingle = false;
    }
  }

  parts.push(text.slice(lastIdx));
  return parts;
}

function parseSequenceLiteral(text: string): AllParseResult {
  const trimmed = text.trim();
  if (!((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("(") && trimmed.endsWith(")")))) {
    return { isStatic: false, names: [] };
  }

  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) {
    return { isStatic: true, names: [] };
  }

  const items = splitByTopLevelChar(inner, ",");
  const names: string[] = [];

  for (const item of items) {
    const itemTrimmed = item.trim();
    if (itemTrimmed.length === 0) continue;
    const str = parseStringLiteral(itemTrimmed);
    if (str === null) {
      return { isStatic: false, names: [] };
    }
    if (str.length > 0) {
      names.push(str);
    }
  }

  return { isStatic: true, names };
}

function parseAllExpression(exprText: string): AllParseResult {
  const trimmed = exprText.trim();
  const plusParts = splitByTopLevelChar(trimmed, "+");
  if (plusParts.length > 1) {
    const allNames: string[] = [];
    for (const part of plusParts) {
      const partRes = parseAllExpression(part.trim());
      if (!partRes.isStatic) {
        return { isStatic: false, names: [] };
      }
      allNames.push(...partRes.names);
    }
    return { isStatic: true, names: allNames };
  }

  return parseSequenceLiteral(trimmed);
}

function parseAllStatement(text: string): { isAllStatement: boolean; isStatic: boolean; names: string[] } {
  const assignMatch = /^__all__\s*(?::\s*[^=]+)?\s*(=|\+=)\s*(.+)$/s.exec(text);
  if (assignMatch) {
    const rhs = assignMatch[2];
    const res = parseAllExpression(rhs);
    return { isAllStatement: true, isStatic: res.isStatic, names: res.names };
  }

  const extendMatch = /^__all__\.extend\s*\(\s*(.+)\s*\)$/s.exec(text);
  if (extendMatch) {
    const arg = extendMatch[1];
    const res = parseAllExpression(arg);
    return { isAllStatement: true, isStatic: res.isStatic, names: res.names };
  }

  const appendMatch = /^__all__\.append\s*\(\s*(.+)\s*\)$/s.exec(text);
  if (appendMatch) {
    const arg = appendMatch[1];
    const str = parseStringLiteral(arg);
    if (str !== null) {
      return { isAllStatement: true, isStatic: true, names: [str] };
    }
    return { isAllStatement: true, isStatic: false, names: [] };
  }

  if (/^__all__\s*:\s*[^=]+$/.test(text)) {
    return { isAllStatement: true, isStatic: true, names: [] };
  }

  return { isAllStatement: false, isStatic: false, names: [] };
}

function parseFunction(text: string): PyExport | undefined {
  const defMatch = /^(?:async\s+)?def\s+([\p{ID_Start}_][\p{ID_Continue}]*)(?:\[[^\]]*\])?\s*\(/u.exec(text);
  if (!defMatch) return undefined;

  const name = defMatch[1];
  if (!name || isPrivateName(name) || PYTHON_KEYWORDS.has(name)) return undefined;

  const parenStart = text.indexOf("(", defMatch.index + defMatch[0].length - 1);
  if (parenStart < 0) return undefined;

  let parenDepth = 0;
  let parenEnd = -1;
  let inSingle = false;
  let inDouble = false;
  let inTripleSingle = false;
  let inTripleDouble = false;

  for (let i = parenStart; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (!inSingle && !inDouble && !inTripleSingle && !inTripleDouble) {
      if (text.startsWith('"""', i)) {
        inTripleDouble = true;
        i += 2;
        continue;
      }
      if (text.startsWith("'''", i)) {
        inTripleSingle = true;
        i += 2;
        continue;
      }
      if (char === '"') {
        inDouble = true;
        continue;
      }
      if (char === "'") {
        inSingle = true;
        continue;
      }
      if (char === "(") {
        parenDepth++;
      } else if (char === ")") {
        parenDepth--;
        if (parenDepth === 0) {
          parenEnd = i;
          break;
        }
      }
    } else if (inTripleDouble && text.startsWith('"""', i)) {
      inTripleDouble = false;
      i += 2;
    } else if (inTripleSingle && text.startsWith("'''", i)) {
      inTripleSingle = false;
      i += 2;
    } else if (inDouble && char === '"') {
      inDouble = false;
    } else if (inSingle && char === "'") {
      inSingle = false;
    }
  }

  if (parenEnd < 0) return undefined;

  const paramsRaw = text.slice(parenStart + 1, parenEnd).trim();
  const compactParams = compact(paramsRaw.replace(/,\s*$/, ""));

  const remainder = text.slice(parenEnd + 1).trim();
  let returnType: string | undefined;
  const retMatch = /^->\s*([^:]+)/.exec(remainder);
  if (retMatch && retMatch[1]) {
    const cleaned = retMatch[1].trim().replace(/\.\.\.$/, "").trim();
    if (cleaned.length > 0) {
      returnType = compact(cleaned);
    }
  }

  const signature = returnType
    ? `${name}(${compactParams}) -> ${returnType}`
    : `${name}(${compactParams})`;

  return { name, kind: "function", signature };
}

function parseClass(text: string): PyExport | undefined {
  const classMatch = /^class\s+([\p{ID_Start}_][\p{ID_Continue}]*)(?:\[[^\]]*\])?(?:\([^)]*\))?\s*:/u.exec(text);
  if (!classMatch) return undefined;
  const name = classMatch[1];
  if (!name || isPrivateName(name) || PYTHON_KEYWORDS.has(name)) return undefined;
  return { name, kind: "class", signature: null };
}

function parseReExport(text: string): PyReExport | undefined {
  const fromMatch = /^from\s+([.\p{ID_Start}_\p{ID_Continue}]*)\s+import\s+(.+)$/u.exec(text);
  if (fromMatch) {
    const rawModule = fromMatch[1].trim();
    const rawImports = fromMatch[2].trim().replace(/^\s*\(/, "").replace(/\)\s*$/, "").trim();
    const moduleSpecifier = rawModule.length === 0 || rawModule === "."
      ? "./"
      : rawModule.startsWith(".")
        ? `./${rawModule.slice(1)}`
        : rawModule;

    if (rawImports === "*") {
      return { module: moduleSpecifier };
    }

    const names: Array<{ from: string; as: string }> = [];
    const items = rawImports.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

    for (const item of items) {
      if (/\s+as\s+/.test(item)) {
        const [fromName, asName] = item.split(/\s+as\s+/).map((s) => s.trim());
        if (fromName && asName) {
          names.push({ from: fromName, as: asName });
        }
      }
    }

    return names.length > 0 ? { module: moduleSpecifier, names } : undefined;
  }

  return undefined;
}

interface ImportedSymbol {
  fromModule: string;
  originalName: string;
}

function parseImports(text: string): Map<string, ImportedSymbol> {
  const result = new Map<string, ImportedSymbol>();

  // from <module> import <items>
  const fromMatch = /^from\s+([.\p{ID_Start}_\p{ID_Continue}]*)\s+import\s+(.+)$/u.exec(text);
  if (fromMatch) {
    const rawModule = fromMatch[1].trim();
    const rawImports = fromMatch[2].trim().replace(/^\s*\(/, "").replace(/\)\s*$/, "").trim();
    const moduleSpecifier = rawModule.length === 0 || rawModule === "."
      ? "./"
      : rawModule.startsWith(".")
        ? `./${rawModule.slice(1)}`
        : rawModule;

    if (rawImports !== "*") {
      const items = rawImports.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      for (const item of items) {
        if (/\s+as\s+/.test(item)) {
          const [fromName, asName] = item.split(/\s+as\s+/).map((s) => s.trim());
          if (fromName && asName) {
            result.set(asName, { fromModule: moduleSpecifier, originalName: fromName });
          }
        } else {
          result.set(item, { fromModule: moduleSpecifier, originalName: item });
        }
      }
    }
    return result;
  }

  // import <items>
  const importMatch = /^import\s+([^#]+)$/u.exec(text);
  if (importMatch) {
    const items = importMatch[1].trim().split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    for (const item of items) {
      if (/\s+as\s+/.test(item)) {
        const [fromMod, asName] = item.split(/\s+as\s+/).map((s) => s.trim());
        if (fromMod && asName) {
          result.set(asName, { fromModule: fromMod, originalName: fromMod });
        }
      } else {
        const modName = item.trim();
        if (modName) {
          result.set(modName, { fromModule: modName, originalName: modName });
        }
      }
    }
    return result;
  }

  return result;
}

function parseAssignmentOrConst(text: string): PyExport | undefined {
  // PEP 695: type Alias = ...
  const typeStmtMatch = /^type\s+([\p{ID_Start}_][\p{ID_Continue}]*)(?:\[[^\]]*\])?\s*=\s*(.+)$/u.exec(text);
  if (typeStmtMatch && typeStmtMatch[1]) {
    const name = typeStmtMatch[1];
    if (isPrivateName(name) || PYTHON_KEYWORDS.has(name)) return undefined;
    return { name, kind: "type", signature: null };
  }

  // NAME: Type = val or NAME: Type or NAME = val
  const assignMatch = /^([\p{ID_Start}_][\p{ID_Continue}]*)\s*(?::\s*([^=]+?))?(?:\s*=\s*(.+))?$/u.exec(text);
  if (!assignMatch) return undefined;

  const name = assignMatch[1];
  if (!name || isPrivateName(name) || name === "__all__" || PYTHON_KEYWORDS.has(name)) return undefined;

  const typeAnnotation = assignMatch[2]?.trim();
  const value = assignMatch[3]?.trim();

  if (!typeAnnotation && value === undefined) {
    return undefined;
  }

  // If it is a TypeAlias or TypeVar
  if (typeAnnotation && /\bTypeAlias\b/.test(typeAnnotation)) {
    return { name, kind: "type", signature: null };
  }
  if (value && /\bTypeVar\s*\(/.test(value)) {
    return { name, kind: "type", signature: null };
  }

  const cleaned = text.replace(/:\s*\.\.\.$/, "").replace(/=\s*\.\.\.$/, "").trim();
  const signature = compact(cleaned);

  return { name, kind: "const", signature: signature || null };
}

function dedupeExports(exports: PyExport[]): PyExport[] {
  const seen = new Map<string, PyExport>();
  const order: string[] = [];

  for (const entry of exports) {
    const key = `${entry.name}\u0000${entry.kind}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, entry);
      order.push(key);
    } else if (existing.signature === null && entry.signature !== null) {
      seen.set(key, entry);
    }
  }

  return order.map((key) => seen.get(key)!);
}

function dedupeReExports(reExports: PyReExport[]): PyReExport[] {
  const seenModules = new Map<string, PyReExport>();
  for (const reExp of reExports) {
    const existing = seenModules.get(reExp.module);
    if (!existing) {
      seenModules.set(reExp.module, {
        module: reExp.module,
        names: reExp.names ? [...reExp.names] : undefined,
      });
    } else {
      if (!reExp.names) {
        existing.names = undefined;
      } else if (existing.names) {
        for (const n of reExp.names) {
          if (!existing.names.some((en) => en.from === n.from && en.as === n.as)) {
            existing.names.push(n);
          }
        }
      }
    }
  }
  return [...seenModules.values()];
}

export function parsePyStub(content: string): ParsedPyStub {
  const statements = extractStatements(content);
  const directExports: PyExport[] = [];
  const reExports: PyReExport[] = [];
  const notes: string[] = [];
  const importedSymbols = new Map<string, ImportedSymbol>();

  let hasAllDeclaration = false;
  let isAllStatic = true;
  const allDeclaredNames: string[] = [];

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];

    if (stmt.indent !== 0) {
      continue;
    }

    let text = stmt.text;

    if (text.startsWith("@")) {
      while (text.startsWith("@") && i + 1 < statements.length && statements[i + 1].indent === 0) {
        i++;
        text = statements[i].text;
      }
      if (text.startsWith("@")) {
        continue;
      }
    }

    const allRes = parseAllStatement(text);
    if (allRes.isAllStatement) {
      hasAllDeclaration = true;
      if (!allRes.isStatic) {
        isAllStatic = false;
      } else {
        allDeclaredNames.push(...allRes.names);
      }
      continue;
    }

    if (/^class\s+/u.test(text)) {
      const cls = parseClass(text);
      if (cls) {
        directExports.push(cls);
      }
      continue;
    }

    if (/^(?:async\s+)?def\s+/u.test(text)) {
      const fn = parseFunction(text);
      if (fn) {
        directExports.push(fn);
      }
      continue;
    }

    if (/^from\s+/u.test(text)) {
      const reExport = parseReExport(text);
      if (reExport) {
        reExports.push(reExport);
      }

      const imports = parseImports(text);
      for (const [name, sym] of imports) {
        importedSymbols.set(name, sym);
      }
      continue;
    }

    if (/^import\s+/u.test(text)) {
      const imports = parseImports(text);
      for (const [name, sym] of imports) {
        importedSymbols.set(name, sym);
      }
      continue;
    }

    if (/^type\s+/u.test(text) || /^[\p{ID_Start}_][\p{ID_Continue}]*\s*[:=]/u.test(text)) {
      const entry = parseAssignmentOrConst(text);
      if (entry) {
        directExports.push(entry);
      }
      continue;
    }
  }

  const dedupedReExports = dedupeReExports(reExports);

  if (!hasAllDeclaration) {
    return {
      exports: dedupeExports(directExports),
      reExports: dedupedReExports,
      notes: notes.length > 0 ? notes : undefined,
    };
  }

  if (!isAllStatic) {
    notes.push("__all__ could not be evaluated statically; public surface fell back to module-level declarations.");
    return {
      exports: dedupeExports(directExports),
      reExports: dedupedReExports,
      notes: notes.length > 0 ? notes : undefined,
    };
  }

  const exports: PyExport[] = [];
  const uniqueAllNames = [...new Set(allDeclaredNames)];
  const directExportMap = new Map<string, PyExport>();
  for (const exp of directExports) {
    if (!directExportMap.has(exp.name)) {
      directExportMap.set(exp.name, exp);
    }
  }

  for (const name of uniqueAllNames) {
    const direct = directExportMap.get(name);
    if (direct) {
      exports.push(direct);
      continue;
    }

    const imp = importedSymbols.get(name);
    if (imp) {
      exports.push({
        name,
        kind: inferKind(name),
        signature: null,
      });
      notes.push(`Exported symbol "${name}" imported from ${imp.fromModule} is declared in __all__; signature unresolvable from this stub.`);
    } else {
      exports.push({
        name,
        kind: inferKind(name),
        signature: null,
      });
      notes.push(`Exported symbol "${name}" is declared in __all__ but not defined or imported in this stub.`);
    }
  }

  return {
    exports: dedupeExports(exports),
    reExports: dedupedReExports,
    notes: notes.length > 0 ? notes : undefined,
  };
}

