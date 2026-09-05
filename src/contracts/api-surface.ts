import { z } from "zod";

/** A declaration-derived npm package API surface; unknown facts are omitted. */
export const ApiSurfaceSchema = z.object({
  id: z.string().regex(/^(npm|pypi|github|huggingface|cargo|rubygems):.+$/, 'id must use the "<ecosystem>:<name>" format'),
  version: z.string().min(1).nullable(),
  typesAvailable: z.enum(["own", "definitely-typed", "none"]),
  typesSource: z.string().min(1).nullable(),
  exports: z.array(z.object({
    name: z.string().min(1),
    kind: z.enum(["function", "class", "interface", "type", "const", "enum", "namespace", "default"]),
    signature: z.string().min(1).nullable(),
    /**
     * Publicly declared members of a class export. Absent for every other kind, and
     * for a class whose declaration could not be read — an empty array would claim
     * "this class has no methods", which is a different statement.
     */
    members: z.array(z.object({
      name: z.string().min(1),
      kind: z.enum(["method", "property", "accessor", "constructor"]),
      signature: z.string().min(1).nullable(),
      static: z.boolean(),
    })).optional(),
    /** True when `members` lists only part of what the class declares. */
    membersTruncated: z.boolean().optional(),
  })),
  truncated: z.boolean(),
  notes: z.array(z.string()),
});

export type ApiSurface = z.infer<typeof ApiSurfaceSchema>;
