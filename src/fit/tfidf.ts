import type { FitScorer } from "../pipeline/interfaces.js";
import type { ComponentCandidate, FitSignal } from "../contracts/index.js";
import { FitSignalSchema } from "../contracts/index.js";
import { applyLexicalSignal, lexicalSignal } from "./lexical-signal.js";

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

/**
 * Tokenizes a text string into normalized tokens, including character n-grams and bigrams
 * to enable partial and phrase matching.
 */
export function tokenize(text: string): string[] {
  const rawTokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const validWords = rawTokens.filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  const tokens: string[] = [];

  // Add standard word tokens and their character ngrams
  for (const word of validWords) {
    tokens.push(word);

    if (word.length >= 3) {
      for (let size = 3; size <= Math.min(5, word.length); size++) {
        for (let i = 0; i <= word.length - size; i++) {
          const gram = word.substring(i, i + size);
          tokens.push(`char_ngram:${gram}`);
        }
      }
    }
  }

  // Add word bigrams
  for (let i = 0; i < validWords.length - 1; i++) {
    tokens.push(`bigram:${validWords[i]}_${validWords[i + 1]}`);
  }

  return tokens;
}

/**
 * TfidfFitScorer calculates the relevance of query terms against the component's name and description.
 * It weights the candidate's name more heavily (3x frequency) than its description.
 * It computes TF-IDF vectors over the current candidate set and returns cosine similarity normalized to 0..1.
 */
export class TfidfFitScorer implements FitScorer {
  async fit(query: string, candidates: ComponentCandidate[]): Promise<FitSignal[]> {
    const queryTokens = tokenize(query);

    if (queryTokens.length === 0 || candidates.length === 0) {
      return candidates.map((candidate) =>
        FitSignalSchema.parse({
          id: candidate.id,
          fitScore: 0,
          rationale: "No query terms matched the component's name or description.",
        })
      );
    }

    const N = candidates.length;

    // 1. Build document representation for each candidate
    const docs = candidates.map((c) => {
      const nameTokens = tokenize(c.name);
      const descTokens = tokenize(c.description);

      const termCounts = new Map<string, number>();
      for (const token of nameTokens) {
        termCounts.set(token, (termCounts.get(token) || 0) + 3);
      }
      for (const token of descTokens) {
        termCounts.set(token, (termCounts.get(token) || 0) + 1);
      }

      return {
        candidate: c,
        termCounts,
      };
    });

    // 2. Compute Document Frequency (DF) for each unique term
    const dfMap = new Map<string, number>();
    for (const doc of docs) {
      for (const token of doc.termCounts.keys()) {
        dfMap.set(token, (dfMap.get(token) || 0) + 1);
      }
    }

    // Helper to get IDF (smoothed)
    const getIdf = (term: string): number => {
      const df = dfMap.get(term) || 0;
      return Math.log(1 + N / (df + 1));
    };

    // 3. Compute Query Vector
    const queryCounts = new Map<string, number>();
    for (const token of queryTokens) {
      queryCounts.set(token, (queryCounts.get(token) || 0) + 1);
    }

    const queryVector = new Map<string, number>();
    let queryNormSq = 0;
    for (const [term, count] of queryCounts.entries()) {
      const idf = getIdf(term);
      const weight = count * idf;
      queryVector.set(term, weight);
      queryNormSq += weight * weight;
    }
    const queryNorm = Math.sqrt(queryNormSq);

    // 4. Compute TF-IDF weights and Cosine Similarity for each document
    return docs.map((doc) => {
      let docNormSq = 0;
      const docVector = new Map<string, number>();
      for (const [term, count] of doc.termCounts.entries()) {
        const idf = getIdf(term);
        const weight = count * idf;
        docVector.set(term, weight);
        docNormSq += weight * weight;
      }
      const docNorm = Math.sqrt(docNormSq);

      let dotProduct = 0;
      for (const [term, qWeight] of queryVector.entries()) {
        const dWeight = docVector.get(term) || 0;
        dotProduct += qWeight * dWeight;
      }

      let cosine = 0;
      if (queryNorm > 0 && docNorm > 0) {
        cosine = dotProduct / (queryNorm * docNorm);
      }

      const baseFitScore = Math.max(0, Math.min(1, cosine));
      const lexical = lexicalSignal(query, doc.candidate);
      const fitScore = applyLexicalSignal(baseFitScore, lexical);
      const rationale = `TF-IDF base ${baseFitScore.toFixed(2)}; lexical coverage ${(lexical.coverage * 100).toFixed(0)}%; keyword overlap ${(lexical.keywordOverlap * 100).toFixed(0)}%.`;

      return FitSignalSchema.parse({
        id: doc.candidate.id,
        fitScore,
        rationale,
      });
    });
  }
}
