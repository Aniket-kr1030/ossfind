import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EmbeddingsProvider } from "../fit/embeddings.js";
import type { IndexRecord } from "./corpus.js";

/**
 * Turns arbitrary user input into a deliberately small subset of FTS5 syntax.
 * Each token is quoted, so FTS5 operators and punctuation can never affect the
 * query's structure. Terms are ORed to retain useful partial matches while
 * BM25 places records that match more query terms first.
 */
export function sanitizeFtsQuery(query: string): string {
  return (query.match(/[A-Za-z0-9]+/g) ?? [])
    .map((term) => `"${term}"`)
    .join(" OR ");
}

export interface LocalIndex {
  search(query: string, options: SearchOptions): IndexRecord[];
  hasVectors(): boolean;
  searchVector(
    queryVector: Float32Array | number[],
    options: SearchOptions,
  ): IndexRecord[];
  searchHybrid(
    query: string,
    queryVector: Float32Array | number[],
    options: SearchOptions,
  ): IndexRecord[];
  close(): void;
}

export interface SearchOptions {
  ecosystem: string;
  limit?: number;
}

export interface BuildIndexOptions {
  /** Optional batch embedder. Omit it to retain the synchronous FTS-only build. */
  embedder?: EmbeddingsProvider;
}

/** Conventional on-disk location for an ecosystem's self-hosted index. */
export function defaultIndexPath(ecosystem: string): string {
  return join(".cache", "index", `${ecosystem}.db`);
}

const CREATE_RECORDS_TABLE = `
  CREATE TABLE index_records (
    id INTEGER PRIMARY KEY,
    ecosystem TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    keywords TEXT NOT NULL,
    downloads REAL,
    repo_url TEXT,
    homepage TEXT,
    latest_version TEXT,
    embedding BLOB,
    embedding_dim INTEGER
  )
`;

const CREATE_FTS_TABLE = `
  CREATE VIRTUAL TABLE index_fts USING fts5(
    name,
    description,
    keywords
  )
`;

/** Replaces the index at dbPath with records in a single SQLite transaction. */
export function buildIndex(dbPath: string, records: readonly IndexRecord[]): void;
export function buildIndex(
  dbPath: string,
  records: readonly IndexRecord[],
  options: BuildIndexOptions & { embedder: EmbeddingsProvider },
): Promise<void>;
export function buildIndex(
  dbPath: string,
  records: readonly IndexRecord[],
  options?: BuildIndexOptions,
): void | Promise<void>;
export function buildIndex(
  dbPath: string,
  records: readonly IndexRecord[],
  options?: BuildIndexOptions,
): void | Promise<void> {
  if (!options?.embedder) {
    writeIndex(dbPath, records);
    return;
  }

  const texts = records.map((record) => (
    `${record.name}. ${record.description}. ${record.keywords.join(" ")}`
  ));
  return options.embedder.embed(texts).then((embeddings) => {
    if (embeddings.length !== records.length) {
      throw new Error("embedder returned a different number of embeddings than input records");
    }
    const normalizedEmbeddings = embeddings.map(normalizeEmbedding);
    const dimension = normalizedEmbeddings[0]?.length;
    if (normalizedEmbeddings.some((embedding) => embedding.length !== dimension)) {
      throw new Error("embedder returned embeddings with inconsistent dimensions");
    }
    writeIndex(dbPath, records, normalizedEmbeddings);
  });
}

