# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run dev                        # vite dev server at /kubernetes-linter/
npm test                           # vitest run (CI gate — build does not run without it)
npm run test:watch
npm run build                      # tsc --noEmit && vite build
npm run gen:schema                 # regenerate every version bundle from upstream
npm run gen:schema -- 1.37         # regenerate one

npx vitest run tests/rules.test.ts          # one file
npx vitest run -t "rejects a bad quantity"  # one test by name
```

`npm run gen:schema` fetches ~4 MB of `swagger.json` per version from
raw.githubusercontent.com, so it needs network access. Its output is committed; nothing is
fetched at runtime.

## Architecture

A browser-only linter — no server, no backend, no CLI. `index.html` → `src/main.ts` →
CodeMirror editor + findings panel. The manifest never leaves the tab (the Share button puts
it in the URL fragment).

### Two lint layers

`lint(text, schema)` in `src/lint/index.ts` is the entire public API. Per YAML document:

1. **Layer 1 — schema conformance** (`src/lint/schema.ts`). `lintSchema()` walks the parsed
   value alongside the generated OpenAPI closure: unknown fields, missing required fields,
   type mismatches, `x-kubernetes-list-map-keys` duplicates. Generic and exhaustive by
   construction — do not hand-write checks that this layer already derives.
2. **Layer 2 — API validation rules** (`src/lint/rules/`). One module per area, listed in
   `registry.ts`, each a `Rule { id, run(ctx) }`. These are the checks the apiserver performs
   that OpenAPI cannot express (cross-field consistency, name formats, enum values).

Adding a rule means writing a `Rule` in `src/lint/rules/` and appending it to `RULES` in
`registry.ts`. Nothing else is wired by hand.

Scope discipline: the project deliberately reports **only** what the apiserver would reject or
what is a genuine misconfiguration. No security posture, no house style.

### `Path` is the currency

Every finding carries a `Path` (`['spec','containers',0,'image']`). The same array is used to

- resolve a source range for the editor marker (`locate()` in `parse.ts`, which falls back to
  the nearest resolvable ancestor and clamps markers to one line), and
- address the node a `FixOp` edits (`fix.ts`).

Tests assert exact `path` arrays, so changing a path is a visible, intentional change.

### Fixes

`fix.ts` applies ops to the **YAML AST** and re-serialises, so comments, key order, quoting and
blank lines survive; `detectFormat()` re-derives indentation from the input. Fixes are `safe`
(unambiguous — a misspelled key, an enum value differing only in case) or not; "apply all"
runs only safe ones, re-linting after each because fixing `contaienrs:` reveals everything
underneath it. Note `ensureParents()`: intermediate levels must be built with
`doc.createNode({})`, since `setIn`'s own `Map` objects serialise as `!!omap` under YAML 1.1.

YAML is parsed as **1.1**, not 1.2, deliberately — the apiserver decodes via `sigs.k8s.io/yaml`,
so bare `no`/`on`/`off` must resolve to booleans here too and get reported as type mismatches.

### Kubernetes versions (1.25–1.36)

There is no version table in TypeScript. `src/lint/schemas.ts` derives `AVAILABLE_VERSIONS`
from an `import.meta.glob` over `src/schema/pod-*.json`, and `DEFAULT_VERSION` from the
`k8sVersion` field of the statically imported default bundle. The only bounds live in
`scripts/generate-schema.mjs` (`OLDEST_MINOR` / `NEWEST_MINOR`). Dropping in a new
`src/schema/pod-1.37.json` makes it appear in the picker; moving the default means changing
the static import.

The glob must stay lazy — Vite rewrites its chunk URLs for the configured `base`, which a
hand-built `fetch('/schema/…')` would not survive under the `/kubernetes-linter/` sub-path.

**Feature gating is schema-driven.** `ctx.supports(path)` is just
`schema.describe(path) !== undefined`, so a field absent from a version's closure is
automatically unsupported. When a rule's *advice* names a field that arrived in a particular
release, gate it: report the problem on every version but withhold the fix, naming the version
in the explanation (see the sidecar case in `rules/containers.ts`, `Container.restartPolicy`,
1.28+). `tests/versions.test.ts` is where per-version behaviour is pinned.

Two things do not come from OpenAPI and need manual attention when adding a version: the enum
table in `rules/enums.ts`, and any version-gated rule advice. Known limitation: enum *values*
added in a later release are accepted on older ones, because the table has no per-value
`since`.

### Pod is hardcoded, not pluggable

There is no kind abstraction. `Pod` is the single root of the program:
`ROOT_DEF = 'io.k8s.api.core.v1.Pod'` in the generator, `pod-*` in the schema glob and
filenames, `RuleContext { pod, spec, containers }` in `rules/context.ts`, and ~38 literal
`['spec', …]` path prefixes across the rule modules. `lintSchema()` bails out with
`unsupportedKind` for anything else, which `index.ts` turns into a `lint/unsupported-kind`
note. The expected kind and apiVersion *are* already read generically from
`x-kubernetes-group-version-kind`, but the surrounding prose is Pod-specific.

Supporting a second kind (e.g. Deployment, whose PodSpec sits at `spec.template.spec`) means
introducing that abstraction — most naturally a kind descriptor carrying the root ref, the
schema-file prefix, and the path prefix to the pod spec, with the literals in the rules
replaced by that prefix. The reusable machinery — the schema walk, `walkFields`, `enums.ts`,
`fix.ts`, `parse.ts`, `k8s/*` — is already kind-agnostic; `walkFields` keys on the resolved
`$ref` owner (`Container.imagePullPolicy`), so it stays correct wherever a type is reused.

### Schema bundles

`scripts/generate-schema.mjs` computes the transitive `$ref` closure from the root definition
(134 defs at 1.36, ~240 KB on disk, ~33 KB brotli) and writes `{ k8sVersion, source, generatedAt, root,
definitions }`. API descriptions are kept on purpose — they are what the hover tooltip and
most `explanation` fields render.

Definitions that are objects in the spec but scalars on the wire (`Quantity`, `IntOrString`,
`Time`) are listed in `SCALAR_DEFINITIONS` in `schema.ts` and validated specially; validating
them property-by-property would produce nonsense.

## Conventions

- TypeScript is strict, including `noUncheckedIndexedAccess`, `noUnusedLocals` and
  `verbatimModuleSyntax`. Relative imports carry a `.js` extension. `scripts/` is outside
  `tsconfig.json` and is not typechecked.
- Rules never re-report what layer 1 already caught. Everything out of YAML is `unknown`;
  narrow with `asString`/`asNumber`/`asObject`/`asArray` from `rules/context.ts` and skip
  wrong-shaped values silently.
- Rule IDs are `pod/<thing>`; schema-layer IDs are `schema/<thing>`; parser IDs are `yaml/<thing>`.
- Findings explain *why*, usually by quoting the field's own API description and pulling its
  "More info:" URL via `docsUrlFrom()`.
- Comments in this codebase explain non-obvious decisions rather than restating code. Match
  that when editing.
- `EXAMPLES` in `src/ui/examples.ts` is load-bearing: `tests/locations.test.ts` iterates it
  (the `valid` example must lint clean, others must not, and safe fixes must not make things
  worse) and `tests/versions.test.ts` lints `valid` on all 12 versions as a regeneration
  tripwire.
