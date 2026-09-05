import type { ComponentCandidate } from "../contracts/index.js";
import type { Discoverer } from "../pipeline/interfaces.js";

/**
 * These caps once bounded the cost of a search, because every candidate they let
 * through was enriched. The orchestrator now scores fit first and enriches only a
 * budgeted shortlist, so the caps are free to pass a much wider pool — which is the
 * point: truncating to 15 per source discarded the query-expansion recall before fit
 * could ever rank it. They still bound memory and keep one source from crowding out
 * the round-robin.
 */
const DEFAULT_PER_SOURCE_LIMIT = 80;
const DEFAULT_TOTAL_LIMIT = 200;
const DEFAULT_SOURCE_TIMEOUT_MS = 10_000;

export interface FederatedSource {
  name: string;
  discoverer: Discoverer;
}

/** Structural readiness reported by one discovery source. */
export interface DiscoverySourceAvailability {
  name: string;
  available: boolean;
}

/** Whether a discovery search had at least one source that could be run. */
export interface DiscoveryAvailability {
  available: boolean;
  sources: DiscoverySourceAvailability[];
}

interface AvailabilityAwareDiscoverer extends Discoverer {
  isAvailable(): boolean;
}

function isAvailabilityAware(discoverer: Discoverer): discoverer is AvailabilityAwareDiscoverer {
  return typeof (discoverer as Partial<AvailabilityAwareDiscoverer>).isAvailable === "function";
}

function sourceAvailable(discoverer: Discoverer): boolean {
  if (!isAvailabilityAware(discoverer)) return true;
  try {
    return discoverer.isAvailable();
  } catch {
    return false;
  }
}

export interface FederatedDiscovererOptions {
  perSourceLimit?: number;
  totalLimit?: number;
  /** Bounds a single unhealthy source without blocking other source results. */
  sourceTimeoutMs?: number;
  /** Injectable for tests and hosts that provide their own logging. */
  warn?: (message: string) => void;
}

function limit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Math.max(0, Math.floor(value));
}

function withinTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("source timed out")), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

/**
 * Combines independently-operating discovery sources into one resilient source.
 * Source order is priority order; successful candidates are then round-robined
 * across sources to prevent a source from dominating the head of the result.
 */
export class FederatedDiscoverer implements Discoverer {
  private readonly perSourceLimit: number;
  private readonly totalLimit: number;
  private readonly sourceTimeoutMs: number;
  private readonly warn: (message: string) => void;
  private readonly warnedSources = new Set<string>();
  private readonly provenance = new Map<string, Set<string>>();
  private lastAvailability: DiscoveryAvailability;

  constructor(
    private readonly sources: FederatedSource[],
    options: FederatedDiscovererOptions = {},
  ) {
    this.perSourceLimit = limit(options.perSourceLimit, DEFAULT_PER_SOURCE_LIMIT);
    this.totalLimit = limit(options.totalLimit, DEFAULT_TOTAL_LIMIT);
    this.sourceTimeoutMs = limit(options.sourceTimeoutMs, DEFAULT_SOURCE_TIMEOUT_MS);
    this.warn = options.warn ?? console.warn;
    this.lastAvailability = this.currentAvailability();
  }

  /**
   * Reports source readiness independently of candidates, so callers never
   * have to infer an empty search space from an empty candidate list.
   */
  availability(): DiscoveryAvailability {
    return this.lastAvailability;
  }

  /** Lets a federation participate as an availability-aware source itself. */
  isAvailable(): boolean {
    return this.currentAvailability().available;
  }

  async discover(query: string): Promise<ComponentCandidate[]> {
    const availability = this.currentAvailability();
    this.lastAvailability = availability;
    const runnable = this.sources
      .map((source, index) => ({ source, index, available: availability.sources[index].available }))
      .filter((entry) => entry.available);
    const settled = await Promise.allSettled(runnable.map(({ source }) =>
      withinTimeout(Promise.resolve().then(() => source.discoverer.discover(query)), this.sourceTimeoutMs),
    ));
    const candidatesBySource: ComponentCandidate[][] = this.sources.map(() => []);

    settled.forEach((result, runnableIndex) => {
      const { source, index } = runnable[runnableIndex];
      if (result.status === "rejected") {
        this.warnUnavailable(source.name);
        return;
      }
      candidatesBySource[index] = result.value.slice(0, this.perSourceLimit);
    });

    return this.roundRobinDeduplicate(candidatesBySource);
  }

  private currentAvailability(): DiscoveryAvailability {
    const sources = this.sources.map((source) => ({
      name: source.name,
      available: sourceAvailable(source.discoverer),
    }));
    return {
      available: sources.some((source) => source.available),
      sources,
    };
  }

  private roundRobinDeduplicate(candidatesBySource: ComponentCandidate[][]): ComponentCandidate[] {
    const candidates: ComponentCandidate[] = [];
    const seen = new Set<string>();
    this.provenance.clear();

    for (let position = 0; candidates.length < this.totalLimit; position += 1) {
      let foundCandidate = false;

      for (let sourceIndex = 0; sourceIndex < candidatesBySource.length; sourceIndex += 1) {
        const candidate = candidatesBySource[sourceIndex][position];
        if (!candidate) continue;
        foundCandidate = true;

        const sourceName = this.sources[sourceIndex].name;
        const candidateSources = this.provenance.get(candidate.id) ?? new Set<string>();
        candidateSources.add(sourceName);
        this.provenance.set(candidate.id, candidateSources);

        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        candidates.push(candidate);
        if (candidates.length === this.totalLimit) break;
      }

      if (!foundCandidate) break;
    }

    return candidates;
  }

  private warnUnavailable(sourceName: string): void {
    if (this.warnedSources.has(sourceName)) return;
    this.warnedSources.add(sourceName);
    this.warn(`[ossfind] discovery source unavailable: ${sourceName}.`);
  }
}
