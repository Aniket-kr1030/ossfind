import { z } from "zod";

/** Verifiable package-installation facts, with uncertainty kept explicit. */
export const IntegrationManifestSchema = z.object({
  id: z.string().regex(/^(npm|pypi|github|huggingface):.+$/, 'id must use the "<ecosystem>:<name>" format'),
  version: z.string().min(1).nullable(),
  install: z.object({ command: z.string().min(1) }),
  importForm: z.object({
    moduleType: z.enum(["esm", "cjs", "dual", "unknown"]),
    esm: z.string().min(1).nullable(),
    cjs: z.string().min(1).nullable(),
    typesPackage: z.string().min(1).nullable(),
  }),
  runtime: z.object({
    engines: z.record(z.string(), z.string()),
    os: z.array(z.string().min(1)).nullable(),
    cpu: z.array(z.string().min(1)).nullable(),
  }),
  peerDependencies: z.record(z.string(), z.string()),
  prerequisites: z.array(z.object({
    kind: z.enum(["prebuilt-native", "external-binary", "peer-dependency"]),
    name: z.string().min(1),
    confidence: z.enum(["verified", "likely", "unknown"]),
    evidence: z.string().min(1),
  })),
  hasInstallScript: z.boolean(),
  notes: z.array(z.string()),
});

export type IntegrationManifest = z.infer<typeof IntegrationManifestSchema>;
