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
  /**
   * The PodSpec, wherever this kind keeps it. Empty for a kind that describes
   * no Pod, which is safe because the rules that read it — everything in
   * `POD_RULES` — do not run for such a kind at all.
   */
  spec: Record<string, unknown>;
  kind: KindDescriptor;
  /** Every container from all three lists, in declaration order. */
  containers: ContainerRef[];
  /**
   * Volumes the controller adds to every Pod it creates, over and above the
   * pod spec's own `volumes` — a StatefulSet's volumeClaimTemplates. Empty for
   * kinds that generate none, so a mount check can simply consider both.
   */
  generatedVolumes: string[];
  schema: KindSchema;
  /**
   * Absolute path to a field inside the PodSpec. Rules address the spec
   * relatively — `ctx.at('dnsPolicy')` is `spec.dnsPolicy` on a Pod and
   * `spec.template.spec.dnsPolicy` on a Deployment. Like `spec`, meaningful
   * only for a kind that has a pod template.
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
  // A kind with no pod template still gets a context: its own rules address the
  // document directly, exactly as the controller rules do. The pod-shaped
  // members below then describe nothing, which no rule that runs for it reads.
  const specPath = kind.podTemplate?.specPath ?? [];
  const spec = descend(doc, specPath);
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
        path: [...specPath, list, index],
        label: name ? `${singular(list)} "${name}"` : `${singular(list)} #${index + 1}`,
      });
    });
  }

  return {
    doc,
    spec,
    kind,
    containers,
    generatedVolumes: generatedVolumes(doc, kind),
    schema,
    at: (...segments) => [...specPath, ...segments],
    meta: (...segments) => [...(kind.podTemplate?.metadataPath ?? []), ...segments],
    field: (...segments) => [...specPath, ...segments].join('.'),
    supports: (path) => schema.describe(path) !== undefined,
    report: (finding) => findings.push(finding),
  };
}

/** Follow a path of mapping keys, stopping at the first thing that is not one. */
function descend(value: Record<string, unknown>, path: Path): Record<string, unknown> {
  const found = valueAt(value, path);
  return isPlainObject(found) ? found : {};
}

function valueAt(value: Record<string, unknown>, path: Path): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[String(segment)];
  }
  return current;
}

/** The names of the volumes this kind's controller generates, if any. */
function generatedVolumes(doc: Record<string, unknown>, kind: KindDescriptor): string[] {
  const claimTemplatesPath = kind.podTemplate?.claimTemplatesPath;
  if (!claimTemplatesPath) return [];
  const templates = valueAt(doc, claimTemplatesPath);
  if (!Array.isArray(templates)) return [];

  const names: string[] = [];
  for (const entry of templates) {
    if (!isPlainObject(entry)) continue;
    const metadata = entry['metadata'];
    const name = isPlainObject(metadata) ? asString(metadata['name']) : undefined;
    if (name !== undefined) names.push(name);
  }
  return names;
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
