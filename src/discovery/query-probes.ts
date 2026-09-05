import { contentWords } from "../fit/lexical-signal.js";

/**
 * Registry search endpoints match text conjunctively: every term in the query must
 * appear in a package's name, description, or keywords. Natural-language queries
 * therefore *exclude* the best-known packages, whose descriptions are terse.
 * "command line argument parser" returns no `commander` — its description says
 * "the complete solution for node.js command-line programs" — while "command line"
 * finds it immediately.
 *
 * Probing with progressively shorter slices of the query recovers that recall. Fit
 * scoring then sorts the wider pool, which it does well: measured on the queries
 * that motivated this, the fit model already scored the irrelevant results low
 * (0.31–0.41) — they only ranked highly because nothing better had been discovered.
 */

export interface QueryProbe {
  /** Text to send to the registry search endpoint. */
  text: string;
  /**
   * Precision rank, 0 for the user's own words. Lower probes are more faithful to
   * the query, so their results win ties when the union is deduplicated.
   */
  tier: number;
}

export interface QueryProbeOptions {
  /** Hard ceiling on requests issued per search. */
  maxProbes?: number;
}

/** Below this many content words, shortening produces no probe the full query lacks. */
const UNIGRAM_MIN_WORDS = 3;
const DEFAULT_MAX_PROBES = 6;

/**
 * Expand a query into registry probes, most faithful first. Short queries expand to
 * themselves alone: measured against `http client`, adding single-word probes tripled
 * the candidate pool and recalled nothing new.
 */
export function queryProbes(query: string, options: QueryProbeOptions = {}): QueryProbe[] {
  const maxProbes = Math.max(1, options.maxProbes ?? DEFAULT_MAX_PROBES);
  const trimmed = query.trim();
  if (!trimmed) return [];

  const words = [...new Set(contentWords(trimmed))];
  const probes: QueryProbe[] = [{ text: trimmed, tier: 0 }];
  const seen = new Set([trimmed.toLowerCase()]);

  const add = (text: string, tier: number): void => {
    const key = text.toLowerCase();
    if (seen.has(key) || probes.length >= maxProbes) return;
    seen.add(key);
    probes.push({ text, tier });
  };

  // Adjacent pairs first: they are far likelier to be a real phrase than a
  // pairing of the first and last word.
  for (let index = 0; index + 1 < words.length; index += 1) add(`${words[index]} ${words[index + 1]}`, 1);
  for (let left = 0; left < words.length; left += 1) {
    for (let right = left + 2; right < words.length; right += 1) add(`${words[left]} ${words[right]}`, 2);
  }

  // Single words cast the widest net and bring the most noise, so they go last and
  // only when the query is long enough that the pairs above may all be too specific.
  if (words.length >= UNIGRAM_MIN_WORDS) {
    for (const word of words) add(word, 3);
  }

  return probes.slice(0, maxProbes);
}
