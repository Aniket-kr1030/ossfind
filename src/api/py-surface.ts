import { posix as path } from "node:path";
import { ApiSurfaceSchema, type ApiSurface } from "../contracts/api-surface.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";
import { parsePyStub, type ParsedPyStub, type PyExport, type PyReExport } from "./py-stub-parser.js";

type ApiExport = ApiSurface["exports"][number];

interface PyPiDocument {
  info?: {
    name?: string;
    version?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface TypeshedStubLocation {
  stubPath: string;
  content: string;
}

const MAX_REEXPORT_DEPTH = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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
      return this.result(id, resolvedVersion, "none", null, [], false, notes);
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
}
