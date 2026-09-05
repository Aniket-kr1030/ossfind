import { posix as path } from "node:path";
import ts from "typescript";
import { ApiSurfaceSchema, type ApiSurface } from "../contracts/api-surface.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";

type ExportKind = ApiSurface["exports"][number]["kind"];
type ApiExport = ApiSurface["exports"][number];

interface RegistryDocument {
  version?: unknown;
  types?: unknown;
  typings?: unknown;
}

interface ListingDocument {
  files?: unknown;
}

interface ReExport {
  path: string;
  names?: Array<{ from: string; as: string }>;
}

interface ParsedDeclaration {
  exports: ApiExport[];
  reExports: ReExport[];
  notes?: string[];
}

const MAX_REEXPORT_DEPTH = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\s*([,:;<>()[\]{}|&=?])\s*/g, "$1").trim();
}

function typeText(node: ts.TypeNode | undefined, source: ts.SourceFile): string {
  return node ? compact(node.getText(source)) : "unknown";
}

function functionSignature(node: ts.FunctionDeclaration, source: ts.SourceFile, name: string): string {
  const typeParameters = node.typeParameters?.map((parameter) => compact(parameter.getText(source))).join(",") ?? "";
  const parameters = node.parameters.map((parameter) => compact(parameter.getText(source))).join(", ");
  return `${name}${typeParameters ? `<${typeParameters}>` : ""}(${parameters}): ${typeText(node.type, source)}`;
}

/** Members beyond this are omitted rather than silently dropped; the flag says so. */
const MAX_CLASS_MEMBERS = 80;

type ClassMember = NonNullable<ApiSurface["exports"][number]["members"]>[number];

/** `private`/`protected` members are implementation, and `#name` is not reachable at all. */
function isPubliclyDeclared(member: ts.ClassElement): boolean {
  if (member.name && ts.isPrivateIdentifier(member.name)) return false;
  const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
  return !modifiers?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword);
}

function isStatic(member: ts.ClassElement): boolean {
  const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
  return !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
}

function memberName(member: ts.ClassElement, source: ts.SourceFile): string | undefined {
  if (ts.isConstructorDeclaration(member)) return "constructor";
  const name = member.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  // Computed keys such as [Symbol.iterator] are reported verbatim, never invented.
  return ts.isComputedPropertyName(name) ? compact(name.getText(source)) : undefined;
}

function signatureFor(
  member: ts.ClassElement,
  source: ts.SourceFile,
  name: string,
): { kind: ClassMember["kind"]; signature: string | null } | undefined {
  const parameterList = (parameters: ts.NodeArray<ts.ParameterDeclaration>) =>
    parameters.map((parameter) => compact(parameter.getText(source))).join(", ");

  if (ts.isConstructorDeclaration(member)) {
    return { kind: "constructor", signature: `constructor(${parameterList(member.parameters)})` };
  }
  if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
    const typeParameters = member.typeParameters?.map((p) => compact(p.getText(source))).join(",") ?? "";
    return {
      kind: "method",
      signature: `${name}${typeParameters ? `<${typeParameters}>` : ""}(${parameterList(member.parameters)}): ${typeText(member.type, source)}`,
    };
  }
  if (ts.isGetAccessorDeclaration(member)) {
    return { kind: "accessor", signature: `${name}: ${typeText(member.type, source)}` };
  }
  if (ts.isSetAccessorDeclaration(member)) {
    return { kind: "accessor", signature: `${name}(${parameterList(member.parameters)}): void` };
  }
  if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
    // A property with no type annotation is reported with a null signature rather
    // than an inferred one — the declaration is the only evidence available here.
    return { kind: "property", signature: member.type ? `${name}: ${typeText(member.type, source)}` : null };
  }
  return undefined;
}

/**
 * Public members declared on a class. Returns `undefined` for anything that is not a
 * class declaration, which is how the caller distinguishes "not a class" and "class
 * whose body could not be read" from "class that declares nothing public".
 */
