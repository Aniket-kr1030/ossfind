import { posix as path } from "node:path";
import { ApiSurfaceSchema, type ApiSurface } from "../contracts/api-surface.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";
import { parsePyStub, type ParsedPyStub, type PyExport, type PyReExport } from "./py-stub-parser.js";
import { openRemoteZip, parseZip, type ZipResult } from "./zip-reader.js";

type ApiExport = ApiSurface["exports"][number];

interface PyPiDocument {
  info?: {
    name?: string;
    version?: string;
    [key: string]: unknown;
  };
  urls?: unknown;
  [key: string]: unknown;
}

interface TypeshedStubLocation {
  stubPath: string;
  content: string;
}

interface PyPiWheel {
  filename: string;
  url: string;
  size: number;
}

interface OwnWheelSurface {
  typesSource: string;
  exports: ApiExport[];
  truncated: boolean;
}

interface WheelArchive {
  listEntryNames(): string[];
  extractText(name: string): Promise<ZipResult<string>>;
}

const MAX_REEXPORT_DEPTH = 3;
// These limits apply only to resolving public re-exports from a package's own
// wheel. They keep the normal root declaration lookup cheap even for packages
// such as NumPy that fan out across many private implementation modules.
const MAX_WHEEL_REEXPORT_SUBMODULES = 15;
const MAX_WHEEL_REEXPORT_DEPTH = 2;
const MAX_WHEEL_REMOTE_FETCH_BYTES = 4 * 1024 * 1024;
// Range extraction does not download the whole wheel. This cap is deliberately
// reserved for the exceptional non-Range fallback, where parseZip still needs
// one bounded in-memory archive.
const MAX_NON_RANGE_WHEEL_BYTES = 16 * 1024 * 1024;

interface WheelImportedSymbol {
  module: string;
  originalName: string;
}

interface WheelPendingSignature {
  rootName: string;
  name: string;
  module: string;
  depth: number;
}

interface LoadedWheelModule {
  parsed: ParsedPyStub;
  imports: ReadonlyMap<string, WheelImportedSymbol>;
}

interface WheelSignatureResolution {
  exports: ApiExport[];
  parserNotes?: string[];
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function pyPiWheel(value: unknown): PyPiWheel | undefined {
  if (!isRecord(value) || value.packagetype !== "bdist_wheel") return undefined;

  const filename = stringValue(value.filename);
  const url = stringValue(value.url);
  const size = nonNegativeSafeInteger(value.size);
  if (!filename || !filename.endsWith(".whl") || !url || size === undefined) return undefined;

  try {
    const location = new URL(url);
    if (location.protocol !== "https:" || location.hostname !== "files.pythonhosted.org") return undefined;
  } catch {
    return undefined;
  }

  return { filename, url, size };
}

function apiFixtureTruncated(content: string): boolean {
  return /\/\/\s*\[fixture truncated\]|#\s*\[fixture truncated\]/i.test(content);
}

function inferKind(name: string): ApiExport["kind"] {
  if (/^[A-Z][a-zA-Z0-9]*$/.test(name) && /[a-z]/.test(name)) {
    return "class";
  }
  if (/^[A-Z0-9_]+$/.test(name) && !/[a-z]/.test(name)) {
    return "const";
  }
  return "function";
}

function dedupeAndSort(exports: ApiExport[]): ApiExport[] {
  const byKey = new Map<string, ApiExport>();
  for (const entry of exports) {
    const key = `${entry.name}\u0000${entry.kind}`;
    const existing = byKey.get(key);
    if (!existing || (existing.signature === null && entry.signature !== null)) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind) || (left.signature ?? "").localeCompare(right.signature ?? ""));
}

function isWheelImportModule(module: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(module);
}

function countParentheses(text: string): number {
  let depth = 0;
  for (const character of text) {
    if (character === "(") depth++;
    else if (character === ")") depth--;
  }
  return depth;
}

/**
 * `parsePyStub` deliberately keeps its import bookkeeping private. The wheel
 * resolver needs only module-level `from ... import ...` bindings, so retain a
 * small local scanner instead of widening the shared parser's API.
 */
