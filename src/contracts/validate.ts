import { z } from "zod";

/** Parse an unknown value with a contract schema, throwing on invalid input. */
export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}
