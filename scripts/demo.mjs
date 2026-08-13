// Demonstration harness — drives the REAL shipped modules and prints responses.
// Part 1: discovery queries through the full pipeline (fixture mode, deterministic).
// Part 2: safety scenarios through the ranking engine, showing fail-closed verdicts.
import { buildPipeline } from "../dist/mcp/pipeline.js";
import { searchComponents } from "../dist/pipeline/orchestrator.js";
import { WeightedRanker } from "../dist/ranking/rank.js";

const V = { ship: "🟢 SHIP", caution: "🟡 CAUTION", avoid: "🔴 AVOID" };
const line = (n = 78) => console.log("─".repeat(n));

function printResult(r, i) {
  console.log(`${i + 1}. ${r.name}`);
  console.log(`   verdict=${V[r.verdict]}  overall=${r.overall}/100`);
  console.log(`   badges: license=${r.badges.license}  cves=${r.badges.cveCount}  openssf=${r.badges.scorecard ?? "n/a"}`);
  console.log(`   scores: fit=${r.scores.fit.toFixed(2)} license=${r.scores.license.toFixed(2)} security=${r.scores.security.toFixed(2)} health=${r.scores.health.toFixed(2)} effort=${r.scores.effort.toFixed(2)}`);
  console.log(`   why: ${r.reasons.join(" · ")}`);
}

// ── Part 1: real discovery queries ─────────────────────────────────────────
async function discoveryDemos() {
  // 1a. Fixture mode (deterministic; only the ~15 bundled packages are enriched)
  line();
  console.log(`QUERY:  "http client"   (FIXTURE mode, deterministic, projectLicense = MIT)`);
  line();
  const fx = buildPipeline({ fixtures: true });
  (await searchComponents("http client", fx, { projectLicense: "MIT" })).slice(0, 3).forEach(printResult);
  console.log("");

  // 1b. Live mode (real suppliers) — shows every result enriched with real data
  line();
  console.log(`QUERY:  "http client"   (LIVE mode, real suppliers, projectLicense = MIT)`);
  line();
  const live = buildPipeline({ fixtures: false });
  (await searchComponents("http client", live, { projectLicense: "MIT" })).slice(0, 4).forEach(printResult);
  console.log("");
}

// ── Part 2: safety scenarios (constructed inputs → ranker) ──────────────────
function bundle(over = {}) {
  return {
    id: "npm:demo",
    license: { spdxId: "MIT", source: "ecosystems", confidence: 1, ...(over.license || {}) },
    vulnerabilities: over.vulnerabilities ?? [],
    sources: { osv: "ok", license: "ok", scorecard: "ok", ...(over.sources || {}) },
    scorecard: { overall: over.scorecardOverall ?? 9, checks: [] },
    maintenance: over.maintenance ?? {},
  };
}
function candidate(over = {}) {
  return { id: "npm:demo", name: "demo-pkg", ecosystem: "npm",
    description: "a demo package", latestVersion: over.latestVersion ?? "1.0.0", ...over };
}

function runScenario(label, { cand = candidate(), bnd = bundle(), projectLicense = "MIT" }, expect) {
  const ranker = new WeightedRanker();
  const fit = [{ id: cand.id, fitScore: 0.8, rationale: "demo fit" }];
  const [r] = ranker.rank("demo query", [{ candidate: cand, bundle: bnd }], fit, { projectLicense });
  const ok = expect ? (r.verdict === expect ? "✓" : "✗ EXPECTED " + expect) : "";
  console.log(`• ${label}`);
  console.log(`    → ${V[r.verdict]}  (overall ${r.overall})  ${ok}`);
  r.reasons.forEach((x) => console.log(`        - ${x}`));
}

function safetyDemos() {
  line();
  console.log("SAFETY SCENARIOS  (ranking engine — full reasons shown)");
  line();
  runScenario("Clean MIT, OpenSSF 9, no vulns  [project=MIT]", {}, "ship");
  console.log("");
  runScenario("GPL-3.0-or-later into an MIT project  [project=MIT]", { bnd: bundle({ license: { spdxId: "GPL-3.0-or-later", source: "ecosystems", confidence: 1 } }) }, "avoid");
  console.log("");
  runScenario("SAME GPL-3.0-or-later, but project is GPL-3.0  [project=GPL-3.0]", { bnd: bundle({ license: { spdxId: "GPL-3.0-or-later", source: "ecosystems", confidence: 1 } }), projectLicense: "GPL-3.0" });
  console.log("");
  runScenario("Unfixed CRITICAL vulnerability (no fix available)  [project=MIT]", { bnd: bundle({ vulnerabilities: [{ id: "GHSA-crit-0001", severity: "CRITICAL" }] }) }, "avoid");
  console.log("");
  runScenario("CRITICAL on latest 2.5.0, fixed only in future 3.0.0  [project=MIT]", {
    cand: candidate({ latestVersion: "2.5.0" }),
    bnd: bundle({ vulnerabilities: [{ id: "GHSA-future-fix", severity: "CRITICAL", fixedIn: "3.0.0" }] }),
  }, "avoid");
  console.log("");
  runScenario("Unknown / undeterminable license  [project=MIT]", { bnd: bundle({ license: { spdxId: null, source: "ecosystems", confidence: 0 }, sources: { license: "missing" } }) }, "caution");
  console.log("");
  runScenario("OSV lookup FAILED (security evidence unverified)  [project=MIT]", { bnd: bundle({ sources: { osv: "failed" } }) }, "caution");
  console.log("");
}

await discoveryDemos();
safetyDemos();
