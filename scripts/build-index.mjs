import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildIndex, defaultIndexPath } from "../src/index/local-index.ts";
import { fetchCorpus } from "../src/index/corpus.ts";
import { TransformersEmbeddingsProvider } from "../src/fit/transformers-provider.ts";

const EMBED_BATCH_SIZE = 100;

const ecosystem = process.argv[2] || process.env.INDEX_ECOSYSTEM || "pypi";
const started = Date.now();
const records = await fetchCorpus({ ecosystem });
const dbPath = process.env.INDEX_DB_PATH || defaultIndexPath(ecosystem);

await mkdir(dirname(dbPath), { recursive: true });

let embedTime = 0;
let storedEmbeddings = false;
let attemptedEmbeddings = false;
if (process.env.INDEX_EMBED === "0") {
  buildIndex(dbPath, records);
  console.log("Skipped embeddings (INDEX_EMBED=0); built an FTS-only index.");
} else {
  const provider = new TransformersEmbeddingsProvider();
  let embeddingFailure;
  attemptedEmbeddings = true;
  const embeddingStarted = Date.now();

  try {
    await buildIndex(dbPath, records, {
      embedder: {
        async embed(texts) {
          const embeddings = [];
          for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) {
            const batch = await provider.embed(texts.slice(offset, offset + EMBED_BATCH_SIZE));
            embeddings.push(...batch);
            console.log(`Embedded ${Math.min(offset + EMBED_BATCH_SIZE, texts.length)}/${texts.length} records.`);
          }
          return embeddings;
        },
      },
    });
    storedEmbeddings = true;
  } catch (error) {
    embeddingFailure = error;
  } finally {
    embedTime = Date.now() - embeddingStarted;
  }

  if (embeddingFailure) {
    const reason = embeddingFailure instanceof Error ? embeddingFailure.message : String(embeddingFailure);
    console.warn(`[ossfind] embeddings unavailable (${reason}); building an FTS-only index.`);
    buildIndex(dbPath, records);
  }
}

const embeddingSummary = storedEmbeddings
  ? ` Embeddings stored in ${embedTime}ms (~${Math.round((embedTime * 1_000) / Math.max(records.length, 1))}ms/1k records).`
  : attemptedEmbeddings
    ? ` Embedding attempt took ${embedTime}ms (~${Math.round((embedTime * 1_000) / Math.max(records.length, 1))}ms/1k records).`
  : "";
console.log(`Built ${records.length} ${ecosystem} records at ${dbPath} in ${Date.now() - started}ms.${embeddingSummary}`);
