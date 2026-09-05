import { describe, expect, it } from "vitest";
import { queryProbes } from "./query-probes.js";

describe("queryProbes", () => {
  it("keeps the user's own words as the most faithful probe", () => {
    const [first] = queryProbes("command line argument parser");
    expect(first).toEqual({ text: "command line argument parser", tier: 0 });
  });

  // The measured defect: npm's conjunctive match returns no `commander` for the full
  // query, but "command line" finds it immediately.
  it("emits the adjacent sub-phrase that recovers a terse-description package", () => {
    expect(queryProbes("command line argument parser").map((probe) => probe.text))
      .toContain("command line");
  });

  it("orders adjacent pairs ahead of distant ones", () => {
    const probes = queryProbes("syntax highlighting code blocks", { maxProbes: 12 });
    const adjacent = probes.findIndex((probe) => probe.text === "highlighting code");
    const distant = probes.findIndex((probe) => probe.text === "syntax blocks");
    expect(adjacent).toBeGreaterThan(-1);
    expect(distant).toBeGreaterThan(adjacent);
  });

  it.each([
    ["http client", 1],
    ["markdown parser", 1],
  ])("leaves the short query %s unexpanded, where expansion recalled nothing new", (query, expected) => {
    expect(queryProbes(query)).toHaveLength(expected);
  });

  it("adds single-word probes only once the query is long enough to over-constrain", () => {
    expect(queryProbes("http client", { maxProbes: 12 }).map((p) => p.text)).not.toContain("http");
    expect(queryProbes("client side full text search", { maxProbes: 40 }).map((p) => p.text)).toContain("search");
  });

  it("never exceeds the probe ceiling, because each probe is a request", () => {
    expect(queryProbes("a very long natural language component discovery query", { maxProbes: 4 })).toHaveLength(4);
    expect(queryProbes("client side full text search index").length).toBeLessThanOrEqual(6);
  });

  it("ignores stop words when forming sub-phrases", () => {
    const probes = queryProbes("markdown to html renderer", { maxProbes: 12 });
    expect(probes.map((probe) => probe.text)).toContain("markdown html");
    // Tier 0 is the user's verbatim query and keeps its stop words on purpose;
    // only the derived sub-phrases drop them.
    const derived = probes.filter((probe) => probe.tier > 0).map((probe) => probe.text);
    expect(derived.some((text) => text.split(" ").includes("to"))).toBe(false);
  });

  it("emits no duplicate probe text", () => {
    const texts = queryProbes("search search search index", { maxProbes: 20 }).map((probe) => probe.text);
    expect(texts).toHaveLength(new Set(texts).size);
  });

  it.each([["", 0], ["   ", 0]])("returns nothing for the empty query %o", (query, expected) => {
    expect(queryProbes(query)).toHaveLength(expected);
  });

  it("handles a query made entirely of stop words without expanding it", () => {
    expect(queryProbes("the and of")).toEqual([{ text: "the and of", tier: 0 }]);
  });
});
