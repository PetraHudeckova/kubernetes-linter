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

Adding a rule means writing a `Rule` in `src/lint/rules/` and appending it to `registry.ts` —
to `POD_RULES` if it reads `ctx.spec`, to `RULES` if it addresses the document and is therefore
correct for every kind — or, for a rule that only applies to one kind, to that kind's `rules`
in `src/lint/kinds.ts`. Nothing else is wired by hand.

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
from an `import.meta.glob` over `src/schema/k8s-*.json`, and `DEFAULT_VERSION` from the
`k8sVersion` field of the statically imported default bundle. The only bounds live in
`scripts/generate-schema.mjs` (`OLDEST_MINOR` / `NEWEST_MINOR`). Dropping in a new
`src/schema/k8s-1.37.json` makes it appear in the picker; moving the default means changing
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

Note that `ctx.supports()` takes an **absolute** path, so a pod-spec gate must be written
`ctx.supports(ctx.at(field))` — passing a bare `['spec', field]` would resolve against the
wrong node on a Deployment and silently close the gate on every version.

### Kinds (Pod, Deployment, StatefulSet, DaemonSet, Job, CronJob, Service, Ingress, IngressClass)

The kind comes from the **document**, not from a picker or a `lint()` argument: `lintSchema()`
reads `kind`, resolves it against the bundle's `roots` map, and returns the name; `index.ts`
looks that up in `KINDS` (`src/lint/kinds.ts`) to get a `KindDescriptor`. A kind the bundle has
no root for still yields `unsupportedKind` and a `lint/unsupported-kind` note. Because one
bundle carries every root, a multi-document manifest can mix kinds with no extra chunk load —
which is what keeps `lint()` synchronous.

A `KindDescriptor` is only `{ kind, podTemplate?, nameFormat?, clusterScoped?, rules }`. The
root `$ref` is
deliberately *not* in it: that lives in the generated bundle, so the generator stays the
single source of truth for definition names — and `apiVersion` is derived from that definition
name too, never declared. `nameFormat` defaults to `'subdomain'`, is `'label'` for a kind whose
name prefixes generated Pod names (StatefulSet) and `'rfc1035'` for a Service, whose name has
to start with a letter; `metadata.ts` reads it. `clusterScoped` is the other thing that module
reads: on a kind that lives outside namespaces (IngressClass) a `metadata.namespace` is not a
name to validate but a field the apiserver forbids, so it is reported as `meta/namespace-not-allowed`
and the format check is skipped.

`podTemplate` is `{ specPath, metadataPath, claimTemplatesPath? }`, and **it is optional**:
a Service, an Ingress and an IngressClass describe no Pod at all. Its absence is what makes `POD_RULES` skip the kind
(`index.ts`), so a kind with no pod template is checked by layer 1, by `RULES` — the
document-level rules, `metadata.ts` and `enums.ts` — and by its own module, and by nothing
else. `claimTemplatesPath` is the one concession to a kind that generates volumes: a
StatefulSet's controller adds one Pod volume per `volumeClaimTemplates` entry, named after it,
so those names reach `volumes.ts` through `ctx.generatedVolumes` and a mount referring to one
is not reported as undeclared.

**Rules address the PodSpec relatively.** `ctx.at(...)` prefixes `podTemplate.specPath`,
`ctx.meta(...)` prefixes `podTemplate.metadataPath`, and `ctx.field(...)` renders a dotted name
for a message. There are no `['spec', …]` literals left in the PodSpec rules; reintroducing one
silently breaks Deployment. The deliberate exceptions are `rules/deployment.ts`,
`rules/statefulset.ts`, `rules/daemonset.ts`, `rules/job.ts`, `rules/cronjob.ts`,
`rules/service.ts`, `rules/ingress.ts` and `rules/ingressclass.ts`, which address
`spec.selector`, `spec.strategy`, `spec.updateStrategy`, `spec.completionMode`, `spec.schedule`,
`spec.ports`, `spec.rules`, `spec.controller` and the like — fields of the object itself, not of
any pod spec.

`ctx.doc` is the document root (used by `metadata.ts`, `enums.ts` and every per-kind module);
`ctx.spec` is the PodSpec wherever this kind keeps it, and `{}` for a kind with no pod
template. `ContainerRef.path` already carries the prefix, so any rule built on `ctx.containers`
is kind-correct for free.

Rule IDs stay `pod/*` for PodSpec checks — they describe a PodSpec problem wherever it lives —
and `deployment/*` / `statefulset/*` / `daemonset/*` / `job/*` / `cronjob/*` / `service/*` /
`ingress/*` / `ingressclass/*` for checks on the object itself. The two document-level rules are named for what they check rather than for a kind,
since they run for every kind including one with no Pod: `meta/*` in `metadata.ts` and
`enum/*` in `enums.ts`. `Schema` is per version and holds every root; `Schema.for(kind)`
returns the `KindSchema` view that both lint layers actually use.

