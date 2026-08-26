# Adversarial audit: API scaffold layer (B)

Scope observed: `src/api/scaffold.ts` and `src/api/py-stub-parser.ts` only. No source, fixture, or configuration files were changed.

## Baseline

```text
$ npm run build
> tsc -p .
exit 0

$ npx vitest run src/api/scaffold.test.ts src/api/py-stub-parser.test.ts
Test Files  2 passed (2)
Tests       38 passed (38)

$ npm run gates
G1–G9: every check() pass; every proveFailure() detected
```

All probes below used `npm run build` first and inline `node --input-type=module -e` imports from `dist/`; no probe executed an emitted snippet.

## Probe results

| Probe | Result | Concrete evidence |
|---|---|---|
| (a) Export-name fabrication / injection | **HOLE** | With the schema-valid export name `safe_load; process.exit()` and signature `safe_load()`, `buildScaffold` returns verified code: `const result = pkg.safe_load; process.exit()();`. `process` and `exit` are not surface exports. The semicolon version compiles as JavaScript; quote and backtick names produce syntactically invalid code. |
| (a) Newline / template-like input | **HOLE** | Name `safe_load\nprocess.exit()` emits two statements; name `safe_load${process.env.SECRET}` emits `const result = pkg.safe_load${process.env.SECRET}();`. A raw signature newline is worse: `run(): void\nprocess.exit()` becomes an executable line after the `// Verified signature:` comment. |
| (a) Reserved, empty, unicode names | Mixed | `class` emits syntactically valid `pkg.class()`. A mathematical-unicode name with an ASCII signature is interpolated verbatim; a unicode signature name is rejected by the ASCII signature parser. Empty `name` reaches output construction then throws `ZodError: String must contain at least 1 character(s)` rather than safely degrading. |
| (a) `self` / `cls` / variadics | **HOLE** | JavaScript signature `run(self: Thing): void` emits `pkg.run(self);`; `cls` likewise. `run(*args: Thing)` and `run(**kwargs: Thing)` emit unbound `args` / `kwargs`. This violates the explicit no-`self`/`cls` rule. The Python first-`self`/`cls` exclusion holds. |
| (b) False `verified-signatures` | **HOLE** | `name: "run", signature: "() => void"` returns `confidence: "verified-signatures"` and `pkg.run();`. So does mismatched `signature: "not_run() => void"`, and `(garbage)` produces `pkg.run(garbage)`. The parser neither requires a declaration name nor consumes the complete signature. Malformed `run(): Promise<` is verified and emits `await pkg.run()`. |
| (c) Import binding / module form | **HOLE** | Manifest `esm: 'import { run } from "my-api";'` plus export `run(): void` returns that import but snippet `myApi.run();`: `myApi` is unbound. Namespace (`import * as api`) and aliased named imports show the same fallback-binding bug. Destructured CJS has the same defect. |
| (c) ESM, CJS, dual / await | Mixed | ESM alone emits no `require`; CJS alone uses its supplied `require`. But CJS plus `get(): Promise<string>` emits top-level `await pkg.get()`, invalid in CommonJS. `dual` and `unknown` return *both* `import pkg ...` and `const pkg = require(...)` in one scaffold, mutually incompatible as a single runnable file. |
| (c) Runtime-kind and instance safety | **HOLE** | `kind: "interface"`, `"type"`, `"namespace"`, or `"enum"` with `Ghost(x: string): void` produces verified `pkg.Ghost(x)`, although these kinds have no assured runtime value. Method exclusion only recognizes first `this` / Python `self`/`cls`; it cannot establish module-level ownership from the flat surface. |
| (d) Parser malformed / large input | Mixed | Unterminated bracket input returns no export and does not throw; it can absorb subsequent declarations. CRLF/tabs preserved the class/top-level boundary. 100,000 nested parentheses took 7.36 ms; a 2 MB line took 22.54 ms: no catastrophic-backtracking hang observed. Unicode declaration names are silently omitted; duplicate declarations are duplicated. |
| (d) Parser scope / strings / docstrings | **HOLE** | `x = "def ghost()"` returns `ghost` as `{kind:"function", signature:"ghost()"}`. `"""\ndef ghost() -> str: ...\n"""` returns a verified `ghost`; a nested `def inner` or control-suite `def ghost` is emitted as a module export. |
| (e) `__all__` honesty | Mixed / **HOLE when combined** | `__all__=["ghost"]` alone emits `{name:"ghost", signature:null}` plus `declared in __all__ but not defined or imported` note (holds). But `__all__=["ghost"]\nx = "def ghost(a):"` emits verified `ghost(a)` with **no note**: the assignment-string fabrication suppresses the fallback honesty path. Dynamic `__all__=a+["ghost"]` is over-trusted (null + note); `__all__=a+b` becomes authoritative empty surface. |
| (f) Determinism | HOLDS | Repeated `JSON.stringify(parsePyStub(input))` and `JSON.stringify(buildScaffold(surface, manifest))` on identical inputs were byte-identical. |

## Ranked findings and reproductions

### Blocker — untrusted export names and signatures inject code into a verified snippet

`ApiSurfaceSchema` accepts arbitrary non-empty strings for `name` and `signature`; the generator directly interpolates both into executable code and a line comment.

```js
const surface = { ...baseSurface, exports: [{
  name: "safe_load; process.exit()", kind: "function", signature: "safe_load()",
}] };
buildScaffold(surface, esmManifest).snippet;
// // Verified signature: safe_load()
// const result = pkg.safe_load; process.exit()();
```

An independent signature-only reproduction is `signature: "run(): void\nprocess.exit()"`, which yields:

```js
// Verified signature: run(): void
process.exit()
const result = pkg.run();
```

