import { z } from "zod";

/** A declaration-derived npm package API surface; unknown facts are omitted. */
export const ApiSurfaceSchema = z.object({
  id: z.string().regex(/^(npm|pypi|github|huggingface):.+$/, 'id must use the "<ecosystem>:<name>" format'),
  version: z.string().min(1).nullable(),
  typesAvailable: z.enum(["own", "definitely-typed", "none"]),
  typesSource: z.string().min(1).nullable(),
  exports: z.array(z.object({
    name: z.string().min(1),
    kind: z.enum(["function", "class", "interface", "type", "const", "enum", "namespace", "default"]),
    signature: z.string().min(1).nullable(),
  })),
  truncated: z.boolean(),
  notes: z.array(z.string()),
});

export type ApiSurface = z.infer<typeof ApiSurfaceSchema>;
