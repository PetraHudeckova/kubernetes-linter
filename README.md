# kubernetes-linter

An online linter for Kubernetes **Pod** manifests. Paste YAML, get told what is wrong, why it
is wrong, and — where the answer is unambiguous — apply the fix with one click.

Everything runs in the browser. The manifest never leaves the tab: there is no server, no
upload, and the "Share link" button puts the document in the URL fragment, which browsers do
not transmit.

Pinned to **Kubernetes v1.36**.

## What it checks

**Schema conformance**, generated from the Kubernetes OpenAPI specification, so it is
exhaustive by construction:

- unknown and misspelled fields, with a "did you mean" suggestion
- missing required fields
- wrong types, including the YAML traps — `value: no` becomes a boolean, `memory: 128`
  becomes a number where a string is required
- duplicate entries in lists the API treats as maps (two containers named the same, two
  volumes named the same), derived from `x-kubernetes-list-map-keys`
- duplicate YAML keys, which the apiserver's strict decoder rejects

**API validation rules**, transcribed from the checks the apiserver performs on top of the
schema, which OpenAPI cannot express:

| Area | Examples |
| --- | --- |
| Names | Pod, container, volume and port names against DNS-1123 / IANA rules; label and annotation keys |
| Enums | `restartPolicy`, `imagePullPolicy`, `dnsPolicy`, `protocol`, tolerations, topology spread, and ~30 more |
| Containers | missing image, names reused across `containers` / `initContainers` / `ephemeralContainers`, probes on a non-sidecar init container |
| Ports | ranges, name format, names reused across the Pod, host port collisions, `hostPort` vs `containerPort` under `hostNetwork` |
| Volumes | a mount naming a volume that is not declared, a volume with zero or several sources, duplicate mount paths, `subPath` escaping the volume |
| Resources | quantity syntax, `requests` above `limits`, non-standard resource names, and `memory: 512m` meaning 0.512 bytes |
| Probes | zero or several handlers, `successThreshold` on liveness, named ports that no container declares |
| Scheduling | selector operators and their values, preference weights, toleration and topology-spread consistency |
| Cross-field | `dnsPolicy: None` without a nameserver, `hostPID` with `shareProcessNamespace`, `runAsNonRoot` with UID 0, `privileged` with `allowPrivilegeEscalation: false`, Linux-only fields on a Windows Pod |

Hovering any field shows its type, whether it is required, and its description straight from
the API specification.

Security posture and house-style opinions are deliberately **not** included: everything the
linter reports is something the apiserver would reject or something that is a genuine
misconfiguration.

## Fixes

A fix edits the parsed YAML syntax tree and re-serialises it, so **comments, key order,
quoting style, blank lines and indentation survive**. Every fix shows a diff before you
apply it.

Fixes are either *safe* — an unambiguous correction such as a misspelled key or an enum value
that differs only in case — or ones that guess at intent, such as raising a limit to match a
request. **Apply all safe fixes** runs only the first kind, re-linting after each edit so that
corrections cascade: fixing `contaienrs:` to `containers:` reveals everything underneath it,
which is then fixed in turn.

## Development

```sh
npm install
npm run dev      # http://localhost:5173/kubernetes-linter/
npm test         # vitest
npm run build    # typecheck + production build into dist/
npm run preview  # serve the production build
```

### Updating the Kubernetes version

The schema is generated from upstream and committed, so builds are deterministic and offline:

```sh
npm run gen:schema -- 1.37
```

That writes `src/schema/pod-v1.37.json`. Point the import in `src/lint/index.ts` at the new
file. Enum values are not present in the OpenAPI document and live in
`src/lint/rules/enums.ts`; check them against the release notes when moving versions.

### Layout

```
scripts/generate-schema.mjs   extracts the Pod definition closure from the k8s OpenAPI spec
src/lint/schema.ts            layer 1: generic schema conformance walker
src/lint/rules/               layer 2: one module per area, registered in registry.ts
src/lint/fix.ts               applies fixes to the YAML AST
src/lint/parse.ts             parsing and mapping paths to editor ranges
src/editor.ts, src/ui/        CodeMirror wiring, findings panel, diff preview
```

Adding a rule means writing a `Rule` in `src/lint/rules/` and listing it in `registry.ts`.
A new rule pack — security posture, for example — slots in the same way.

## Deployment

Pushes to `main` build and publish to GitHub Pages via `.github/workflows/deploy.yml`.
Set **Settings → Pages → Source** to **GitHub Actions** once; the workflow cannot do that
itself.
