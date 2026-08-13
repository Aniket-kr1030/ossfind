import type { FitScorer } from "../pipeline/interfaces.js";
import type { ComponentCandidate, FitSignal } from "../contracts/index.js";
import { FitSignalSchema } from "../contracts/index.js";
import { tokenize } from "./tfidf.js";

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

    const STOPWORDS = new Set([
      "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "arent",
      "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
      "cant", "cannot", "could", "couldnt", "did", "didnt", "do", "does", "doesnt", "doing", "dont",
      "down", "during", "each", "few", "for", "from", "further", "had", "hadnt", "has", "hasnt", "have",
      "havent", "having", "he", "hed", "hell", "hes", "her", "here", "heres", "hers", "herself", "him",
      "himself", "his", "how", "hows", "i", "id", "ill", "im", "ive", "if", "in", "into", "is", "isnt",
      "it", "its", "itself", "lets", "me", "more", "most", "mustnt", "my", "myself", "no", "nor", "not",
      "of", "off", "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves", "out",
      "over", "own", "same", "shant", "she", "shed", "shell", "shes", "should", "shouldnt", "so", "some",
      "such", "than", "that", "thats", "the", "their", "theirs", "them", "themselves", "then", "there",
      "theres", "these", "they", "theyd", "theyll", "theyre", "theyve", "this", "those", "through", "to",
      "too", "under", "until", "up", "very", "was", "wasnt", "we", "wed", "well", "were", "weve", "werent",
      "what", "whats", "when", "whens", "where", "wheres", "which", "while", "who", "whos", "whom",
      "why", "whys", "with", "wont", "would", "wouldnt", "you", "youd", "youll", "youre", "youve",
      "your", "yours", "yourself", "yourselves"
    ]);

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

      const fitScore = Math.max(0, Math.min(1, cosine));

      // Generate rationale based on token overlap
      let rationale = "";
      if (fitScore > 0) {
        const matchedWords = new Set<string>();
        const qRawWords = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
        const cRawWords = (candidate.name + " " + candidate.description)
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length >= 2 && !STOPWORDS.has(w));

        for (const qw of qRawWords) {
          for (const cw of cRawWords) {
            if (qw === cw || cw.includes(qw) || qw.includes(cw)) {
              matchedWords.add(qw);
            }
          }
        }

        if (matchedWords.size > 0) {
          const list = Array.from(matchedWords).join(", ");
          const strength = fitScore > 0.4 ? "strong" : "moderate";
          rationale = `${strength} semantic overlap on: ${list}`;
        } else {
          rationale = `semantic similarity score of ${fitScore.toFixed(2)}`;
        }
      } else {
        rationale = "No semantic overlap detected.";
      }

      return FitSignalSchema.parse({
        id: candidate.id,
        fitScore,
        rationale,
      });
    });
  }
}

function isCandidateEmbeddingsProvider(provider: EmbeddingsProvider): provider is CandidateEmbeddingsProvider {
  return "embedCandidates" in provider && typeof provider.embedCandidates === "function";
}
