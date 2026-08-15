# Federation self-review audit — 2026-08-15

Scope: read-only adversarial review of federation, GitHub, Hugging Face,
per-candidate enrichment routing, ranking, and G1–G7.  This is a self-review
of code I wrote, not independent assurance.  Green baseline results are
therefore treated as necessary but insufficient evidence.

## Baseline commands (offline)

`npm run typecheck` — exit 0:

```text
> ossfind@0.1.0 typecheck
> tsc --noEmit
```

`npm test` — exit 0:

```text
> ossfind@0.1.0 test
> vitest run

 RUN  v3.2.7 /Users/aniket/Projects/OpensourceRepoForAgents

 ✓ src/http/cache.test.ts (9 tests) 32ms
 ✓ src/http/fixture-client.test.ts (3 tests) 32ms
 ✓ src/index/corpus.test.ts (3 tests) 82ms
 ✓ src/adapters/discovery.test.ts (2 tests) 37ms
 ✓ src/index/local-index.test.ts (13 tests) 86ms
 ✓ src/adapters/local-index-discovery.test.ts (14 tests) 90ms
 ✓ src/http/limit.test.ts (2 tests) 19ms
 ✓ src/pipeline/foundation.test.ts (4 tests) 21ms
 ✓ src/adapters/enrichment.test.ts (18 tests) 167ms
 ✓ src/adapters/github-discovery.test.ts (3 tests) 8ms
 ✓ src/pipeline/integration.test.ts (1 test) 19ms
 ✓ src/mcp/pipeline.test.ts (14 tests) 217ms
 ✓ src/web/server.test.ts (8 tests) 226ms
 ✓ src/adapters/huggingface-discovery.test.ts (2 tests) 8ms
 ✓ src/adapters/libraries-discovery.test.ts (3 tests) 15ms
 ✓ src/gates/gates.test.ts (7 tests) 223ms
 ✓ src/fit/tfidf.test.ts (7 tests) 5ms
 ✓ src/ranking/rank.test.ts (22 tests) 6ms
 ✓ src/license/compat.test.ts (34 tests) 3ms
 ✓ src/mcp/server.test.ts (6 tests) 216ms
 ✓ src/discovery/federated.test.ts (2 tests) 4ms
 ✓ src/fit/lexical-signal.test.ts (6 tests) 4ms
 ✓ src/contracts/component-candidate.test.ts (4 tests) 2ms
 ↓ src/fit/transformers-provider.test.ts (1 test | 1 skipped)

 Test Files  23 passed | 1 skipped (24)
      Tests  187 passed | 1 skipped (188)
   Start at  07:47:12
   Duration  691ms (transform 500ms, setup 0ms, collect 1.78s, tests 1.52s, environment 2ms, prepare 912ms)
```

`npm run gates` — exit 0:

```text
> ossfind@0.1.0 gates
> tsx src/gates/run.ts

=== Running Quality-Gate Battery ===

| Gate ID | Description | check() status | proveFailure() status |
| G1 | Contract validation: every pipeline output validates against the zod schemas | pass | detected |
| G2 | Determinism check: same input → identical ranking output twice | pass | detected |
| G3 | Critical-CVSS safety fact: v3.0/v3.1/v4 source vectors derive CRITICAL and never ship | pass | detected |
| G4 | License safety fact: GPL/AGPL SPDX expressions and unknown licenses never ship into permissive projects | pass | detected |
| G5 | Offline check: the whole pipeline runs with the fixture client and makes ZERO network calls | pass | detected |
| G6 | Version-relevance safety fact: prerelease, intervals, lists, and unknown versions are not silently dropped | pass | detected |
| G7 | Evidence completeness: unverified OSV, license, or health never ships | pass | detected |

====================================

✅ All quality gates passed successfully!
```

The fixture client was used for the test and gates runs; G5 additionally
replaces `globalThis.fetch` and passed with zero attempted network calls.

## Adversarial probe results

| Probe | Result | Concrete evidence |
|---|---|---|
| a. Mixed-ecosystem enrichment routing | **HOLE** | Canonical ambiguous IDs hold: `npm:github` used npmjs/deps npm and OSV `{ecosystem:"npm",name:"github"}`; `pypi:github` used pypi.org/deps pypi and OSV `{ecosystem:"PyPI",name:"github"}`; `github:npm:not-real` and `huggingface:npm:not-real` made no registry/OSV call. But `ComponentCandidateSchema.parse({id:"npm:not-real", ecosystem:"github", ...})` succeeds, and `HttpEnricher` then obtains npm registry/deps/OSV evidence. The schema permits a semantically GitHub candidate to receive npm data. |
| b. GitHub fail-closed integrity and spoofed licenses | **HOLE** | The normal adapter holds: a MIT GitHub repo with scorecard 10 produced `{osv:"missing",license:"ok",scorecard:"ok"}`, overall 78, `caution`. `MIT-ish`, `MΙT` (Greek iota), full-width MIT, and a 6,000-character MIT-like string are conditional and not permissive. However, a valid forged all-positive bundle for `github:owner/repo` (MIT, scorecard 10, all sources `ok`, fit 1) gives overall 99 and `ship`. The ranker has no ecosystem-aware raw-repository cap, so an accidental future OSV-routing/provenance regression bypasses the intended invariant. |
| c. Hanging FederatedDiscoverer source | **HOLDS** | A `discover()` returning `new Promise(() => {})`, alongside a healthy source and `sourceTimeoutMs:50`, returned `npm:healthy` in 51 ms and emitted one fixed warning for `hang`. Default is 10,000 ms. Caveat: the wrapper does not abort the underlying request; it merely stops awaiting it. |
| d. Dedup determinism | **HOLDS** | Two sources emitted `npm:same` with descriptions `FIRST` and `SECOND`; five runs produced the same output, selecting `FIRST` (earliest declared source). Observed order: `same FIRST, b, a, c`. |
| e. G2-style all-mode determinism | **HOLDS** | Two full `searchComponents("video editing", buildPipeline({fixtures:true, ecosystem:"all", projectLicense:"MIT"}))` JSON strings were byte-identical: 17,958 UTF-8 bytes, SHA-256 `04d718b49cfa2aa18d7bb05b9e2ca4ce3158a434f09d2333caf32b96bb6f4d6f` in both runs. |
| f. GitHub token handling | **HOLDS** | `GITHUB_TOKEN` is only placed in the `Authorization` header; query URL is limited to `q`, `sort`, `order`, and `per_page`. Injecting an HTTP error containing a sentinel token produced `[]` and zero captured console calls. A header/URL probe confirmed `authAttached:true`, `tokenInUrl:false`. The cache key uses method/URL/body, not headers. |
| g. One failed all-mode source | **HOLDS** | Forcing `GitHubDiscoverer.discover` to throw in fixture `ecosystem:"all"` returned npm=15 and PyPI=15 candidates, 30 schema-valid ranked results, and only `[ossfind] discovery source unavailable: github.` Direct injected GitHub 500 and 429 each returned `[]`; federation retained a healthy `npm:alive` result. |