function writeIndex(
  dbPath: string,
  records: readonly IndexRecord[],
  embeddings?: readonly Float32Array[],
): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("DROP TABLE IF EXISTS index_fts");
    db.exec("DROP TABLE IF EXISTS index_records");
    db.exec(CREATE_RECORDS_TABLE);
    db.exec(CREATE_FTS_TABLE);
    db.exec("CREATE INDEX index_records_ecosystem ON index_records(ecosystem)");

    const insertRecord = db.prepare(`
      INSERT INTO index_records (
        ecosystem, name, description, keywords, downloads, repo_url, homepage, latest_version,
        embedding, embedding_dim
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(`
      INSERT INTO index_fts (rowid, name, description, keywords) VALUES (?, ?, ?, ?)
    `);

    db.exec("BEGIN");
    try {
      for (const [position, record] of records.entries()) {
        const embedding = embeddings?.[position];
        const keywords = record.keywords.join(" ");
        const result = insertRecord.run(
          record.ecosystem,
          record.name,
          record.description,
          JSON.stringify(record.keywords),
          record.downloads,
          record.repoUrl ?? null,
          record.homepage ?? null,
          record.latestVersion ?? null,
          embedding ?? null,
          embedding?.length ?? null,
        );
        insertFts.run(Number(result.lastInsertRowid), record.name, record.description, keywords);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

/** Opens a previously-built local package index. Call close() when finished. */
export function openIndex(dbPath: string): LocalIndex {
  const db = new DatabaseSync(dbPath);
  const searchStatement = db.prepare(`
    SELECT
      records.ecosystem,
      records.name,
      records.description,
      records.keywords,
      records.downloads,
      records.repo_url,
      records.homepage,
      records.latest_version
    FROM index_fts
    JOIN index_records AS records ON records.id = index_fts.rowid
    WHERE index_fts MATCH ? AND records.ecosystem = ?
    ORDER BY rank
    LIMIT ?
  `);
  const vectorStatement = db.prepare(`
    SELECT
      id,
      ecosystem,
      name,
      description,
      keywords,
      downloads,
      repo_url,
      homepage,
      latest_version,
      embedding,
      embedding_dim
    FROM index_records
    WHERE ecosystem = ? AND embedding IS NOT NULL AND embedding_dim > 0
  `);
  const hasVectorsStatement = db.prepare(`
    SELECT 1 FROM index_records
    WHERE embedding IS NOT NULL AND embedding_dim > 0
    LIMIT 1
  `);
  const vectorsStored = hasVectorsStatement.get() !== undefined;

  return {
    search(query: string, { ecosystem, limit = 20 }: SearchOptions): IndexRecord[] {
      const match = sanitizeFtsQuery(query);
      const maximum = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 20;
      if (!match || maximum === 0) return [];

      return searchStatement.all(match, ecosystem, maximum).map((row) => {
        const result = row as {
          ecosystem: string;
          name: string;
          description: string;
          keywords: string;
          downloads: number | null;
          repo_url: string | null;
          homepage: string | null;
          latest_version: string | null;
        };
        return indexRecordFromRow(result);
      });
    },
    hasVectors(): boolean {
      return vectorsStored;
    },
    searchVector(queryVector: Float32Array | number[], { ecosystem, limit = 20 }: SearchOptions): IndexRecord[] {
      const maximum = normalizedLimit(limit);
      const normalizedQuery = normalizeQueryVector(queryVector);
      if (!vectorsStored || maximum === 0 || !normalizedQuery) return [];

      return vectorStatement.all(ecosystem)
        .flatMap((row) => {
          const result = row as VectorRow;
          const embedding = float32FromBlob(result.embedding, result.embedding_dim);
          if (!embedding || embedding.length !== normalizedQuery.length) return [];
          return [{ id: result.id, score: dotProduct(normalizedQuery, embedding), record: indexRecordFromRow(result) }];
        })
        .sort((left, right) => right.score - left.score || left.id - right.id)
        .slice(0, maximum)
        .map((result) => result.record);
    },
    searchHybrid(
      query: string,
      queryVector: Float32Array | number[],
      { ecosystem, limit = 20 }: SearchOptions,
    ): IndexRecord[] {
      const maximum = normalizedLimit(limit);
      if (!vectorsStored) return this.search(query, { ecosystem, limit: maximum });
      if (maximum === 0) return [];

      const candidateLimit = Math.max(maximum, 20);
      const lexical = this.search(query, { ecosystem, limit: candidateLimit });
      const semantic = this.searchVector(queryVector, { ecosystem, limit: candidateLimit });
      const fused = new Map<string, { record: IndexRecord; score: number; firstRank: number }>();
      const addRanks = (results: readonly IndexRecord[]) => {
        results.forEach((record, position) => {
          const key = recordKey(record);
          const previous = fused.get(key);
          const score = (previous?.score ?? 0) + 1 / (60 + position + 1);
          fused.set(key, { record, score, firstRank: Math.min(previous?.firstRank ?? position, position) });
        });
      };
      addRanks(lexical);
      addRanks(semantic);

      return [...fused.values()]
        .sort((left, right) => right.score - left.score || left.firstRank - right.firstRank || left.record.name.localeCompare(right.record.name))
        .slice(0, maximum)
        .map((result) => result.record);
    },
    close(): void {
      db.close();
    },
  };
}

type IndexRow = {
  ecosystem: string;
  name: string;
  description: string;
  keywords: string;
  downloads: number | null;
  repo_url: string | null;
  homepage: string | null;
  latest_version: string | null;
};

type VectorRow = IndexRow & {
  id: number;
  embedding: unknown;
  embedding_dim: number;
};

function indexRecordFromRow(result: IndexRow): IndexRecord {
  return {
    ecosystem: result.ecosystem,
    name: result.name,
    description: result.description,
    keywords: parseKeywords(result.keywords),
    downloads: result.downloads ?? 0,
    repoUrl: result.repo_url ?? undefined,
    homepage: result.homepage ?? undefined,
    latestVersion: result.latest_version ?? undefined,
  };
}

function normalizeEmbedding(embedding: number[]): Float32Array {
  if (embedding.length === 0 || !embedding.every(Number.isFinite)) {
    throw new Error("embedder returned an empty or non-finite embedding");
  }
  const vector = Float32Array.from(embedding);
  let normSquared = 0;
  for (const value of vector) normSquared += value * value;
  const norm = Math.sqrt(normSquared);
  if (norm > 0) {
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  }
  return vector;
}

function normalizeQueryVector(queryVector: Float32Array | number[]): Float32Array | undefined {
  try {
    return normalizeEmbedding(Array.from(queryVector));
  } catch {
    return undefined;
  }
}

function float32FromBlob(value: unknown, dimension: number): Float32Array | undefined {
  if (!(value instanceof Uint8Array) || !Number.isSafeInteger(dimension) || dimension <= 0) return undefined;
  if (value.byteOffset % Float32Array.BYTES_PER_ELEMENT !== 0 || value.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) {
    return undefined;
  }
  return new Float32Array(value.buffer, value.byteOffset, dimension);
}

function dotProduct(left: Float32Array, right: Float32Array): number {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

function normalizedLimit(limit: number | undefined): number {
  return typeof limit === "number" && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 20;
}

function recordKey(record: IndexRecord): string {
  return `${record.ecosystem}\u0000${record.name}`;
}

function parseKeywords(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}
