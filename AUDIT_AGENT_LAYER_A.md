# Adversarial Audit Report: Agent-Facing Layer A

**Auditor:** Independent Adversarial Auditor  
**Target Repository:** `/Users/aniket/Projects/OpensourceRepoForAgents` (`ossfind`)  
**Scope:** `src/api/surface.ts`, `src/api/manifest.ts`, `src/api/compat.ts`, `src/mcp/server.ts`, `src/api/py-manifest.ts`, `src/api/py-compat.ts`, `src/api/py-project.ts`, `src/api/zip-reader.ts`, and `src/api/py-surface.ts` (wheel/range/submodule resolution).  
**Excluded:** `src/api/scaffold.ts`, `src/recipes/**`, `src/api/py-stub-parser.ts`.

---

## 1. Baseline Verification

All three baseline verification commands passed cleanly on the unaltered repository:

### `npm run typecheck`
```
> ossfind@0.1.0 typecheck
> tsc --noEmit
```
*(Exit code: 0)*

### `npm test`
```
> ossfind@0.1.0 test
> vitest run

 RUN  v3.2.7 /Users/aniket/Projects/OpensourceRepoForAgents

 ✓ src/http/fixture-client.test.ts (4 tests) 55ms
 ✓ src/index/corpus.test.ts (3 tests) 83ms
 ✓ src/index/local-index.test.ts (13 tests) 136ms
 ✓ src/adapters/local-index-discovery.test.ts (14 tests) 132ms
 ✓ src/api/py-manifest.test.ts (6 tests) 40ms
 ✓ src/adapters/discovery.test.ts (2 tests) 37ms
 ✓ src/api/py-surface.test.ts (13 tests) 271ms
 ✓ src/api/surface.test.ts (7 tests) 157ms
 ✓ src/adapters/enrichment.test.ts (18 tests) 273ms
 ✓ src/http/limit.test.ts (2 tests) 18ms
 ✓ src/http/cache.test.ts (9 tests) 28ms
 ✓ src/gates/gates.test.ts (8 tests) 233ms
 ✓ src/api/manifest.test.ts (7 tests) 35ms
 ✓ src/mcp/pipeline.test.ts (14 tests) 305ms
 ✓ src/pipeline/integration.test.ts (1 test) 22ms
 ✓ src/web/server.test.ts (8 tests) 340ms
 ✓ src/api/py-compat.test.ts (12 tests) 12ms
 ✓ src/pipeline/foundation.test.ts (4 tests) 34ms
 ✓ src/api/zip-reader.test.ts (2 tests) 12ms
 ✓ src/api/compat.test.ts (6 tests) 17ms
 ✓ src/adapters/libraries-discovery.test.ts (3 tests) 14ms
 ✓ src/adapters/huggingface-discovery.test.ts (2 tests) 12ms
 ✓ src/api/scaffold.test.ts (26 tests) 18ms
 ✓ src/adapters/github-discovery.test.ts (3 tests) 8ms
 ✓ src/ranking/rank.test.ts (24 tests) 6ms
 ✓ src/recipes/recipes.test.ts (15 tests) 7ms
 ✓ src/fit/tfidf.test.ts (7 tests) 6ms
 ✓ src/api/py-stub-parser.test.ts (12 tests) 10ms
 ✓ src/api/py-project.test.ts (14 tests) 3ms
 ✓ src/discovery/federated.test.ts (2 tests) 14ms
 ✓ src/fit/lexical-signal.test.ts (6 tests) 4ms
 ✓ src/contracts/recipe.test.ts (5 tests) 3ms
 ✓ src/license/compat.test.ts (34 tests) 3ms
 ✓ src/contracts/scaffold.test.ts (3 tests) 2ms
 ✓ src/contracts/component-candidate.test.ts (8 tests) 3ms
 ✓ src/contracts/compatibility-report.test.ts (2 tests) 6ms
 ↓ src/fit/transformers-provider.test.ts (1 test | 1 skipped)
 ✓ src/mcp/server.test.ts (16 tests) 1219ms

 Test Files  37 passed | 1 skipped (38)
      Tests  335 passed | 1 skipped (336)
   Duration  1.92s
```
*(Exit code: 0)*

