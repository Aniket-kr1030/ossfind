/**
 * Relevance metrics for the labelled query set.
 *
 * Every relevance change before this file was verified by running a few queries and
 * reading the output — which is how a fix that widened discovery and then had it
 * silently truncated away produced byte-identical results and still looked correct.
 * These turn that judgement into numbers that can be compared between two runs.
 *
 * The labels are hand-authored editorial judgement, not ground truth. They are useful
 * for detecting *change* between runs of the same set; they are not an accuracy claim.
 */

export interface LabelledQuery {
  query: string;
  ecosystem: string;
  /** Packages a competent developer would accept as a correct answer. */
  relevant: string[];
  /** Packages previously observed ranking highly while plainly not answering the query. */
  irrelevant?: string[];
}

export interface QueryOutcome {
  query: string;
  ecosystem: string;
  /** Result names, best first. */
  results: string[];
  relevant: string[];
  irrelevant: string[];
}

export interface QueryScore {
  query: string;
  /** 1-based rank of the first relevant result, or null if none was returned. */
  firstRelevantRank: number | null;
  reciprocalRank: number;
  hitAt1: boolean;
  hitAt3: boolean;
  hitAt10: boolean;
  /** Fraction of labelled relevant packages that appeared anywhere in the results. */
  recall: number;
  /** A labelled-irrelevant package appeared in the top 3. */
  noiseAt3: boolean;
  topResult: string | null;
}

export interface EvalSummary {
  queries: number;
  meanReciprocalRank: number;
  hitAt1: number;
  hitAt3: number;
  hitAt10: number;
  meanRecall: number;
  noiseAt3: number;
}

function normalize(name: string): string {
  // Registries differ on case and on the -/_ boundary (PyPI especially).
  return name.trim().toLowerCase().replace(/_/g, "-");
}

export function scoreQuery(outcome: QueryOutcome): QueryScore {
  const results = outcome.results.map(normalize);
  const relevant = new Set(outcome.relevant.map(normalize));
  const irrelevant = new Set(outcome.irrelevant.map(normalize));

  const index = results.findIndex((name) => relevant.has(name));
  const firstRelevantRank = index === -1 ? null : index + 1;
  const found = new Set(results.filter((name) => relevant.has(name)));

  return {
    query: outcome.query,
    firstRelevantRank,
    reciprocalRank: firstRelevantRank === null ? 0 : 1 / firstRelevantRank,
    hitAt1: firstRelevantRank === 1,
    hitAt3: firstRelevantRank !== null && firstRelevantRank <= 3,
    hitAt10: firstRelevantRank !== null && firstRelevantRank <= 10,
    recall: relevant.size === 0 ? 0 : found.size / relevant.size,
    noiseAt3: results.slice(0, 3).some((name) => irrelevant.has(name)),
    topResult: outcome.results[0] ?? null,
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

export function summarize(scores: QueryScore[]): EvalSummary {
  return {
    queries: scores.length,
    meanReciprocalRank: mean(scores.map((score) => score.reciprocalRank)),
    hitAt1: mean(scores.map((score) => (score.hitAt1 ? 1 : 0))),
    hitAt3: mean(scores.map((score) => (score.hitAt3 ? 1 : 0))),
    hitAt10: mean(scores.map((score) => (score.hitAt10 ? 1 : 0))),
    meanRecall: mean(scores.map((score) => score.recall)),
    noiseAt3: mean(scores.map((score) => (score.noiseAt3 ? 1 : 0))),
  };
}

export interface Regression {
  query: string;
  before: number | null;
  after: number | null;
}

/**
 * Queries whose first relevant result moved further down (or disappeared).
 * Registry data drifts between runs, so a single regression is a prompt to look,
 * not proof of a defect — the aggregate summary is the reliable signal.
 */
export function regressions(before: QueryScore[], after: QueryScore[]): Regression[] {
  const previous = new Map(before.map((score) => [score.query, score]));
  const worse: Regression[] = [];

  for (const score of after) {
    const earlier = previous.get(score.query);
    if (!earlier) continue;
    const wasFound = earlier.firstRelevantRank !== null;
    const isFound = score.firstRelevantRank !== null;
    if (wasFound && (!isFound || score.firstRelevantRank! > earlier.firstRelevantRank!)) {
      worse.push({ query: score.query, before: earlier.firstRelevantRank, after: score.firstRelevantRank });
    }
  }
  return worse;
}