function classMembers(
  node: ts.Node,
  source: ts.SourceFile,
): { members: ClassMember[]; truncated: boolean } | undefined {
  if (!ts.isClassDeclaration(node)) return undefined;

  const members: ClassMember[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (const member of node.members) {
    if (!isPubliclyDeclared(member)) continue;
    const name = memberName(member, source);
    if (!name) continue;
    const described = signatureFor(member, source, name);
    if (!described) continue;

    // Overloads and get/set pairs declare one member under several nodes.
    const key = `${isStatic(member) ? "static " : ""}${name}`;
    if (seen.has(key)) continue;

    if (members.length >= MAX_CLASS_MEMBERS) { truncated = true; break; }
    seen.add(key);
    members.push({ name, kind: described.kind, signature: described.signature, static: isStatic(member) });
  }

  return { members, truncated };
}

/** Attach class members to an export entry, omitting the fields entirely when absent. */
function withMembers(
  entry: { name: string; kind: ApiSurface["exports"][number]["kind"]; signature: string | null },
  node: ts.Node,
  source: ts.SourceFile,
): ApiSurface["exports"][number] {
  const found = classMembers(node, source);
  if (!found) return entry;
  return found.truncated
    ? { ...entry, members: found.members, membersTruncated: true }
    : { ...entry, members: found.members };
}

function declarationName(node: ts.Declaration): string | undefined {
  const name = ts.getNameOfDeclaration(node);
  return name && ts.isIdentifier(name) ? name.text : undefined;
}

function sourcePathForReExport(fromPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const raw = path.normalize(path.join(path.dirname(fromPath), specifier));
  if (raw.startsWith("../") || raw === "..") return undefined;
  if (/\.cjs$/i.test(raw)) return raw.replace(/\.cjs$/i, ".d.cts");
  if (/\.mjs$/i.test(raw)) return raw.replace(/\.mjs$/i, ".d.mts");
  if (/\.js$/i.test(raw)) return raw.replace(/\.js$/i, ".d.ts");
  if (/\.d\.(?:ts|cts|mts)$/i.test(raw)) return raw;
  return `${raw}.d.ts`;
}

function apiFixtureTruncated(content: string): boolean {
  return /\/\/\s*\[fixture truncated\]/i.test(content);
}

function extractNamespaceMembers(nsDecl: ts.ModuleDeclaration, source: ts.SourceFile, found: ApiExport[]): void {
  if (!nsDecl.body || !ts.isModuleBlock(nsDecl.body)) return;
  for (const statement of nsDecl.body.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const name = declarationName(statement);
      if (name) found.push({ name, kind: "function", signature: functionSignature(statement, source, name) });
    } else if (ts.isClassDeclaration(statement)) {
      const name = declarationName(statement);
      if (name) found.push(withMembers({ name, kind: "class", signature: null }, statement, source));
    } else if (ts.isInterfaceDeclaration(statement)) {
      found.push({ name: statement.name.text, kind: "interface", signature: null });
    } else if (ts.isTypeAliasDeclaration(statement)) {
      found.push({ name: statement.name.text, kind: "type", signature: null });
    } else if (ts.isEnumDeclaration(statement)) {
      found.push({ name: statement.name.text, kind: "enum", signature: null });
    } else if (ts.isModuleDeclaration(statement)) {
      const name = declarationName(statement);
      if (name) found.push({ name, kind: "namespace", signature: null });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const varName = declaration.name.text;
          const annotation = declaration.type ? `: ${typeText(declaration.type, source)}` : "";
          found.push({ name: varName, kind: "const", signature: `${varName}${annotation}` || null });
        }
      }
    }
  }
}

