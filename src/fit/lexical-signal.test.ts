import { describe, expect, it } from "vitest";
import type { ComponentCandidate } from "../contracts/index.js";
import {
  applyLexicalSignal,
  COVERAGE_FLOOR,
  KEYWORD_OVERLAP_BONUS,
  lexicalSignal,
} from "./lexical-signal.js";
import { TfidfFitScorer } from "./tfidf.js";
import { EmbeddingFitScorer, type EmbeddingsProvider } from "./embeddings.js";

function candidate(
  name: string,
  description: string,
  keywords?: string[],
): ComponentCandidate {
  return { id: `npm:${name}`, name, ecosystem: "npm", description, keywords };
}

describe("lexicalSignal", () => {
  it("measures distinct content-word coverage and keyword overlap", () => {
    const signal = lexicalSignal(
      "Video encoding with FFmpeg",
      candidate("fluent-ffmpeg", "A fluent API for video transcoding.", ["ffmpeg", "video"]),
    );

    expect(signal).toEqual({ coverage: 2 / 3, keywordOverlap: 2 / 3 });
  });

  it("gives empty keywords no bonus and no penalty", () => {
    const signal = lexicalSignal("http client", candidate("axios", "Promise based HTTP client."));

    expect(signal).toEqual({ coverage: 1, keywordOverlap: 0 });
    expect(applyLexicalSignal(0.8, signal)).toBe(0.8);
  });

  it("keeps a synonym-like semantic match above the coverage floor", () => {
    const signal = lexicalSignal("date parsing", candidate("date-fns", "Modern JavaScript date library."));
    const final = applyLexicalSignal(0.8, signal);

    expect(signal).toEqual({ coverage: 0.5, keywordOverlap: 0 });
    expect(final).toBeGreaterThan(COVERAGE_FLOOR * 0.8);
    expect(final).toBeCloseTo(0.6);
  });
});

describe("TF-IDF lexical signal integration", () => {
  const scorer = new TfidfFitScorer();

  it("demotes a semantically nearby but topically wrong encoding package", async () => {
    const candidates = [
      candidate("fluent-ffmpeg", "A fluent API to use FFmpeg from Node.js.", ["ffmpeg", "video", "encoding"]),
      candidate("bare-ffmpeg", "FFmpeg bindings for video encoding and codecs.", ["ffmpeg", "video", "codec"]),
      candidate("webcodecs-ffmpeg", "WebCodecs and FFmpeg video encoding for browsers.", ["webcodecs", "ffmpeg", "video"]),
      candidate("html-encoding-sniffer", "Sniffs the encoding from an HTML byte stream.", ["html", "encoding", "sniffing"]),
    ];

    const signals = await scorer.fit("video encoding ffmpeg", candidates);
    const byId = new Map(signals.map((signal) => [signal.id, signal]));
    const html = byId.get("npm:html-encoding-sniffer")!;

    for (const id of ["npm:fluent-ffmpeg", "npm:bare-ffmpeg", "npm:webcodecs-ffmpeg"]) {
      expect(byId.get(id)!.fitScore).toBeGreaterThan(html.fitScore);
    }

    // Recover and pin the untouched TF-IDF base from the final formula. The
    // html package has only one of three topical terms in its corpus/keywords.
    const htmlLexical = lexicalSignal("video encoding ffmpeg", candidates[3]);
    const previousHtmlBase = (html.fitScore - KEYWORD_OVERLAP_BONUS * htmlLexical.keywordOverlap)
      / (COVERAGE_FLOOR + (1 - COVERAGE_FLOOR) * htmlLexical.coverage);
    expect(previousHtmlBase).toBeCloseTo(0.32107, 4);
    expect(previousHtmlBase - html.fitScore).toBeGreaterThan(0.06);
    expect(html.rationale).toContain("lexical coverage 33%");
    expect(html.rationale).toContain("keyword overlap 33%");
  });

  it("retains topical winners for HTTP and synonym-style date queries", async () => {
    const httpSignals = await scorer.fit("http client", [
      candidate("axios", "Promise based HTTP client for browsers and Node.js."),
      candidate("lodash", "A utility library for JavaScript."),
    ]);
    expect(httpSignals[0].fitScore).toBeGreaterThan(httpSignals[1].fitScore);

    const dateSignals = await scorer.fit("date parsing", [
      candidate("date-fns", "Modern JavaScript date library."),
      candidate("left-pad", "String padding utility."),
    ]);
    expect(dateSignals[0].fitScore).toBeGreaterThan(dateSignals[1].fitScore);
    expect(dateSignals[0].fitScore).toBeGreaterThan(0);
  });
});

describe("embedding lexical signal integration", () => {
  it("applies the same soft synonym coverage floor to embedding fit", async () => {
    const provider: EmbeddingsProvider = {
      async embed(texts) {
        return texts.map((text) => text.includes("unrelated") ? [0, 1] : [1, 0]);
      },
    };
    const signals = await new EmbeddingFitScorer(provider).fit("date parsing", [
      candidate("date-fns", "Modern JavaScript date library."),
      candidate("unrelated", "Unrelated utility."),
    ]);

    expect(signals[0].fitScore).toBeCloseTo(0.75);
    expect(signals[0].fitScore).toBeGreaterThan(COVERAGE_FLOOR);
    expect(signals[0].fitScore).toBeGreaterThan(signals[1].fitScore);
    expect(signals[0].rationale).toContain("lexical coverage 50%");
  });
});
