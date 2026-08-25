import { IntegrationManifestSchema, type IntegrationManifest } from "../contracts/integration-manifest.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";

interface RegistryDocument {
  version?: unknown;
  type?: unknown;
  exports?: unknown;
  module?: unknown;
  main?: unknown;
  types?: unknown;
  typings?: unknown;
  engines?: unknown;
  os?: unknown;
  cpu?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
  scripts?: unknown;
  description?: unknown;
}

const EXTERNAL_BINARIES = ["ffmpeg", "imagemagick", "cairo", "libvips", "python", "cmake", "sox"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .flatMap(([key, item]) => {
      const text = stringValue(item);
      return text ? [[key, text]] : [];
    })
    .sort(([left], [right]) => left.localeCompare(right)));
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((item) => {
    const text = stringValue(item);
    return text ? [text] : [];
  }).sort((left, right) => left.localeCompare(right));
}

function hasCondition(value: unknown, condition: "import" | "require" | "types"): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => key === condition || hasCondition(child, condition));
}

function hasBundledTypes(document: RegistryDocument): boolean {
  return !!stringValue(document.types) || !!stringValue(document.typings) || hasCondition(document.exports, "types");
}

function moduleTarget(value: unknown): "esm" | "cjs" | undefined {
  const target = stringValue(value)?.toLowerCase();
  if (!target) return undefined;
  if (/\.mjs$/.test(target)) return "esm";
  if (/\.cjs$/.test(target)) return "cjs";
  return undefined;
}

function moduleType(document: RegistryDocument): IntegrationManifest["importForm"]["moduleType"] {
  const hasImport = hasCondition(document.exports, "import");
  const hasRequire = hasCondition(document.exports, "require");
  if (hasImport && hasRequire) return "dual";

  const type = stringValue(document.type);
  if (hasImport || type === "module") return hasRequire ? "dual" : "esm";
  if (hasRequire) return "cjs";

  const exportTarget = moduleTarget(document.exports);
  if (exportTarget) return exportTarget;
  if (stringValue(document.module) && stringValue(document.main)) return "dual";
  if (stringValue(document.module)) return "esm";
  if (moduleTarget(document.main) === "esm") return "esm";
  // Node treats a package without an explicit module declaration as CommonJS.
  // The unknown state is reserved for failed/unreadable registry metadata.
  return "cjs";
}