function collectWheelImports(content: string, sourcePackage: string): ReadonlyMap<string, WheelImportedSymbol> {
  const imports = new Map<string, WheelImportedSymbol>();
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.length !== line.trimStart().length || !line.trimStart().startsWith("from ")) continue;

    let statement = line.replace(/#.*/, "").trim();
    let parentheses = countParentheses(statement);
    while ((parentheses > 0 || statement.endsWith("\\")) && index + 1 < lines.length) {
      index++;
      const next = (lines[index] ?? "").replace(/#.*/, "").trim();
      statement = `${statement.replace(/\\$/, "")} ${next}`;
      parentheses += countParentheses(next);
    }

    const match = /^from\s+([.A-Za-z0-9_]+)\s+import\s+(.+)$/s.exec(statement);
    if (!match?.[1] || !match[2]) continue;

    const module = resolveWheelImportModule(match[1], sourcePackage);
    if (!module) continue;

    const rawNames = match[2].trim().replace(/^\(\s*/, "").replace(/\s*\)$/, "");
    if (rawNames === "*") continue;
    for (const item of rawNames.split(",")) {
      const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/.exec(item.trim());
      if (!nameMatch?.[1]) continue;
      imports.set(nameMatch[2] ?? nameMatch[1], { module, originalName: nameMatch[1] });
    }
  }

  return imports;
}

function resolveWheelImportModule(specifier: string, sourcePackage: string): string | undefined {
  if (!specifier.startsWith(".")) return isWheelImportModule(specifier) ? specifier : undefined;

  const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  const suffix = specifier.slice(dots);
  const parts = sourcePackage.split(".");
  for (let level = 1; level < dots; level++) parts.pop();
  if (parts.length === 0) return undefined;

  const module = suffix ? `${parts.join(".")}.${suffix}` : parts.join(".");
  return isWheelImportModule(module) ? module : undefined;
}

function wheelEntryPackage(entryPath: string): string | undefined {
  const parts = entryPath.replace(/\.(?:pyi|py)$/, "").split("/");
  if (parts.length === 0 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) return undefined;
  const packageParts = parts.at(-1) === "__init__" ? parts.slice(0, -1) : parts.slice(0, -1);
  return packageParts.length > 0 ? packageParts.join(".") : undefined;
}

function wheelModuleEntryPath(module: string, entryNames: ReadonlySet<string>): string | undefined {
  const basePath = module.replace(/\./g, "/");
  return [
    `${basePath}.pyi`,
    `${basePath}/__init__.pyi`,
    `${basePath}.py`,
    `${basePath}/__init__.py`,
  ].find((entryPath) => entryNames.has(entryPath));
}

function isWithinWheelPackage(module: string, importPackage: string): boolean {
  return module === importPackage || module.startsWith(`${importPackage}.`);
}

function isUnresolvedWheelImportNote(note: string): boolean {
  return /^Exported symbol ".+" imported from .+ is declared in __all__; signature unresolvable from this stub\.$/.test(note);
}

function withPublicReExports(parsed: ParsedPyStub): ApiExport[] {
  const exports = [...parsed.exports];
  const names = new Set(exports.map((entry) => entry.name));
  for (const reExport of parsed.reExports) {
    for (const name of reExport.names ?? []) {
      if (names.has(name.as)) continue;
      names.add(name.as);
      exports.push({ name: name.as, kind: inferKind(name.as), signature: null });
    }
  }
  return exports;
}

export class PyApiSurfaceExtractor {
  constructor(private readonly http: HttpClient = defaultHttpClient) {}

