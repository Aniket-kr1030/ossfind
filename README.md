# ossfind — safety-ranked open-source component discovery

Given a query like *"http client"*, ossfind returns open-source components **ranked by whether you
can actually ship a product on them** — a blended, explainable score of **fit · license · security ·
maintenance health · integration effort** — served through **both a web UI and an MCP tool** over one
ranking engine.

Its core promise: **never recommend ("ship") a component whose safety evidence is unsafe, missing, or
ambiguous.** The engine fails *closed*.

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

## Live mode & caching

Live mode stores successful supplier responses on disk to reduce repeat requests and avoid supplier
rate limits. Fixture mode remains local and does not use this cache.

- `OSSFIND_CACHE_DIR` — cache directory (default `.cache/http/`).
- `OSSFIND_CACHE_TTL` — cache lifetime in seconds (default `3600`).
- `OSSFIND_CONCURRENCY` — maximum concurrent upstream enrichment requests (default `4`).
- `OSSFIND_NO_CACHE=1` — disable the live-response cache.

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

- `AUDIT_REPORT.md` — independent adversarial audit that found 5 safety blockers.
- `REAUDIT_REPORT.md` — independent re-audit confirming all 5 closed.

## Status & limitations (MVP)

- Ecosystem: **npm** only (deps.dev/ecosyste.ms coverage strongest here). Python/others are next.
- Fit is lexical; the interface is ready for embeddings.
- Fixtures cover ~15 packages; non-fixtured packages show `unknown`/estimated data in offline mode
  and enrich fully in live mode.
- License output is **guidance, not legal advice.**
