import { describe, expect, it } from "vitest";
import type { ComponentCandidate } from "../contracts/index.js";
import { EmbeddingFitScorer } from "./embeddings.js";

const candidates: ComponentCandidate[] = [
  {
    id: "npm:fluent-ffmpeg",
    name: "fluent-ffmpeg",
    ecosystem: "npm",
    description: "A fluent API to use FFmpeg from Node.js.",
    keywords: ["ffmpeg", "video", "audio", "transcoding"],
  },
  {
    id: "npm:html-encoding-sniffer",
    name: "html-encoding-sniffer",
    ecosystem: "npm",
    description: "Sniffs the encoding from an HTML byte stream.",
    keywords: ["html", "encoding", "sniffing"],
  },
  {
    id: "npm:left-pad",
    name: "left-pad",
    ecosystem: "npm",
    description: "String padding utility.",
    keywords: ["string", "padding"],
  },
];

describe("TransformersEmbeddingsProvider", () => {
  it.runIf(process.env.OSSFIND_TEST_MODEL === "1")(
    "semantically ranks fluent-ffmpeg above an HTML encoding parser",
    async () => {
      // Keep the provider (and therefore the model import) out of the default offline suite.
      const { TransformersEmbeddingsProvider } = await import("./transformers-provider.js");
      const scorer = new EmbeddingFitScorer(new TransformersEmbeddingsProvider());

      const signals = await scorer.fit("video encoding ffmpeg", candidates);
      const byId = new Map(signals.map((signal) => [signal.id, signal]));

      expect(byId.get("npm:fluent-ffmpeg")!.fitScore)
        .toBeGreaterThan(byId.get("npm:html-encoding-sniffer")!.fitScore);
      expect(byId.get("npm:fluent-ffmpeg")!.fitScore)
        .toBeGreaterThan(byId.get("npm:left-pad")!.fitScore);
    },
  );
});
