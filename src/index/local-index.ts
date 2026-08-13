import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  close(): void;
}

export interface SearchOptions {
  ecosystem: string;
  limit?: number;
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
    latest_version TEXT
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
export function buildIndex(dbPath: string, records: readonly IndexRecord[]): void {
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
        ecosystem, name, description, keywords, downloads, repo_url, homepage, latest_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(`
      INSERT INTO index_fts (rowid, name, description, keywords) VALUES (?, ?, ?, ?)
    `);

    db.exec("BEGIN");
    try {
      for (const record of records) {
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
      });
    },
    close(): void {
      db.close();
    },
  };
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
