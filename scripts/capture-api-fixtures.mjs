// One-shot capture of API-surface + integration-manifest source data for npm packages.
// Sources: npm registry (authoritative package.json fields), jsDelivr (file listing),
// unpkg/jsDelivr (actual .d.ts content). Frozen under fixtures/raw/api/.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const OUT = new URL("../fixtures/raw/api/", import.meta.url);

// Chosen to exercise distinct cases:
//  zod/axios      - ship their own types
//  express        - types live in @types/express (DefinitelyTyped), not the package
//  chalk          - ESM-only (import form matters)
//  left-pad       - no types at all (degradation path)
//  sharp          - native prereq (libvips / prebuilt binaries, os/cpu fields)
//  fluent-ffmpeg  - requires an external ffmpeg BINARY (the Mac video case)
const PACKAGES = ["zod", "axios", "express", "@types/express", "chalk", "left-pad", "sharp", "fluent-ffmpeg"];

const MAX_DTS_BYTES = 120_000; // keep fixtures reasonable; truncation is recorded

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
  const note = typeof data === "string"
    ? `${data.length} chars`
    : (data && data.__error ? `ERROR ${data.__error}` : "ok");
  console.log(`  ${rel.padEnd(46)} ${note}`);
}

const slug = (name) => name.replace("/", "__");

for (const pkg of PACKAGES) {
  console.log(`\n== ${pkg} ==`);

  // 1. Registry "latest" — authoritative package.json fields for the manifest:
  //    types/typings, exports, main, module, type, peerDependencies, engines, os, cpu, bin, scripts
  const meta = await get(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`);
  await save(`registry/${slug(pkg)}.json`, meta);

  const version = meta && !meta.__error ? meta.version : null;
  if (!version) { await sleep(300); continue; }

  // 2. jsDelivr flat file listing — lets us FIND type files without guessing paths
  const listing = await get(`https://data.jsdelivr.com/v1/package/npm/${pkg}@${version}/flat`);
  await save(`listing/${slug(pkg)}.json`, listing);

  // 3. The actual declaration file content (the machine-readable API surface)
  let dtsPath = meta.types || meta.typings || null;
  if (!dtsPath && listing && Array.isArray(listing.files)) {
    const candidates = listing.files.filter((f) => f.name.endsWith(".d.ts"));
    const preferred = candidates.find((f) => /index\.d\.ts$/.test(f.name)) || candidates[0];
    dtsPath = preferred ? preferred.name : null;
  }
  if (dtsPath) {
    const clean = String(dtsPath).replace(/^\.?\//, "");
    const text = await get(`https://cdn.jsdelivr.net/npm/${pkg}@${version}/${clean}`, true);
    if (typeof text === "string") {
      const truncated = text.length > MAX_DTS_BYTES;
      await save(`dts/${slug(pkg)}.d.ts`, truncated ? text.slice(0, MAX_DTS_BYTES) + "\n// [fixture truncated]\n" : text);
      await save(`dts/${slug(pkg)}.meta.json`, { package: pkg, version, path: clean, truncated, bytes: text.length });
    } else {
      await save(`dts/${slug(pkg)}.meta.json`, { package: pkg, version, path: clean, __error: text.__error });
    }
  } else {
    await save(`dts/${slug(pkg)}.meta.json`, { package: pkg, version, path: null, note: "no declaration file found" });
  }

  await sleep(400);
}

console.log("\nDone.");
