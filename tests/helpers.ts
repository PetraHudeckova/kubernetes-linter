import { expect } from 'vitest';
import { lint } from '../src/lint/index.js';
import type { LocatedFinding } from '../src/lint/types.js';

/** A minimal valid Pod that individual tests mutate. */
export const VALID_POD = `apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  containers:
    - name: web
      image: nginx:1.27-alpine
`;

export function findings(yaml: string): LocatedFinding[] {
  return lint(yaml).findings;
}

export function ruleIds(yaml: string): string[] {
  return findings(yaml).map((finding) => finding.ruleId);
}

/** Assert that exactly the given rules fire, ignoring order. */
export function expectRules(yaml: string, expected: string[]): void {
  expect([...new Set(ruleIds(yaml))].sort()).toEqual([...new Set(expected)].sort());
}

export function expectRule(yaml: string, ruleId: string): LocatedFinding {
  const match = findings(yaml).find((finding) => finding.ruleId === ruleId);
  expect(
    match,
    `expected rule "${ruleId}" to fire, got: ${ruleIds(yaml).join(', ') || '(none)'}`,
  ).toBeDefined();
  return match!;
}

export function expectNoRule(yaml: string, ruleId: string): void {
  expect(ruleIds(yaml)).not.toContain(ruleId);
}

/** Build a Pod document from a spec fragment, keeping tests readable. */
export function pod(specFragment: string, metadataFragment = '  name: web\n'): string {
  return `apiVersion: v1\nkind: Pod\nmetadata:\n${metadataFragment}spec:\n${specFragment}`;
}

export function podWithContainer(containerFragment: string): string {
  return pod(`  containers:\n    - name: web\n      image: nginx:1.27\n${containerFragment}`);
}

/** A minimal valid Deployment that individual tests mutate. */
export const VALID_DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27-alpine
`;

/**
 * Build a Deployment from a fragment of DeploymentSpec, with a selector and
 * template that already agree so only the fragment under test misbehaves.
 * Fragments are indented two spaces, matching `pod()`.
 */
export function deployment(specFragment: string, templateSpecFragment = ''): string {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
${specFragment}  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
${templateSpecFragment}      containers:
        - name: web
          image: nginx:1.27
`;
}

/** A Deployment whose pod template carries the given PodSpec fragment. */
export function deploymentWithPodSpec(templateSpecFragment: string): string {
  return deployment('', templateSpecFragment);
}

/**
 * A minimal valid StatefulSet that individual tests mutate. It keeps a claim
 * template and a mount that references it, since that pairing is what makes a
 * StatefulSet's volumes different from every other kind's.
 */
export const VALID_STATEFULSET = `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  serviceName: db
  selector:
    matchLabels:
      app: db
  template:
    metadata:
      labels:
        app: db
    spec:
      containers:
        - name: db
          image: postgres:16-alpine
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
`;

/**
 * Build a StatefulSet from a fragment of StatefulSetSpec, with a selector and
 * template that already agree so only the fragment under test misbehaves.
 * `serviceName` is included because it was required until 1.33.
 * Fragments are indented two spaces, matching `pod()`.
 */
export function statefulSet(specFragment: string, templateSpecFragment = ''): string {
  return `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
${specFragment}  serviceName: db
  selector:
    matchLabels:
      app: db
  template:
    metadata:
      labels:
        app: db
    spec:
${templateSpecFragment}      containers:
        - name: db
          image: postgres:16-alpine
`;
}

/** A StatefulSet whose pod template carries the given PodSpec fragment. */
export function statefulSetWithPodSpec(templateSpecFragment: string): string {
  return statefulSet('', templateSpecFragment);
}

/** A minimal valid DaemonSet that individual tests mutate. */
export const VALID_DAEMONSET = `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
spec:
  selector:
    matchLabels:
      app: node-exporter
  template:
    metadata:
      labels:
        app: node-exporter
    spec:
      containers:
        - name: node-exporter
          image: prom/node-exporter:v1.8.2
`;

/**
 * Build a DaemonSet from a fragment of DaemonSetSpec, with a selector and
 * template that already agree so only the fragment under test misbehaves.
 * Fragments are indented two spaces, matching `pod()`.
 */
export function daemonSet(specFragment: string, templateSpecFragment = ''): string {
  return `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
spec:
${specFragment}  selector:
    matchLabels:
      app: node-exporter
  template:
    metadata:
      labels:
        app: node-exporter
    spec:
${templateSpecFragment}      containers:
        - name: node-exporter
          image: prom/node-exporter:v1.8.2
`;
}

/** A DaemonSet whose pod template carries the given PodSpec fragment. */
export function daemonSetWithPodSpec(templateSpecFragment: string): string {
  return daemonSet('', templateSpecFragment);
}

/**
 * A minimal valid Job that individual tests mutate. It spells out
 * `restartPolicy` because a Job is the one kind that cannot take the PodSpec
 * default: leaving it out is an error rather than shorthand for "Always".
 */
export const VALID_JOB = `apiVersion: batch/v1
kind: Job
metadata:
  name: import
spec:
  backoffLimit: 4
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: import
          image: importer:1.2.0
`;

/**
 * Build a Job from a fragment of JobSpec. There is no selector to keep
 * consistent — a Job's is generated by the apiserver — but the template needs
 * its restartPolicy, so that is what the second fragment sits beside.
 * Fragments are indented two spaces, matching `pod()`.
 */
export function job(specFragment: string, templateSpecFragment = ''): string {
  return `apiVersion: batch/v1
kind: Job
metadata:
  name: import
spec:
${specFragment}  template:
    spec:
${templateSpecFragment}      restartPolicy: Never
      containers:
        - name: import
          image: importer:1.2.0
`;
}

