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
