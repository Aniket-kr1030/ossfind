import {
  defaultIndexPath,
  openIndex,
  type LocalIndex,
} from "../index/local-index.js";
import { existsSync } from "node:fs";
import {
  ComponentCandidateSchema,
  type ComponentCandidate,
} from "../contracts/index.js";
import type { IndexRecord } from "../index/corpus.js";
import type { Discoverer } from "../pipeline/interfaces.js";

function validUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    new URL(value);
    return value;
  } catch {
    return undefined;
  }
}

function candidateFromRecord(record: IndexRecord): ComponentCandidate | undefined {
  try {
    return ComponentCandidateSchema.parse({
      id: `${record.ecosystem}:${record.name}`,
      ecosystem: record.ecosystem,
      name: record.name,
      description: record.description,
      keywords: record.keywords,
      repoUrl: validUrl(record.repoUrl),
      homepage: validUrl(record.homepage),
      latestVersion: record.latestVersion,
      downloads: record.downloads,
    });
  } catch {
    return undefined;
  }
}

/**
 * Discovers packages from the self-hosted FTS index. The database is not opened
 * until discovery (or an availability check) is requested, so an absent local
 * index remains an optional capability rather than a startup failure.
 */
export class LocalIndexDiscoverer implements Discoverer {
  private readonly cache = new Map<string, Promise<ComponentCandidate[]>>();
  private index: LocalIndex | undefined;
  private unavailable = false;

  constructor(
    private readonly ecosystem = "pypi",
    private readonly dbPath = defaultIndexPath(ecosystem),
    private readonly limit = 25,
  ) {}

  /** True when the index can be opened; false for missing or invalid databases. */
  isAvailable(): boolean {
    return this.getIndex() !== undefined;
  }

  discover(query: string): Promise<ComponentCandidate[]> {
    const cached = this.cache.get(query);
    if (cached) return cached;

    const discovery = Promise.resolve(this.search(query));
    this.cache.set(query, discovery);
    return discovery;
  }

  /** Releases the database handle when a caller owns this discoverer's lifetime. */
  close(): void {
    this.index?.close();
    this.index = undefined;
  }

  private search(query: string): ComponentCandidate[] {
    const index = this.getIndex();
    if (!index) return [];

    try {
      return index.search(query, { ecosystem: this.ecosystem, limit: this.limit })
        .flatMap((record) => {
          const candidate = candidateFromRecord(record);
          return candidate ? [candidate] : [];
        });
    } catch {
      // An index that becomes unreadable must degrade like an unavailable index.
      this.close();
      this.unavailable = true;
      return [];
    }
  }

  private getIndex(): LocalIndex | undefined {
    if (this.index) return this.index;
    if (this.unavailable) return undefined;

    // DatabaseSync creates an empty database for a missing path. Check first so
    // discovery does not turn an unavailable optional index into a stray file.
    if (!existsSync(this.dbPath)) {
      this.unavailable = true;
      return undefined;
    }

    try {
      this.index = openIndex(this.dbPath);
      return this.index;
    } catch {
      this.unavailable = true;
      return undefined;
    }
  }
}
