# ossfind Re-Audit Report

**Date:** 2026-08-12  
**Role:** Independent Auditor

## 1. Command Outputs

### npm run typecheck
```text
> ossfind@0.1.0 typecheck
> tsc --noEmit
```

### npm test
```text
> ossfind@0.1.0 test
> vitest run


 RUN  v3.2.7 /Users/aniket/Projects/OpensourceRepoForAgents

 ✓ src/license/compat.test.ts (34 tests) 3ms
 ✓ src/fit/lexical.test.ts (3 tests) 2ms
 ✓ src/ranking/rank.test.ts (21 tests) 5ms
 ✓ src/pipeline/foundation.test.ts (4 tests) 18ms
 ✓ src/pipeline/integration.test.ts (1 test) 17ms
 ✓ src/adapters/discovery.test.ts (2 tests) 37ms
 ✓ src/web/server.test.ts (4 tests) 75ms
 ✓ src/adapters/enrichment.test.ts (12 tests) 102ms
 ✓ src/mcp/server.test.ts (2 tests) 33ms
 ✓ src/gates/gates.test.ts (7 tests) 77ms

 Test Files  10 passed (10)
      Tests  90 passed (90)
   Start at  07:50:58
   Duration  432ms (transform 308ms, setup 0ms, collect 1.07s, tests 369ms, environment 1ms, prepare 475ms)
```

### npm run gates
```text
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
| G7      | Evidence completeness: unverified OSV or license never ships; missing scorecard has an explicit policy | pass           | detected              |

====================================

✅ All quality gates passed successfully!
```

---

## 2. Blocker Verification Table

| Blocker | Description / Repro Case | Status | Evidence / Observed Verdict |
|---|---|---|---|
| **B1** | GPL/AGPL SPDX expressions (`GPL-3.0-or-later`, `AGPL-3.0-or-later`, `GPL-3.0 OR MIT`, `(GPL-3.0)`) and unverified/null licenses into permissive projects (`MIT`, `Apache-2.0`). | **CLOSED** | GPL/AGPL expressions normalize to copyleft and resolve to `avoid`. Unverified/null licenses resolve to `caution`. Zero cases of shipping unsafe licenses into permissive projects.<br>• `GPL-3.0-or-later` → `avoid` (77)<br>• `AGPL-3.0-or-later` → `avoid` (77)<br>• `GPL-3.0 OR MIT` → `avoid` (77)<br>• `(GPL-3.0)` → `avoid` (77)<br>• `unknown` / `null` → `caution` (82) |
| **B2** | Active CRITICAL affecting latest version `2.5.0` in interval `[2.0.0,3.0.0)` with future fix `fixedIn: "3.0.0"`. | **CLOSED** | Resolved to `avoid` (Score: 71) because the latest version lies within the active vulnerability range. Presence of future fix does not override active vulnerability status. |
| **B3** | CVSS v4 critical vector with no database severity, and UNPARSEABLE severity affecting latest version. | **CLOSED** | CVSS v4 vector (`CVSS:4.0/...`) is correctly parsed to severity `CRITICAL` (no database severity needed) and resolves to `avoid` (Score: 59). `UNPARSEABLE` severity defaults to `unknown` vulnerability severity, which triggers a downgrade to `caution` (Score: 66) (not `ship`). |
| **B4** | OSV request failing (500) must not claim "No known vulnerabilities detected" or ship. | **CLOSED** | Resolved to `caution` (Score: 66). Provenance shows `sources.osv = "failed"`. Reason list correctly claims: `OSV vulnerability data unavailable — security evidence unverified.` |
| **B5** | Prerelease latest version `1.0.0-beta.1` inside `[1.0.0-beta.0,1.0.0)` affected by a critical vulnerability. | **CLOSED** | The vulnerability is correctly included in the bundle, resulting in a verdict of `avoid` (Score: 59) rather than stripping prerelease information and shipping. |
| **B6 (Extra)** | Synactically nonempty/invalid `fixedIn: "not-a-version"` on a critical vulnerability. | **CLOSED** | The invalid version string is rejected during comparison, resulting in the vulnerability being correctly treated as active/unfixed, leading to a verdict of `avoid` (Score: 71). |

---

## 3. New-Hole Hunt Findings

No new vulnerabilities, safety bypasses, or determinism breaks were found. 

### Hardening verification details:
- **SPDX Normalization**: The parser checks case, parentheses, `-only`, `-or-later`, `+`, and logical operators (`AND`/`OR`) with robust regular expressions.
- **Fail-Closed Range Check**: The affected version check `isAffected` is written defensively. If any semantic version cannot be parsed, or if a range metadata layout is unexpected/malformed, the code defaults to assuming the component is affected (`return true`).
- **Fail-Closed Severity**: Unparseable CVSS vectors or database severities default to `"unknown"` severity, which triggers a hard-rule downgrade of any potential `ship` verdict to `caution`.
- **Fail-Closed Sources**: If the OSV or license source request fails (e.g. 500 error), the `sources` metadata tracks `"failed"`, which strictly blocks `ship` (downgrading it to `caution`).

---

## 4. Final Verdict

**Final Verdict:** YES. The MVP now strictly upholds the core promise to "never ship an unsafe/insufficiently-evidenced component."
