import { describe, expect, it } from "vitest";
import { TfidfFitScorer } from "./tfidf.js";
import { LexicalFitScorer } from "./lexical.js";
import { DefaultEmbeddingsProvider, EmbeddingFitScorer } from "./embeddings.js";
import type { ComponentCandidate } from "../contracts/index.js";

describe("TfidfFitScorer", () => {
  const scorer = new TfidfFitScorer();

  const candidates: ComponentCandidate[] = [
    {
      id: "npm:axios",
      name: "axios",
      ecosystem: "npm",
      description: "Promise based HTTP client for the browser and node.js",
    },
    {
      id: "npm:lodash",
      name: "lodash",
      ecosystem: "npm",
      description: "Lodash modular utilities.",
    },
    {
      id: "npm:got",
      name: "got",
      ecosystem: "npm",
      description: "Human-friendly and powerful HTTP request library for Node.js",
    },
  ];

  it("outranks an unrelated library by fitScore for query 'http client' and asserts ordering", async () => {
    const signals = await scorer.fit("http client", candidates);
    const signalMap = new Map(signals.map((s) => [s.id, s]));

    const axiosSignal = signalMap.get("npm:axios")!;
    const gotSignal = signalMap.get("npm:got")!;
    const lodashSignal = signalMap.get("npm:lodash")!;

    expect(axiosSignal.fitScore).toBeGreaterThan(lodashSignal.fitScore);
    expect(gotSignal.fitScore).toBeGreaterThan(lodashSignal.fitScore);
    expect(axiosSignal.fitScore).toBeGreaterThan(0);
    expect(gotSignal.fitScore).toBeGreaterThan(0);
    expect(lodashSignal.fitScore).toBe(0);

    expect(axiosSignal.rationale).toContain("lexical coverage");
    expect(lodashSignal.rationale).toContain("lexical coverage 0%");
  });

  it("demonstrates semantic-ish win over pure lexical (LexicalFitScorer)", async () => {
    // Query is "https authentication"
    const query = "https authentication";

    const testCandidates: ComponentCandidate[] = [
      {
        id: "npm:http-auth",
        name: "http-auth",
        ecosystem: "npm",
        description: "secure communication helper",
      },
      {
        id: "npm:unrelated-pkg",
        name: "unrelated-pkg",
        ecosystem: "npm",
        description: "this has authentication but does nothing else",
      },
    ];

    // Let's run lexical scorer
    const lexicalScorer = new LexicalFitScorer();
    const lexicalSignals = await lexicalScorer.fit(query, testCandidates);
    const lexicalMap = new Map(lexicalSignals.map((s) => [s.id, s]));

    // Let's run tfidf scorer
    const tfidfSignals = await scorer.fit(query, testCandidates);
    const tfidfMap = new Map(tfidfSignals.map((s) => [s.id, s]));

    const lexHttpAuth = lexicalMap.get("npm:http-auth")!;
    const lexUnrelated = lexicalMap.get("npm:unrelated-pkg")!;

    const tfidfHttpAuth = tfidfMap.get("npm:http-auth")!;
    const tfidfUnrelated = tfidfMap.get("npm:unrelated-pkg")!;

    // Lexical scorer ranks unrelated-pkg higher because of exact description word match,
    // and cannot recognize http-auth at all (relevance is 0)
    expect(lexUnrelated.fitScore).toBeGreaterThan(lexHttpAuth.fitScore);
    expect(lexHttpAuth.fitScore).toBe(0);

    // TF-IDF with character ngrams matches both terms partially in http-auth
    // (http <-> https, auth <-> authentication), and weights name 3x,
    // leading to http-auth ranking higher than unrelated-pkg.
    expect(tfidfHttpAuth.fitScore).toBeGreaterThan(tfidfUnrelated.fitScore);
  });

  it("is case insensitive", async () => {
    const signals = await scorer.fit("HTTP CLIENT", candidates);
    const signalMap = new Map(signals.map((s) => [s.id, s]));
    expect(signalMap.get("npm:axios")!.fitScore).toBeGreaterThan(0);
  });

  it("handles empty query gracefully", async () => {
    const signals = await scorer.fit("", candidates);
    expect(signals.every((s) => s.fitScore === 0)).toBe(true);
  });

  it("guarantees determinism: same inputs -> identical FitSignal[] twice", async () => {
    const run1 = await scorer.fit("http client", candidates);
    const run2 = await scorer.fit("http client", candidates);
    expect(run1).toEqual(run2);
  });

  it("validates that fitScore is always within [0,1] and rationale is non-empty", async () => {
    const signals = await scorer.fit("http client", candidates);
    for (const signal of signals) {
      expect(signal.fitScore).toBeGreaterThanOrEqual(0);
      expect(signal.fitScore).toBeLessThanOrEqual(1);
      expect(signal.rationale.length).toBeGreaterThan(0);
    }
  });
});

describe("EmbeddingFitScorer with DefaultEmbeddingsProvider", () => {
  const provider = new DefaultEmbeddingsProvider();
  const scorer = new EmbeddingFitScorer(provider);

  const candidates: ComponentCandidate[] = [
    {
      id: "npm:axios",
      name: "axios",
      ecosystem: "npm",
      description: "Promise based HTTP client for the browser and node.js",
    },
    {
      id: "npm:lodash",
      name: "lodash",
      ecosystem: "npm",
      description: "Lodash modular utilities.",
    },
  ];

  it("returns valid, deterministic scores within [0,1] and non-empty rationales", async () => {
    const run1 = await scorer.fit("http client", candidates);
    const run2 = await scorer.fit("http client", candidates);

    expect(run1).toEqual(run2);

    for (const signal of run1) {
      expect(signal.fitScore).toBeGreaterThanOrEqual(0);
      expect(signal.fitScore).toBeLessThanOrEqual(1);
      expect(signal.rationale.length).toBeGreaterThan(0);
    }

    // Verify got a non-zero similarity for axios vs lodash
    const signalMap = new Map(run1.map((s) => [s.id, s]));
    expect(signalMap.get("npm:axios")!.fitScore).toBeGreaterThan(signalMap.get("npm:lodash")!.fitScore);
  });
});
