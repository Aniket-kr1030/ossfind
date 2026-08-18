# Getting started

Five minutes from clone to your first safety-ranked query — as a human in a browser, or as an
AI agent over MCP.

## 1. Install

```bash
git clone <this-repo-url> ossfind && cd ossfind
npm install        # also builds dist/ automatically (the "prepare" script)
```

Requires Node 22+ (for the built-in `node:sqlite` used by the local PyPI index).

## 2. Try it with zero setup (offline demo)

No network, no keys — runs against frozen fixtures for ~15 npm/PyPI/GitHub/Hugging Face packages:

```bash
OSSFIND_FIXTURES=1 npm run web        # → http://localhost:8787
```

Open it, type `http client`, hit Search. You'll see ranked cards with a verdict pill
(ship/caution/avoid), license/CVE/health badges, and the reasons behind the score.

Or see the same engine narrated in your terminal:

```bash
npm run demo
```

## 3. Go live — per ecosystem, what you need

Drop `OSSFIND_FIXTURES=1` to query real suppliers. Setup needed varies by ecosystem:

| Ecosystem | Setup | Notes |
|---|---|---|
| **npm** | none | npm registry search, first-party |
| **GitHub** | none (optional `GITHUB_TOKEN`) | token raises the rate limit; put it in `.env.local` |
| **Hugging Face** | none | public models search API |
| **PyPI** | build a local index once | see below — this is the only ecosystem with setup |

Build the PyPI index (one-time; self-hosted, no key, no third-party dependency):

```bash
INDEX_MAX=50000 npm run index:build   # ~5-10 min depending on size; bigger = more coverage
```

Without it, PyPI discovery falls back to [libraries.io](https://libraries.io) (needs a free API
key in `.env.local` — see `README.md`) or returns empty rather than crashing.

Then just run live:

```bash
npm run web                            # http://localhost:8787 — pick an ecosystem in the selector
```

Try `ecosystem=all` in the selector (or `&ecosystem=all` on the API) to search **npm + PyPI +
GitHub + Hugging Face in one query** — useful when you don't know which ecosystem has the answer
(e.g. "video generation" spans all four).

## 4. Connect it to an AI agent over MCP

The MCP server exposes one tool, `search_components(query, ecosystem?, projectLicense?, limit?)`,
returning the same ranked, safety-scored results as the web UI.

**Sanity-check it works** (offline, no client needed):

```bash
OSSFIND_FIXTURES=1 npm run mcp
```

It should sit waiting on stdio — that's correct, it's a stdio server, not an HTTP one. Ctrl-C to
stop; a real client drives it over stdin/stdout.

**Register it with a client.** Use the absolute path to your checkout (replace `/path/to/ossfind`):

<details>
<summary><b>Claude Code</b> — project-level <code>.mcp.json</code></summary>

```json
{
  "mcpServers": {
    "ossfind": {
      "command": "node",
      "args": ["/path/to/ossfind/dist/mcp/server.js"],
      "env": { "OSSFIND_FIXTURES": "1" }
    }
  }
}
```

Drop `OSSFIND_FIXTURES` once you've built the PyPI index / are happy querying live. Restart
Claude Code to pick up the new server.
</details>

<details>
<summary><b>Claude Desktop</b> — <code>claude_desktop_config.json</code></summary>

```json
{
  "mcpServers": {
    "ossfind": {
      "command": "node",
      "args": ["/path/to/ossfind/dist/mcp/server.js"]
    }
  }
}
```

(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`.) Restart Claude Desktop.
</details>

<details>
<summary><b>Cursor</b> / other MCP-aware editors — <code>mcp.json</code></summary>

Same shape as Claude Code's — most MCP-aware tools accept an equivalent
`{"mcpServers": {"ossfind": {"command": "node", "args": [...]}}}` block. Check your tool's docs for
the exact file location.
</details>

**Prefer a bare command name over a long path?** Run `npm link` inside the repo once — this puts
`ossfind-mcp` and `ossfind-web` on your `PATH`, so the config above can use
`"command": "ossfind-mcp"` with no `args` instead.

## 5. What "safety-ranked" actually means

Every result gets a verdict — `ship`, `caution`, or `avoid` — derived from license compatibility,
known CVEs, OpenSSF health, and (for GitHub/Hugging Face) an honest cap: a raw repo or model can
never reach `ship`, because its dependency vulnerabilities can't be verified the way a published
package's can. The `reasons[]` on every result explain exactly why. See `README.md` for the full
model and the audit trail (`AUDIT_REPORT.md`, `REAUDIT_REPORT.md`, `CACHE_AUDIT.md`,
`FEDERATION_AUDIT.md`) if you want to see how that promise has been tested.

## Troubleshooting

- **"Cannot find module" errors** — run `npm install` again (it auto-builds `dist/` via `prepare`);
  if you skipped scripts, run `npm run build` manually.
- **PyPI returns nothing** — you haven't built the local index or set a libraries.io key; see step 3.
- **GitHub/Hugging Face rate-limited** — set `GITHUB_TOKEN` in `.env.local` for GitHub; Hugging Face
  needs no key but has its own public rate limits.