/** A Job whose pod template carries the given PodSpec fragment. */
export function jobWithPodSpec(templateSpecFragment: string): string {
  return job('', templateSpecFragment);
}

/**
 * A minimal valid CronJob that individual tests mutate. Its jobTemplate.spec
 * is a JobSpec one level deeper than a Job's own, so it spells out
 * `restartPolicy` for the same reason `VALID_JOB` does.
 */
export const VALID_CRONJOB = `apiVersion: batch/v1
kind: CronJob
metadata:
  name: import
spec:
  schedule: "0 0 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: import
              image: importer:1.2.0
`;

/**
 * Build a CronJob from a fragment of CronJobSpec, one of JobSpec (sitting
 * next to the jobTemplate's own `template`, at `spec.jobTemplate.spec`) and
 * one of PodSpec (at `spec.jobTemplate.spec.template.spec`, beside its
 * `restartPolicy`) — the three levels `checkJobSpec` and the shared pod
 * rules address once `cronjob.ts` hands them the deeper base path.
 * Fragments are indented two spaces, matching `pod()`.
 */
export function cronJob(
  specFragment: string,
  jobSpecFragment = '',
  templateSpecFragment = '',
): string {
  return `apiVersion: batch/v1
kind: CronJob
metadata:
  name: import
spec:
  schedule: "0 0 * * *"
${specFragment}  jobTemplate:
    spec:
${jobSpecFragment}      template:
        spec:
${templateSpecFragment}          restartPolicy: Never
          containers:
            - name: import
              image: importer:1.2.0
`;
}

/** A CronJob whose pod template carries the given PodSpec fragment. */
export function cronJobWithPodSpec(templateSpecFragment: string): string {
  return cronJob('', '', templateSpecFragment);
}

/** A minimal valid Service that individual tests mutate. */
export const VALID_SERVICE = `apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
    - name: http
      port: 80
      targetPort: http
      protocol: TCP
`;

/**
 * Build a Service from a fragment of ServiceSpec. Unlike the workload helpers
 * there is no template to keep consistent, so the fragment is the whole spec:
 * a Service is only valid in combinations, and most tests are about which
 * fields may sit next to which `type`. Fragments are indented two spaces,
 * matching `pod()`.
 */
export function service(specFragment: string, metadataFragment = '  name: web\n'): string {
  return `apiVersion: v1\nkind: Service\nmetadata:\n${metadataFragment}spec:\n${specFragment}`;
}

/** A minimal valid Ingress that individual tests mutate. */
export const VALID_INGRESS = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - web.example.com
      secretName: web-tls
  rules:
    - host: web.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
`;

/**
 * Build an Ingress from a fragment of IngressSpec. Like `service()` the
 * fragment is the whole spec: an Ingress has no pod template to keep
 * consistent, and most of what it is checked for is which fields may sit next
 * to which. Fragments are indented two spaces, matching `pod()`.
 */
export function ingress(specFragment: string, metadataFragment = '  name: web\n'): string {
  return `apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n${metadataFragment}spec:\n${specFragment}`;
}

/**
 * An Ingress carrying one rule with the given path entries, which is the shape
 * most path and backend tests need.
 */
export function ingressWithPaths(pathsFragment: string, host = 'web.example.com'): string {
  return ingress(`  rules:\n    - host: ${host}\n      http:\n        paths:\n${pathsFragment}`);
}

/** One `http.paths` entry pointing at a Service, for `ingressWithPaths`. */
export function ingressPath(path: string, pathType = 'Prefix'): string {
  return (
    `          - path: ${path}\n            pathType: ${pathType}\n` +
    '            backend:\n              service:\n                name: web\n' +
    '                port:\n                  number: 80\n'
  );
}

/** A minimal valid IngressClass that individual tests mutate. */
export const VALID_INGRESS_CLASS = `apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: nginx
  annotations:
    ingressclass.kubernetes.io/is-default-class: "true"
spec:
  controller: k8s.io/ingress-nginx
  parameters:
    apiGroup: k8s.example.com
    kind: IngressParameters
    name: external-lb
    scope: Namespace
    namespace: ingress-nginx
`;

/**
 * Build an IngressClass from a fragment of IngressClassSpec. Like `ingress()`
 * the fragment is the whole spec, and like a Service most of what is checked is
 * which fields may sit next to which. Fragments are indented two spaces,
 * matching `pod()`.
 */
export function ingressClass(specFragment: string, metadataFragment = '  name: nginx\n'): string {
  return `apiVersion: networking.k8s.io/v1\nkind: IngressClass\nmetadata:\n${metadataFragment}spec:\n${specFragment}`;
}

/** An IngressClass whose parameters reference carries the given fragment. */
export function ingressClassParameters(parametersFragment: string): string {
  return ingressClass(`  controller: k8s.io/ingress-nginx\n  parameters:\n${parametersFragment}`);
}

/** A minimal valid PersistentVolumeClaim that individual tests mutate. */
export const VALID_PERSISTENTVOLUMECLAIM = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
`;

/**
 * Build a PersistentVolumeClaim from a fragment of PersistentVolumeClaimSpec.
 * Like `service()` the fragment is the whole spec: a PersistentVolumeClaim has
 * no pod template to keep consistent. Fragments are indented two spaces,
 * matching `pod()`.
 */
export function persistentVolumeClaim(
  specFragment: string,
  metadataFragment = '  name: data\n',
): string {
  return `apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n${metadataFragment}spec:\n${specFragment}`;
}
