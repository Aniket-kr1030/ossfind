import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildIndex, defaultIndexPath } from "../src/index/local-index.ts";
import { fetchCorpus } from "../src/index/corpus.ts";

const ecosystem = process.argv[2] || process.env.INDEX_ECOSYSTEM || "pypi";
const started = Date.now();
const records = await fetchCorpus({ ecosystem });
const dbPath = process.env.INDEX_DB_PATH || defaultIndexPath(ecosystem);

await mkdir(dirname(dbPath), { recursive: true });
buildIndex(dbPath, records);
console.log(`Built ${records.length} ${ecosystem} records at ${dbPath} in ${Date.now() - started}ms.`);
