// One-shot Hugging Face model-search fixture capture (no key needed).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const OUT = new URL("../fixtures/raw/huggingface/", import.meta.url);
const QUERIES = { "video-generation": "video generation", "video-editing": "video editing" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) {
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url);
      if (!res.ok) { if (res.status === 429) { await sleep(2000); continue; } return { __error: res.status }; }
      return await res.json();
    } catch (e) { if (a === 2) return { __error: String(e) }; await sleep(1200); }
  }
  return { __error: "retries" };
}
async function save(rel, data) {
  const p = new URL(rel, OUT); await mkdir(dirname(p.pathname), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2));
  console.log(`  ${rel.padEnd(36)} ${Array.isArray(data) ? data.length + " items" : (data.__error ? "ERR " + data.__error : "ok")}`);
}

for (const [slug, q] of Object.entries(QUERIES)) {
  console.log(`\n== search: ${q} ==`);
  const j = await getJSON(`https://huggingface.co/api/models?search=${encodeURIComponent(q)}&sort=downloads&direction=-1&limit=15`);
  await save(`search/${slug}.json`, j);
  await sleep(500);
}
console.log("\nDone.");