function directExports(source: ts.SourceFile): ParsedDeclaration {
  const found: ApiExport[] = [];
  const reExports: ReExport[] = [];
  const notes: string[] = [];

  const localFunctions: ts.FunctionDeclaration[] = [];
  const localClasses = new Map<string, ts.ClassDeclaration>();
  const localInterfaces = new Map<string, ts.InterfaceDeclaration>();
  const localTypes = new Map<string, ts.TypeAliasDeclaration>();
  const localEnums = new Map<string, ts.EnumDeclaration>();
  const localVariables = new Map<string, ts.TypeNode | undefined>();
  const localNamespaces = new Map<string, ts.ModuleDeclaration[]>();
  const localImportEquals = new Map<string, ts.ImportEqualsDeclaration>();
  const namespaceImports = new Set<string>();
  let exportAssignment: ts.ExportAssignment | undefined;

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings
      && ts.isNamespaceImport(statement.importClause.namedBindings)) {
      namespaceImports.add(statement.importClause.namedBindings.name.text);
      continue;
    }

    if (ts.isFunctionDeclaration(statement)) {
      const name = declarationName(statement);
      if (name) localFunctions.push(statement);
      if (name && hasExportModifier(statement)) {
        found.push({ name, kind: "function", signature: functionSignature(statement, source, name) });
      }
      continue;
    }
    if (ts.isClassDeclaration(statement)) {
      const name = declarationName(statement);
      if (name) localClasses.set(name, statement);
      if (name && hasExportModifier(statement)) {
        found.push(withMembers({ name, kind: "class", signature: null }, statement, source));
      }
      continue;
    }
    if (ts.isInterfaceDeclaration(statement)) {
      const name = statement.name.text;
      localInterfaces.set(name, statement);
      if (hasExportModifier(statement)) {
        found.push({ name, kind: "interface", signature: null });
      }
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      const name = statement.name.text;
      localTypes.set(name, statement);
      if (hasExportModifier(statement)) {
        found.push({ name, kind: "type", signature: null });
      }
      continue;
    }
    if (ts.isEnumDeclaration(statement)) {
      const name = statement.name.text;
      localEnums.set(name, statement);
      if (hasExportModifier(statement)) {
        found.push({ name, kind: "enum", signature: null });
      }
      continue;
    }
    if (ts.isModuleDeclaration(statement)) {
      const name = declarationName(statement);
      if (name) {
        const list = localNamespaces.get(name) ?? [];
        list.push(statement);
        localNamespaces.set(name, list);
      }
      if (name && hasExportModifier(statement)) {
        found.push({ name, kind: "namespace", signature: null });
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const varName = declaration.name.text;
          localVariables.set(varName, declaration.type);
          if (hasExportModifier(statement)) {
            const annotation = declaration.type ? `: ${typeText(declaration.type, source)}` : "";
            found.push({ name: varName, kind: "const", signature: `${varName}${annotation}` || null });
          }
        }
      }
      continue;
    }
    if (ts.isImportEqualsDeclaration(statement)) {
      const name = declarationName(statement);
      if (name) localImportEquals.set(name, statement);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      exportAssignment = statement;
      continue;
    }
    if (!ts.isExportDeclaration(statement)) continue;

    const moduleSpecifier = stringValue(statement.moduleSpecifier?.getText(source).replace(/^["']|["']$/g, ""));
    if (moduleSpecifier) {
      const resolved = sourcePathForReExport(source.fileName, moduleSpecifier);
      if (resolved) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          reExports.push({
            path: resolved,
            names: statement.exportClause.elements.map((element) => ({
              from: element.propertyName?.text ?? element.name.text,
              as: element.name.text,
            })),
          });
        } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
          found.push({ name: statement.exportClause.name.text, kind: "namespace", signature: null });
        } else {
          reExports.push({ path: resolved });
        }
      }
      continue;
    }
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text;
        const asName = element.name.text;
        if (namespaceImports.has(localName)) {
          found.push({ name: asName, kind: "namespace", signature: null });
        } else {
          let resolvedLocal = false;
          const fn = localFunctions.find((f) => declarationName(f) === localName);
          if (fn) {
            found.push({ name: asName, kind: "function", signature: functionSignature(fn, source, asName) });
            resolvedLocal = true;
          }
          if (localClasses.has(localName)) {
            found.push(withMembers({ name: asName, kind: "class", signature: null }, localClasses.get(localName)!, source));
            resolvedLocal = true;
          }
          if (localInterfaces.has(localName)) {
            found.push({ name: asName, kind: "interface", signature: null });
            resolvedLocal = true;
          }
          if (localTypes.has(localName)) {
            found.push({ name: asName, kind: "type", signature: null });
            resolvedLocal = true;
          }
          if (localEnums.has(localName)) {
            found.push({ name: asName, kind: "enum", signature: null });
            resolvedLocal = true;
          }
          if (localVariables.has(localName)) {
            const typeNode = localVariables.get(localName);
            const annotation = typeNode ? `: ${typeText(typeNode, source)}` : "";
            found.push({ name: asName, kind: "const", signature: `${asName}${annotation}` || null });
            resolvedLocal = true;
          }
          if (localNamespaces.has(localName)) {
            found.push({ name: asName, kind: "namespace", signature: null });
            resolvedLocal = true;
          }
          if (!resolvedLocal) {
            notes.push(`Could not verify local export ${asName} in ${source.fileName}.`);
          }
        }
      }
    }
  }

  if (exportAssignment) {
    const expression = exportAssignment.expression;
    if (ts.isIdentifier(expression)) {
      const targetName = expression.text;
      let resolvedAny = false;

      const funcDecl = localFunctions.find((f) => declarationName(f) === targetName);
      if (funcDecl) {
        found.push({
          name: "default",
          kind: "default",
          signature: functionSignature(funcDecl, source, "default"),
        });
        resolvedAny = true;
      } else if (localClasses.has(targetName)) {
        found.push({ name: "default", kind: "default", signature: null });
        resolvedAny = true;
      } else if (localVariables.has(targetName)) {
        const typeNode = localVariables.get(targetName);
        const annotation = typeNode ? `: ${typeText(typeNode, source)}` : "";
        found.push({ name: "default", kind: "default", signature: `default${annotation}` || null });
        resolvedAny = true;
      } else if (localInterfaces.has(targetName) || localTypes.has(targetName) || localEnums.has(targetName)) {
        found.push({ name: "default", kind: "default", signature: null });
        resolvedAny = true;
      }

      const importEquals = localImportEquals.get(targetName);
      if (importEquals) {
        const ref = importEquals.moduleReference;
        if (ts.isExternalModuleReference(ref) && ref.expression && ts.isStringLiteral(ref.expression)) {
          const specifier = ref.expression.text;
          const resolved = sourcePathForReExport(source.fileName, specifier);
          if (resolved) {
            reExports.push({ path: resolved });
            resolvedAny = true;
          }
        }
      }

      const nsList = localNamespaces.get(targetName);
      if (nsList && nsList.length > 0) {
        resolvedAny = true;
        for (const nsDecl of nsList) {
          extractNamespaceMembers(nsDecl, source, found);
        }
      }

      if (!resolvedAny) {
        notes.push(`Could not resolve export assignment ${targetName} in ${source.fileName}.`);
      }
    } else {
      found.push({
        name: "default",
        kind: "default",
        signature: null,
      });
    }
  }

  return { exports: found, reExports, notes };
}

