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
