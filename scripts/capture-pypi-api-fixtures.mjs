// One-shot capture of PyPI API-surface + manifest source data.
// Sources: PyPI JSON API (metadata/manifest) and typeshed stubs via jsDelivr (the
// DefinitelyTyped analog for Python). Frozen under fixtures/raw/pyapi/.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const OUT = new URL("../fixtures/raw/pyapi/", import.meta.url);

// Chosen to exercise distinct cases:
//  requests / pyyaml   - typeshed stubs exist (third-party stub path)
//  numpy / attrs       - ship their own inline types (PEP 561, py.typed)
//  moviepy             - our running video example; likely no stubs (honest "none" path)
//  ffmpeg-python       - external binary prerequisite + likely no stubs
const PACKAGES = ["requests", "pyyaml", "numpy", "attrs", "moviepy", "ffmpeg-python"];

// typeshed lays stubs out as stubs/<distribution>/<import_package>/__init__.pyi
// (distribution name and import name differ, e.g. PyYAML -> yaml)
const TYPESHED = {
  requests: ["requests", "requests"],
  pyyaml: ["PyYAML", "yaml"],
  numpy: ["numpy", "numpy"],
  attrs: ["attrs", "attr"],
  moviepy: ["moviepy", "moviepy"],
  "ffmpeg-python": ["ffmpeg-python", "ffmpeg"],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, asText = false) {
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (res.status === 429) { await sleep(2000 * (a + 1)); continue; }
      if (!res.ok) return { __error: res.status, __url: url };
      return asText ? await res.text() : await res.json();
    } catch (e) {
      if (a === 2) return { __error: String(e), __url: url };
      await sleep(1000);
    }
  }
  return { __error: "retries_exhausted", __url: url };
}

async function save(rel, data) {
  const p = new URL(rel, OUT);
  await mkdir(dirname(p.pathname), { recursive: true });
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  await writeFile(p, body);
  const note = typeof data === "string" ? `${data.length} chars`
    : (data && data.__error ? `ERROR ${data.__error}` : "ok");
  console.log(`  ${rel.padEnd(44)} ${note}`);
}

for (const pkg of PACKAGES) {
  console.log(`\n== ${pkg} ==`);

  // 1. PyPI JSON — the manifest source of truth
  const meta = await get(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`);
  // Trim the huge release history; keep info + the current urls only.
  const trimmed = meta && !meta.__error
    ? { info: meta.info, urls: meta.urls, last_serial: meta.last_serial }
    : meta;
  await save(`pypi/${pkg}.json`, trimmed);

  // 2. typeshed stub (third-party stubs live under stubs/<dist>/<import_pkg>/__init__.pyi)
  const entry = TYPESHED[pkg];
  if (entry) {
    const [dist, importPkg] = entry;
    const url = `https://cdn.jsdelivr.net/gh/python/typeshed@main/stubs/${dist}/${importPkg}/__init__.pyi`;
    const text = await get(url, true);
    if (typeof text === "string") {
      await save(`typeshed/${pkg}.pyi`, text);
      await save(`typeshed/${pkg}.meta.json`, { package: pkg, distribution: dist, importPackage: importPkg, path: `stubs/${dist}/${importPkg}/__init__.pyi`, bytes: text.length });
    } else {
      await save(`typeshed/${pkg}.meta.json`, { package: pkg, distribution: dist, importPackage: importPkg, __error: text.__error, note: "no typeshed stub for this distribution" });
    }
  }

  await sleep(400);
}

console.log("\nDone.");
