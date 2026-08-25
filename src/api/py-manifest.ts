import { IntegrationManifestSchema, type IntegrationManifest } from "../contracts/integration-manifest.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";

interface PyPiDocument {
  info?: {
    name?: unknown;
    version?: unknown;
    requires_python?: unknown;
    requires_dist?: unknown;
    summary?: unknown;
    description?: unknown;
  };
}

type PythonImportForm = NonNullable<IntegrationManifest["importForm"]["python"]>;

const EXTERNAL_BINARIES = ["ffmpeg", "imagemagick", "cairo", "libvips", "cmake", "sox"] as const;

// These are intentionally an explicit, small mapping rather than a name
// transformation. A distribution name alone is not evidence of its import name.
const VERIFIED_IMPORT_NAMES: Readonly<Record<string, string>> = {
  "attrs": "attr",
  "ffmpeg-python": "ffmpeg",
  "moviepy": "moviepy",
  "numpy": "numpy",
  "pyyaml": "yaml",
  "requests": "requests",
};

// A candidate is not reported until its own PyPI metadata confirms it exists.
const TYPE_STUB_CANDIDATES: Readonly<Record<string, string>> = {
  "requests": "types-requests",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizedDistributionName(value: string): string {
  return value.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

function packageRequest(packageName: string): { distribution: string; installTarget: string } {
  const installTarget = packageName.trim();
  const extraMarker = installTarget.indexOf("[");
  return {
    distribution: (extraMarker >= 0 ? installTarget.slice(0, extraMarker) : installTarget).trim(),
    installTarget,
  };
}

function importForm(distribution: string, notes: Set<string>): PythonImportForm {
  const importName = VERIFIED_IMPORT_NAMES[normalizedDistributionName(distribution)];
  if (!importName) {
    notes.add(`No verified Python import name was available for ${distribution}; no import statement was generated.`);
    return {
      importName: null,
      statements: [],
      confidence: "unknown",
      evidence: "No captured package metadata or maintained import-name mapping identified a top-level Python module.",
    };
  }

  return {
    importName,
    statements: [`import ${importName}`],
    confidence: "verified",
    evidence: `Verified import-name mapping: ${distribution} -> ${importName}.`,
  };
}

function externalBinaryPrerequisites(summary: string | undefined, description: string | undefined): IntegrationManifest["prerequisites"] {
  const sources = [
    ["info.summary", summary],
    ["info.description", description],
  ] as const;

  return EXTERNAL_BINARIES.flatMap((name) => {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matcher = new RegExp([
      `\\b(?:requires?|needs?|uses?)\\s+(?:an?\\s+)?${escapedName}\\b`,
      `\\b(?:api|wrapper|bindings?)\\s+(?:to|for)\\s+${escapedName}\\b`,
      `\\b(?:python\\s+)?bindings?\\s+for\\s+${escapedName}\\b`,
      `\\b${escapedName}\\s+(?:binary|executable)\\b`,
      `\\b${escapedName}\\s+is\\s+required\\b`,
    ].join("|"), "i");

    for (const [field, value] of sources) {
      if (!value) continue;
      const match = matcher.exec(value);
      if (match) {
        return [{
          kind: "external-binary" as const,
          name,
          confidence: "likely" as const,
          evidence: `${field}: "${value}" (matched "${match[0]}").`,
        }];
      }
    }

    return [];
  });
}

function runtimeRequirements(value: unknown, notes: Set<string>): IntegrationManifest["prerequisites"] {
  if (!Array.isArray(value)) return [];

  const conditional: string[] = [];
  const requirements = value.flatMap((item) => {
    const raw = stringValue(item);
    if (!raw) return [];

    const [unmarkedRequirement, ...markers] = raw.split(";");
    if (markers.length > 0) {
      conditional.push(raw);
      return [];
    }

    const name = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(unmarkedRequirement)?.[1];
    if (!name) {
      notes.add(`Could not parse PyPI runtime requirement "${raw}".`);
      return [];
    }

    return [{
      kind: "peer-dependency" as const,
      name,
      confidence: "verified" as const,
      evidence: `info.requires_dist: "${raw}".`,
    }];
  });

  if (conditional.length > 0) {
    notes.add(`Excluded ${conditional.length} marker-qualified PyPI runtime requirement${conditional.length === 1 ? "" : "s"} from unconditional prerequisites.`);
  }

  const byName = new Map<string, IntegrationManifest["prerequisites"][number]>();
  for (const requirement of requirements.sort((left, right) => left.name.localeCompare(right.name) || left.evidence.localeCompare(right.evidence))) {
    if (!byName.has(requirement.name)) byName.set(requirement.name, requirement);
  }
  return [...byName.values()];
}

export class PyIntegrationManifestBuilder {
  constructor(private readonly http: HttpClient = defaultHttpClient) {}

  async build(packageName: string, version?: string): Promise<IntegrationManifest> {
    const request = packageRequest(packageName);
    const id = `pypi:${request.distribution}`;
    const notes = new Set<string>([
      "Python runtime requirements are represented as verified peer-dependency prerequisites; marker-qualified requirements are excluded because they are conditional.",
      "External-binary prerequisites are allowlisted prose hints and are never verified.",
      "Python has no ESM/CJS split; importForm.python carries Python import evidence.",
    ]);
    const document = await this.fetchPyPi(request.distribution, notes);
    if (!document) return this.result(id, request.installTarget, request.distribution, null, {}, [], null, notes);

    const info = isRecord(document.info) ? document.info : {};
    const distribution = stringValue(info.name) ?? request.distribution;
    const resolvedVersion = version ?? stringValue(info.version) ?? null;
    if (!resolvedVersion) notes.add(`PyPI metadata for ${request.distribution} has no verifiable version.`);

    const requiresPython = stringValue(info.requires_python);
    if (!requiresPython) notes.add(`PyPI metadata for ${request.distribution} has no verified Python version requirement.`);
    const prerequisites = [
      ...runtimeRequirements(info.requires_dist, notes),
      ...externalBinaryPrerequisites(stringValue(info.summary), stringValue(info.description)),
    ];
    const typesPackage = await this.typesPackage(distribution, notes);

    return this.result(
      id,
      request.installTarget,
      distribution,
      resolvedVersion,
      requiresPython ? { python: requiresPython } : {},
      prerequisites,
      typesPackage,
      notes,
    );
  }

  private result(
    id: string,
    installTarget: string,
    distribution: string,
    version: string | null,
    engines: Record<string, string>,
    prerequisites: IntegrationManifest["prerequisites"],
    typesPackage: string | null,
    notes: Set<string>,
  ): IntegrationManifest {
    return IntegrationManifestSchema.parse({
      id,
      version,
      install: { command: `pip install ${installTarget}` },
      importForm: {
        moduleType: "unknown",
        esm: null,
        cjs: null,
        typesPackage,
        python: importForm(distribution, notes),
      },
      runtime: { engines, os: null, cpu: null },
      peerDependencies: {},
      prerequisites: prerequisites.sort((left, right) =>
        left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name) || left.evidence.localeCompare(right.evidence)),
      hasInstallScript: false,
      notes: [...notes].sort(),
    });
  }

  private async fetchPyPi(distribution: string, notes: Set<string>): Promise<PyPiDocument | undefined> {
    const document = await this.requestJson(`https://pypi.org/pypi/${encodeURIComponent(distribution)}/json`);
    if (!isRecord(document)) {
      notes.add(`Could not fetch PyPI metadata for ${distribution}.`);
      return undefined;
    }
    return document as PyPiDocument;
  }

  private async typesPackage(distribution: string, notes: Set<string>): Promise<string | null> {
    const candidate = TYPE_STUB_CANDIDATES[normalizedDistributionName(distribution)];
    if (!candidate) {
      notes.add(`No verified separate type-stub distribution was available for ${distribution}.`);
      return null;
    }

    const document = await this.requestJson(`https://pypi.org/pypi/${encodeURIComponent(candidate)}/json`);
    const info = isRecord(document) && isRecord(document.info) ? document.info : undefined;
    if (!stringValue(info?.version)) {
      notes.add(`No verified separate type-stub distribution was available for ${distribution}.`);
      return null;
    }

    notes.add(`Verified separate type-stub distribution ${candidate}.`);
    return candidate;
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
