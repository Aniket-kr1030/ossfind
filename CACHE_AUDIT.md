# adversarial audit report: ossfind persistent http cache

This document details an independent adversarial audit of the persistent HTTP cache implementation in `ossfind`.

---

## 1. Command Outputs

### Command: `npm run typecheck`
```
> ossfind@0.1.0 typecheck
> tsc --noEmit
```

### Command: `npm test`
```
> ossfind@0.1.0 test
> vitest run


 RUN  v3.2.7 /Users/aniket/Projects/OpensourceRepoForAgents

 ✓ src/license/compat.test.ts (34 tests) 2ms
 ✓ src/http/cache.test.ts (5 tests) 12ms
 ✓ src/http/limit.test.ts (2 tests) 23ms
 ✓ src/ranking/rank.test.ts (21 tests) 5ms
 ✓ src/pipeline/foundation.test.ts (4 tests) 18ms
 ✓ src/adapters/discovery.test.ts (2 tests) 36ms
 ✓ src/pipeline/integration.test.ts (1 test) 20ms
 ✓ src/web/server.test.ts (4 tests) 62ms
 ✓ src/adapters/enrichment.test.ts (12 tests) 92ms
 ✓ src/mcp/server.test.ts (2 tests) 41ms
 ✓ src/fit/lexical.test.ts (3 tests) 2ms
 ✓ src/fit/tfidf.test.ts (7 tests) 4ms
 ✓ src/gates/gates.test.ts (7 tests) 99ms

 Test Files  13 passed (13)
      Tests  104 passed (104)
   Start at  08:50:00
   Duration  393ms (transform 314ms, setup 0ms, collect 1.03s, tests 417ms, environment 1ms, prepare 476ms)
```

### Command: `npm run gates`
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
| G7      | Evidence completeness: unverified OSV or license never ships; missing scorecard has an explicit policy | pass           | detected              |

====================================

✅ All quality gates passed successfully!
```

---

## 2. Adversarial Probes Audit Table

| Step | Probe Description | Verdict | Evidence |
| :--- | :--- | :--- | :--- |
| **a** | **Correctness**:<br>- Identical requests served from cache<br>- TTL expiry triggers refetch<br>- Non-ok (429/500) responses are NOT cached | **HOLDS** | verified via test probes. A cached OK response returns in 1 call to the inner client, while expiring the TTL increments calls. Error status (e.g. 500) is never written to disk, so a retried error triggers a refetch. |
| **b** | **Cache-key safety**:<br>- Method + body + URL collision check | **HOLE** | **Newline Injection**: concatenation of `method + "\n" + url + "\n" + body` allows cross-boundary collisions when newline characters exist in URLs or method. <br>**Non-string Serialization**: `FormData` and stream bodies serialize to standard string tags like `"[object FormData]"`, collapsing different payloads into the same key. |
| **c** | **Path/dir safety**:<br>- Path traversal vulnerability check via URL contents | **HOLDS** | The cache key is strictly a SHA-256 hash formatted as a hex string (`[a-f0-9]{64}.json`), avoiding any raw URL/path components in the filename. |
| **d** | **Corruption resilience**:<br>- Truncated/garbage cache file treated as a miss, does not throw | **HOLDS** | The `loadEntry` function wraps the `JSON.parse` operations in a `try/catch` and returns `undefined` on parsing error. The calling wrapper `withCache` correctly treats this as a cache miss. |
| **e** | **Poisoning**:<br>- Storage of error bodies or partial responses served as success | **HOLDS** | Only responses where `response.ok` is true are cached. If `response.json()` throws a JSON syntax or stream error, the execution fails before reaching `saveEntry` and is not cached. |
| **f** | **Fixture-mode isolation**:<br>- Determinism check: fixture mode does not access the disk cache | **HOLDS** | In `src/mcp/pipeline.ts`, requesting fixture mode directly maps to the `createFixtureHttpClient()`, completely bypassing `withCache` wrapping. |
| **g** | **Concurrency limiter**:<br>- Peak in-flight limits, deadlock avoidance, error tolerance | **HOLDS** | The limiter uses an active counter and a FIFO promise-resolving queue. Handled via `finally`, ensuring the slot is released even on rejection, preventing deadlocks. |

---

## 3. Findings & Safety Signal Considerations

### Finding 1: Cache Key Collision via Newline Injection (HOLE)
- **Severity**: Medium
- **Description**: The cache key is generated by hashing `${method}\n${url}\n${body}`. However, because the fields are not delimited or length-prefixed, a URL containing a newline character can shift content from the URL field to overlap with the method or body.
- **Repro**:
  - Request 1: `GET` to `http://example.com/\nPOST` with body `"body"`
  - Request 2: `GET` to `http://example.com/` with body `"POST\nbody"`
  - Both requests result in the same concatenated string: `GET\nhttp://example.com/\nPOST\nbody`, producing a SHA-256 hash collision and serving incorrect cached data.

### Finding 2: Cache Key Collision for Complex Body Formats (HOLE)
- **Severity**: Medium
- **Description**: The helper `requestBody` handles strings, `URLSearchParams`, and `ArrayBuffer` but falls back to `String(body)` for other types. Complex objects like `FormData` or custom streams serialize to standard placeholder strings (e.g. `"[object FormData]"`), which causes all requests using those formats to share a single cache key.
- **Repro**:
  - Sending two different `POST` requests to `https://example.com/api` with different `FormData` parameters results in both requests being mapped to the exact same cache key since `requestBody` returns `"[object FormData]"` for both.

### Stale Safety Signal Consideration (NEW-HOLE)
- **Severity**: Medium / High (under safety terms)
- **Implication**: `ossfind` promises a strict fail-closed safety model (never recommending components with unsafe, missing, or ambiguous safety evidence). However, live mode caches security data (e.g., OSV vulnerability responses) for `OSSFIND_CACHE_TTL` (default 3600 seconds/1 hour). If a new critical vulnerability is published during this window, the tool will serve a cached "clean" safety signal, potentially recommending a package that has since become unsafe.
- **Documentation**: While the existence of `OSSFIND_CACHE_TTL` is documented in the README, the security risk of serving a stale safety signal for up to 1 hour is not explicitly documented or mitigated.

---

## 4. Final Verdict

Is the cache correct and safe to enable in live mode? **NO**.
**Caveats**: While the concurrency limiter, corruption resilience, and path traversal protections hold, the cache key algorithm suffers from two key collision vulnerabilities (newline injection and complex body type collisions). Furthermore, caching security-critical OSV responses under a 1-hour TTL violates the strict fail-closed security guarantees of `ossfind` for newly published vulnerabilities without explicit user warning.