Both still claim `confidence: "verified-signatures"`. This is a direct breach of the anti-fabrication invariant and makes the generated code unsafe to run.

### Blocker — “verified” only means balanced parentheses, not a grounded declaration

The selected export is not bound to the parsed signature name and trailing grammar is ignored.

```js
{ name: "run", kind: "function", signature: "() => void" }
// verified: pkg.run();
{ name: "run", kind: "function", signature: "not_run() => void" }
// verified: pkg.run();
{ name: "run", kind: "function", signature: "(garbage)" }
// verified: const result = pkg.run(garbage);
{ name: "run", kind: "function", signature: "run(): Promise<" }
// verified: const result = await pkg.run();
```

The last case additionally violates the no-`await`-without-a-real-async/Promise-signature requirement. JavaScript `self`/`cls` inputs are also passed as arguments (`pkg.run(self)` / `pkg.run(cls)`).

### Blocker — parser invents exports from non-declarations, feeding a verified scaffold

The parser uses an unanchored function regex and does not retain multiline-string or function/control-suite scope. This full source-to-snippet reproduction needs no hand-built surface export:

```js
const parsed = parsePyStub('"""\ndef ghost() -> str: ...\n"""\n');
// parsed.exports: [{ name: "ghost", kind: "function", signature: "ghost() -> str" }]
buildScaffold({ ...pySurface, exports: parsed.exports }, verifiedPyManifest).snippet;
// # Verified signature: ghost() -> str
// result = demo.ghost()
```

`x = "def forged(a):"` and an unterminated string produce the same class of false function export. Nested `inner` functions and declarations under `if TYPE_CHECKING:` are incorrectly module exports as well.

### Blocker — generated calls do not necessarily refer to an imported binding

```js
manifest.importForm.esm = 'import { run } from "my-api";';
surface.exports = [{ name: "run", kind: "function", signature: "run(): void" }];
buildScaffold(surface, manifest);
// imports: ['import { run } from "my-api";']
// snippet: '// Verified signature: run(): void\nmyApi.run();'
```

`myApi` was fabricated from the package id. The same failure occurs with namespace, alias, and destructured-CJS forms. It cannot be safe to call a binding the manifest never imported.

### Should-fix — invalid execution contexts and unsupported runtime kinds

- CJS with a Promise return generates top-level `await`; Node's CommonJS parser rejects it.
- `dual` / `unknown` returns both ESM and CJS imports without marking them as alternatives.
- `interface`, `type`, `namespace`, and `enum` are selected as callable despite no verified runtime value.
- Invalid names such as `foo bar`, quote/backtick names, and an empty name cause broken code or a throw instead of import-only.

### Should-fix — `__all__` dynamic expression over-trust and lossy malformed input

Nonliteral `__all__` expressions are treated as an authoritative literal-string inventory. That can drop genuine direct exports (`a + b`) or expose literal strings from conditional/dynamic expressions. Unmatched brackets silently swallow following statements. These are principally accuracy/availability problems, but the string-decoy combination above escalates to a blocker.

### Nice-to-have — parser completeness and limits

Unicode Python identifiers are omitted, and direct duplicate declarations remain duplicated. The timed 100k-parenthesis / 2MB-line cases were linear enough in this run, but a maximum declaration/input size and an explicit unresolved note would make failures more predictable.

## Missing-gate hunt

G1 only validates broad Zod contracts (which accept hostile strings); G2 checks ranking determinism, not these module outputs; G3–G9 address unrelated safety and compatibility facts. Therefore **none of G1–G9 would catch any blocker above**. All passed in the baseline while these reproductions remained live.

### Proposed G10 — scaffold provenance, syntax, and binding safety

`check()` must build inputs through the public schemas and assert all of the following:

1. Semicolon, newline, quote, backtick, template-like, whitespace, empty, keyword, and Unicode-adversarial names/signatures either safely use an exact supported binding/property form or produce `snippet: null` and `confidence: "import-only"`; no raw signature comment may create another executable line.
2. A verified signature is fully consumed, identifies the same export name, has structurally valid parameters/return syntax, and belongs only to a proven runtime-callable kind (`function`, `class`, or a separately proven callable default/const).
3. No JavaScript or Python snippet contains `self` or `cls` as a supplied call argument; malformed `Promise<` cannot introduce `await`.
4. The call binding is exactly supplied by its import form: named imports call their local binding, namespace imports call their namespace, aliases use their alias, and absent/unrepresentable binding degrades. Parse ESM output in ESM mode and CJS in CJS mode; CJS contains no top-level `await`; dual/unknown alternatives are not combined as one runnable program.
5. Every property/call target is an exact member of `surface.exports` (except a verified import binding itself), with no extra executable identifiers.

`proveFailure()` must run the real generator on (i) `foo; globalThis.pwn = 1; //` and (ii) named ESM `{ get }` input, and verify G10 flags the extra executable statement and the unbound synthesized namespace. It must also feed `run(): Promise<` and require detection of its false verified/await result.

### Proposed G11 — Python stub structural honesty

`check()` must assert that `parsePyStub` emits no module export for `def` text in an assignment, unterminated string, multiline docstring, nested function/class, or control suite. For nonliteral/dynamic `__all__`, it must not make the surface authoritative; any unresolved literal fallback must be a valid Python identifier with `signature: null` and an explicit unresolved note. Then pass the parsed docstring-decoy output to `buildScaffold` and require import-only/no snippet.

`proveFailure()` must inject a forged `{name:"ghost", signature:"ghost()"}` parser result for a docstring/assignment fixture and verify the checker reports it; it must also inject an unnoted `__all__` ghost and verify detection.

## Verdict

**Unsafe for an agent to rely on: verified scaffolds can contain injected code, fabricated bindings/signatures, and parser-invented Python exports.**
