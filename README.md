# ossfind — safety-ranked open-source component discovery

Given a query like *"http client"*, ossfind returns open-source components **ranked by whether you
can actually ship a product on them** — a blended, explainable score of **fit · license · security ·
maintenance health · integration effort** — served through **both a web UI and an MCP tool** over one
ranking engine.

Its core promise: **never recommend ("ship") a component whose safety evidence is unsafe, missing, or
ambiguous.** The engine fails *closed*.

**New here?** → [`GETTING_STARTED.md`](GETTING_STARTED.md) — install, try the offline demo, go live,
and connect it to an AI agent over MCP (Claude Code / Claude Desktop / Cursor config included), in
about five minutes.

## Quick start

```bash
npm install
npm run typecheck && npm test     # 418 tests, fully offline
npm run gates                     # 13 safety gates, each proven able to fail
```

Run the web app (offline demo mode, uses frozen fixtures):

```bash
OSSFIND_FIXTURES=1 npm run web    # http://127.0.0.1:8787
```

By default, the web server binds exclusively to loopback (`127.0.0.1`).
- `HOST` — bind host (default `127.0.0.1`). Non-loopback hosts (e.g. `HOST=0.0.0.0`) require `OSSFIND_WEB_TOKEN` to be set; starting wide-open without a token is refused.
- `PORT` — server port (default `8787`).
- `OSSFIND_WEB_TOKEN` — optional Bearer token requiring `Authorization: Bearer <token>` on `/api/*` endpoints.

Run the MCP server (for AI agents):

```bash
OSSFIND_FIXTURES=1 npm run mcp    # stdio MCP server exposing `search_components`
```

Drop `OSSFIND_FIXTURES=1` to hit live suppliers (npm registry, ecosyste.ms, deps.dev, OSV).

## Ecosystems (npm + PyPI + GitHub + Hugging Face)

ossfind searches **npm** (default), **PyPI**, **GitHub** repositories, **Hugging Face** models, or
**all four at once** (`ecosystem: "all"`) — one query, results from every ecosystem merged and
safety-ranked together, so you don't have to guess where the answer lives (e.g. "video generation" →
PyPI's `decord`, a GitHub AI-model repo, and a Hugging Face model in the same result set). Pick the
ecosystem with the web/MCP selector, the `ecosystem` MCP tool argument, or `&ecosystem=all` on
`/api/search`.

Discovery is **federated**: a `FederatedDiscoverer` composes multiple source adapters per query
(parallel, per-source error isolation + timeouts, results merged and deduped by id). Enrichment routes
each candidate by its own id prefix (`npm:`/`pypi:`/`github:`/`huggingface:`), so a mixed batch is
enriched correctly per-source. The safety-ranking layer is the same for every source — ossfind owns
the ranking, not the corpus. GitHub and Hugging Face are what surface AI-model repos/models (diffusers,
CogVideo, …) that aren't on any package registry.

- **npm** needs no key — discovery uses the npm registry search API.
- **GitHub** uses the repo search API. Set an optional `GITHUB_TOKEN` in `.env.local` for higher rate
  limits.
- **Hugging Face** needs no key — discovery uses the public models search API.
- **GitHub and Hugging Face components fail-closed to at most "caution"** (never "ship") — a raw repo's
  or model's dependency CVEs can't be verified the way a published package's can; Hugging Face also has
  no OpenSSF-style health score, so it relies on the existing missing-scorecard cap. License (SPDX) is
  still enriched and gated for both.
- **PyPI** discovery uses a **self-hosted local index** by default (no key, no third-party service).
  Build/refresh it once:
  ```
  INDEX_MAX=50000 npm run index:build          # top-N PyPI packages by downloads → .cache/index/pypi.db
  ```
  The index is `node:sqlite` FTS5 (BM25) over name/description/keywords, semantically reranked by the
  embedding model. Select the discovery source with `OSSFIND_PYPI_DISCOVERY=index|libraries|auto`
  (default `auto`: local index if built, else libraries.io).
- **libraries.io is the fallback** for PyPI (used when no local index exists). It needs a free key in
  a gitignored `.env.local` (`LIBRARY_IO_API_KEY=…`, `LIBRARIES_IO_API_KEY` also accepted), loaded via
  `node --env-file=.env.local …`. Without index or key, PyPI discovery degrades to empty (never crashes).

## Live mode & caching

Live mode stores successful supplier responses on disk to reduce repeat requests and avoid supplier
rate limits. Fixture mode remains local and does not use this cache.

- `OSSFIND_CACHE_DIR` — cache directory (default `.cache/http/`).
- `OSSFIND_CACHE_TTL` — cache lifetime in seconds for discovery, license, and health data (default `3600`).
- `OSSFIND_SECURITY_TTL` — cache lifetime in seconds for OSV vulnerability data (default `300`).
- `OSSFIND_CONCURRENCY` — maximum concurrent upstream enrichment requests (default `4`).
- `OSSFIND_NO_CACHE=1` — disable the live-response cache.