function dedupeAndSort(exports: ApiExport[]): ApiExport[] {
  const byKey = new Map<string, ApiExport>();
  for (const entry of exports) {
    const key = `${entry.name}\u0000${entry.kind}`;
    const existing = byKey.get(key);
    if (!existing || (existing.signature === null && entry.signature !== null)) byKey.set(key, entry);
  }
  return [...byKey.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind) || (left.signature ?? "").localeCompare(right.signature ?? ""));
}

function fallbackTypesPackage(packageName: string): string {
  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.slice(1).split("/");
    return scope && name ? `@types/${scope}__${name}` : `@types/${packageName.slice(1)}`;
  }
  return `@types/${packageName}`;
}

export class ApiSurfaceExtractor {
  constructor(private readonly http: HttpClient = defaultHttpClient) {}

  async extract(packageName: string, version?: string): Promise<ApiSurface> {
    const id = `npm:${packageName}`;
    const notes = new Set<string>();
    const registry = await this.fetchRegistry(packageName, notes);
    const resolvedVersion = version ?? registry.version ?? null;
    if (!resolvedVersion) {
      notes.add(`Could not verify a registry version for ${packageName}.`);
      return this.result(id, null, "none", null, [], false, notes);
    }

    const ownPath = await this.findTypesPath(packageName, registry.document, resolvedVersion, notes);
    if (ownPath) {
      const own = await this.extractDeclarations(packageName, resolvedVersion, ownPath, notes);
      if (own) return this.result(id, resolvedVersion, "own", ownPath, own.exports, own.truncated, notes);
    }

    const typesPackage = fallbackTypesPackage(packageName);
    const fallbackRegistry = await this.fetchRegistry(typesPackage, notes, true);
    const fallbackVersion = fallbackRegistry.version;
    if (fallbackVersion) {
      const fallbackPath = await this.findTypesPath(typesPackage, fallbackRegistry.document, fallbackVersion, notes);
      if (fallbackPath) {
        const fallback = await this.extractDeclarations(typesPackage, fallbackVersion, fallbackPath, notes);
        if (fallback) {
          notes.add(`Used DefinitelyTyped fallback ${typesPackage}.`);
          return this.result(id, resolvedVersion, "definitely-typed", typesPackage, fallback.exports, fallback.truncated, notes);
        }
      }
    }
    notes.add(`No verifiable TypeScript declarations were available for ${packageName}.`);
    return this.result(id, resolvedVersion, "none", null, [], false, notes);
  }

  private result(
    id: string,
    version: string | null,
    typesAvailable: ApiSurface["typesAvailable"],
    typesSource: string | null,
    exports: ApiExport[],
    truncated: boolean,
    notes: Set<string>,
  ): ApiSurface {
    return ApiSurfaceSchema.parse({
      id,
      version,
      typesAvailable,
      typesSource,
      exports: dedupeAndSort(exports),
      truncated,
      notes: [...notes].sort(),
    });
  }

