# ossfind Independent Adversarial Audit

Date: 2026-08-12  
Scope: read-only review of ranking, enrichment, license compatibility, gates,
pipeline, fixture HTTP, and contracts. No files under `src/`, `fixtures/`, or
configuration were modified. All custom probes were inline `tsx` programs or
temporary files under `/tmp`.

## Executive result

**Final verdict: NO.** The MVP does not currently uphold the core promise of
never returning `ship` for an unsafe component. Concrete bypasses exist for
strong-copyleft SPDX expressions, a CVSS v4 critical vulnerability, failed
OSV enrichment, and prerelease version relevance. The ordinary fixture suite
is deterministic and offline, but its gates do not cover those cases.

## Baseline commands

Commands run from the repository root:

```text
$ npm run typecheck

> ossfind@0.1.0 typecheck
> tsc --noEmit
```

**PASS** (exit 0).

```text
$ npm test

Test Files  10 passed (10)
     Tests  53 passed (53)
  Duration  653ms
```

**PASS** (exit 0).

```text
$ npm run gates

| Gate ID | Description | check() status | proveFailure() status |
| G1 | Contract validation ... | pass | detected |
| G2 | Determinism check ... | pass | detected |
| G3 | Explainability + critical-CVE ... | pass | detected |
| G4 | License check ... | pass | detected |
| G5 | Offline check ... | pass | detected |
| G6 | Resilience + version-relevance check ... | pass | detected |

All quality gates passed successfully!
```

**PASS** (exit 0). Fixture-mode execution was fully offline: G5 replaces
`globalThis.fetch`, observes zero attempted network calls, and passed. The
fixture client maps supplier URLs to frozen local fixtures.

## Core logic reviewed

Reviewed: `src/ranking/rank.ts`, `src/adapters/enrichment.ts`,
`src/license/compat.ts`, all `src/gates/*`, `src/mcp/pipeline.ts`,
`src/http/fixture-client.ts`, and every file in `src/contracts/`.

Important design observations:

- A `ship` is score-based (75+) unless an explicit hard rule changes it.
- Unknown non-null license strings are treated as conditional and score `0.7`.
- Empty vulnerabilities mean the positive assertion "No known vulnerabilities
  detected," even when the OSV request failed.
- The gates primarily run happy-path fixtures, and G3/G4 inspect output text or
  an exact license badge rather than independently preserving safety facts.

## Adversarial probes

### a. Critical-CVE gate

**Result: HOLE.** The direct ranker path does hold for the literal severity
forms tested, but not for all CVSS representations.

| Input (MIT project, fit 1.0, scorecard 10, not archived) | Observed enrichment / verdict | Result |
|---|---|---|
| Direct bundle: `{ id: "CVE-x", severity: "CRITICAL" }`, no `fixedIn` | `security: 0.05`, `avoid` | HOLDS |
| Direct bundle severity `critical` and `CrItIcAl`, no `fixedIn` | `avoid` | HOLDS |
| OSV only: `CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H`, no database severity, `introduced: "0"`, latest `1.0.0` | normalized to `CRITICAL`; `avoid` | HOLDS |
| OSV only: `CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H`, no database severity, `introduced: "0"`, latest `1.0.0` | emitted bundle `[ { id: "GHSA-cvss4", severity: "LOW" } ]`; `security: 0.9`, `overall: 84`, **`ship`** | **HOLE** |
| OSV critical interval `[introduced: "2.0.0", fixed: "3.0.0")`, selected latest `2.5.0` | emitted `{ severity: "CRITICAL", fixedIn: "3.0.0" }`; `overall: 84`, **`ship`** | **HOLE** |
| Schema-valid direct bundle: critical vuln with `fixedIn: "not-a-version"` | `schemaValid: true`, `security: 0.5`, `overall: 84`, **`ship`** | **HOLE** |

The CVSS code rewrites a v4 prefix to v3 syntax, then parses incompatible v4
metrics as low severity (`enrichment.ts:183-200`). The ranker treats any
truthy `fixedIn` string as fixed (`rank.ts:69-79`), even if the fix is in a
future version and the selected latest version is in the affected range. The
contract accepts any nonempty string (`enrichment-bundle.ts:18-23`).

### b. GPL/AGPL compatibility into MIT and Apache-2.0

**Result: HOLE.** Exact, case-insensitive identifiers hold, but common SPDX
expressions evade the hard rule.