Security responses may be up to `OSSFIND_SECURITY_TTL` seconds stale; tune this value down when
stricter vulnerability-data freshness is required.

Supplier APIs are free but rate-limited; review each supplier's terms before commercial use.

## Telemetry & Usage Metrics

ossfind includes an in-memory, privacy-preserving usage collector that tracks aggregate operational health and supplier rate limits.

### Local Inspection (Read-Only)

You can inspect usage metrics at any time without sending data anywhere:
- **MCP Tool:** Call `usage_stats` to receive the metrics snapshot and a formatted summary of top suppliers, cache hit rates, rate-limit headroom, and latency percentiles (p50/p95).
- **Web API:** Send `GET /api/usage` to retrieve the JSON snapshot. When `OSSFIND_WEB_TOKEN` is set, `/api/usage` requires the same `Authorization: Bearer <token>` header as `/api/search`.

### What Is Collected
- **Aggregate Supplier Counters:** Total requests, cache hits, cache misses, HTTP status class counts (`2xx`, `4xx`, `5xx`), 429 counts, error counts, and latest rate-limit headroom (`remaining`, `limit`, `reset`, `retryAfter`) per approved supplier host.
- **Search Operations:** Total searches served, ecosystem distribution (`npm`, `pypi`, `github`, `huggingface`), verdict distribution (`ship`, `caution`, `avoid`), result count summary (min, max, mean), error counts, and latency percentiles (p50, p95).
- **Anonymous Install ID:** A random UUID v4 generated once and stored locally in `.cache/telemetry/install-id`.
- **Metadata:** Tool version (`0.1.0`) and ISO 8601 timestamp.

### What Is Explicitly NOT Collected
- **NO** raw query strings or search phrases.
- **NO** package names, repository names, or model identifiers.
- **NO** file paths, local paths, or directory names.
- **NO** auth tokens, API keys, credentials, or environment secrets.
- **NO** full URLs, request payloads, or response bodies.
- **NO** IP addresses, hostnames, usernames, MAC addresses, or hardware fingerprints.

### Opt-In Remote Telemetry (Client-Side)

Remote telemetry is **off by default**. Absolutely no network calls are made unless **both** switches are explicitly set:

```bash
# Enable remote telemetry by setting BOTH switches:
export OSSFIND_TELEMETRY=1
export OSSFIND_TELEMETRY_URL="https://your-telemetry-collector.example.com/v1/metrics"
```

- **Two-switch requirement:** If either `OSSFIND_TELEMETRY=1` or `OSSFIND_TELEMETRY_URL` is omitted, telemetry is completely inert.
- **HTTPS required:** Ingestion URLs must use `https://`; unencrypted `http://` URLs are rejected.
- **Batched & Non-blocking:** Telemetry flushes asynchronously in the background and never blocks search or user requests.
- **Fail-open & silent:** Any network failure, DNS error, timeout, or HTTP error is swallowed silently. It will never break, slow, or alter search results.
- **Inert in fixture/test mode:** Telemetry never executes when `OSSFIND_FIXTURES=1` or during automated test runs.
- **To disable:** Unset `OSSFIND_TELEMETRY` (or set `OSSFIND_TELEMETRY=0`) or unset `OSSFIND_TELEMETRY_URL`.

### Telemetry Payload Shape

```json
{
  "installId": "c3e98db2-5b94-4f27-9c98-1092e4ab78ef",
  "version": "0.1.0",
  "timestamp": "2026-08-30T06:30:00.000Z",
  "snapshot": {
    "suppliers": {
      "registry.npmjs.org": {
        "requests": 14,
        "cacheHits": 12,
        "cacheMisses": 2,
        "statusClasses": { "1xx": 0, "2xx": 2, "3xx": 0, "4xx": 0, "5xx": 0 },
        "rateLimited429": 0,
        "errors": 0,
        "rateLimit": { "remaining": 980, "limit": 1000 }
      },
      "api.github.com": {
        "requests": 4,
        "cacheHits": 3,
        "cacheMisses": 1,
        "statusClasses": { "1xx": 0, "2xx": 1, "3xx": 0, "4xx": 0, "5xx": 0 },
        "rateLimited429": 0,
        "errors": 0,
        "rateLimit": { "remaining": 58, "limit": 60, "reset": 1725000000 }
      }
    },
    "operations": {
      "searchesServed": 3,
      "ecosystems": { "npm": 2, "pypi": 1, "github": 0, "huggingface": 0 },
      "verdicts": { "ship": 2, "caution": 1, "avoid": 0 },
      "results": { "count": 3, "total": 24, "min": 5, "max": 10, "mean": 8.0 },
      "errors": 0,
      "latency": { "count": 3, "p50": 18, "p95": 42, "reservoirSize": 3 }
    }
  }
}
```

## How it works

`discover → enrich → fit → rank`, wired in `src/pipeline/orchestrator.ts`:

| Stage | Module | Source |
|---|---|---|
| **Discover** | `src/adapters/discovery.ts` | npm registry search |
| **Enrich** | `src/adapters/enrichment.ts` | ecosyste.ms (license/repo), deps.dev + OpenSSF Scorecard (health), OSV (vulns) |
| **Fit** | `src/fit/embeddings.ts` · `src/fit/tfidf.ts` | local embedding model (live) / deterministic TF-IDF (tests), both with a keyword+coverage guard |
| **Rank** ★ | `src/ranking/rank.ts` | pure, deterministic, explainable blend + verdict |

The HTTP layer is injectable (`src/http/client.ts`), so every test replays frozen fixtures in
`fixtures/raw/` — **no test touches the network.**

## The safety model (the moat)

`rank()` is pure and deterministic. It computes five 0–1 sub-scores, an overall 0–100, and a verdict
(`ship` / `caution` / `avoid`) with **hard, fail-closed rules** that override any high score:

- A vulnerability that **affects the selected version** (version-aware, prerelease-aware) forces
  `avoid` if critical — regardless of a *future* `fixedIn`.
- **GPL/AGPL** into a permissive project — across SPDX expression forms (`-or-later`, `+`, `AND`/`OR`,
  case) — can never `ship`.
- **Unknown / unverified** license, **failed OSV** retrieval, or **unparseable severity** → capped at
  `caution`; the engine will not claim "no vulnerabilities" when OSV data is missing.

Every result carries a non-empty, human-readable `reasons[]` explaining the drivers.

## Quality gates (`npm run gates`)

Thirteen executable gates, each mapped to the defect/decision that spawned it (see `PIPELINE_LOG.md`),
each proven to **reject a known-bad input** (not just accept a good one):

`G1` contract · `G2` determinism · `G3` critical-CVSS fact (v3.0/v3.1/v4) · `G4` license SPDX fact ·
`G5` offline · `G6` version-relevance fact · `G7` evidence completeness · `G8` federation provenance ·
`G9` Python project-context honesty · `G10` scaffold snippet integrity · `G11` Python stub structural
honesty · `G12` recipe resolution honesty · `G13` adoption cannot override safety.

Every gate after `G7` exists because an independent adversarial audit found a real bug that the
then-green test suite missed.

## Audit trail

Every component has been independently audited — each audit by an agent that did not write the code —
and **every one found real bugs the green test suite had missed**. All are fixed and gated.

- `AUDIT_REPORT.md` — the safety layer: 5 blockers (all fixed).
- `REAUDIT_REPORT.md` — independent re-audit confirming all 5 closed.
- `CACHE_AUDIT.md` — the live cache: key-collision + stale safety signal (both fixed).
- `FEDERATION_AUDIT.md` — federation/GitHub/all-ecosystem: 2 structural holes (→ `G8`).
- `AUDIT_AGENT_LAYER_A.md` — npm/PyPI manifest, compat, MCP, ZIP/range: false "compatible" blocker (→ `G9`).
- `AUDIT_AGENT_LAYER_B.md` — scaffold + stub parser: **code injection** into generated snippets and
  fabricated exports from docstrings (→ `G10`, `G11`).
- `AUDIT_AGENT_LAYER_C.md` — recipes + typeshed: fail-open on supplier errors, false "ready" (→ `G12`).

## Status & limitations (MVP)

- **Live mode works** against real suppliers, with a persistent disk cache (category-aware TTL:
  security/OSV data defaults to 300s, everything else 3600s) and a concurrency cap. Fixture mode
  stays offline and deterministic for tests/demos.
- **Fit is semantic in live mode** — a local embedding model (`Xenova/all-MiniLM-L6-v2` via
  `@huggingface/transformers`, mean-pooled, cached per package under `.cache/embeddings/`) ranks by
  meaning. Fixture/test mode uses deterministic TF-IDF so tests stay offline and exact. Force either
  with `OSSFIND_FIT=embeddings|tfidf`; live falls back to TF-IDF if the model can't load.
- Ecosystems: **npm, PyPI, and GitHub**, via a federated discovery layer. Discovery composes existing
  search sources (registry APIs, a self-hosted PyPI index, libraries.io, GitHub) — ossfind owns the
  safety ranking, not the corpus. More sources (Hugging Face, Cargo/Go/Maven) are thin adapters away.
- GitHub repo components fail-closed to "caution" (dependency-CVE data isn't available for a raw repo).
- The self-hosted PyPI index is optional (one source in the federation): FTS5/BM25 recall + semantic
  rerank, plus a stored-vector hybrid recall (`searchHybrid`). It does not scale to the full ~928k
  corpus by API crawl — use ecosyste.ms bulk dumps + an ANN index for that (deliberately not built).
- Bundled fixtures cover ~15 npm + 12 PyPI packages for offline tests/demo; live mode enriches any package.
- License output is **guidance, not legal advice.**