function identifierFor(packageName: string): string {
  const words = packageName.replace(/^@/, "").split(/[\/_-]+/).filter(Boolean);
  const candidate = words.map((word, index) => index === 0 ? word : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join("");
  return candidate && /^[A-Za-z_$]/.test(candidate) ? candidate : "packageApi";
}

function importStatements(packageName: string, type: IntegrationManifest["importForm"]["moduleType"]): Pick<IntegrationManifest["importForm"], "esm" | "cjs"> {
  const identifier = identifierFor(packageName);
  return {
    esm: type === "esm" || type === "dual" ? `import ${identifier} from "${packageName}";` : null,
    cjs: type === "cjs" || type === "dual" ? `const ${identifier} = require("${packageName}");` : null,
  };
}

function typesFallback(packageName: string): string {
  if (!packageName.startsWith("@")) return `@types/${packageName}`;
  const [scope, name] = packageName.slice(1).split("/");
  return scope && name ? `@types/${scope}__${name}` : `@types/${packageName.slice(1)}`;
}

function platformOptionalDependencies(dependencies: Record<string, string>): string[] {
  return Object.keys(dependencies).filter((name) => /(?:^|[-/])(aix|android|darwin|freebsd|linux(?:musl)?|musl|openbsd|sunos|wasm32|webcontainers|win32)(?:[-/]|$)/i.test(name));
}

function externalBinaryPrerequisites(description: string | undefined): IntegrationManifest["prerequisites"] {
  if (!description) return [];
  return EXTERNAL_BINARIES.flatMap((name) => {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(
      `\\b(?:requires?|needs?|uses?)\\s+(?:an?\\s+)?${escapedName}\\b|\\b(?:api\\s+(?:to|for)|wrapper\\s+for)\\s+${escapedName}\\b|\\b${escapedName}\\s+(?:binary|executable)\\b|\\b${escapedName}\\s+is\\s+required\\b`,
      "i",
    ).exec(description);
    return match ? [{
      kind: "external-binary" as const,
      name,
      confidence: "likely" as const,
      evidence: `description: "${description}" (matched "${match[0]}")`,
    }] : [];
  });
}

export class IntegrationManifestBuilder {
  constructor(private readonly http: HttpClient = defaultHttpClient) {}

  async build(packageName: string, version?: string): Promise<IntegrationManifest> {
    const id = `npm:${packageName}`;
    const notes = new Set<string>([
      "Prerequisites include only verified package metadata and allowlisted prose hints; other external requirements may be unknown.",
    ]);
    const document = await this.fetchRegistry(packageName, notes);
    if (!document) return this.result(id, packageName, null, "unknown", null, {}, null, null, {}, [], false, notes);

    const resolvedVersion = version ?? stringValue(document.version) ?? null;
    if (!resolvedVersion) notes.add(`Registry metadata for ${packageName} has no verifiable version.`);
    const type = moduleType(document);
    const peerDependencies = stringRecord(document.peerDependencies);
    const optionalDependencies = stringRecord(document.optionalDependencies);
    const platformDependencies = platformOptionalDependencies(optionalDependencies);
    const prerequisites: IntegrationManifest["prerequisites"] = [
      ...platformDependencies.map((name) => ({
        kind: "prebuilt-native" as const,
        name,
        confidence: "verified" as const,
        evidence: `optionalDependencies.${name}: "${optionalDependencies[name]}" names a platform-specific package.`,
      })),
      ...Object.entries(peerDependencies).map(([name, range]) => ({
        kind: "peer-dependency" as const,
        name,
        confidence: "verified" as const,
        evidence: `peerDependencies.${name}: "${range}".`,
      })),
      ...externalBinaryPrerequisites(stringValue(document.description)),
    ];
    const typesPackage = await this.typesPackage(packageName, document, notes);
    return this.result(
      id,
      packageName,
      resolvedVersion,
      type,
      typesPackage,
      stringRecord(document.engines),
      stringList(document.os),
      stringList(document.cpu),
      peerDependencies,
      prerequisites,
      this.hasInstallScript(document.scripts),
      notes,
    );
  }

  private result(
    id: string,
    packageName: string,
    version: string | null,
    moduleTypeValue: IntegrationManifest["importForm"]["moduleType"],
    typesPackage: string | null,
    engines: Record<string, string>,
    os: string[] | null,
    cpu: string[] | null,
    peerDependencies: Record<string, string>,
    prerequisites: IntegrationManifest["prerequisites"],
    hasInstallScript: boolean,
    notes: Set<string>,
  ): IntegrationManifest {
    const statements = importStatements(packageName, moduleTypeValue);
    return IntegrationManifestSchema.parse({
      id,
      version,
      install: { command: `npm install ${packageName}` },
      importForm: { moduleType: moduleTypeValue, ...statements, typesPackage },
      runtime: { engines, os, cpu },
      peerDependencies,
      prerequisites: prerequisites.sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)),
      hasInstallScript,
      notes: [...notes].sort(),
    });
  }

  private async fetchRegistry(packageName: string, notes: Set<string>): Promise<RegistryDocument | undefined> {
    const document = await this.requestJson(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`);
    if (!isRecord(document)) {
      notes.add(`Could not fetch registry metadata for ${packageName}.`);
      return undefined;
    }
    return document;
  }

  private async typesPackage(packageName: string, document: RegistryDocument, notes: Set<string>): Promise<string | null> {
    if (hasBundledTypes(document)) return null;
    const candidate = typesFallback(packageName);
    const fallback = await this.requestJson(`https://registry.npmjs.org/${encodeURIComponent(candidate)}/latest`);
    if (!isRecord(fallback) || !stringValue(fallback.version) || !hasBundledTypes(fallback)) {
      notes.add(`No verifiable separate types package was available for ${packageName}.`);
      return null;
    }
    notes.add(`Verified separate types package ${candidate}.`);
    return candidate;
  }

  private hasInstallScript(scripts: unknown): boolean {
    if (!isRecord(scripts)) return false;
    return ["preinstall", "install", "postinstall"].some((name) => typeof scripts[name] === "string");
  }

  private async requestJson(url: string): Promise<unknown | undefined> {
    try {
      const response = await this.http(url);
      return response.ok ? await response.json() : undefined;
    } catch {
      return undefined;
    }
  }
}
