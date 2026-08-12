# Graph Report - OpensourceRepoForAgents  (2026-08-12)

## Corpus Check
- 113 files · ~423,489 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 316 nodes · 710 edges · 22 communities (15 shown, 7 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e3b060aa`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- index.ts
- pipeline.ts
- loader.ts
- package.json
- fakes.ts
- enrichment.ts
- compilerOptions
- ossfind Independent Adversarial Audit
- discovery.ts
- g7.ts
- compat.ts
- capture-fixtures.mjs
- g3.ts
- app.js
- node-fs-promises.d.ts
- PIPELINE_LOG.md
- node-url.d.ts
- FakeDiscoverer
- FakeEnricher
- FakeFitScorer
- FakeRanker

## God Nodes (most connected - your core abstractions)
1. `ComponentCandidate` - 26 edges
2. `EnrichmentBundle` - 15 edges
3. `FitSignal` - 15 edges
4. `createFixtureHttpClient()` - 15 edges
5. `ScoredComponentSchema` - 14 edges
6. `buildPipeline()` - 14 edges
7. `searchComponents()` - 14 edges
8. `loadEcosystems()` - 12 edges
9. `HttpClient` - 12 edges
10. `compilerOptions` - 12 edges

## Surprising Connections (you probably didn't know these)
- `proveFailure()` --references--> `ScoredComponentSchema`  [EXTRACTED]
  src/gates/g1.ts → src/contracts/scored-component.ts
- `candidateFromResult()` --references--> `ComponentCandidateSchema`  [EXTRACTED]
  src/adapters/discovery.ts → src/contracts/component-candidate.ts
- `HttpDiscoverer` --implements--> `Discoverer`  [EXTRACTED]
  src/adapters/discovery.ts → src/pipeline/interfaces.ts
- `candidate()` --references--> `ComponentCandidateSchema`  [EXTRACTED]
  src/adapters/enrichment.test.ts → src/contracts/component-candidate.ts
- `check()` --references--> `ScoredComponentSchema`  [EXTRACTED]
  src/gates/g1.ts → src/contracts/scored-component.ts

## Import Cycles
- None detected.

## Communities (22 total, 7 thin omitted)

### Community 0 - "index.ts"
Cohesion: 0.10
Nodes (21): ComponentCandidate, EnrichmentBundle, ScorecardCheck, ScorecardCheckSchema, FitSignal, FitSignalSchema, LicenseCompatResult, LicenseCompatResultSchema (+13 more)

### Community 1 - "pipeline.ts"
Cohesion: 0.09
Nodes (30): check(), proveFailure(), check(), proveFailure(), check(), advisory(), check(), client() (+22 more)

### Community 2 - "loader.ts"
Cohesion: 0.11
Nodes (33): DepsDevPackageFixture, DepsDevPackageKey, DepsDevVersion, EcosystemsPackageFixture, fixtureSegment(), listFixturePackages(), loadDepsDev(), loadEcosystems() (+25 more)

### Community 3 - "package.json"
Cohesion: 0.05
Nodes (38): cvss, @modelcontextprotocol/sdk, bin, ossfind-mcp, dependencies, cvss, @modelcontextprotocol/sdk, semver (+30 more)

### Community 4 - "fakes.ts"
Cohesion: 0.15
Nodes (21): candidate(), ComponentCandidateSchema, EnrichmentBundleSchema, validate(), asUrl(), canonicalPackageName(), firstString(), fixedVersion() (+13 more)

### Community 5 - "enrichment.ts"
Cohesion: 0.19
Nodes (20): defaultVersionFromDepsDev(), fetchJson(), FetchResult, firstLicense(), githubProjectUrl(), HttpEnricher, isAffected(), isRecord() (+12 more)

### Community 6 - "compilerOptions"
Cohesion: 0.11
Nodes (17): dist, node_modules, src/**/*.ts, compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, module (+9 more)

### Community 7 - "ossfind Independent Adversarial Audit"
Cohesion: 0.15
Nodes (12): a. Critical-CVE gate, Adversarial probes, b. GPL/AGPL compatibility into MIT and Apache-2.0, Baseline commands, c. Version relevance (Defect B), Core logic reviewed, d. Determinism, e. Resilience under HTTP 429 / 500 / thrown request (+4 more)

### Community 8 - "discovery.ts"
Cohesion: 0.24
Nodes (9): candidateFromResult(), HttpDiscoverer, nonnegativeNumber(), normalizeUrl(), NpmSearchResponse, NpmSearchResult, sleep(), stringValue() (+1 more)

### Community 9 - "g7.ts"
Cohesion: 0.31
Nodes (7): check(), completenessMatrix, doesNotExceed(), hasCompletenessSafetyFact(), MaximumVerdict, proveFailure(), SourceState

### Community 10 - "compat.ts"
Cohesion: 0.61
Nodes (6): AGPL_STRONG, checkLicense(), GPL_STRONG, normalizeLicense(), PERMISSIVE, WEAK_COPYLEFT

### Community 11 - "capture-fixtures.mjs"
Cohesion: 0.33
Nodes (4): getJSON(), OUT, PACKAGES, sleep()

### Community 12 - "g3.ts"
Cohesion: 0.53
Nodes (5): check(), criticalVectors, proveFailure(), shipsCritical(), sourceClient()

### Community 13 - "app.js"
Cohesion: 0.83
Nodes (3): escapeHtml(), renderResults(), showStatus()

## Knowledge Gaps
- **89 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+84 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ComponentCandidate` connect `index.ts` to `loader.ts`, `fakes.ts`, `enrichment.ts`, `discovery.ts`, `g7.ts`?**
  _High betweenness centrality (0.047) - this node is a cross-community bridge._
- **Why does `ScoredComponentSchema` connect `index.ts` to `pipeline.ts`, `loader.ts`, `fakes.ts`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Why does `EnrichmentBundle` connect `index.ts` to `g7.ts`, `loader.ts`, `fakes.ts`, `enrichment.ts`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _89 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.10283687943262411 - nodes in this community are weakly interconnected._
- **Should `pipeline.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09082125603864734 - nodes in this community are weakly interconnected._
- **Should `loader.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11341463414634147 - nodes in this community are weakly interconnected._