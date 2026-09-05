#!/usr/bin/env node
// Relevance evaluation over the labelled query set. Hits real registries.
//
//   npm run eval                          run and print the report
//   npm run eval -- --save base.json      write the report for later comparison
//   npm run eval -- --baseline base.json  compare against an earlier report
//   npm run eval -- --filter markdown     run only matching queries
//
// Labels are editorial judgement (see eval/queries.json). Registry data drifts, so
// this measures CHANGE between runs, not absolute accuracy.
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { buildPipeline } from "../dist/mcp/pipeline.js";
import { searchComponents } from "../dist/pipeline/orchestrator.js";
import { regressions, scoreQuery, summarize } from "../dist/eval/metrics.js";

const RESULT_DEPTH = 10;
// Each query fires up to 6 registry probes. The first full run used concurrency 4 and
// was rate-limited into 12 empty result sets, which scored as relevance failures —
// serial with a pause is the only setting that produces trustworthy numbers.
const CONCURRENCY = 1;
const PAUSE_MS = 900;

const { values } = parseArgs({
  options: {
    save: { type: "string" },
    baseline: { type: "string" },
    filter: { type: "string" },
    depth: { type: "string", default: String(RESULT_DEPTH) },
  },
});

const set = JSON.parse(await readFile(new URL("../eval/queries.json", import.meta.url), "utf8"));
const depth = Number(values.depth) || RESULT_DEPTH;
const cases = set.queries.filter((entry) =>
  !values.filter || `${entry.query} ${entry.ecosystem}`.toLowerCase().includes(values.filter.toLowerCase()));

if (cases.length === 0) {
  console.error(`No queries matched --filter ${values.filter}`);
  process.exit(1);
}

async function runCase(entry) {
  try {
    const pipeline = buildPipeline({ fixtures: false, ecosystem: entry.ecosystem, projectLicense: "MIT" });
    const results = await searchComponents(entry.query, pipeline, { limit: depth });
    return scoreQuery({
      query: `${entry.ecosystem}: ${entry.query}`,
      ecosystem: entry.ecosystem,
      results: results.map((result) => result.name),
      relevant: entry.relevant,
      irrelevant: entry.irrelevant ?? [],
    });
  } catch (error) {
    // A supplier outage must not be silently scored as a relevance failure.
    console.error(`  ERROR ${entry.ecosystem}: ${entry.query} — ${error.message}`);
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scores = [];
let failures = 0;
for (let start = 0; start < cases.length; start += CONCURRENCY) {
  const batch = await Promise.all(cases.slice(start, start + CONCURRENCY).map(runCase));
  for (const score of batch) {
    if (score === null) failures += 1;
    else scores.push(score);
  }
  process.stderr.write(`  ...${Math.min(start + CONCURRENCY, cases.length)}/${cases.length}\n`);
  if (start + CONCURRENCY < cases.length) await sleep(PAUSE_MS);
}

// A run where suppliers refused is not a relevance measurement. Say so loudly rather
// than printing a plausible-looking MRR computed from empty result sets.
if (failures > 0) {
  console.error(`\n${failures} of ${cases.length} queries could not be answered by their registry.`);
  console.error("Those are excluded from the summary; if the count is high, the numbers below are not comparable.");
}

const summary = summarize(scores);
const pct = (value) => `${(value * 100).toFixed(1)}%`;

console.log("\n| Query | Top result | First relevant | RR |");
console.log("|---|---|---|---|");
for (const score of scores) {
  const rank = score.firstRelevantRank === null ? "—" : `#${score.firstRelevantRank}`;
  const flag = score.noiseAt3 ? " ⚠noise" : "";
  console.log(`| ${score.query} | ${score.topResult ?? "—"}${flag} | ${rank} | ${score.reciprocalRank.toFixed(2)} |`);
}

console.log(`\nqueries        ${summary.queries}${failures ? `  (${failures} errored, excluded)` : ""}`);
console.log(`MRR            ${summary.meanReciprocalRank.toFixed(3)}`);
console.log(`hit@1          ${pct(summary.hitAt1)}`);
console.log(`hit@3          ${pct(summary.hitAt3)}`);
console.log(`hit@10         ${pct(summary.hitAt10)}`);
console.log(`mean recall    ${pct(summary.meanRecall)}`);
console.log(`noise@3        ${pct(summary.noiseAt3)}   (lower is better)`);

if (values.save) {
  await writeFile(values.save, JSON.stringify({ at: new Date().toISOString(), depth, summary, scores }, null, 2));
  console.log(`\nsaved → ${values.save}`);
}

if (values.baseline) {
  const before = JSON.parse(await readFile(values.baseline, "utf8"));
  const delta = (key) => summary[key] - before.summary[key];
  const sign = (value) => (value >= 0 ? `+${value.toFixed(3)}` : value.toFixed(3));

  console.log(`\nvs ${values.baseline} (${before.at})`);
  console.log(`  MRR      ${before.summary.meanReciprocalRank.toFixed(3)} → ${summary.meanReciprocalRank.toFixed(3)}  ${sign(delta("meanReciprocalRank"))}`);
  console.log(`  hit@3    ${pct(before.summary.hitAt3)} → ${pct(summary.hitAt3)}`);
  console.log(`  noise@3  ${pct(before.summary.noiseAt3)} → ${pct(summary.noiseAt3)}`);

  const worse = regressions(before.scores, scores);
  if (worse.length === 0) console.log("  no per-query regressions");
  else {
    console.log(`  ${worse.length} regression(s):`);
    for (const item of worse) {
      console.log(`    ${item.query}: #${item.before} → ${item.after === null ? "not found" : `#${item.after}`}`);
    }
  }
}