Each kind keeps its **own** rule module rather than sharing one: `deployment.ts`,
`statefulset.ts`, `daemonset.ts` and `job.ts` overlap on the selector and template checks, but
the four upstream validators are separate, diverge in wording and in what they forbid, and are
versioned independently — so they are kept independent here too, and a change to one is not a
change to the others. The rollout checks are where that pays off: a Deployment rejects
`maxSurge` and `maxUnavailable` both at zero, a DaemonSet rejects that *and* the two both
non-zero (it either drains a node or surges onto it, never both), a StatefulSet has no
`maxSurge` at all, and a Job has no rollout to speak of.

`job.ts` is where the shared template checks invert. The other three require
`restartPolicy: Always`; a Job forbids it, and since the PodSpec default *is* `Always` and is
applied before validation runs, **an absent `restartPolicy` is an error on a Job** — the one
place a missing field is reported rather than read as the default. Its selector inverts too:
the apiserver generates one from the Job's UID, so writing one at all is rejected unless
`manualSelector: true` says the Pods are being adopted rather than created. Everything else
turns on the effective `completionMode`, resolved the way `service.ts` resolves `spec.type`
(defaulting to `NonIndexed`, `undefined` for a value the API does not know), because only an
Indexed Job has indexes for `backoffLimitPerIndex`, `maxFailedIndexes` and `successPolicy` to
address. The version gates are dense here — the per-index fields and `podReplacementPolicy`
arrived in 1.28, `managedBy` and `successPolicy` in 1.30 — so every one of those reads
`ctx.supports(['spec', field])` first. Deliberately skipped are the size caps that only bound
how long `.status` can grow (20 policy rules, 255 exit codes, 100000 completions); the module
comment says so, and `maxFailedIndexes` against `completions` is kept because that pair is a
contradiction rather than a limit.

`cronjob.ts` is the one kind whose pod template sits under another kind's spec rather than
directly under its own: `spec.jobTemplate.spec` is a full JobSpec, and the apiserver validates
it with the *same* `validateJobSpec` a Job's own spec goes through — so `job.ts` exports
`checkJobSpec(ctx, spec, base)`, the JobSpec checks above with every `['spec', …]` literal
replaced by `[...base, …]`, and `cronjob.ts` calls it against `spec.jobTemplate.spec` instead of
duplicating those checks under `cronjob/*` ids. A finding from that nested spec keeps its `job/*`
id and fires at the deeper path, exactly as a `pod/*` finding does under any kind's PodSpec.
Two checks stay behind in `job.ts`, since upstream keeps them in `ValidateJob` rather than
`validateJobSpec` and both read the *object's* own name or selector rather than anything inside
the JobSpec: the generated-selector check (a CronJob's jobTemplate may not carry a selector at
all, which `cronjob.ts` reports itself, unconditionally) and the indexed-Pod-hostname check (a
CronJob's Job name is generated by the controller, not written in the manifest, so there is
nothing to check up front). What is left to `cronjob.ts` itself — `schedule`, `timeZone`,
`concurrencyPolicy`, the two history limits, and the 52-character name cap the controller's
`-<timestamp>` suffix imposes — has no home in a Job at all. The schedule and `@every <duration>`
formats are parsed in `src/k8s/cron.ts`, mirroring `robfig/cron`'s `ParseStandard`; the
`timeZone` check layers a browser stand-in for `time.LoadLocation` — `Intl.DateTimeFormat`,
which throws on a zone the runtime's tz database does not know — on top of the same structural
rules upstream applies first. Nothing here is version-gated: CronJobSpec, `timeZone` included,
has been unchanged since the 1.25 floor.

`service.ts` is the odd one out and shows what a kind without a pod template costs: almost
everything it checks turns on `spec.type`, which decides whether a `nodePort`, a
`loadBalancerClass` or an `externalName` is allowed to exist at all. The effective type is
resolved once — defaulting to `ClusterIP`, and `undefined` when the value is not one the API
knows, since the enum rule has already reported that — and the checks that turn on it sit out
the `undefined` case while the rest (port numbers, name formats, IP syntax) still run.
`k8s/net.ts` holds the IP and CIDR parsers that needs, matching Go's netip rather than
inet_aton: `010.1.1.1` is an error, not octal.

`ingress.ts` is the second such kind, and it turns instead on how much layer 1 already covers:
`pathType` and `backend` are required on a path, `paths` on an `http` block, `name` on a service
backend, so the module is left with what the schema cannot express — an empty list where a
missing one would have been caught, an empty string where a missing key would have been, and the
mutually exclusive pairs (`service` vs `resource`, port `name` vs `number`) the API models as two
optional fields. It reuses `isIPAddress` to refuse an address where a rule wants a name, and
`isWildcardDNS1123Subdomain` in `k8s/names.ts` for the one leading `*.` label a host may carry.
Nothing in it is version-gated: networking/v1 Ingress has been served unchanged since 1.19.

