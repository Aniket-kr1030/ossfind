import { z } from "zod";

export const ComponentCandidateSchema = z.object({
  id: z.string().regex(/^(npm|pypi):.+$/, 'id must use the "<ecosystem>:<name>" format'),
  name: z.string().min(1),
  ecosystem: z.string().min(1),
  description: z.string(),
  keywords: z.array(z.string()).optional(),
  repoUrl: z.string().url().optional(),
  homepage: z.string().url().optional(),
  downloads: z.number().nonnegative().optional(),
  stars: z.number().nonnegative().optional(),
  latestVersion: z.string().min(1).optional(),
  publishedAt: z.string().min(1).optional(),
});

export type ComponentCandidate = z.infer<typeof ComponentCandidateSchema>;
