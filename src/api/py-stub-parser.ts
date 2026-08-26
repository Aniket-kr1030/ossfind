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

function isDunderName(name: string): boolean {
  return name.startsWith("__") && name.endsWith("__") && name.length > 4;
}

function isPrivateName(name: string): boolean {
  return name.startsWith("_") && !isDunderName(name);
}

function inferKind(name: string): PyExport["kind"] {
  if (/^[A-Z][a-zA-Z0-9]*$/.test(name) && /[a-z]/.test(name)) {
    return "class";
  }
  if (/^[A-Z0-9_]+$/.test(name) && !/[a-z]/.test(name)) {
    return "const";
  }
  return "function";
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let inTripleSingle = false;
  let inTripleDouble = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const prev = i > 0 ? line[i - 1] : "";
    if (prev === "\\") continue;

    if (!inSingle && !inDouble && !inTripleSingle && !inTripleDouble) {
      if (char === "#") {
        return line.slice(0, i);
      }
      if (line.startsWith('"""', i)) {
        inTripleDouble = true;
        i += 2;
        continue;
      }
      if (line.startsWith("'''", i)) {
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
    } else if (inTripleDouble && line.startsWith('"""', i)) {
      inTripleDouble = false;
      i += 2;
    } else if (inTripleSingle && line.startsWith("'''", i)) {
      inTripleSingle = false;
      i += 2;
    } else if (inDouble && char === '"') {
      inDouble = false;
    } else if (inSingle && char === "'") {
      inSingle = false;
    }
  }
  return line;
}

function countBracketDelta(text: string): number {
  let delta = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const prev = i > 0 ? text[i - 1] : "";
    if (prev === "\\") continue;
    if (!inSingle && !inDouble) {
      if (char === "'" || char === '"') {
        if (char === "'") inSingle = true;
        else inDouble = true;
      } else if (char === "(" || char === "[" || char === "{") {
        delta++;
      } else if (char === ")" || char === "]" || char === "}") {
        delta--;
      }
    } else if (inSingle && char === "'") {
      inSingle = false;
    } else if (inDouble && char === '"') {
      inDouble = false;
    }
  }
  return delta;
}

interface RawStatement {
  indent: number;
  text: string;
}

