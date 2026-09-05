import { z } from "zod";

export const FitSignalSchema = z.object({
  id: z.string().regex(/^(npm|pypi|github|huggingface|cargo|rubygems):.+$/, 'id must use the "<ecosystem>:<name>" format'),
  fitScore: z.number().min(0).max(1),
  rationale: z.string().min(1),
  /**
   * Fraction of the query's content words found in the candidate's name,
   * description or keywords. Reported separately from `fitScore` because it
   * answers a different question: fitScore is "how similar", this is "does it
   * literally say what was asked for". Mean-pooled embeddings score a long,
   * thorough description below a one-line gem that echoes the query, so a
   * complete lexical match is the evidence that survives that bias.
   */
  lexicalCoverage: z.number().min(0).max(1).optional(),
});

export type FitSignal = z.infer<typeof FitSignalSchema>;