  private async fetchRegistry(packageName: string, notes: Set<string>, fallback = false): Promise<{ version?: string; document?: RegistryDocument }> {
    const response = await this.requestJson(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`);
    if (!response || !isRecord(response)) {
      notes.add(`Could not fetch registry metadata for ${packageName}${fallback ? " fallback" : ""}.`);
      return {};
    }
    const version = stringValue(response.version);
    if (!version) notes.add(`Registry metadata for ${packageName} has no verifiable version.`);
    return { version, document: response };
  }

  private async findTypesPath(packageName: string, registry: RegistryDocument | undefined, version: string, notes: Set<string>): Promise<string | undefined> {
    const declared = stringValue(registry?.types) ?? stringValue(registry?.typings);
    if (declared) return declared.replace(/^\.\//, "");
    const listing = await this.requestJson(`https://data.jsdelivr.com/v1/package/npm/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}/flat`);
    if (!isRecord(listing) || !Array.isArray(listing.files)) {
      notes.add(`Could not verify a declaration-file listing for ${packageName}.`);
      return undefined;
    }
    const candidates = listing.files
      .filter(isRecord)
      .map((file) => stringValue(file.name))
      .filter((name): name is string => !!name && /\.d\.(?:ts|cts|mts)$/i.test(name))
      .map((name) => name.replace(/^\//, ""))
      .sort((left, right) => (left.includes("index.d.") ? -1 : right.includes("index.d.") ? 1 : left.localeCompare(right)));
    return candidates[0];
  }

  private async extractDeclarations(packageName: string, version: string, rootPath: string, notes: Set<string>): Promise<{ exports: ApiExport[]; truncated: boolean } | undefined> {
    const files = new Map<string, Promise<{ parsed: ParsedDeclaration; truncated: boolean } | undefined>>();
    const load = async (declarationPath: string): Promise<{ parsed: ParsedDeclaration; truncated: boolean } | undefined> => {
      const existing = files.get(declarationPath);
      if (existing) return existing;
      const pending = (async () => {
        const content = await this.requestText(`https://cdn.jsdelivr.net/npm/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}/${declarationPath}`);
        if (content === undefined) {
          notes.add(`Unresolved re-export or declaration file: ${declarationPath}.`);
          return undefined;
        }
        return {
          parsed: directExports(ts.createSourceFile(declarationPath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)),
          truncated: apiFixtureTruncated(content),
        };
      })();
      files.set(declarationPath, pending);
      return pending;
    };

    const collect = async (declarationPath: string, depth: number, active: Set<string>): Promise<{ exports: ApiExport[]; truncated: boolean }> => {
      if (active.has(declarationPath)) {
        notes.add(`Re-export cycle detected at ${declarationPath}.`);
        return { exports: [], truncated: false };
      }
      const file = await load(declarationPath);
      if (!file) return { exports: [], truncated: false };
      if (file.parsed.notes) {
        for (const note of file.parsed.notes) notes.add(note);
      }
      const result = { exports: [...file.parsed.exports], truncated: file.truncated };
      if (depth >= MAX_REEXPORT_DEPTH) {
        if (file.parsed.reExports.length > 0) notes.add(`Re-export depth limit (${MAX_REEXPORT_DEPTH}) reached at ${declarationPath}.`);
        return result;
      }
      const nextActive = new Set(active).add(declarationPath);
      for (const reExport of file.parsed.reExports) {
        const child = await collect(reExport.path, depth + 1, nextActive);
        result.truncated ||= child.truncated;
        if (!reExport.names) {
          result.exports.push(...child.exports);
          continue;
        }
        for (const name of reExport.names) {
          const exported = child.exports.find((entry) => entry.name === name.from);
          if (exported) result.exports.push({ ...exported, name: name.as });
          else notes.add(`Could not verify re-export ${name.as} from ${reExport.path}.`);
        }
      }
      return result;
    };

    const collected = await collect(rootPath, 0, new Set());
    return files.has(rootPath) ? collected : undefined;
  }

  private async requestJson(url: string): Promise<unknown | undefined> {
    try {
      const response = await this.http(url);
      return response.ok ? await response.json() : undefined;
    } catch {
      return undefined;
    }
  }

  private async requestText(url: string): Promise<string | undefined> {
    try {
      const response = await this.http(url);
      if (!response.ok) return undefined;
      if (response.text) return await response.text();
      const json = await response.json();
      return typeof json === "string" ? json : undefined;
    } catch {
      return undefined;
    }
  }
}
