import { z } from "zod";

export const ComponentCandidateSchema = z.object({
  id: z.string().regex(/^(npm|pypi|github|huggingface):.+$/, 'id must use the "<ecosystem>:<name>" format'),
  name: z.string().min(1),
  ecosystem: z.enum(["npm", "pypi", "github", "huggingface"]),
  description: z.string(),
  keywords: z.array(z.string()).optional(),
  repoUrl: z.string().url().optional(),
  homepage: z.string().url().optional(),
  downloads: z.number().nonnegative().optional(),
  stars: z.number().nonnegative().optional(),
  latestVersion: z.string().min(1).optional(),
  publishedAt: z.string().min(1).optional(),
  /** SPDX hint supplied by the discovery source; package metadata is enriched separately. */
  license: z.string().min(1).optional(),
  /** Source-level maintenance signal, currently supplied by GitHub repository search. */
  archived: z.boolean().optional(),
}).refine(
  ({ id, ecosystem }) => id.startsWith(`${ecosystem}:`),
  {
    message: "id prefix must match ecosystem",
    path: ["id"],
  },
);

export type ComponentCandidate = z.infer<typeof ComponentCandidateSchema>;
