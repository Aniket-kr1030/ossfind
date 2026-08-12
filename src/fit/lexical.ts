import type { FitScorer } from "../pipeline/interfaces.js";
import type { ComponentCandidate, FitSignal } from "../contracts/index.js";
import { FitSignalSchema } from "../contracts/index.js";

/**
 * LexicalFitScorer calculates the relevance of query terms against the component's name and description.
 * It is completely deterministic and runs offline.
 */
export class LexicalFitScorer implements FitScorer {
  async fit(query: string, candidates: ComponentCandidate[]): Promise<FitSignal[]> {
    const qTokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);

    if (qTokens.length === 0) {
      return candidates.map((candidate) =>
        FitSignalSchema.parse({
          id: candidate.id,
          fitScore: 0,
          rationale: "No search terms found in the query.",
        })
      );
    }

    return candidates.map((candidate) => {
      const nameLower = candidate.name.toLowerCase();
      const descLower = candidate.description.toLowerCase();

      const nameTokens = nameLower.split(/[^a-z0-9]+/).filter(Boolean);
      const descTokens = descLower.split(/[^a-z0-9]+/).filter(Boolean);

      const nameTokenSet = new Set(nameTokens);
      const descTokenSet = new Set(descTokens);

      let rawScore = 0;
      let nameMatches = 0;
      let descMatches = 0;

      for (const token of qTokens) {
        let tokenScore = 0;
        let matchedInName = false;
        let matchedInDesc = false;

        if (nameTokenSet.has(token)) {
          tokenScore = 3.0;
          matchedInName = true;
        } else if (nameLower.includes(token)) {
          tokenScore = 1.5;
          matchedInName = true; // substring match
        }

        if (descTokenSet.has(token)) {
          tokenScore = Math.max(tokenScore, 1.0);
          matchedInDesc = true;
        } else if (descLower.includes(token)) {
          tokenScore = Math.max(tokenScore, 0.5);
          matchedInDesc = true; // substring match
        }

        rawScore += tokenScore;
        if (matchedInName) nameMatches++;
        if (matchedInDesc) descMatches++;
      }

      const maxPossibleScore = qTokens.length * 3.0;
      const fitScore = Math.max(0, Math.min(1, rawScore / maxPossibleScore));

      // Generate a clear, human-readable rationale
      let rationale = "";
      const totalMatched = new Set(
        qTokens.filter((t) => nameLower.includes(t) || descLower.includes(t))
      ).size;

      if (totalMatched === 0) {
        rationale = "No query terms matched the component's name or description.";
      } else {
        const parts: string[] = [];
        if (nameMatches > 0) {
          parts.push(`${nameMatches} term(s) matched in name`);
        }
        if (descMatches > 0) {
          parts.push(`${descMatches} term(s) matched in description`);
        }
        rationale = `Matched ${totalMatched}/${qTokens.length} query terms (${parts.join(", ")}).`;
      }

      return FitSignalSchema.parse({
        id: candidate.id,
        fitScore,
        rationale,
      });
    });
  }
}
