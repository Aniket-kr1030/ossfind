import { z } from "zod";

/** Ready-to-apply integration scaffold for an AI agent. */
export const ScaffoldSchema = z.object({
  component: z.string().min(1),
  install: z.string().min(1),
  imports: z.array(z.string().min(1)),
  snippet: z.string().min(1).nullable(),
  basedOn: z.array(
    z.object({
      name: z.string().min(1),
      signature: z.string().min(1).nullable(),
    }),
  ),
  confidence: z.enum(["verified-signatures", "import-only"]),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type Scaffold = z.infer<typeof ScaffoldSchema>;
