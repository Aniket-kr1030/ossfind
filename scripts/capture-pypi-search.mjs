// Captures libraries.io PyPI search fixtures. Reads the key from .env.local
// (accepts LIBRARIES_IO_API_KEY or LIBRARY_IO_API_KEY). NEVER prints the key or full URL.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function loadKey() {
  try {
    const env = await readFile(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(/^\s*(LIBRARIES_IO_API_KEY|LIBRARY_IO_API_KEY)\s*=\s*(.+)\s*$/);
      if (m) return m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  return process.env.LIBRARIES_IO_API_KEY || process.env.LIBRARY_IO_API_KEY || "";
}

const OUT = new URL("../fixtures/raw/pypi/search/", import.meta.url);
const QUERIES = { "video-editing": "video editing", "http-client": "http client", "date-parsing": "date parsing" };

const key = await loadKey();
if (!key) { console.error("No API key found in .env.local"); process.exit(1); }

for (const [slug, q] of Object.entries(QUERIES)) {
  const url = `https://libraries.io/api/search?q=${encodeURIComponent(q)}&platforms=Pypi&per_page=15&api_key=${key}`;
  let status = "ok", data = null;
  try {
    const res = await fetch(url);
    if (!res.ok) { status = `HTTP ${res.status}`; }
    else { data = await res.json(); }
  } catch (e) {
    status = "request failed"; // deliberately not printing e (may contain the URL+key)
  }
  if (data) {
    const path = new URL(`${slug}.json`, OUT);
    await mkdir(dirname(path.pathname), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2));
    const names = Array.isArray(data) ? data.slice(0, 8).map((x) => x.name).join(", ") : "(unexpected shape)";
    console.log(`"${q}" -> ${Array.isArray(data) ? data.length : "?"} results: ${names}`);
  } else {
    console.log(`"${q}" -> ${status}`);
  }
  await new Promise((r) => setTimeout(r, 1200));
}
