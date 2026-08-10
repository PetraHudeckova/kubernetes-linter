# kubernetes-linter

An online linter for Kubernetes **Pod**, **Deployment**, **StatefulSet**, **DaemonSet**,
**Job**, **CronJob**, **Service**, **Ingress**, **IngressClass** and **PersistentVolumeClaim**
manifests. Paste YAML, get told what is wrong, why it is wrong, and — where the answer is
unambiguous — apply the fix with one click.

The kind comes from the document itself, so a multi-document manifest holding all ten is
linted correctly in one pass.

Everything runs in the browser. The manifest never leaves the tab: there is no server, no
upload, and the "Share link" button puts the document in the URL fragment, which browsers do
not transmit.

Covers **Kubernetes v1.25 through v1.36**, selectable from the header. The schema for the
chosen version decides what counts as a valid field, so linting a manifest destined for an
older cluster reports what that cluster would actually reject.

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
| Names | Object, container, volume and port names against DNS-1123 / IANA rules; label and annotation keys |
| Enums | `restartPolicy`, `imagePullPolicy`, `dnsPolicy`, `protocol`, tolerations, topology spread, and ~30 more |
| Containers | missing image, names reused across `containers` / `initContainers` / `ephemeralContainers`, probes on a non-sidecar init container |
| Ports | ranges, name format, names reused across the Pod, host port collisions, `hostPort` vs `containerPort` under `hostNetwork` |
| Volumes | a mount naming a volume that is not declared, a volume with zero or several sources, duplicate mount paths, `subPath` escaping the volume |
| Resources | quantity syntax, `requests` above `limits`, non-standard resource names, and `memory: 512m` meaning 0.512 bytes |
| Probes | zero or several handlers, `successThreshold` on liveness, named ports that no container declares |
| Scheduling | selector operators and their values, preference weights, toleration and topology-spread consistency |
| Cross-field | `dnsPolicy: None` without a nameserver, `hostPID` with `shareProcessNamespace`, `runAsNonRoot` with UID 0, `privileged` with `allowPrivilegeEscalation: false`, Linux-only fields on a Windows Pod |
| Deployment | a selector that does not match the template's labels, an empty selector, `restartPolicy` other than `Always` in the template, `activeDeadlineSeconds` or ephemeral containers in a template, `rollingUpdate` under a `Recreate` strategy, `maxSurge` and `maxUnavailable` both zero, `progressDeadlineSeconds` below `minReadySeconds` |
| StatefulSet | the same selector and template checks, plus a `serviceName` that is not a DNS label, `rollingUpdate` under an `OnDelete` strategy, a negative `partition` or `ordinals.start`, `maxUnavailable` at zero or above 100%, and volume claim templates that are unnamed, misnamed, duplicated or shadowing a volume of the pod template |
| DaemonSet | the same selector and template checks, plus a rollout that sets `maxSurge` alongside a non-zero `maxUnavailable` (a DaemonSet does one or the other, never both), both of them at zero, a percentage above 100, a `rollingUpdate` block an `OnDelete` strategy will ignore, and a read-write GCE persistent disk, which cannot be attached to every node |
| Job | a `restartPolicy` the template leaves to default to `Always` (a Job accepts only `OnFailure` or `Never`), a hand-written `selector` without `manualSelector`, one that does not match the template's labels, negative counters, an `Indexed` Job without `completions` or whose name cannot become a Pod hostname once the index is appended, per-index fields on a `NonIndexed` one, `maxFailedIndexes` without `backoffLimitPerIndex` or above `completions`, a pod failure policy rule matching on both or neither of `onExitCodes` and `onPodConditions`, exit codes that are empty, unsorted, repeated or zero under `In`, a `containerName` no container answers to, `FailIndex` without per-index retries, `podReplacementPolicy` other than `Failed` beside a failure policy, a success policy on a `NonIndexed` Job or with rules that say nothing, a malformed `succeededIndexes`, and a `managedBy` that is not a domain-prefixed path |
| CronJob | a missing or empty `schedule`, one with the wrong number of fields, a field outside its range, or an unrecognised descriptor, a `TZ=`/`CRON_TZ=` prefix that belongs in `timeZone` instead, a `timeZone` that is malformed, `"Local"` or not in the IANA database, negative deadlines or history limits, a name over 52 characters (the controller appends `-<timestamp>` to make each run's Job name), and a `jobTemplate.spec.selector` or `manualSelector: true` — both always rejected, since every Job it creates is fresh. Everything a Job's own spec checks — counters, completion mode, failure and success policies, `managedBy`, the template's `restartPolicy` — is checked the same way one level deeper, under `jobTemplate.spec` |
| Service | a name that is not an RFC 1035 label, a missing or duplicated port, a `targetPort` that names nothing a container port could be called, a `nodePort` on a type that has none (and one outside the default 30000-32767 range), a headless `NodePort` or `LoadBalancer`, an `ExternalName` with a cluster IP or without a hostname, load balancer and traffic policy fields on a type that ignores them, malformed cluster, external and source-range addresses, and dual-stack families that contradict `ipFamilyPolicy` |
| Ingress | neither `rules` nor a `defaultBackend`, a rule host that is an IP address or a misplaced wildcard, a rule with no `http` block, a relative path or one containing `//`, `/./`, `/../` or an escaped slash, a host and path routed twice, a backend naming both a Service and a resource or neither, a Service port given as both a name and a number or as neither, a certificate host that no rule routes, and the `kubernetes.io/ingress.class` annotation that `spec.ingressClassName` replaced |
| IngressClass | a `metadata.namespace` on a cluster-scoped object, a missing `controller` or one that is not a domain-prefixed path, a `parameters` reference whose `scope` and `namespace` contradict each other, an empty `apiGroup`, `kind` or `name`, a `kind` or `name` that could not be a URL path segment, and an `ingressclass.kubernetes.io/is-default-class` annotation whose value is not the exact string the apiserver reads |
| PersistentVolumeClaim | a missing or empty `accessModes`, an unrecognised one, `ReadWriteOncePod` combined with another mode, a missing or non-positive `resources.requests.storage`, a `storageClassName` or `volumeAttributesClassName` that is not a DNS subdomain, a `dataSource`/`dataSourceRef` missing a `name` or `kind`, one naming a non-core kind with no `apiGroup`, a `dataSource` set alongside a cross-namespace `dataSourceRef`, and the two naming different objects. The same checks run against a StatefulSet's `volumeClaimTemplates` and a Pod's `ephemeral.volumeClaimTemplate`, which the apiserver validates with the very same function |

The PodSpec rows apply to every kind that carries a pod template: there is one PodSpec rule
set, addressed relative to whichever kind the document declares, so it reports against
`spec.template.spec` on a controller and `spec` on a Pod. A StatefulSet's `volumeClaimTemplates`
are folded into that: the controller adds one Pod volume per template, so mounting one is
recognised as valid even though `spec.template.spec.volumes` never mentions it. A Service, an
Ingress, an IngressClass and a PersistentVolumeClaim have no pod template at all, so those rules
do not run for them — each is checked by the schema, the name and label rules every object gets,
and its own row above.

Hovering any field shows its type, whether it is required, and its description straight from
the API specification.

Security posture and house-style opinions are deliberately **not** included: everything the
linter reports is something the apiserver would reject or something that is a genuine
misconfiguration.

## Fixes

A fix edits the parsed YAML syntax tree and re-serialises it, so **comments, key order,
quoting style, blank lines and indentation survive**. Every fix shows a diff before you
apply it, and once applied the rewritten lines are highlighted in the editor so you can see
exactly what moved.

Fixes are either *safe* — an unambiguous correction such as a misspelled key or an enum value
that differs only in case — or ones that guess at intent, such as raising a limit to match a
request. **Apply all safe fixes** runs only the first kind, re-linting after each edit so that
corrections cascade: fixing `contaienrs:` to `containers:` reveals everything underneath it,
which is then fixed in turn. Because of that cascade the problem count can go *up* after a
run — that is progress, not a regression, so the outcome is spelled out in words rather than
left to the counter.

## Development

```sh
npm install
npm run dev      # http://localhost:5173/kubernetes-linter/
npm test         # vitest
npm run build    # typecheck + production build into dist/
npm run preview  # serve the production build
```

### Kubernetes versions

Schemas are generated from upstream and committed, so builds are deterministic and offline
and the deployed site serves them from its own origin — nothing is fetched from GitHub or
kubernetes.io at runtime.

```sh
npm run gen:schema            # regenerate every supported version
npm run gen:schema -- 1.37    # add a single new one
```

`src/lint/schemas.ts` discovers the files with `import.meta.glob`, so a new
`src/schema/k8s-1.37.json` shows up in the picker with no other code change. Vite emits each
as its own chunk (42-54 KB brotli), fetched only when that version is selected; the default
version is bundled, so the first load makes no extra request. To move the default, change the
static import in that file.

Two things do not come from the OpenAPI document and may need attention when adding a
version: enum values, in `src/lint/rules/enums.ts`, and any rule whose advice names a field
that arrived in a particular release. Gate those with `ctx.supports(path)`, as
`src/lint/rules/containers.ts` does for sidecars — before 1.28 there is no
`Container.restartPolicy`, so offering that fix would produce a manifest the cluster rejects.

**Known limitation:** enum *values* added in a later release are accepted on older versions,
because the table has no per-value `since`. A whole field not existing yet — much the more
common case — is handled correctly by the schema layer.

### Layout

```
scripts/generate-schema.mjs   extracts the definition closure per kind, one file per version
src/lint/kinds.ts             kind descriptors: where each kind keeps its PodSpec
src/lint/schemas.ts           version registry and lazy chunk loading
src/lint/schema.ts            layer 1: generic schema conformance walker
src/lint/rules/               layer 2: one module per area, registered in registry.ts
src/lint/fix.ts               applies fixes to the YAML AST
src/lint/parse.ts             parsing and mapping paths to editor ranges
src/editor.ts, src/ui/        CodeMirror wiring, findings panel, diff preview
```

Adding a rule means writing a `Rule` in `src/lint/rules/` and listing it in `registry.ts`.
A new rule pack — security posture, for example — slots in the same way.

Rules address the PodSpec relatively, through `ctx.at(...)`, so one rule set serves every kind:
`ctx.at('dnsPolicy')` is `spec.dnsPolicy` on a Pod and `spec.template.spec.dnsPolicy` on a
Deployment. Adding a kind means a root in `scripts/generate-schema.mjs`, a descriptor in
`src/lint/kinds.ts` naming those two paths, and any rules unique to it. A kind that carries no
pod template leaves `podTemplate` out of its descriptor instead, and the PodSpec rules
(`POD_RULES` in `registry.ts`) are skipped for it; one that lives outside namespaces sets
`clusterScoped` there too, which is what makes `metadata.namespace` an error rather than a
name to validate. Each kind keeps its own rule module — `rules/deployment.ts`,
`rules/statefulset.ts`, `rules/daemonset.ts`, `rules/job.ts`, `rules/cronjob.ts`,
`rules/service.ts`, `rules/ingress.ts`, `rules/ingressclass.ts`, `rules/persistentvolumeclaim.ts`
— since what the apiserver checks beyond the pod template is particular to it. CronJob and
PersistentVolumeClaim are the exceptions by design: a CronJob's `spec.jobTemplate.spec` is a
full JobSpec that the apiserver validates with the very same function a Job's own spec goes
through, so `rules/job.ts` exports `checkJobSpec` for `rules/cronjob.ts` to call against the
nested spec; likewise a StatefulSet's `volumeClaimTemplates` and a Pod's
`ephemeral.volumeClaimTemplate` are both PersistentVolumeClaimSpecs, so
`rules/persistentvolumeclaim.ts` exports `checkClaimSpec` for `rules/statefulset.ts` and
`rules/volumes.ts` to call against those nested specs — rather than duplicating either set of
checks under a second set of rule ids.

## Deployment

Pushes to `main` build and publish to GitHub Pages via `.github/workflows/deploy.yml`.
Set **Settings → Pages → Source** to **GitHub Actions** once; the workflow cannot do that
itself.