## Findings

### Should-fix — identity contract permits wrong-source enrichment

Reproduction (accepted by the public schema):

```ts
const candidate = ComponentCandidateSchema.parse({
  id: "npm:not-real", name: "not-real", ecosystem: "github",
  description: "contradictory identity",
});
await new HttpEnricher(recordingHttp).enrich(candidate);
```

Recorded calls were npm registry, deps.dev npm, and OSV npm, and the returned
bundle reported npm supplier evidence as `ok`. All current discoverers create
coherent fields, so this is not presently reached through the normal pipeline.
It is nevertheless a valid contract-boundary input and turns a future adapter
or caller mistake into cross-ecosystem attribution. Make the candidate schema
reject an `id` prefix that differs from `ecosystem` (or establish one validated
canonical ecosystem field and route exclusively from it).

### Should-fix — raw GitHub safety is adapter-dependent, not invariant

The current GitHub enricher deliberately assigns OSV `missing`, so normal
GitHub results cannot ship. This is good but insufficient defense in depth:

```ts
// candidate: github:owner/repo, MIT, scorecard 10, fitScore 1
bundle.sources = { osv: "ok", license: "ok", scorecard: "ok" };
// WeightedRanker => { overall: 99, verdict: "ship" }
```

The bundle is contract-valid. A routing bug such as the first finding, or a
future attempt to query OSV for a repository, can therefore produce an unsafe
ship verdict. Add an ecosystem-aware ranker hard-cap for raw GitHub repositories
(and, consistently, Hugging Face model cards) regardless of forged positive
provenance. This is a safety-in-depth defect, not evidence that a current
normal GitHub result ships.

### Nice-to-have — timeouts bound callers but do not cancel work

`withinTimeout` rejects its wrapper after the deadline but leaves the source
promise alive. A permanently stuck HTTP request therefore consumes resources;
a source-level cached promise also remains permanently pending. User-visible
federation calls still remain bounded and other sources return, so this is not
a correctness failure for probe c. Consider propagating `AbortSignal` through
discoverers if their HTTP boundary can support it.

## Missing-gate hunt and exact G8 specification

No existing gate catches either should-fix finding. G1, G2, and G5 construct
the default npm fixture pipeline; G3, G4, G6, and G7 construct generic npm
candidates/bundles. G4 does not exercise spoofed lookalikes, and G7 tests
generic missing evidence rather than source identity or the GitHub adapter.
Existing unit tests have a benign all-mode fixture and normal GitHub non-ship
case, but neither is an adversarial gate-battery regression check.

Add **G8: Federation provenance and raw-repository integrity** after fixing
the two should-fix defects. Its `check()` must:

1. Reject all candidates whose `id` prefix differs from `ecosystem`, including
   `npm:not-real`/`github`, `pypi:github`/`npm`, and equivalent GitHub and HF
   contradictions.
2. Use a recording fake `HttpEnricher` supplier to enrich, in one batch,
   `npm:github`, `pypi:github`, `github:npm:not-real`, and
   `huggingface:npm:not-real`. Give each supplier a distinguishable fact and
   assert npm only calls npm registry/deps/OSV, PyPI only calls PyPI
   registry/deps/OSV, GitHub calls neither registry nor OSV and records OSV
   missing, and HF makes no enrichment HTTP call and records OSV/scorecard
   missing.
3. Rank GitHub and HF candidates with a deliberately forged MIT, scorecard-10,
   all-`ok` bundle and fit 1; require `verdict !== "ship"`.
4. Under project MIT, require `MIT-ish`, Greek-iota `MΙT`, full-width MIT, and
   `"MIT".repeat(1000)` never to ship.

Register G8 in `src/gates/run.ts` and `src/gates/gates.test.ts`; its
`proveFailure()` should mutate a source route / repository cap predicate and
must return `detected`. A separate future federation-resilience gate would
also be valuable for all-mode byte determinism, never-settling-source timeout,
source-order dedup, and one-source-failure survival; those probes hold today
but G1–G7 do not cover them.

## Verdict

**No — do not keep federation as the default discovery path until the two
should-fix integrity holes have been closed; current normal paths are bounded,
offline-fixture deterministic, and fail-closed for GitHub, but those guarantees
are not structurally enforced at the public contract/ranker boundaries.**