| Component license, ideal bundle | MIT verdict | Apache-2.0 verdict | Result |
|---|---:|---:|---|
| `GPL-3.0`, `gPl-3.0`, `AGPL-3.0`, `agpl-3.0` | `avoid` | `avoid` | HOLDS |
| `GPL-3.0-or-later`, `GPL-3.0+`, `GPL-3.0-only`, `GPL-3.0 OR MIT`, `(GPL-3.0)` | **`ship` (92)** | **`ship` (92)** | **HOLE** |
| AGPL equivalents (for example `AGPL-3.0-or-later`) | **`ship` (92)** | **`ship` (92)** | **HOLE** |
| literal `unknown` | **`ship` (92)** | **`ship` (92)** | Missing safety gate |
| `null` license | `ship` (82 with scorecard 10) | `ship` | Missing safety gate |

`normalizeLicense` recognizes only exact strings (`compat.ts:14-27`). Every
unrecognized non-null string becomes `conditional`, then gets a generous `0.7`
license score (`rank.ts:46-53`). G4 only rejects the exact badge
`"GPL-3.0"` (`g4.ts:9-16`), so it passes while all expression variants ship.

### c. Version relevance (Defect B)

**Result: HOLE.** The normal fixture case works, but a prerelease is falsely
excluded.

- Correct exclusion: fixture `axios` latest version `1.19.0` has **44** raw
  OSV records and **0** retained active vulnerabilities. The inspected ranges
  all ended before that latest version.
- Correct inclusion: fixture `vite` latest `8.0.3` retains **5** active
  vulnerabilities. Their relevant `8.0.x` affected intervals end at `8.0.5`
  or `8.0.16`, so all five apply to `8.0.3`.
- False negative reproduction: custom supplier responses specified latest
  `1.0.0-beta.1` and an OSV **CRITICAL** interval
  `introduced: "1.0.0-beta.0", fixed: "1.0.0"`. The enriched vulnerability
  list was `[]`; the otherwise ideal MIT component ranked
  `overall: 87, verdict: "ship"`. `semver.coerce` strips prerelease data in
  the relevance check (`enrichment.ts:75-162`), so the affected prerelease is
  assessed as final `1.0.0` and incorrectly excluded.

No patched-at-latest false positive was found in the supplied fixtures.

### d. Determinism

**Result: HOLDS.** Ran the full fixture pipeline for `"http client"` twice,
serialized each result to `/tmp/ossfind-http-client-{1,2}.json`, and diffed
them:

```text
diff -u /tmp/ossfind-http-client-1.json /tmp/ossfind-http-client-2.json
exit 0

SHA-256 (both): bba727c7e7a51d9bf0e4aafac8ed6a5c3d7afae51afa31b4d961cd5e400e9330
```

### e. Resilience under HTTP 429 / 500 / thrown request

**Result: HOLDS for no-crash degradation; HOLE for safety semantics.**

- Direct `HttpDiscoverer` and `HttpEnricher` probes with each of 429, 500, and
  a thrown error did not crash. Each yielded discovery count `0` and bundle
  `{ license: { spdxId: null, confidence: 0 }, vulnerabilities: [],
  scorecard: { overall: null, checks: [] }, maintenance: {} }`.
- With fixture discovery but **every** enrichment request returning 500, the
  full pipeline did not crash, but emitted schema-valid `caution` results at
  70 with `unknown` license, scorecard 0.4 default, CVE count 0, and the
  misleading reason `No known vulnerabilities detected.`
- More seriously, wrapping only OSV to return 500 left fixture `axios` as
  `{ overall: 85, verdict: "ship", badges: { license: "MIT", cveCount: 0,
  scorecard: 8.1 } }`, again with `No known vulnerabilities detected.` OSV
  never returned data. This is a `ship` on incomplete security evidence.

## Ranked findings and required missing gates

1. **BLOCKER — SPDX strong-copyleft expressions ship into permissive projects.**
   Evidence: `GPL-3.0-or-later` and `AGPL-3.0-or-later` produced `ship: 92`
   for both MIT and Apache-2.0. Exact-only license normalization and G4's
   exact-string check permit the bypass.

   **Missing gate:** data-drive GPL/AGPL detection through case, `-only`,
   `-or-later`, `+`, parentheses, and SPDX `AND`/`OR` expressions. For an MIT
   or Apache project, assert each expression that permits a GPL/AGPL licensing
   path cannot be `ship`; unknown/unparseable expressions must be fail-closed
   (`caution` or `avoid`) pending review.

