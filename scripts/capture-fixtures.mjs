// One-shot fixture capture. Pulls raw JSON from ecosyste.ms, deps.dev, and OSV
// for a diverse set of npm packages, then freezes it under fixtures/raw/.
// Run once: `node scripts/capture-fixtures.mjs`. Tests must NEVER hit the network;
// they read these frozen files instead.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const OUT = new URL("../fixtures/raw/", import.meta.url);

// Diverse on purpose: varied licenses, a deprecated pkg, known-CVE pkgs,
// protestware/malware-history pkgs, tiny + huge, healthy + abandoned.
const PACKAGES = [
  "express", "lodash", "react", "axios", "chalk",
  "left-pad", "request", "moment", "minimist", "zod",
  "typescript", "vite", "node-fetch", "colors", "event-stream",
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
  const n = data && data.__error ? `ERROR ${data.__error}` : "ok";
  console.log(`  ${rel.padEnd(40)} ${n}`);
}

function repoSlug(url) {
  if (!url) return null;
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

for (const pkg of PACKAGES) {
  console.log(`\n== ${pkg} ==`);
  // 1. ecosyste.ms — discovery + license + repo url
  const eco = await getJSON(
    `https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/${encodeURIComponent(pkg)}`
  );
  await save(`ecosystems/${pkg}.json`, eco);

  // 2. deps.dev — versions + default version + deprecation
  const dd = await getJSON(
    `https://api.deps.dev/v3/systems/npm/packages/${encodeURIComponent(pkg)}`
  );
  await save(`depsdev/${pkg}.json`, dd);

  // 3. deps.dev project — OpenSSF Scorecard (keyed by repo)
  const slug = repoSlug(eco && eco.repository_url);
  if (slug) {
    const proj = await getJSON(
      `https://api.deps.dev/v3/projects/${encodeURIComponent("github.com/" + slug)}`
    );
    await save(`scorecard/${pkg}.json`, proj);
  } else {
    await save(`scorecard/${pkg}.json`, { __error: "no_repo_slug", pkg });
  }

  // 4. OSV — known vulnerabilities
  const osv = await getJSON("https://api.osv.dev/v1/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package: { ecosystem: "npm", name: pkg } }),
  });
  await save(`osv/${pkg}.json`, osv);

  await sleep(300);
}

// Also capture one discovery search result for a natural-language query,
// so the discovery adapter has a realistic search fixture.
console.log(`\n== search: "http client" ==`);
const search = await getJSON(
  `https://packages.ecosyste.ms/api/v1/packages?ecosystem=npm&sort=downloads&order=desc&keyword=http`
);
await save(`search/http-keyword.json`, search);

console.log("\nDone.");
