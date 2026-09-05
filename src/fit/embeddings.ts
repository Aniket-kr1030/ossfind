import type { FitScorer } from "../pipeline/interfaces.js";
import type { ComponentCandidate, FitSignal } from "../contracts/index.js";
import { FitSignalSchema } from "../contracts/index.js";
import { tokenize } from "./tfidf.js";
import { applyLexicalSignal, lexicalSignal } from "./lexical-signal.js";

/**
 * Pluggable provider interface for generating text embeddings.
 */
export interface EmbeddingsProvider {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Optional extension for providers that can persist embeddings by candidate.
 * Keeping this separate preserves the small, generic EmbeddingsProvider seam
 * used by the deterministic fixture implementation.
 */
export interface CandidateEmbeddingsProvider extends EmbeddingsProvider {
  embedCandidates(candidates: ComponentCandidate[]): Promise<number[][]>;
}

/**
 * Trivial deterministic default provider that implements a feature hashing vectorizer.
 * Useful for offline and network-free testing of the embeddings pipeline.
 */
export class DefaultEmbeddingsProvider implements EmbeddingsProvider {
  async embed(texts: string[]): Promise<number[][]> {
    const DIM = 128;
    return texts.map((text) => {
      const tokens = tokenize(text);
      const vec = new Array(DIM).fill(0);

      for (const token of tokens) {
        // Compute DJB2 hash of the token
        let hash = 5381;
        for (let i = 0; i < token.length; i++) {
          hash = (hash << 5) + hash + token.charCodeAt(i);
          hash = hash & hash; // Convert to 32bit integer
        }
        const uHash = Math.abs(hash);
        const idx = uHash % DIM;

        // Use a second hash to determine sign to reduce collision interference
        let signHash = 5381;
        const signKey = token + "_sign";
        for (let i = 0; i < signKey.length; i++) {
          signHash = (signHash << 5) + signHash + signKey.charCodeAt(i);
          signHash = signHash & signHash;
        }
        const sign = Math.abs(signHash) % 2 === 0 ? 1 : -1;

        vec[idx] += sign;
      }

      // L2 Normalize the vector to unit length
      let normSq = 0;
      for (const val of vec) {
        normSq += val * val;
      }
      const norm = Math.sqrt(normSq);
      if (norm > 0) {
        for (let i = 0; i < DIM; i++) {
          vec[i] /= norm;
        }
      }

      return vec;
    });
  }
}

/**
 * EmbeddingFitScorer scores candidates by using a text embeddings provider to obtain vectors
 * for both the query and the documents, then calculating cosine similarity between them.
 */
export class EmbeddingFitScorer implements FitScorer {
  constructor(private readonly provider: EmbeddingsProvider) {}

  async fit(query: string, candidates: ComponentCandidate[]): Promise<FitSignal[]> {
    if (candidates.length === 0) {
      return [];
    }

    // Prepare text representation for each candidate (weighting name 3x by repetition)
    const candidateTexts = candidates.map((c) => {
      const namePart = `${c.name} ${c.name} ${c.name}`;
      return `${namePart} ${c.description}`;
    });

    const queryEmbedding = (await this.provider.embed([query]))[0];
    const candidateEmbeddings = isCandidateEmbeddingsProvider(this.provider)
      ? await this.provider.embedCandidates(candidates)
      : await this.provider.embed(candidateTexts);

    return candidates.map((candidate, idx) => {
      const candEmbedding = candidateEmbeddings[idx];

      // Calculate cosine similarity
      let dotProduct = 0;
      let qNormSq = 0;
      let cNormSq = 0;
      for (let i = 0; i < queryEmbedding.length; i++) {
        dotProduct += queryEmbedding[i] * candEmbedding[i];
        qNormSq += queryEmbedding[i] * queryEmbedding[i];
        cNormSq += candEmbedding[i] * candEmbedding[i];
      }

      const qNorm = Math.sqrt(qNormSq);
      const cNorm = Math.sqrt(cNormSq);
      let cosine = 0;
      if (qNorm > 0 && cNorm > 0) {
        cosine = dotProduct / (qNorm * cNorm);
      }

      const baseFitScore = Math.max(0, Math.min(1, cosine));
      const lexical = lexicalSignal(query, candidate);
      const fitScore = applyLexicalSignal(baseFitScore, lexical);

      const rationale = `semantic base ${baseFitScore.toFixed(2)}; lexical coverage ${(lexical.coverage * 100).toFixed(0)}%; keyword overlap ${(lexical.keywordOverlap * 100).toFixed(0)}%.`;

      return FitSignalSchema.parse({
        id: candidate.id,
        fitScore,
        rationale,
        lexicalCoverage: lexical.coverage,
      });
    });
  }
}

function isCandidateEmbeddingsProvider(provider: EmbeddingsProvider): provider is CandidateEmbeddingsProvider {
  return "embedCandidates" in provider && typeof provider.embedCandidates === "function";
}