2. **BLOCKER — Active critical vulnerabilities with a future fix can ship.**
   Evidence: latest `2.5.0` in the active critical OSV interval `[2.0.0,
   3.0.0)` was emitted with `fixedIn: "3.0.0"` and shipped at 84. The ranker
   equates the existence of a future fix with the selected version being fixed.

   **Missing gate:** for every vulnerability independently established as
   affecting the selected/latest version, assert a CRITICAL record is `avoid`
   regardless of a later `fixedIn` value. The hard rule must compare the
   selected version to the fix, not test string truthiness.

3. **BLOCKER — CVSS v4 critical vulnerabilities can ship.**
   Evidence: the fully specified v4 critical vector above was classified LOW
   and returned `ship: 84`. G3 proves only one v3 vector.

   **Missing gate:** test representative CVSS v3.0, v3.1, and v4 critical
   vectors with no database-specific severity; each must produce critical
   treatment and never `ship`. If parsing cannot establish severity, prevent
   `ship` rather than assigning a low/default severity.

4. **BLOCKER — Failed OSV data is represented as no vulnerabilities and can ship.**
   Evidence: OSV 500 for `axios` still returned `ship: 85` and the false claim
   "No known vulnerabilities detected." `fetchJson` intentionally collapses
   all error states to `undefined` (`enrichment.ts`), losing provenance.

   **Missing gate:** carry per-source success/completeness into the enrichment
   contract; assert `ship` requires successful OSV and license evidence (and a
   defined health/scorecard policy). On OSV failure, the output must disclose
   unavailable security data and cannot state that no vulnerabilities exist.

5. **BLOCKER — Current prerelease vulnerability is falsely excluded.**
   Evidence: latest `1.0.0-beta.1` inside the critical interval
   `[1.0.0-beta.0, 1.0.0)` was omitted and the component shipped at 87.

   **Missing gate:** version-relevance cases must include prereleases,
   multi-interval advisories, `last_affected`, explicit version lists, and
   unknown/unparseable versions. An ambiguous/latest prerelease must not be
   silently excluded from a `ship` decision.

6. **SHOULD-FIX — Any syntactically nonempty `fixedIn` suppresses the critical
   hard rule.** Evidence: a Zod-valid critical record with
   `fixedIn: "not-a-version"` shipped at 84. This also makes direct use of the
   contract unsafe even if supplier parsing usually produces version-like text.

   **Missing gate:** schema/ranker tests must reject invalid/whitespace
   `fixedIn`, and a current critical vulnerability may be treated as fixed only
   after a valid version comparison proves the selected version is outside the
   affected interval.

7. **SHOULD-FIX — Thin/unknown enrichment can get a `ship` verdict.**
   Evidence: a direct component with literal `unknown` license, no scorecard,
   and no OSV evidence returned `ship: 80`; the same with scorecard 10 returned
   `ship: 92`. A null license with scorecard 10 still shipped at 82. This is
   especially dangerous because missing-source failures are currently
   indistinguishable from a clean result.

   **Missing gate:** test a completeness matrix (missing license, missing OSV,
   missing scorecard, missing maintenance); specify the maximum verdict for
   each. At minimum, unverified license or OSV must block `ship`.

8. **NICE-TO-HAVE — Fit/default-data collapse produces indistinguishable
   recommendations.** Fixture `http client` produced seven schema-valid
   unknown-license/no-scorecard components at exactly `70/caution`, all with
   fit 1.0, security 1.0, health 0.4, effort 0.9. The deterministic ID
   tiebreaker makes ordering reproducible but not substantively meaningful.

   **Missing gate:** assert that a result set with missing enrichment is
   labeled incomplete and that fit ties do not imply fabricated health/security
   confidence. This is ranking quality rather than a direct `ship` bypass.

## Gate quality assessment

The current battery passes because it checks the happy fixture set and seeded
toy failures. G3 infers an unfixed critical CVE from a reason string, not a
source vulnerability fact; G4 checks only exact `GPL-3.0`; G6 covers a stable
version and no-crash behavior. Thus schema-valid, visibly wrong output passes
the battery in each blocker listed above.
