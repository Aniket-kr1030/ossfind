import { z } from "zod";

export const LicenseCompatResultSchema = z.object({
  compatible: z.enum(["yes", "conditional", "no"]),
  obligations: z.array(z.string()),
  notes: z.string(),
});

export type LicenseCompatResult = z.infer<typeof LicenseCompatResultSchema>;
