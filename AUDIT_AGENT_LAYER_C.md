# Independent audit C — recipes + typeshed path

**Auditor:** the PM (Claude), which wrote neither of these components — they were written by the `agy`
agent (tickets A6, P6 for recipes; P1 for the typeshed path). This closes the gap left when audit B
was split for timeout and covered only `scaffold.ts` + `py-stub-parser.ts`.

**Scope:** `src/recipes/**` (catalog, resolution) and the **typeshed** path of `src/api/py-surface.ts`.

## Baseline

`npm run typecheck` clean · `npm test` 362 passed | 1 skipped · `npm run gates` G1–G11 all pass /
proveFailure detected.

## Probe results

| Probe | Result | Evidence |
|---|---|---|
| a. `fill()` throws | **HOLE (blocker)** | `resolveRecipe(recipe, async () => { throw new Error("network down") })` propagates the error straight out — resolution crashes instead of degrading. |
| b. `fill()` returns `null` | **HOLE (blocker)** | Raw `TypeError: Cannot read properties of null (reading 'filter')` escapes to the caller. |
| c. `fill()` returns malformed objects | HOLDS | `[{id:"npm:x"}]` (no `verdict`) → role unfilled, `status: "blocked"`. Correctly fail-closed. |
| d. All-caution stack | **HOLE (should-fix)** | Every required role filled with a `caution` component still yields `status: "ready"`. |
| e. Zero-role recipe | HOLE (nice-to-have) | A recipe with `roles: []` returns `status: "ready"` vacuously. |
| f. `avoid` never selected | HOLDS | Sole candidate `verdict:"avoid"` with `overall: 99` → not selected, `status: "blocked"`. |
| g. Typeshed hostile names | HOLDS | `../../../etc/passwd`, `requests/../../numpy`, `requests%2F..%2Fnumpy`, `req uests`, unicode-homoglyph `requeѕts` → all `typesAvailable: "none"`, **no traversal segment reaches the built URL**. Fails closed. |
| h. Determinism | Mixed | Byte-identical across runs *in this environment*, but the tiebreak uses `localeCompare` (see finding 3). |

## Findings

### 1. BLOCKER — `resolveRecipe` throws instead of failing closed

`resolveRole` does `const candidates = await fill(role.candidateQuery);` with no error handling
(`src/recipes/resolve.ts:39`). In production `fill` wraps the live search pipeline, which performs
network I/O against rate-limited third-party suppliers, so a transient failure or a malformed response
crashes the entire recipe resolution.

This is the **outlier in the codebase**: discovery, enrichment, the scaffold builder, the stub parser,
and the ZIP reader all degrade to an honest result rather than throwing. Recipes should behave the same
— a role whose `fill` fails is simply a role that cannot be safely filled, i.e. `blocked` with a note
naming the failure.

```js
await resolveRecipe(recipe, async () => { throw new Error("network down"); });
// → throws "network down" (expected: status "blocked" + honest note)
await resolveRecipe(recipe, async () => null);
// → throws TypeError (expected: same)
```

### 2. SHOULD-FIX — an all-`caution` stack is reported `status: "ready"`

This interacts badly with a deliberate design decision elsewhere: **GitHub and Hugging Face components
are capped at `caution` and can never reach `ship`** (they have no verifiable dependency-CVE data). So a
recipe composed entirely of GitHub/HF components reports:

```
status: "ready"
```

…while every single part carries unverified security evidence. The per-role notes do say "Review before
production use", but `status` is the machine-readable field an agent branches on — and it currently says
go. Recommend a distinct status (or an explicit flag) for "all required roles filled, but nothing is
ship-grade", so `ready` keeps meaning what a caller assumes it means.

### 3. SHOULD-FIX — locale-dependent tiebreak undermines determinism

`selectBestCandidate` breaks ties with `a.id.localeCompare(b.id)` (`resolve.ts:28`). `localeCompare` is
locale/ICU-dependent, so identical inputs can order differently across environments or Node builds.
Given the project enforces determinism as a gate (G2), this is a latent cross-environment hazard. Use a
plain code-unit comparison (`<` / `>`) instead.

### 4. NICE-TO-HAVE — vacuous `ready`

A recipe with no roles returns `ready`. Harmless today (the catalog has none) but it means "ready" is
not evidence that anything was actually verified.

### 5. NICE-TO-HAVE — case sensitivity in typeshed lookup

`REQUESTS` resolves to `none` where `requests` resolves to stubs. PyPI distribution names are normalised
case-insensitively, so this is lost coverage. It fails *closed*, so it is correctness-safe — only a
recall gap.

## Missing gates

G1–G11 would not catch any of findings 1–4: no gate exercises `src/recipes/**` at all. Recommend
**G12 — "Recipe resolution honesty"**, whose `check()` asserts that a throwing `fill`, a `null`-returning
`fill`, and a malformed-candidate `fill` each yield a fail-closed `ResolvedRecipe` (never an exception);
that an `avoid`-only role is `blocked`; and that a stack with no ship-grade component does not claim the
unqualified `ready`. Its `proveFailure()` must remove the error handling / re-enable the unqualified
`ready` and confirm the gate detects it.

## Verdict

**No — not safe to rely on as-is.** The typeshed path is sound and resists hostile input, and the core
fail-closed selection rule (`avoid` is never chosen) holds. But recipe resolution can throw out of the
public API on ordinary supplier failure, and it reports `ready` for stacks in which nothing is
ship-grade. Both must be fixed before an agent should act on a `ResolvedRecipe`.