### `npm run gates`
```
> ossfind@0.1.0 gates
> tsx src/gates/run.ts

=== Running Quality-Gate Battery ===

| Gate ID | Description | check() status | proveFailure() status |
|---------|-------------|----------------|-----------------------|
| G1      | Contract validation: every pipeline output validates against the zod schemas                         | pass           | detected              |
| G2      | Determinism check: same input → identical ranking output twice                                       | pass           | detected              |
| G3      | Critical-CVSS safety fact: v3.0/v3.1/v4 source vectors derive CRITICAL and never ship                | pass           | detected              |
| G4      | License safety fact: GPL/AGPL SPDX expressions and unknown licenses never ship into permissive projects | pass           | detected              |
| G5      | Offline check: the whole pipeline runs with the fixture client and makes ZERO network calls          | pass           | detected              |
| G6      | Version-relevance safety fact: prerelease, intervals, lists, and unknown versions are not silently dropped | pass           | detected              |
| G7      | Evidence completeness: unverified OSV, license, or health never ships                                | pass           | detected              |
| G8      | Federation provenance and raw-repository integrity                                                   | pass           | detected              |

====================================

✅ All quality gates passed successfully!
```
*(Exit code: 0)*

---

## 2. Adversarial Probes Table (a–i)

| Probe | Target | Status | Concrete Evidence / Summary |
|---|---|---|---|
| **a. Fabrication hunt** | `manifest.ts`, `surface.ts`, `py-manifest.ts`, `py-surface.ts` | **HOLDS** | `@types` candidate packages and PyPI stub packages are verified via HTTP requests before emission. Unknown Python packages yield `importName: null` with `confidence: "unknown"`. No unverified imports or packages are emitted. |
| **b. False "verified"** | `manifest.ts`, `py-manifest.ts`, `py-surface.ts` | **HOLDS** | Prose-derived prerequisites (e.g. `ffmpeg`) are strictly marked `confidence: "likely"`. `typesAvailable: "own"` is strictly guarded by `py.typed` or `.pyi` existence in the wheel. |
| **c. Undisclosed truncation** | `server.ts`, `surface.ts`, `py-surface.ts` | **HOLDS** | MCP `inspect_component` sets `exportsTruncated: true` and states `"Showing X of Y exports"`. Re-export depth and submodule caps explicitly append structured notices to `notes`. |
| **d. ZIP reader hostility** | `zip-reader.ts` | **HOLDS** | Never writes to disk (in-memory only). Decompression bomb inflations are constrained via `maxOutputLength: entry.uncompressedSize` and `MAX_UNCOMPRESSED_ENTRY_BYTES` (16 MiB). ZIP64, encrypted flags, bad offsets, and path traversal strings return safe error results without throwing or hanging. |
| **e. Range/resource bounds** | `py-surface.ts`, `zip-reader.ts` | **HOLDS** | Suffix escalation is capped at exactly 3 tail requests (`[64 KiB, 256 KiB, 1 MiB]`). Submodule re-export traversal was probed with 30 chained modules: strictly stopped at depth 2 (12 HTTP requests, 4,444 bytes fetched). |
| **f. Compat correctness** | `py-project.ts`, `py-compat.ts`, `compat.ts` | **HOLE** | **Blocker:** Unclosed dependency arrays in `pyproject.toml` silently drop all dependencies and yield a **false `"compatible"`** verdict. **Should-fix:** `specifiersIntersect` returns `{ intersect: true }` for degenerate closed intervals with `!=` exclusions (e.g., `>=2.0,<=2.0` vs `!=2.0`). **Should-fix:** PEP 440 parser regex over-matches `rc` tags as `post: 0`. |
| **g. Wrong-package data** | `surface.ts`, `py-surface.ts`, `py-manifest.ts` | **HOLDS** | Scoped npm `@types` correctly map `@foo/bar` -> `@types/foo__bar`. Python distribution mappings are explicit and allowlisted (`PyYAML` -> `yaml`, `attrs` -> `attr`, `ffmpeg-python` -> `ffmpeg`). Typeshed lookups are strictly prefixed with `stubs/<dist>/`. |
| **h. Determinism** | Layer A components | **HOLDS** | Repeated extractions across npm and PyPI surface, manifest, and compat checks yielded 100% byte-identical serialized JSON. |
| **i. MCP error handling** | `server.ts` | **HOLDS** | Hostile, missing, null, and schema-violating inputs across all 4 MCP tool handlers return clean structured `{ isError: true, content: [...] }` results with zero unhandled exceptions and zero leaked stack traces. |

---

## 3. Findings Ranked by Severity

