import type { Finding, Path, Severity } from '../types.js';
import type { Schema } from '../schema.js';
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
  pod: Record<string, unknown>;
  spec: Record<string, unknown>;
  /** Every container from all three lists, in declaration order. */
  containers: ContainerRef[];
  schema: Schema;
  report(finding: Finding): void;
}

export interface Rule {
  id: string;
  run(ctx: RuleContext): void;
}

export function createContext(
  pod: Record<string, unknown>,
  schema: Schema,
  findings: Finding[],
): RuleContext {
  const spec = isPlainObject(pod['spec']) ? pod['spec'] : {};
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
        path: ['spec', list, index],
        label: name ? `${singular(list)} "${name}"` : `${singular(list)} #${index + 1}`,
      });
    });
  }

  return {
    pod,
    spec,
    containers,
    schema,
    report: (finding) => findings.push(finding),
  };
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
