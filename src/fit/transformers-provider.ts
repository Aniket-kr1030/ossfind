import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ComponentCandidate } from "../contracts/index.js";
import type { CandidateEmbeddingsProvider } from "./embeddings.js";

export const TRANSFORMERS_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

type FeatureExtractionPipeline = (
  texts: string | string[],
  options: { pooling: "mean"; normalize: true },
) => Promise<{ tolist(): unknown[] }>;

export type TransformersPipelineLoader = (
  modelId: string,
  options: { cache_dir?: string },
) => Promise<FeatureExtractionPipeline>;

export interface TransformersEmbeddingsProviderOptions {
  /** Embeddings are persisted here; failures are treated as cache misses. */
  cacheDir?: string;
  /** Optional model cache. By default Transformers reuses its installed cache. */
  modelCacheDir?: string;
  /** Injectable only for focused tests; production uses a lazy dynamic import. */
  loader?: TransformersPipelineLoader;
}

let defaultPipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

async function defaultLoader(
  modelId: string,
  options: { cache_dir?: string },
): Promise<FeatureExtractionPipeline> {
  // Do not even import Transformers until live-mode code first asks to embed.
  const { pipeline } = await import("@huggingface/transformers");
  return pipeline("feature-extraction", modelId, options);
}

/** Candidate document deliberately keeps all discovery meaning, including npm keywords. */
export function embeddingDocument(candidate: ComponentCandidate): string {
  return `${candidate.name}. ${candidate.description}. ${(candidate.keywords ?? []).join(", ")}`;
}

function keyFor(candidate: ComponentCandidate, document: string): string {
  const documentHash = createHash("sha256").update(document).digest("hex");
  return createHash("sha256")
    .update(`${TRANSFORMERS_MODEL_ID}\0${candidate.id}\0${documentHash}`)
    .digest("hex");
}

function isEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

async function loadEmbedding(path: string): Promise<number[] | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isEmbedding(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function saveEmbedding(path: string, embedding: number[]): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, JSON.stringify(embedding), "utf8");
    await rename(temporary, path);
  } catch {
    // The disk cache is an optimisation. A failed write must not affect ranking.
  }
}

function vectorsFrom(output: { tolist(): unknown[] }, expected: number): number[][] {
  const rows = output.tolist();
  if (!Array.isArray(rows) || rows.length !== expected || !rows.every(isEmbedding)) {
    throw new Error("Transformers feature-extraction returned an unexpected embedding shape");
  }
  return rows;
}

/**
 * Local MiniLM embeddings with a process-wide lazy model and persistent
 * candidate-vector cache. Query vectors are intentionally not persisted.
 */
export class TransformersEmbeddingsProvider implements CandidateEmbeddingsProvider {
  private readonly cacheDir: string;
  private readonly modelCacheDir: string | undefined;
  private readonly loader: TransformersPipelineLoader;
  private pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

  constructor(options: TransformersEmbeddingsProviderOptions = {}) {
    this.cacheDir = options.cacheDir ?? process.env.OSSFIND_EMBEDDINGS_CACHE_DIR ?? ".cache/embeddings";
    this.modelCacheDir = options.modelCacheDir ?? process.env.OSSFIND_TRANSFORMERS_CACHE_DIR;
    this.loader = options.loader ?? defaultLoader;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getPipeline();
    return vectorsFrom(await extractor(texts, { pooling: "mean", normalize: true }), texts.length);
  }

  async embedCandidates(candidates: ComponentCandidate[]): Promise<number[][]> {
    if (candidates.length === 0) return [];

    const documents = candidates.map(embeddingDocument);
    const paths = candidates.map((candidate, index) => join(this.cacheDir, `${keyFor(candidate, documents[index])}.json`));
    const cached = await Promise.all(paths.map(loadEmbedding));
    const missing = cached
      .map((embedding, index) => ({ embedding, index }))
      .filter((entry): entry is { embedding: undefined; index: number } => entry.embedding === undefined);

    if (missing.length > 0) {
      const fresh = await this.embed(missing.map(({ index }) => documents[index]));
      await Promise.all(fresh.map((embedding, index) => saveEmbedding(paths[missing[index].index], embedding)));
      for (let index = 0; index < missing.length; index++) {
        cached[missing[index].index] = fresh[index];
      }
    }

    // Every gap is filled above; this protects callers if a future cache implementation changes.
    if (!cached.every(isEmbedding)) throw new Error("Failed to produce candidate embeddings");
    return cached;
  }

  private getPipeline(): Promise<FeatureExtractionPipeline> {
    if (this.loader === defaultLoader) {
      defaultPipelinePromise ??= defaultLoader(TRANSFORMERS_MODEL_ID, this.pipelineOptions())
        .catch((error: unknown) => {
          defaultPipelinePromise = undefined;
          throw error;
        });
      return defaultPipelinePromise;
    }

    this.pipelinePromise ??= this.loader(TRANSFORMERS_MODEL_ID, this.pipelineOptions())
      .catch((error: unknown) => {
        this.pipelinePromise = undefined;
        throw error;
      });
    return this.pipelinePromise;
  }

  private pipelineOptions(): { cache_dir?: string } {
    return this.modelCacheDir ? { cache_dir: this.modelCacheDir } : {};
  }
}