  async extract(packageName: string, version?: string): Promise<ApiSurface> {
    const id = `pypi:${packageName}`;
    const notes = new Set<string>();

    const pypiData = await this.fetchPyPiMetadata(packageName, notes);
    const resolvedVersion = version ?? pypiData.version ?? null;

    if (!resolvedVersion && !pypiData.distribution) {
      notes.add(`Could not fetch PyPI metadata for ${packageName}.`);
      return this.result(id, null, "none", null, [], false, notes);
    }

    const distribution = pypiData.distribution ?? packageName;
    const stubLocation = await this.findTypeshedStub(packageName, distribution, notes);

    if (!stubLocation) {
      notes.add(`No typeshed stubs found for ${packageName}.`);
      const ownWheel = await this.extractOwnWheelSurface(packageName, distribution, pypiData.document, notes);
      if (!ownWheel) {
        return this.result(id, resolvedVersion, "none", null, [], false, notes);
      }

      return this.result(
        id,
        resolvedVersion,
        "own",
        ownWheel.typesSource,
        ownWheel.exports,
        ownWheel.truncated,
        notes,
      );
    }

    notes.add("Used typeshed stubs for Python type declarations.");
    const declarations = await this.extractDeclarations(stubLocation, notes);

    return this.result(
      id,
      resolvedVersion,
      "definitely-typed",
      stubLocation.stubPath,
      declarations.exports,
      declarations.truncated,
      notes,
    );
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

  private async fetchPyPiMetadata(packageName: string, notes: Set<string>): Promise<{ version?: string; distribution?: string; document?: PyPiDocument }> {
    const response = await this.requestJson(`https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`);
    if (!response || !isRecord(response)) {
      return {};
    }
    const info = isRecord(response.info) ? response.info : undefined;
    const version = stringValue(info?.version);
    const distribution = stringValue(info?.name);
    return { version, distribution, document: response as PyPiDocument };
  }

  private generateCandidateLocations(packageName: string, distribution: string): string[] {
    const distNames = Array.from(new Set([
      distribution,
      packageName,
      packageName.toLowerCase(),
      distribution.toLowerCase(),
      distribution.replace(/-/g, "_"),
    ]));

    const candidatePaths: string[] = [];

    for (const dist of distNames) {
      const lower = dist.toLowerCase();
      const importCandidates = Array.from(new Set([
        lower.replace(/-/g, "_"),
        lower.startsWith("py") ? lower.slice(2) : undefined,
        lower.endsWith("-python") ? lower.replace(/-python$/, "") : undefined,
        lower.endsWith("_python") ? lower.replace(/_python$/, "") : undefined,
        lower.endsWith("s") && lower.length > 3 ? lower.slice(0, -1) : undefined,
        dist,
      ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)));

      for (const importPkg of importCandidates) {
        candidatePaths.push(`stubs/${dist}/${importPkg}/__init__.pyi`);
        candidatePaths.push(`stubs/${dist}/${importPkg}.pyi`);
      }
    }

    return Array.from(new Set(candidatePaths));
  }

  private generateOwnImportCandidates(packageName: string, distribution: string): string[] {
    const distNames = Array.from(new Set([
      distribution,
      packageName,
      packageName.toLowerCase(),
      distribution.toLowerCase(),
      distribution.replace(/-/g, "_"),
    ]));

    const candidates: string[] = [];
    for (const dist of distNames) {
      const lower = dist.toLowerCase();
      candidates.push(...[
        lower.replace(/-/g, "_"),
        lower.startsWith("py") ? lower.slice(2) : undefined,
        lower.endsWith("-python") ? lower.replace(/-python$/, "") : undefined,
        lower.endsWith("_python") ? lower.replace(/_python$/, "") : undefined,
        lower.endsWith("s") && lower.length > 3 ? lower.slice(0, -1) : undefined,
        dist,
      ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0));
    }

    return Array.from(new Set(candidates))
      .filter((candidate) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(candidate));
  }

  private async findTypeshedStub(packageName: string, distribution: string, notes: Set<string>): Promise<TypeshedStubLocation | undefined> {
    const candidatePaths = this.generateCandidateLocations(packageName, distribution);

    for (const candidatePath of candidatePaths) {
      const content = await this.requestText(`https://cdn.jsdelivr.net/gh/python/typeshed@main/${candidatePath}`);
      if (content !== undefined && content.trim().length > 0) {
        return { stubPath: candidatePath, content };
      }
    }

    return undefined;
  }

  private selectSmallWheel(document: PyPiDocument | undefined, packageName: string, notes: Set<string>): PyPiWheel | undefined {
    const wheels = Array.isArray(document?.urls)
      ? document.urls.map(pyPiWheel).filter((wheel): wheel is PyPiWheel => wheel !== undefined)
      : [];

    if (wheels.length === 0) {
      notes.add(`No eligible wheel was listed in PyPI metadata for ${packageName}.`);
      return undefined;
    }

    return [...wheels].sort((left, right) =>
      left.size - right.size || left.filename.localeCompare(right.filename) || left.url.localeCompare(right.url))[0];
  }

  private async extractOwnWheelSurface(
    packageName: string,
    distribution: string,
    document: PyPiDocument | undefined,
    notes: Set<string>,
  ): Promise<OwnWheelSurface | undefined> {
    const wheel = this.selectSmallWheel(document, packageName, notes);
    if (!wheel) return undefined;

    const remote = await openRemoteZip({
      http: this.http,
      url: wheel.url,
      maxTotalBytes: MAX_WHEEL_REMOTE_FETCH_BYTES,
    });
    if (remote.ok) {
      const surface = await this.extractOwnWheelArchiveSurface(packageName, distribution, wheel, remote.value, notes);
      notes.add(`Used HTTP byte ranges to inspect ${wheel.filename} (${remote.value.bytesFetched} bytes fetched).`);
      return surface;
    }

    if (!remote.rangeUnsupported) {
      notes.add(`Could not inspect ${wheel.filename} with HTTP byte ranges: ${remote.error}`);
      return undefined;
    }

    if (wheel.size > MAX_NON_RANGE_WHEEL_BYTES) {
      notes.add(`Skipped PyPI wheel for ${packageName}: its ${wheel.size} byte full-download fallback exceeds the ${MAX_NON_RANGE_WHEEL_BYTES} byte safety limit.`);
      return undefined;
    }

    const bytes = await this.requestBytes(wheel.url);
    if (!bytes) {
      notes.add(`Could not fetch the selected PyPI wheel for ${packageName} using the non-Range fallback.`);
      return undefined;
    }
    if (bytes.byteLength > MAX_NON_RANGE_WHEEL_BYTES) {
      notes.add(`Skipped PyPI wheel for ${packageName}: download exceeds the ${MAX_NON_RANGE_WHEEL_BYTES} byte non-Range fallback safety limit.`);
      return undefined;
    }

    const archive = parseZip(bytes);
    if (!archive.ok) {
      notes.add(`Could not parse the selected PyPI wheel for ${packageName}: ${archive.error}`);
      return undefined;
    }

    notes.add(`Used bounded full-download fallback for ${wheel.filename} because the server did not honour HTTP Range requests.`);
    return this.extractOwnWheelArchiveSurface(packageName, distribution, wheel, archive.value, notes);
  }

  private async resolveOwnWheelReExportSignatures(
    rootContent: string,
    rootParsed: ParsedPyStub,
    importPackage: string,
    entryNames: ReadonlySet<string>,
    archive: WheelArchive,
  ): Promise<WheelSignatureResolution> {
    const exports = withPublicReExports(rootParsed);
    const rootImports = collectWheelImports(rootContent, importPackage);
    const unresolvedPublicNames = new Set(
      exports
        .filter((entry) => entry.signature === null && rootImports.has(entry.name))
        .map((entry) => entry.name),
    );

    const parserNotes = rootParsed.notes?.filter((note) => !isUnresolvedWheelImportNote(note));
    if (unresolvedPublicNames.size === 0) return { exports, parserNotes };

    const pending: WheelPendingSignature[] = [];
    for (const rootName of [...unresolvedPublicNames].sort((left, right) => left.localeCompare(right))) {
      const imported = rootImports.get(rootName);
      if (!imported || !isWithinWheelPackage(imported.module, importPackage)) continue;
      pending.push({ rootName, name: imported.originalName, module: imported.module, depth: 0 });
    }
    if (pending.length === 0) return { exports, parserNotes };

    const resolved = new Map<string, ApiExport>();
    const modules = new Map<string, LoadedWheelModule | undefined>();
    const seenBindings = new Set<string>();
    let moduleAttempts = 0;
    let fetchedModules = 0;

    while (pending.length > 0) {
      const grouped = new Map<string, WheelPendingSignature[]>();
      for (const binding of pending) {
        if (binding.depth > MAX_WHEEL_REEXPORT_DEPTH || resolved.has(binding.rootName)) continue;
        const bindingKey = `${binding.rootName}\u0000${binding.name}\u0000${binding.module}`;
        if (seenBindings.has(bindingKey)) continue;
        const group = grouped.get(binding.module);
        if (group) group.push(binding);
        else grouped.set(binding.module, [binding]);
      }
      pending.length = 0;
      if (grouped.size === 0) break;

      const [module, bindings] = [...grouped.entries()].sort((left, right) => {
        const leftRoots = new Set(left[1].map((binding) => binding.rootName)).size;
        const rightRoots = new Set(right[1].map((binding) => binding.rootName)).size;
        return rightRoots - leftRoots || left[0].localeCompare(right[0]);
      })[0]!;

      for (const binding of bindings) {
        seenBindings.add(`${binding.rootName}\u0000${binding.name}\u0000${binding.module}`);
      }
      for (const [otherModule, otherBindings] of grouped) {
        if (otherModule !== module) pending.push(...otherBindings);
      }

      let loaded: LoadedWheelModule | undefined;
      if (modules.has(module)) {
        loaded = modules.get(module);
      } else if (moduleAttempts < MAX_WHEEL_REEXPORT_SUBMODULES) {
        moduleAttempts++;
        const entryPath = wheelModuleEntryPath(module, entryNames);
        if (entryPath) {
          try {
            const content = await archive.extractText(entryPath);
            if (content.ok) {
              const sourcePackage = wheelEntryPackage(entryPath);
              if (sourcePackage) {
                loaded = {
                  parsed: parsePyStub(content.value),
                  imports: collectWheelImports(content.value, sourcePackage),
                };
                fetchedModules++;
              }
            }
          } catch {
            // Extraction failures leave the root's verified public name intact
            // with its existing null signature.
          }
        }
        modules.set(module, loaded);
      }

      if (!loaded) continue;
      for (const binding of bindings) {
        const matched = loaded.parsed.exports.find((entry) => entry.name === binding.name && entry.signature !== null);
        if (matched?.signature) {
          resolved.set(binding.rootName, matched);
          continue;
        }

        if (binding.depth >= MAX_WHEEL_REEXPORT_DEPTH) continue;
        const next = loaded.imports.get(binding.name);
        if (!next || !isWithinWheelPackage(next.module, importPackage)) continue;
        pending.push({
          rootName: binding.rootName,
          name: next.originalName,
          module: next.module,
          depth: binding.depth + 1,
        });
      }
    }

    const resolvedNames = new Set(resolved.keys());
    return {
      exports: exports.map((entry) => {
        const matched = entry.signature === null ? resolved.get(entry.name) : undefined;
        return matched?.signature ? { ...entry, signature: matched.signature } : entry;
      }),
      parserNotes,
      note: `Resolved ${resolvedNames.size} public re-export signatures from ${fetchedModules} wheel submodules; ${unresolvedPublicNames.size - resolvedNames.size} remained unresolved (limits: ${MAX_WHEEL_REEXPORT_SUBMODULES} submodules, ${MAX_WHEEL_REMOTE_FETCH_BYTES} range bytes, depth ${MAX_WHEEL_REEXPORT_DEPTH}).`,
    };
  }

  private async extractOwnWheelArchiveSurface(
    packageName: string,
    distribution: string,
    wheel: PyPiWheel,
    archive: WheelArchive,
    notes: Set<string>,
  ): Promise<OwnWheelSurface | undefined> {
    const entryNames = new Set(archive.listEntryNames());
    let bestSurface: (OwnWheelSurface & { fromSource: boolean; parserNotes?: string[] }) | undefined;
    let foundOwnTypes = false;
    for (const importPackage of this.generateOwnImportCandidates(packageName, distribution)) {
      const basePath = importPackage.replace(/\./g, "/");
      const prefix = `${basePath}/`;
      const stubPath = `${basePath}/__init__.pyi`;
      const sourcePath = `${basePath}/__init__.py`;
      const hasOwnTypes = entryNames.has(`${basePath}/py.typed`)
        || [...entryNames].some((entryName) => entryName.startsWith(prefix) && entryName.endsWith(".pyi"));

      if (!hasOwnTypes) continue;
      foundOwnTypes = true;

      const entryPath = entryNames.has(stubPath) ? stubPath : entryNames.has(sourcePath) ? sourcePath : undefined;
      if (!entryPath) {
        notes.add(`PEP 561 type metadata was found in ${wheel.filename}, but no root module could be extracted for ${importPackage}.`);
        continue;
      }

      const content = await archive.extractText(entryPath);
      if (!content.ok) {
        notes.add(`Could not extract ${entryPath} from ${wheel.filename}: ${content.error}`);
        continue;
      }

      const fromSource = entryPath.endsWith(".py");
      const parsed = parsePyStub(content.value);
      const resolution = await this.resolveOwnWheelReExportSignatures(
        content.value,
        parsed,
        importPackage,
        entryNames,
        archive,
      );
      const candidate: OwnWheelSurface & { fromSource: boolean; parserNotes?: string[] } = {
        typesSource: `${wheel.filename}:${entryPath}`,
        exports: resolution.exports,
        // A .py parser intentionally recognizes only a conservative subset;
        // make that limitation visible in the structured surface as well.
        truncated: fromSource || apiFixtureTruncated(content.value),
        fromSource,
        parserNotes: resolution.parserNotes,
      };
      if (resolution.note) notes.add(resolution.note);

      // A distribution can expose both a compatibility import and its primary
      // import package (attrs -> attr and attrs). Prefer stubs over source,
      // then the richer parsed root, rather than treating an arbitrary alias
      // as the whole package API.
      if (!bestSurface
        || (!candidate.fromSource && bestSurface.fromSource)
        || (candidate.fromSource === bestSurface.fromSource && candidate.exports.length > bestSurface.exports.length)) {
        bestSurface = candidate;
      }
    }

    if (!bestSurface) {
      if (!foundOwnTypes) {
        notes.add(`The selected PyPI wheel for ${packageName} has no PEP 561 marker or package stubs.`);
      }
      return undefined;
    }

    if (bestSurface.parserNotes) {
      for (const note of bestSurface.parserNotes) notes.add(note);
    }
    if (bestSurface.fromSource) {
      notes.add("Surface was parsed from package source rather than stubs and may be incomplete.");
    } else {
      notes.add("Used PEP 561 type declarations bundled in the package wheel.");
    }
    return bestSurface;
  }

  private async extractDeclarations(rootLocation: TypeshedStubLocation, notes: Set<string>): Promise<{ exports: ApiExport[]; truncated: boolean }> {
    const files = new Map<string, Promise<{ parsed: ParsedPyStub; truncated: boolean } | undefined>>();

    const load = async (stubPath: string, initialContent?: string): Promise<{ parsed: ParsedPyStub; truncated: boolean } | undefined> => {
      const existing = files.get(stubPath);
      if (existing) return existing;

      const pending = (async () => {
        const content = initialContent !== undefined
          ? initialContent
          : await this.requestText(`https://cdn.jsdelivr.net/gh/python/typeshed@main/${stubPath}`);

        if (content === undefined) {
          notes.add(`Unresolved re-export stub file: ${stubPath}.`);
          return undefined;
        }

        return {
          parsed: parsePyStub(content),
          truncated: apiFixtureTruncated(content),
        };
      })();

      files.set(stubPath, pending);
      return pending;
    };

    const resolveReExportPath = (fromStubPath: string, reExport: PyReExport, name?: { from: string; as: string }): string[] => {
      const baseDir = path.dirname(fromStubPath);
      const mod = reExport.module;

      if (mod === "./") {
        if (name) {
          return [
            path.normalize(`${baseDir}/${name.from}.pyi`),
            path.normalize(`${baseDir}/${name.from}/__init__.pyi`),
          ];
        }
        return [];
      }

      if (mod.startsWith("./") || mod.startsWith("../")) {
        const raw = path.normalize(path.join(baseDir, mod));
        return [
          `${raw}.pyi`,
          `${raw}/__init__.pyi`,
        ];
      }

      return [];
    };

    const collect = async (stubPath: string, depth: number, active: Set<string>, initialContent?: string): Promise<{ exports: ApiExport[]; truncated: boolean }> => {
      if (active.has(stubPath)) {
        notes.add(`Re-export cycle detected at ${stubPath}.`);
        return { exports: [], truncated: false };
      }

      const file = await load(stubPath, initialContent);
      if (!file) return { exports: [], truncated: false };

      if (file.parsed.notes) {
        for (const note of file.parsed.notes) notes.add(note);
      }

      const result: { exports: ApiExport[]; truncated: boolean } = {
        exports: [...file.parsed.exports],
        truncated: file.truncated,
      };

      if (depth >= MAX_REEXPORT_DEPTH) {
        if (file.parsed.reExports.length > 0) {
          notes.add(`Re-export depth limit (${MAX_REEXPORT_DEPTH}) reached at ${stubPath}.`);
        }
        return result;
      }

      const nextActive = new Set(active).add(stubPath);

      for (const reExport of file.parsed.reExports) {
        if (!reExport.names) {
          // Wildcard re-export
          const candidatePaths = resolveReExportPath(stubPath, reExport);
          let loaded = false;
          for (const candidatePath of candidatePaths) {
            const child = await collect(candidatePath, depth + 1, nextActive);
            if (files.get(candidatePath) !== undefined) {
              result.exports.push(...child.exports);
              result.truncated ||= child.truncated;
              loaded = true;
              break;
            }
          }
          if (!loaded && candidatePaths.length > 0) {
            notes.add(`Could not verify wildcard re-export from ${reExport.module}.`);
          }
          continue;
        }

        for (const name of reExport.names) {
          const candidatePaths = resolveReExportPath(stubPath, reExport, name);
          let matchedExport: ApiExport | undefined;

          for (const candidatePath of candidatePaths) {
            const child = await collect(candidatePath, depth + 1, nextActive);
            const found = child.exports.find((entry) => entry.name === name.from);
            if (found) {
              matchedExport = { ...found, name: name.as };
              result.truncated ||= child.truncated;
              break;
            }
          }

          if (matchedExport) {
            result.exports.push(matchedExport);
          } else {
            // Cannot resolve sibling stub or name within sibling stub.
            // Record the exported name with signature: null and infer kind, with an honest note.
            result.exports.push({
              name: name.as,
              kind: inferKind(name.as),
              signature: null,
            });
            notes.add(`Could not verify re-export ${name.as} from ${reExport.module}.`);
          }
        }
      }

      return result;
    };

    return collect(rootLocation.stubPath, 0, new Set(), rootLocation.content);
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

  private async requestBytes(url: string): Promise<Uint8Array | undefined> {
    try {
      const response = await this.http(url);
      if (!response.ok) return undefined;

      // HttpClient intentionally exposes only the JSON/text contract used by
      // the rest of the project. Native fetch responses (and our fixture
      // client) additionally provide arrayBuffer; keep this narrow optional
      // capability local to binary wheel retrieval rather than weakening that
      // shared boundary for every caller.
      const binaryResponse = response as typeof response & {
        arrayBuffer?: () => Promise<ArrayBuffer>;
      };
      if (typeof binaryResponse.arrayBuffer !== "function") return undefined;

      return new Uint8Array(await binaryResponse.arrayBuffer());
    } catch {
      return undefined;
    }
  }
}