function extractStatements(sourceText: string): RawStatement[] {
  const rawLines = sourceText.split(/\r?\n/);
  const statements: RawStatement[] = [];

  let currentIndent = 0;
  let currentParts: string[] = [];
  let bracketDepth = 0;

  for (const rawLine of rawLines) {
    const withoutComment = stripComment(rawLine);
    const trimmed = withoutComment.trim();
    if (trimmed.length === 0) continue;

    const leadingSpaces = withoutComment.search(/\S/);

    if (currentParts.length === 0) {
      currentIndent = leadingSpaces >= 0 ? leadingSpaces : 0;
    }

    currentParts.push(trimmed);
    bracketDepth += countBracketDelta(withoutComment);

    if (bracketDepth <= 0 && !trimmed.endsWith("\\")) {
      bracketDepth = 0;
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

function extractStringLiterals(raw: string): string[] {
  const strings: string[] = [];
  const strRegex = /(?:[rRuUbB]?)(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')/g;
  let match: RegExpExecArray | null;
  while ((match = strRegex.exec(raw)) !== null) {
    const rawVal = match[1] ?? match[2] ?? "";
    const unescaped = rawVal.replace(/\\(.)/g, "$1");
    if (unescaped.length > 0) {
      strings.push(unescaped);
    }
  }
  return strings;
}

function parseAllStatement(text: string): string[] | undefined {
  const assignMatch = /^__all__\s*(?::\s*[^=]+)?\s*(?:\+=|=)\s*(.+)$/s.exec(text);
  if (assignMatch) {
    return extractStringLiterals(assignMatch[1]);
  }

  const extendMatch = /^__all__\.extend\s*\(\s*(.+)\s*\)$/s.exec(text);
  if (extendMatch) {
    return extractStringLiterals(extendMatch[1]);
  }

  const appendMatch = /^__all__\.append\s*\(\s*(.+)\s*\)$/s.exec(text);
  if (appendMatch) {
    return extractStringLiterals(appendMatch[1]);
  }

  if (/^__all__\s*:\s*[^=]+$/.test(text)) {
    return [];
  }

  return undefined;
}

function parseFunction(text: string): PyExport | undefined {
  const defMatch = /(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(/s.exec(text);
  if (!defMatch) return undefined;

  const name = defMatch[1];
  if (!name || isPrivateName(name)) return undefined;

  const parenStart = text.indexOf("(", defMatch.index);
  if (parenStart < 0) return undefined;

  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < text.length; i++) {
    const char = text[i];
    if (char === "(") parenDepth++;
    else if (char === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        parenEnd = i;
        break;
      }
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
  const classMatch = /^class\s+([a-zA-Z0-9_]+)(?:\[[^\]]*\])?(?:\([^)]*\))?\s*:/s.exec(text);
  if (!classMatch) return undefined;
  const name = classMatch[1];
  if (!name || isPrivateName(name)) return undefined;
  return { name, kind: "class", signature: null };
}

function parseReExport(text: string): PyReExport | undefined {
  const fromMatch = /^from\s+([a-zA-Z0-9_.]*)\s+import\s+(.+)$/s.exec(text);
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
  const fromMatch = /^from\s+([a-zA-Z0-9_.]*)\s+import\s+(.+)$/s.exec(text);
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
  const importMatch = /^import\s+([^#]+)$/s.exec(text);
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
  const typeStmtMatch = /^type\s+([a-zA-Z0-9_]+)(?:\[[^\]]*\])?\s*=\s*(.+)$/s.exec(text);
  if (typeStmtMatch && typeStmtMatch[1]) {
    const name = typeStmtMatch[1];
    if (isPrivateName(name)) return undefined;
    return { name, kind: "type", signature: null };
  }

  // NAME: Type = val or NAME: Type or NAME = val
  const assignMatch = /^([a-zA-Z0-9_]+)\s*(?::\s*([^=]+?))?(?:\s*=\s*(.+))?$/.exec(text);
  if (!assignMatch) return undefined;

  const name = assignMatch[1];
  if (!name || isPrivateName(name) || name === "__all__") return undefined;

  const typeAnnotation = assignMatch[2]?.trim();
  const value = assignMatch[3]?.trim();

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

export function parsePyStub(content: string): ParsedPyStub {
  const statements = extractStatements(content);
  const directExports: PyExport[] = [];
  const reExports: PyReExport[] = [];
  const notes: string[] = [];
  const importedSymbols = new Map<string, ImportedSymbol>();

  let allDeclaredNames: string[] | null = null;
  let currentClassIndent: number | null = null;

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    let text = stmt.text;

    // Skip decorators or attach them to the next declaration
    while (text.startsWith("@") && i + 1 < statements.length) {
      i++;
      text = statements[i].text;
    }

    // Check if we are inside a class body
    if (currentClassIndent !== null) {
      if (stmt.indent > currentClassIndent) {
        continue;
      }
      currentClassIndent = null;
    }

    // Check for module-level __all__ declaration
    if (stmt.indent === 0) {
      const allNames = parseAllStatement(text);
      if (allNames !== undefined) {
        if (allDeclaredNames === null) {
          allDeclaredNames = [];
        }
        allDeclaredNames.push(...allNames);
        continue;
      }
    }

    // Check for class declaration
    if (/^class\s+/.test(text)) {
      const cls = parseClass(text);
      if (cls) {
        directExports.push(cls);
        currentClassIndent = stmt.indent;
      }
      continue;
    }

    // Check for function declaration
    if (/(?:async\s+)?def\s+/.test(text)) {
      const fn = parseFunction(text);
      if (fn) directExports.push(fn);
      continue;
    }

    // Check for re-export or plain import (from ... import ...)
    if (/^from\s+/.test(text)) {
      const reExport = parseReExport(text);
      if (reExport) reExports.push(reExport);

      const imports = parseImports(text);
      for (const [name, sym] of imports) {
        importedSymbols.set(name, sym);
      }
      continue;
    }

    // Check for import statement (import ...)
    if (/^import\s+/.test(text)) {
      const imports = parseImports(text);
      for (const [name, sym] of imports) {
        importedSymbols.set(name, sym);
      }
      continue;
    }

    // Check for constant / variable / type assignment
    if (/^[a-zA-Z0-9_]+\s*[:=]/.test(text) || /^type\s+/.test(text)) {
      const entry = parseAssignmentOrConst(text);
      if (entry) directExports.push(entry);
      continue;
    }
  }

  // If __all__ is not defined, keep existing behavior (direct exports only, no plain-import emission)
  if (allDeclaredNames === null) {
    return {
      exports: directExports,
      reExports,
      notes: notes.length > 0 ? notes : undefined,
    };
  }

  // When __all__ is present, it is the authoritative public surface
  const exports: PyExport[] = [...directExports];
  const directExportNames = new Set(directExports.map((e) => e.name));
  const uniqueAllNames = [...new Set(allDeclaredNames)];

  for (const name of uniqueAllNames) {
    if (directExportNames.has(name)) {
      continue;
    }

    const kind = inferKind(name);
    exports.push({
      name,
      kind,
      signature: null,
    });

    const imp = importedSymbols.get(name);
    if (imp) {
      notes.push(`Exported symbol "${name}" imported from ${imp.fromModule} is declared in __all__; signature unresolvable from this stub.`);
    } else {
      notes.push(`Exported symbol "${name}" is declared in __all__ but not defined or imported in this stub.`);
    }
  }

  return {
    exports,
    reExports,
    notes: notes.length > 0 ? notes : undefined,
  };
}
