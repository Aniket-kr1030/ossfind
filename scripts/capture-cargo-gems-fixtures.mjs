// One-shot fixture capture for the crates.io (Rust) and RubyGems ecosystems.
// Sources per package: registry search, registry metadata, ecosyste.ms, deps.dev,
// deps.dev project (OpenSSF Scorecard), and OSV. Frozen under fixtures/raw/{cargo,rubygems}/.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const OUT = new URL("../fixtures/raw/", import.meta.url);
const UA = { "User-Agent": "ossfind-fixture-capture (+https://github.com/Aniket-kr1030/ossfind)" };

// Chosen to exercise distinct cases: very popular, known-CVE, and small/plain packages.
const ECOSYSTEMS = {
  cargo: {
    dir: "cargo",
    packages: ["serde", "tokio", "reqwest", "clap", "smallvec"],
    ecosystemsRegistry: "crates.io",
    depsDevSystem: "cargo",
    osvEcosystem: "crates.io",
    searchQueries: { "http-client": "http client", "json-serialization": "json serialization" },
    searchUrl: (q) => `https://crates.io/api/v1/crates?q=${encodeURIComponent(q)}&per_page=15`,
    metaUrl: (p) => `https://crates.io/api/v1/crates/${encodeURIComponent(p)}`,
  },
  rubygems: {
    dir: "rubygems",
    packages: ["rails", "nokogiri", "rack", "sinatra", "puma"],
    ecosystemsRegistry: "rubygems.org",
    depsDevSystem: "rubygems",
    osvEcosystem: "RubyGems",
    searchQueries: { "http-client": "http client", "web-framework": "web framework" },
    searchUrl: (q) => `https://rubygems.org/api/v1/search.json?query=${encodeURIComponent(q)}`,
    metaUrl: (p) => `https://rubygems.org/api/v1/gems/${encodeURIComponent(p)}.json`,
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, init) {
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { headers: UA, ...init });
      if (res.status === 429) { await sleep(2500 * (a + 1)); continue; }
      if (!res.ok) return { __error: res.status, __url: url };
      return await res.json();
    } catch (e) {
      if (a === 2) return { __error: String(e), __url: url };
      await sleep(1200);
    }
  }
  return { __error: "retries_exhausted", __url: url };
}

async function save(rel, data) {
  const p = new URL(rel, OUT);
  await mkdir(dirname(p.pathname), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2));
  console.log(`  ${rel.padEnd(44)} ${data && data.__error ? "ERROR " + data.__error : "ok"}`);
}

function repoSlug(url) {
  if (!url) return null;
  const m = String(url).match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

for (const [name, cfg] of Object.entries(ECOSYSTEMS)) {
  console.log(`\n======== ${name} ========`);

  for (const [slug, query] of Object.entries(cfg.searchQueries)) {
    console.log(`\n== search: "${query}" ==`);
    await save(`${cfg.dir}/search/${slug}.json`, await get(cfg.searchUrl(query)));
    await sleep(600);
  }

  for (const pkg of cfg.packages) {
    console.log(`\n== ${pkg} ==`);
    await save(`${cfg.dir}/registry/${pkg}.json`, await get(cfg.metaUrl(pkg)));

    const eco = await get(`https://packages.ecosyste.ms/api/v1/registries/${cfg.ecosystemsRegistry}/packages/${encodeURIComponent(pkg)}`);
    await save(`${cfg.dir}/ecosystems/${pkg}.json`, eco);

    await save(`${cfg.dir}/depsdev/${pkg}.json`,
      await get(`https://api.deps.dev/v3/systems/${cfg.depsDevSystem}/packages/${encodeURIComponent(pkg)}`));

    const slug2 = repoSlug(eco && eco.repository_url);
    await save(`${cfg.dir}/scorecard/${pkg}.json`, slug2
      ? await get(`https://api.deps.dev/v3/projects/${encodeURIComponent("github.com/" + slug2)}`)
      : { __error: "no_repo_slug", pkg });

    await save(`${cfg.dir}/osv/${pkg}.json`, await get("https://api.osv.dev/v1/query", {
      method: "POST",
      headers: { ...UA, "Content-Type": "application/json" },
      body: JSON.stringify({ package: { ecosystem: cfg.osvEcosystem, name: pkg } }),
    }));

    await sleep(500);
  }
}

console.log("\nDone.");
