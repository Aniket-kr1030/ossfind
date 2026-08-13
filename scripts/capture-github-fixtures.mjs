// One-shot GitHub discovery + repo-scorecard fixture capture (no key needed for low volume).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const OUT = new URL("../fixtures/raw/github/", import.meta.url);
const QUERIES = { "video-generation": "video generation", "video-editing": "video editing" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, headers) {
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 403 || res.status === 429) { await sleep(3000 * (a + 1)); continue; }
      if (!res.ok) return { __error: res.status };
      return await res.json();
    } catch (e) { if (a === 2) return { __error: String(e) }; await sleep(1500); }
  }
  return { __error: "retries" };
}
async function save(rel, data) {
  const p = new URL(rel, OUT); await mkdir(dirname(p.pathname), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2));
  console.log(`  ${rel.padEnd(44)} ${data && data.__error ? "ERR " + data.__error : "ok"}`);
}

const ghHeaders = { Accept: "application/vnd.github+json", "User-Agent": "ossfind-fixture" };
const repos = new Set();
for (const [slug, q] of Object.entries(QUERIES)) {
  console.log(`\n== search: ${q} ==`);
  const j = await getJSON(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=15`, ghHeaders);
  await save(`search/${slug}.json`, j);
  (j.items || []).slice(0, 8).forEach((r) => repos.add(r.full_name));
  await sleep(2500);
}
console.log(`\n== deps.dev scorecards for ${repos.size} repos ==`);
for (const full of repos) {
  const proj = await getJSON(`https://api.deps.dev/v3/projects/${encodeURIComponent("github.com/" + full)}`);
  await save(`scorecard/${full.replace("/", "__")}.json`, proj);
  await sleep(200);
}
console.log("\nDone.");
