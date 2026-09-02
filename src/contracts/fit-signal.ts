import { z } from "zod";

export const FitSignalSchema = z.object({
  id: z.string().regex(/^(npm|pypi|github|huggingface|cargo|rubygems):.+$/, 'id must use the "<ecosystem>:<name>" format'),
  fitScore: z.number().min(0).max(1),
  rationale: z.string().min(1),
});

export type FitSignal = z.infer<typeof FitSignalSchema>;