`ingressclass.ts` is the third, and the reverse case: `IngressClassSpec` has no required fields
at all, so layer 1 covers almost nothing and even `spec.controller` — which the apiserver does
require — is the module's to report. Everything else turns on `parameters.scope`, resolved the
way `service.ts` resolves `spec.type`: defaulting (to `Cluster`, as the API does) and left
`undefined` when the value is not one the enum table knows, since a scope that means nothing
says nothing about the `namespace` beside it. The last check is not a validation rule at all —
`ingressclass.kubernetes.io/is-default-class` is compared to the string `"true"` by the
admission plugin that reads it, so `"True"` is a class that is quietly not the default. Like
Ingress, none of it is version-gated.

**Adding a further kind**, in order:

1. A root in `ROOTS` (`scripts/generate-schema.mjs`), then `npm run gen:schema` to regenerate
   and commit *every* version bundle. Generation throws if the definition is missing from any
   supported release, so a kind younger than the `OLDEST_MINOR` floor cannot be added without
   moving that floor.
2. A descriptor in `KINDS` (`src/lint/kinds.ts`) — for anything carrying a PodTemplateSpec that
   is the shared `POD_TEMPLATE` constant, plus `nameFormat`/`claimTemplatesPath`/`clusterScoped`
   if the kind needs them. For a kind that describes no Pod, leave `podTemplate` out entirely;
   that is the whole switch.
3. A rule module `src/lint/rules/<kind>.ts` for the kind's own fields, with `<kind>/*`
   rule IDs, wired into that descriptor's `rules` — *not* into `RULES` or `POD_RULES` in
   `registry.ts`, which are the every-kind and every-pod-kind lists. Nothing is needed for the
   PodSpec of a kind that has one: the shared rules already run.
4. Enum entries in `rules/enums.ts` for the kind's own enum fields, keyed
   `<Definition>.<field>` — upstream's OpenAPI carries no enum values, so the table is hand-kept.
5. Tests and copy: helpers and a valid manifest in `tests/helpers.ts`, pinned across versions in
   `tests/versions.test.ts` (which also asserts `schema.kinds` exactly, so its list changes,
   as does `tests/schema.test.ts` — it pins that list and uses a kind the bundle does *not*
   carry to exercise `lint/unsupported-kind`), an example appended to `EXAMPLES`
   (`src/ui/examples.ts`), and the kind names in `index.html`, `README.md` and in the
   `lint/unsupported-kind` explanation in `src/lint/index.ts`.

The reusable machinery — the schema walk, `walkFields`,
`enums.ts`, `fix.ts`, `parse.ts`, `k8s/*` — is kind-agnostic; `walkFields` keys on the resolved
`$ref` owner (`Container.imagePullPolicy`), so it stays correct wherever a type is reused.

### Schema bundles

`scripts/generate-schema.mjs` unions the transitive `$ref` closure of every root in `ROOTS`
(201 defs at 1.36, ~360 KB on disk, ~55 KB brotli) and writes `{ k8sVersion, source, generatedAt,
roots, definitions }`. One file per version rather than one per kind: the Deployment closure is
a near-total superset of Pod's, the StatefulSet one adds little beyond `PersistentVolumeClaim`,
the DaemonSet one adds only its own spec and update strategy, and the Job one only its spec and
the two policies hanging off it, so per-kind files would be near-duplicates. CronJob costs almost
nothing on top of Job: its spec only wraps a JobTemplateSpec around the JobSpec the Job root
already reaches, so it adds just `CronJob`, `CronJobSpec`, `CronJobStatus` and `JobTemplateSpec`.
Service, Ingress and IngressClass are the roots that share nothing below `ObjectMeta`, and the
first two still add only about a dozen definitions each while IngressClass adds two. API
descriptions are kept on purpose — they are what the hover tooltip and most `explanation` fields
render.

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
- Rule IDs are `pod/<thing>` for PodSpec checks and `deployment/<thing>` / `statefulset/<thing>`
  / `daemonset/<thing>` / `job/<thing>` / `cronjob/<thing>` / `service/<thing>` /
  `ingress/<thing>` / `ingressclass/<thing>` for checks on the object itself; the rules that run
  for every kind are `meta/<thing>` and `enum/<thing>`; schema-layer IDs are `schema/<thing>`;
  parser IDs are `yaml/<thing>`.
- Findings explain *why*, usually by quoting the field's own API description and pulling its
  "More info:" URL via `docsUrlFrom()`.
- Comments in this codebase explain non-obvious decisions rather than restating code. Match
  that when editing.
- `EXAMPLES` in `src/ui/examples.ts` is load-bearing: `tests/locations.test.ts` iterates it
  (the `valid` example must lint clean, others must not, and safe fixes must not make things
  worse) and indexes entries positionally, so append rather than insert. `tests/versions.test.ts`
  lints `valid`, `VALID_DEPLOYMENT` and `VALID_STATEFULSET` on all 12 versions as a regeneration
  tripwire.
