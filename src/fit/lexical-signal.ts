import type { ComponentCandidate } from "../contracts/index.js";

/**
 * Common English stop words excluded from lexical coverage. Keeping the list
 * here makes the coverage calculation identical for every fit implementation.
 */
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
  "your", "yours", "yourself", "yourselves",
]);

/**
 * Longest suffix difference still treated as the same word. Covers inflection
 * ("parse"/"parser", "highlight"/"highlighting", "block"/"blocks") without letting
 * a short word claim a much longer unrelated one.
 */
const MAX_INFLECTION_DIFFERENCE = 5;

/**
 * A lexical match is an exact word or a shared stem.
 *
 * This was previously an unanchored substring test in both directions, which paid
 * full credit for coincidences: "code" matched "unicode" and "barcode", and "serial"
 * matched "serialization". Requiring a common prefix of similar length drops those
 * while keeping real inflections.
 *
 * Measured honestly: on the labelled eval set this is *neutral* — MRR 0.561 either
 * way. A first attempt at 3 characters scored worse (0.509), because it broke
 * "format"/"formatting". It is kept because the matches it removes are wrong by
 * inspection, not because it improved the numbers. Tighten further only with
 * evidence; the eval already refused one such change.
 */
function matches(queryWord: string, candidateWord: string): boolean {
  if (queryWord === candidateWord) return true;

  const [shorter, longer] = queryWord.length <= candidateWord.length
    ? [queryWord, candidateWord]
    : [candidateWord, queryWord];

  if (longer.length - shorter.length > MAX_INFLECTION_DIFFERENCE) return false;
  return longer.startsWith(shorter);
}

/** Normalized content words: lower-case, distinctness left to the caller. */
export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word));
}

export interface LexicalSignal {
  /** Fraction of distinct query content words found in name, description, or keywords. */
  coverage: number;
  /** Fraction of distinct query content words found specifically in npm keywords. */
  keywordOverlap: number;
}

/**
 * Measures lexical evidence without ranking on it directly. Missing keywords
 * deliberately yield zero overlap rather than a negative signal.
 */
export function lexicalSignal(query: string, candidate: ComponentCandidate): LexicalSignal {
  const queryWords = [...new Set(contentWords(query))];
  // A query made solely of stop words should leave semantic fit untouched.
  if (queryWords.length === 0) return { coverage: 1, keywordOverlap: 0 };

  const candidateWords = contentWords(`${candidate.name} ${candidate.description} ${(candidate.keywords ?? []).join(" ")}`);
  const keywordWords = contentWords((candidate.keywords ?? []).join(" "));
  const matched = (words: string[]) => queryWords.filter((queryWord) => words.some((word) => matches(queryWord, word))).length;

  return {
    coverage: matched(candidateWords) / queryWords.length,
    keywordOverlap: matched(keywordWords) / queryWords.length,
  };
}

/**
 * Coverage preserves at least half of base semantic fit so synonym matches
 * remain viable even when their wording differs from the query.
 */
export const COVERAGE_FLOOR = 0.5;

/** Keywords can add evidence but never become a requirement for relevance. */
export const KEYWORD_OVERLAP_BONUS = 0.12;

export function applyLexicalSignal(baseFitScore: number, signal: LexicalSignal): number {
  return clamp01(
    baseFitScore * (COVERAGE_FLOOR + (1 - COVERAGE_FLOOR) * signal.coverage)
      + KEYWORD_OVERLAP_BONUS * signal.keywordOverlap,
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
