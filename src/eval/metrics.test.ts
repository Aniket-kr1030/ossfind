import { describe, expect, it } from "vitest";
import { regressions, scoreQuery, summarize } from "./metrics.js";

const base = { query: "q", ecosystem: "npm", relevant: ["marked", "markdown-it"], irrelevant: ["left-pad"] };

describe("scoreQuery", () => {
  it("scores a first-place hit", () => {
    const score = scoreQuery({ ...base, results: ["marked", "other"] });
    expect(score).toMatchObject({ firstRelevantRank: 1, reciprocalRank: 1, hitAt1: true, hitAt3: true, hitAt10: true });
  });

  it("uses the rank of the first relevant result, not the best one", () => {
    const score = scoreQuery({ ...base, results: ["noise", "markdown-it", "marked"] });
    expect(score.firstRelevantRank).toBe(2);
    expect(score.reciprocalRank).toBeCloseTo(0.5);
    expect(score.hitAt1).toBe(false);
  });

  it("reports a miss when nothing relevant was returned", () => {
    const score = scoreQuery({ ...base, results: ["a", "b", "c"] });
    expect(score).toMatchObject({ firstRelevantRank: null, reciprocalRank: 0, hitAt10: false, recall: 0 });
  });

  it("counts recall over all labelled answers", () => {
    expect(scoreQuery({ ...base, results: ["marked"] }).recall).toBeCloseTo(0.5);
    expect(scoreQuery({ ...base, results: ["marked", "markdown-it"] }).recall).toBe(1);
  });

  it("does not double-count a duplicated result", () => {
    expect(scoreQuery({ ...base, results: ["marked", "marked"] }).recall).toBeCloseTo(0.5);
  });

  it("flags a labelled-irrelevant package inside the top 3 only", () => {
    expect(scoreQuery({ ...base, results: ["a", "left-pad", "c"] }).noiseAt3).toBe(true);
    expect(scoreQuery({ ...base, results: ["a", "b", "c", "left-pad"] }).noiseAt3).toBe(false);
  });

  it.each([
    ["case", ["MARKED"]],
    ["underscore/hyphen spelling", ["markdown_it"]],
  ])("normalizes %s so registry spelling differences are not scored as misses", (_label, results) => {
    expect(scoreQuery({ ...base, results }).firstRelevantRank).toBe(1);
  });

  it("handles an empty result set", () => {
    const score = scoreQuery({ ...base, results: [] });
    expect(score.topResult).toBeNull();
    expect(score.reciprocalRank).toBe(0);
  });

  it("hitAt10 excludes a relevant result below rank 10", () => {
    const results = [...Array.from({ length: 10 }, (_u, i) => `filler-${i}`), "marked"];
    const score = scoreQuery({ ...base, results });
    expect(score.firstRelevantRank).toBe(11);
    expect(score.hitAt10).toBe(false);
  });
});

describe("summarize", () => {
  it("averages across queries", () => {
    const scores = [
      scoreQuery({ ...base, results: ["marked"] }),
      scoreQuery({ ...base, results: ["x", "y", "z"] }),
    ];
    const summary = summarize(scores);
    expect(summary.queries).toBe(2);
    expect(summary.meanReciprocalRank).toBeCloseTo(0.5);
    expect(summary.hitAt1).toBeCloseTo(0.5);
  });

  it("returns zeros rather than NaN for an empty run", () => {
    expect(summarize([])).toMatchObject({ queries: 0, meanReciprocalRank: 0, hitAt1: 0 });
  });
});

describe("regressions", () => {
  const before = [scoreQuery({ ...base, query: "a", results: ["marked"] })];

  it("reports a result that moved down", () => {
    const after = [scoreQuery({ ...base, query: "a", results: ["noise", "marked"] })];
    expect(regressions(before, after)).toEqual([{ query: "a", before: 1, after: 2 }]);
  });

  it("reports a result that disappeared", () => {
    expect(regressions(before, [scoreQuery({ ...base, query: "a", results: ["noise"] })]))
      .toEqual([{ query: "a", before: 1, after: null }]);
  });

  it("reports nothing for an improvement or a match", () => {
    const improved = [scoreQuery({ ...base, query: "a", results: ["marked", "markdown-it"] })];
    expect(regressions(before, improved)).toEqual([]);
  });

  it("ignores queries absent from the baseline", () => {
    expect(regressions(before, [scoreQuery({ ...base, query: "new", results: ["x"] })])).toEqual([]);
  });

  it("does not treat a query that was already missing as a regression", () => {
    const missing = [scoreQuery({ ...base, query: "a", results: ["x"] })];
    expect(regressions(missing, missing)).toEqual([]);
  });
});
