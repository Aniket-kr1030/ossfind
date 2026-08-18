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
npm run typecheck && npm test     # 90 tests, fully offline
npm run gates                     # 7 safety gates, each proven able to fail
```

Run the web app (offline demo mode, uses frozen fixtures):

```bash
OSSFIND_FIXTURES=1 npm run web    # http://localhost:8787
```

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

## How it works

`discover → enrich → fit → rank`, wired in `src/pipeline/orchestrator.ts`:

| Stage | Module | Source |
|---|---|---|
| **Discover** | `src/adapters/discovery.ts` | npm registry search |
| **Enrich** | `src/adapters/enrichment.ts` | ecosyste.ms (license/repo), deps.dev + OpenSSF Scorecard (health), OSV (vulns) |
| **Fit** | `src/fit/lexical.ts` | lexical relevance (embeddings-ready interface) |
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

Seven executable gates, each mapped to the defect/decision that spawned it (see `PIPELINE_LOG.md`),
each proven to **reject a known-bad input** (not just accept a good one):

`G1` contract · `G2` determinism · `G3` critical-CVSS fact (v3.0/v3.1/v4) · `G4` license SPDX fact ·
`G5` offline · `G6` version-relevance fact · `G7` evidence completeness.

## Audit trail

- `AUDIT_REPORT.md` — independent adversarial audit that found 5 safety blockers (all fixed).
- `REAUDIT_REPORT.md` — independent re-audit confirming all 5 closed.
- `CACHE_AUDIT.md` — independent audit of the live cache (key-collision + stale-signal, both fixed).

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
