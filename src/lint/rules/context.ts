import type { Finding, Path, Severity } from '../types.js';
import type { KindSchema } from '../schema.js';
import type { KindDescriptor } from '../kinds.js';
import { isPlainObject } from '../schema.js';

export type ContainerList = 'containers' | 'initContainers' | 'ephemeralContainers';

export interface ContainerRef {
  list: ContainerList;
  index: number;
  container: Record<string, unknown>;
  path: Path;
  /** Human-friendly identifier for messages: the name, or a positional label. */
  label: string;
}

export interface RuleContext {
  /** The whole document — a Pod, a Deployment, whatever `kind` declared. */
  doc: Record<string, unknown>;
  /** The PodSpec, wherever this kind keeps it. */
  spec: Record<string, unknown>;
  kind: KindDescriptor;
  /** Every container from all three lists, in declaration order. */
  containers: ContainerRef[];
  schema: KindSchema;
  /**
   * Absolute path to a field inside the PodSpec. Rules address the spec
   * relatively — `ctx.at('dnsPolicy')` is `spec.dnsPolicy` on a Pod and
   * `spec.template.spec.dnsPolicy` on a Deployment.
   */
  at(...segments: (string | number)[]): Path;
  /** Absolute path to a field inside the pod's own metadata. */
  meta(...segments: (string | number)[]): Path;
  /** Render a pod-spec-relative field name for a message. */
  field(...segments: string[]): string;
  /**
   * Does the selected Kubernetes version know this field? Rules use it before
   * naming a field in a message or writing one in a fix, since the linter
   * spans releases in which fields came and went.
   */
  supports(path: Path): boolean;
  report(finding: Finding): void;
}

export interface Rule {
  id: string;
  run(ctx: RuleContext): void;
}

export function createContext(
  doc: Record<string, unknown>,
  kind: KindDescriptor,
  schema: KindSchema,
  findings: Finding[],
): RuleContext {
  const spec = descend(doc, kind.specPath);
  const containers: ContainerRef[] = [];

  const lists: ContainerList[] = ['containers', 'initContainers', 'ephemeralContainers'];
  for (const list of lists) {
    const value = spec[list];
    if (!Array.isArray(value)) continue;
    value.forEach((entry, index) => {
      if (!isPlainObject(entry)) return;
      const name = asString(entry['name']);
      containers.push({
        list,
        index,
        container: entry,
        path: [...kind.specPath, list, index],
        label: name ? `${singular(list)} "${name}"` : `${singular(list)} #${index + 1}`,
      });
    });
  }

  return {
    doc,
    spec,
    kind,
    containers,
    schema,
    at: (...segments) => [...kind.specPath, ...segments],
    meta: (...segments) => [...kind.podMetadataPath, ...segments],
    field: (...segments) => [...kind.specPath, ...segments].join('.'),
    supports: (path) => schema.describe(path) !== undefined,
    report: (finding) => findings.push(finding),
  };
}

/** Follow a path of mapping keys, stopping at the first thing that is not one. */
function descend(value: Record<string, unknown>, path: Path): Record<string, unknown> {
  let current: unknown = value;
  for (const segment of path) {
    if (!isPlainObject(current)) return {};
    current = current[String(segment)];
  }
  return isPlainObject(current) ? current : {};
}

function singular(list: ContainerList): string {
  switch (list) {
    case 'containers':
      return 'container';
    case 'initContainers':
      return 'init container';
    case 'ephemeralContainers':
      return 'ephemeral container';
  }
}

/* Narrowing helpers: everything coming out of YAML is `unknown`, and the
 * schema layer already reports type mismatches, so rules quietly skip values
 * of the wrong shape instead of double-reporting them. */

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Build a finding with the common fields filled in. */
export function finding(
  ruleId: string,
  severity: Severity,
  path: Path,
  message: string,
  extra: Partial<Finding> = {},
): Finding {
  return { ruleId, severity, path, message, ...extra };
}
