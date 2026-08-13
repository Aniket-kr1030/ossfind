// One-shot PyPI enrichment fixture capture (no API key needed).
// Pulls ecosyste.ms, deps.dev, deps.dev scorecard, and OSV for a diverse set of
// Python packages (incl. video-relevant ones) and freezes them under fixtures/raw/pypi/.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const OUT = new URL("../fixtures/raw/pypi/", import.meta.url);

const PACKAGES = [
  "requests", "urllib3", "numpy", "pillow", "flask", "pyyaml",
  "moviepy", "ffmpeg-python", "opencv-python", "imageio", "scikit-video", "diffusers",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, opts) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
      if (!res.ok) return { __error: res.status, __url: url };
      return await res.json();
    } catch (e) {
      if (attempt === 3) return { __error: String(e), __url: url };
      await sleep(1000 * (attempt + 1));
    }
  }
  return { __error: "retries_exhausted", __url: url };
}

async function save(rel, data) {
  const path = new URL(rel, OUT);
  await mkdir(dirname(path.pathname), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
  console.log(`  ${rel.padEnd(36)} ${data && data.__error ? "ERROR " + data.__error : "ok"}`);
}

function repoSlug(url) {
  if (!url) return null;
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

for (const pkg of PACKAGES) {
  console.log(`\n== ${pkg} ==`);
  const eco = await getJSON(`https://packages.ecosyste.ms/api/v1/registries/pypi.org/packages/${encodeURIComponent(pkg)}`);
  await save(`ecosystems/${pkg}.json`, eco);
  const dd = await getJSON(`https://api.deps.dev/v3/systems/pypi/packages/${encodeURIComponent(pkg)}`);
  await save(`depsdev/${pkg}.json`, dd);
  const slug = repoSlug(eco && eco.repository_url);
  if (slug) {
    const proj = await getJSON(`https://api.deps.dev/v3/projects/${encodeURIComponent("github.com/" + slug)}`);
    await save(`scorecard/${pkg}.json`, proj);
  } else {
    await save(`scorecard/${pkg}.json`, { __error: "no_repo_slug", pkg });
  }
  const osv = await getJSON("https://api.osv.dev/v1/query", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package: { ecosystem: "PyPI", name: pkg } }),
  });
  await save(`osv/${pkg}.json`, osv);
  await sleep(300);
}
console.log("\nDone.");