### Finding 1: False `"compatible"` verdict on unclosed/malformed `pyproject.toml` dependency arrays
- **Severity:** **BLOCKER**
- **Affected File:** [`src/api/py-project.ts`](file:///Users/aniket/Projects/OpensourceRepoForAgents/src/api/py-project.ts#L248-L271)
- **Description:** In `parsePyprojectToml()`, when a multiline `dependencies = [` or `[project.optional-dependencies]` array is not closed before the end of the file or section, `inDependenciesArray` remains `true` without flushing or recording uncertainty. The dependencies buffer is discarded, and the function returns `{ dependencies: {}, notes: [] }` without setting `uncertain: true`. When evaluated by `checkPyCompatibility()`, real version conflicts are ignored, and a false `"compatible"` verdict is emitted.
- **Reproduction:**
```typescript
import { parsePyprojectToml } from "./src/api/py-project.js";
import { checkPyCompatibility } from "./src/api/py-compat.js";

const unclosedToml = `[project]
name = "demo"
version = "0.1.0"
license = "MIT"
dependencies = [
    "requests<2.0.0",
`;

const projectContext = parsePyprojectToml(unclosedToml);
// projectContext is: { dependencies: {}, license: "MIT", notes: [] }
// Note that projectContext.uncertain is undefined!

const manifest = {
  id: "pypi:requests",
  version: "2.31.0",
  install: { command: "pip install requests" },
  importForm: {
    moduleType: "unknown", esm: null, cjs: null, typesPackage: null,
    python: { importName: "requests", statements: ["import requests"], confidence: "verified", evidence: "test" }
  },
  runtime: { engines: {}, os: null, cpu: null },
  peerDependencies: {}, prerequisites: [], hasInstallScript: false, notes: []
};

const report = checkPyCompatibility(manifest, projectContext, "MIT");
console.log(report.verdict); // "compatible" (FALSE POSITIVE! Project declared requests<2.0.0, manifest is 2.31.0)
```

---

### Finding 2: `specifiersIntersect` returns `{ intersect: true }` for degenerate closed intervals with `!=` exclusions
- **Severity:** **SHOULD-FIX**
- **Affected File:** [`src/api/py-compat.ts`](file:///Users/aniket/Projects/OpensourceRepoForAgents/src/api/py-compat.ts#L280-L343)
- **Description:** `specifiersIntersect()` handles `!=` clauses only when exact equality clauses (`==`) exist. When evaluating an interval like `>=2.0,<=2.0` (which defines the single point `{2.0}`) against `!=2.0` (which excludes `{2.0}`), `allClauses` contains no `==` operator, so `!=` is ignored during interval computation. It calculates `maxLower = 2.0 (inclusive)` and `minUpper = 2.0 (inclusive)`, concluding that the ranges intersect.
- **Reproduction:**
```typescript
import { specifiersIntersect } from "./src/api/py-compat.js";

const result = specifiersIntersect(">=2.0,<=2.0", "!=2.0");
console.log(result); // { intersect: true } (FALSE POSITIVE: intersection of [2.0, 2.0] and !=2.0 is empty)
```

---

### Finding 3: PEP 440 version parser treats release candidates as postreleases (`post: 0`)
- **Severity:** **SHOULD-FIX**
- **Affected File:** [`src/api/py-compat.ts`](file:///Users/aniket/Projects/OpensourceRepoForAgents/src/api/py-compat.ts#L70-L84)
- **Description:** In `parsePep440Version()`, `postMatch = /[.-]?(?:post|r|rev).?(\d+)?/i` is executed against the entire `remainder` rather than the string after the matched prerelease tag. In `2.0.0rc1`, the character `r` inside `rc1` matches `(?:post|r|rev)` with no numeric group, causing `post: 0` to be assigned to the parsed version. This causes `compareParsedVersions(parsePep440Version("2.0.0rc1"), parsePep440Version("2.0.0rc1.post0"))` to evaluate to `0` (equal).
- **Reproduction:**
```typescript
import { parsePep440Version, compareParsedVersions } from "./src/api/py-compat.js";

const vRc = parsePep440Version("2.0.0rc1");
// { epoch: 0, release: [2,0,0], prerelease: { phase: 'rc', num: 1 }, post: 0 }
const vRcPost = parsePep440Version("2.0.0rc1.post0");
// { epoch: 0, release: [2,0,0], prerelease: { phase: 'rc', num: 1 }, post: 0 }

console.log(compareParsedVersions(vRc, vRcPost)); // 0 (Evaluated as equal)
```

---

### Finding 4: Re-export recursion depth cap records note but does not toggle `ApiSurface.truncated`
- **Severity:** **NICE-TO-HAVE**
- **Affected File:** [`src/api/surface.ts`](file:///Users/aniket/Projects/OpensourceRepoForAgents/src/api/surface.ts#L471-L475), [`src/api/py-surface.ts`](file:///Users/aniket/Projects/OpensourceRepoForAgents/src/api/py-surface.ts#L720-L725)
- **Description:** When `MAX_REEXPORT_DEPTH` (3) is reached and unresolved re-exports remain, an informative note is appended to `notes`, but `result.truncated` remains `false` (unless the source file had a `[fixture truncated]` comment). While the note discloses the cutoff in human/agent text, setting `truncated: true` on the structured schema would offer immediate programmatic signaling.

---

## 4. Quality Gate Specifications for Missing Gates

Gates G1–G8 only validate the discovery/ranking/enrichment layer and do not cover Layer A contracts, determinism, or fail-closed parsing. Two new quality gates are specified below:

### Gate G9: Layer-A Contract Validation & Fail-Closed Safety
- **Gate ID:** `G9`
- **Description:** `Layer-A contract validation: surface, manifest, compat, and scaffold outputs validate against Zod schemas; malformed project files fail closed to 'unknown'.`
- **`check()` Specification:**
  1. Instantiate `ApiSurfaceExtractor`, `IntegrationManifestBuilder`, `PyApiSurfaceExtractor`, and `PyIntegrationManifestBuilder` with fixture client.
  2. For fixture components (`npm:zod`, `npm:express`, `pypi:requests`, `pypi:numpy`):
     - Validate surfaces against `ApiSurfaceSchema.parse()`.
     - Validate manifests against `IntegrationManifestSchema.parse()`.
     - Generate compatibility reports and validate against `CompatibilityReportSchema.parse()`.
  3. Parse unclosed/malformed `pyproject.toml` and verify `projectContext.uncertain === true`.
  4. Run `checkPyCompatibility` on unclosed/malformed project context and verify `report.verdict === "unknown"` (or `"conflicts"`), asserting it **never** returns `"compatible"`.
  5. Return `{ status: "pass" }` if all assertions hold; otherwise `{ status: "fail", message }`.
- **`proveFailure()` Specification:**
  1. Construct an invalid `CompatibilityReport` (e.g. `verdict: "compatible"` with an unresolved blocker finding, or missing required fields).
  2. Attempt `CompatibilityReportSchema.parse(invalidReport)`.
  3. Return `{ status: "detected" }` if the schema rejects the invalid report; otherwise `{ status: "undetected" }`.

### Gate G10: Layer-A Determinism & Non-Fabrication Truth
- **Gate ID:** `G10`
- **Description:** `Layer-A determinism & non-fabrication: repeated extractions are byte-identical, and unverified imports/types never report false verified confidence.`
- **`check()` Specification:**
  1. Perform two consecutive extractions for all fixture components. Assert `JSON.stringify(run1) === JSON.stringify(run2)`.
  2. Build manifest for an unmapped Python distribution and assert `manifest.importForm.python?.confidence === "unknown"` and `importName === null`.
  3. Verify that external binaries (e.g. `ffmpeg`) never receive `confidence: "verified"` and are strictly `"likely"`.
  4. Return `{ status: "pass" }` if all invariants hold; otherwise `{ status: "fail", message }`.
- **`proveFailure()` Specification:**
  1. Inject an artificially fabricated import form `{ importName: "guessed", confidence: "verified" }` for an unmapped package into the assertion pipeline.
  2. Assert that the verification predicate catches the fabricated verified claim and returns `{ status: "detected" }`.

---

## 5. Final Verdict

**Verdict:** **NO** (Safe with caveats once Finding 1 is resolved).

**Caveats:** The Layer A architecture exhibits exceptional defenses against ZIP decompression hostility, remote range bounds exhaustion, fabrication, and MCP exception leakage. However, **Finding 1 is a blocker**: unclosed TOML dependency arrays in `pyproject.toml` silently drop dependency constraints and produce false `"compatible"` verdicts, directly violating the fail-closed guarantee required for autonomous agent safety. Once Finding 1 and the should-fix edge cases in Finding 2 and 3 are patched, this layer will be fully safe for agent consumption.
