import type { ComponentCandidate } from "../contracts/index.js";
import { queryProbes } from "./query-probes.js";

/**
 * Shared query-expansion for registry search endpoints. Every registry ossfind talks
 * to matches text conjunctively, so all of them under-recall the best-known packages
 * for a natural-language query — this was measured on npm first, but crates.io and
 * rubygems.org behave the same way.
 */

/** One probe's result: answered (possibly with nothing) versus never answered. */
export type ProbeOutcome =
  | { ok: true; candidates: ComponentCandidate[] }
  | { ok: false };

export interface ExpandOptions {
  /** Named in the error raised when the registry refuses every probe. */
  sourceName: string;
  maxProbes?: number;
}

/**
 * Run one probe per query slice and union the answers, most faithful probe first.
 *
 * Throws when *every* probe failed. That distinction matters: a registry that refuses
 * a search must not be reported as a search that matched nothing — the caller's
 * federated layer marks the source unavailable instead, and says so in the response.
 * A partial failure keeps whatever did answer.
 */
export async function expandDiscovery(
  query: string,
  fetchOne: (text: string) => Promise<ProbeOutcome>,
  options: ExpandOptions,
): Promise<ComponentCandidate[]> {
  const probes = queryProbes(query, { maxProbes: options.maxProbes });
  if (probes.length === 0) return [];

  const settled = await Promise.all(probes.map(async (probe) => ({
    tier: probe.tier,
    outcome: await fetchOne(probe.text).catch((): ProbeOutcome => ({ ok: false })),
  })));

  if (settled.every(({ outcome }) => !outcome.ok)) {
    throw new Error(`${options.sourceName} search failed for every probe of ${JSON.stringify(query)}`);
  }

  // Earliest probe wins a duplicate: its wording was closer to what the user asked.
  const byId = new Map<string, ComponentCandidate>();
  for (const { outcome } of settled.sort((left, right) => left.tier - right.tier)) {
    if (!outcome.ok) continue;
    for (const candidate of outcome.candidates) {
      if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
    }
  }
  return [...byId.values()];
}
