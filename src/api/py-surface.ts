import { posix as path } from "node:path";
import { ApiSurfaceSchema, type ApiSurface } from "../contracts/api-surface.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";
import { parsePyStub, type ParsedPyStub, type PyExport, type PyReExport } from "./py-stub-parser.js";
import { parseZip } from "./zip-reader.js";

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

const MAX_REEXPORT_DEPTH = 3;
// The metadata check happens before downloading the wheel. This is deliberately
// well below the ZIP reader's defensive archive limit: wheel fallback is only
// intended for small, inspectable API roots.
const MAX_WHEEL_BYTES = 3 * 1024 * 1024;

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

    const wheel = wheels.find((candidate) => candidate.size <= MAX_WHEEL_BYTES);
    if (!wheel) {
      notes.add(`Skipped PyPI wheels for ${packageName}: all exceed the ${MAX_WHEEL_BYTES} byte safety limit.`);
      return undefined;
    }

    return wheel;
  }

  private async extractOwnWheelSurface(
    packageName: string,
    distribution: string,
    document: PyPiDocument | undefined,
    notes: Set<string>,
  ): Promise<OwnWheelSurface | undefined> {
    const wheel = this.selectSmallWheel(document, packageName, notes);
    if (!wheel) return undefined;

    const bytes = await this.requestBytes(wheel.url);
    if (!bytes) {
      notes.add(`Could not fetch the selected PyPI wheel for ${packageName}.`);
      return undefined;
    }
    if (bytes.byteLength > MAX_WHEEL_BYTES) {
      notes.add(`Skipped PyPI wheel for ${packageName}: download exceeds the ${MAX_WHEEL_BYTES} byte safety limit.`);
      return undefined;
    }

    const archive = parseZip(bytes);
    if (!archive.ok) {
      notes.add(`Could not parse the selected PyPI wheel for ${packageName}: ${archive.error}`);
      return undefined;
    }

    const entryNames = new Set(archive.value.listEntryNames());
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

      const content = await archive.value.extractText(entryPath);
      if (!content.ok) {
        notes.add(`Could not extract ${entryPath} from ${wheel.filename}: ${content.error}`);
        continue;
      }

      const fromSource = entryPath.endsWith(".py");
      const parsed = parsePyStub(content.value);
      const candidate: OwnWheelSurface & { fromSource: boolean; parserNotes?: string[] } = {
        typesSource: `${wheel.filename}:${entryPath}`,
        exports: parsed.exports,
        // A .py parser intentionally recognizes only a conservative subset;
        // make that limitation visible in the structured surface as well.
        truncated: fromSource || apiFixtureTruncated(content.value),
        fromSource,
        parserNotes: parsed.notes,
      };

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
