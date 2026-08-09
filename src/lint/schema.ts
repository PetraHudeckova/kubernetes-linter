import type { Finding, Path } from './types.js';
import { didYouMean } from './suggest.js';
import { parseQuantity } from '../k8s/quantity.js';

/** The subset of OpenAPI v2 that the Kubernetes spec actually uses. */
export interface SchemaNode {
  description?: string;
  type?: string;
  format?: string;
  $ref?: string;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: SchemaNode;
  'x-kubernetes-list-type'?: string;
  'x-kubernetes-list-map-keys'?: string[];
  'x-kubernetes-group-version-kind'?: { group: string; version: string; kind: string }[];
}

export interface SchemaBundle {
  k8sVersion: string;
  source: string;
  generatedAt: string;
  root: string;
  definitions: Record<string, SchemaNode>;
}

/**
 * Definitions that are structurally objects in the spec but behave as scalars
 * on the wire. Validating them property-by-property would produce nonsense.
 */
const SCALAR_DEFINITIONS = new Set([
  'io.k8s.apimachinery.pkg.api.resource.Quantity',
  'io.k8s.apimachinery.pkg.util.intstr.IntOrString',
  'io.k8s.apimachinery.pkg.apis.meta.v1.Time',
  'io.k8s.apimachinery.pkg.apis.meta.v1.MicroTime',
]);

/** Free-form objects whose contents the API does not describe. */
const OPAQUE_DEFINITIONS = new Set(['io.k8s.apimachinery.pkg.apis.meta.v1.FieldsV1']);

export class Schema {
  constructor(private readonly bundle: SchemaBundle) {}

  get version(): string {
    return this.bundle.k8sVersion;
  }

  get rootRef(): string {
    return this.bundle.root;
  }

  definition(name: string): SchemaNode | undefined {
    return this.bundle.definitions[name];
  }

  /** Follow a $ref chain to the underlying definition. */
  resolve(node: SchemaNode | undefined): { node: SchemaNode | undefined; ref?: string } {
    if (!node) return { node: undefined };
    if (!node.$ref) return { node };
    const name = refName(node.$ref);
    const target = this.bundle.definitions[name];
    return { node: target, ref: name };
  }

  /** Describe a field for tooltips: type, requiredness and API description. */
  describe(path: Path): { title: string; type: string; required: boolean; description?: string } | undefined {
    let current: SchemaNode | undefined = { $ref: `#/definitions/${this.bundle.root}` };
    let required = false;
    let title = 'Pod';

    for (const segment of path) {
      const { node } = this.resolve(current);
      if (!node) return undefined;
      if (typeof segment === 'number') {
        current = node.items;
        title = `${title}[]`;
        continue;
      }
      const property = node.properties?.[segment];
      if (property) {
        required = node.required?.includes(segment) ?? false;
        current = property;
        title = segment;
      } else if (node.additionalProperties) {
        required = false;
        current = node.additionalProperties;
        title = segment;
      } else {
        return undefined;
      }
    }

    const { node, ref } = this.resolve(current);
    const description = current?.description ?? node?.description;
    return { title, type: typeName(current, ref, node), required, description };
  }
}

function refName(ref: string): string {
  return ref.split('/').pop() ?? ref;
}

function typeName(property: SchemaNode | undefined, ref: string | undefined, resolved: SchemaNode | undefined): string {
  if (ref) {
    const short = ref.split('.').pop() ?? ref;
    return property?.type === 'array' ? `${short}[]` : short;
  }
  if (property?.type === 'array') {
    const itemRef = property.items?.$ref ? refName(property.items.$ref).split('.').pop() : property.items?.type;
    return `${itemRef ?? 'unknown'}[]`;
  }
  if (property?.type === 'object' && property.additionalProperties) {
    const valueRef = property.additionalProperties.$ref
      ? refName(property.additionalProperties.$ref).split('.').pop()
      : property.additionalProperties.type;
    return `map[string]${valueRef ?? 'unknown'}`;
  }
  return property?.type ?? resolved?.type ?? 'object';
}

/** Pull the "More info: <url>" that many Kubernetes descriptions end with. */
export function docsUrlFrom(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const match = /More info:\s*(https?:\/\/\S+)/.exec(description);
  return match?.[1]?.replace(/[.,)]+$/, '');
}

export interface SchemaLintResult {
  findings: Finding[];
  /** Set when the document is not a Pod, so the caller can skip Pod rules. */
  unsupportedKind?: string;
}

/** Layer 1: validate a document against the generated Kubernetes schema. */
export function lintSchema(value: unknown, schema: Schema): SchemaLintResult {
  const findings: Finding[] = [];

  if (!isPlainObject(value)) {
    findings.push({
      ruleId: 'schema/root-type',
      severity: 'error',
      path: [],
      message: 'A Kubernetes manifest must be a mapping with apiVersion, kind, metadata and spec.',
    });
    return { findings };
  }

  const gvk = schema.definition(schema.rootRef)?.['x-kubernetes-group-version-kind']?.[0];
  const expectedApiVersion = gvk && gvk.group ? `${gvk.group}/${gvk.version}` : (gvk?.version ?? 'v1');
  const expectedKind = gvk?.kind ?? 'Pod';

  const kind = value['kind'];
  const apiVersion = value['apiVersion'];

  if (kind == null) {
    findings.push({
      ruleId: 'schema/missing-kind',
      severity: 'error',
      path: [],
      message: 'Required field "kind" is missing.',
      explanation: 'Every Kubernetes object declares its type through "kind". For a Pod this is "Pod".',
      fix: { title: 'Add kind: Pod', safe: false, ops: [{ op: 'set', path: ['kind'], value: expectedKind }] },
    });
  } else if (kind !== expectedKind) {
    return { findings, unsupportedKind: String(kind) };
  }

  if (apiVersion == null) {
    findings.push({
      ruleId: 'schema/missing-api-version',
      severity: 'error',
      path: [],
      message: 'Required field "apiVersion" is missing.',
      explanation: `A Pod belongs to the core API group, so its apiVersion is "${expectedApiVersion}".`,
      fix: {
        title: `Add apiVersion: ${expectedApiVersion}`,
        safe: true,
        ops: [{ op: 'set', path: ['apiVersion'], value: expectedApiVersion }],
      },
    });
  } else if (apiVersion !== expectedApiVersion) {
    findings.push({
      ruleId: 'schema/wrong-api-version',
      severity: 'error',
      path: ['apiVersion'],
      message: `Pod is served by apiVersion "${expectedApiVersion}", not "${String(apiVersion)}".`,
      explanation: 'Pod has always been part of the core API group, which uses a bare version with no group prefix.',
      fix: {
        title: `Change to ${expectedApiVersion}`,
        safe: true,
        ops: [{ op: 'set', path: ['apiVersion'], value: expectedApiVersion }],
      },
    });
  }

  walk(value, { $ref: `#/definitions/${schema.rootRef}` }, [], schema, findings);
  return { findings };
}

function walk(
  value: unknown,
  property: SchemaNode,
  path: Path,
  schema: Schema,
  findings: Finding[],
): void {
  const { node, ref } = schema.resolve(property);
  if (!node) return;
  if (ref && OPAQUE_DEFINITIONS.has(ref)) return;

  if (ref && SCALAR_DEFINITIONS.has(ref)) {
    checkScalarDefinition(value, ref, path, findings);
    return;
  }

  const effectiveType = property.type ?? node.type ?? (node.properties ? 'object' : undefined);

  if (effectiveType === 'array') {
    const items = property.items ?? node.items;
    if (!Array.isArray(value)) {
      findings.push(typeMismatch(path, 'array', value, property.description));
      return;
    }
    checkListUniqueness(value, property, path, findings);
    if (items) {
      value.forEach((item, index) => {
        if (item == null) return;
        walk(item, items, [...path, index], schema, findings);
      });
    }
    return;
  }

  if (effectiveType === 'object' || node.properties || node.additionalProperties) {
    if (!isPlainObject(value)) {
      findings.push(typeMismatch(path, 'object', value, property.description));
      return;
    }

    for (const name of node.required ?? []) {
      if (value[name] == null) {
        const child = node.properties?.[name];
        findings.push({
          ruleId: 'schema/required-field',
          severity: 'error',
          path,
          // Point at the key that owns the missing field rather than at its
          // whole value block.
          anchor: 'key',
          message: `Required field "${name}" is missing${
            name in value ? ' (it is present but empty)' : ''
          }.`,
          explanation: child?.description,
          docsUrl: docsUrlFrom(child?.description),
        });
      }
    }

    const known = node.properties;
    for (const [key, child] of Object.entries(value)) {
      if (known) {
        const childSchema = known[key];
        if (!childSchema) {
          if (node.additionalProperties) {
            walk(child, node.additionalProperties, [...path, key], schema, findings);
            continue;
          }
          findings.push(unknownField(key, path, Object.keys(known)));
          continue;
        }
        if (child == null) continue;
        walk(child, childSchema, [...path, key], schema, findings);
      } else if (node.additionalProperties) {
        if (child == null) continue;
        walk(child, node.additionalProperties, [...path, key], schema, findings);
      }
    }
    return;
  }

  checkPrimitive(value, effectiveType, property, path, findings);
}

function checkPrimitive(
  value: unknown,
  expected: string | undefined,
  property: SchemaNode,
  path: Path,
  findings: Finding[],
): void {
  if (!expected) return;
  switch (expected) {
    case 'string':
      if (typeof value !== 'string') {
        findings.push(typeMismatch(path, 'string', value, property.description));
      }
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        findings.push(typeMismatch(path, 'integer', value, property.description));
      }
      break;
    case 'number':
      if (typeof value !== 'number') {
        findings.push(typeMismatch(path, 'number', value, property.description));
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        findings.push(typeMismatch(path, 'boolean', value, property.description));
      }
      break;
    default:
      break;
  }
}

function checkScalarDefinition(value: unknown, ref: string, path: Path, findings: Finding[]): void {
  if (ref === 'io.k8s.apimachinery.pkg.util.intstr.IntOrString') {
    if (typeof value === 'string') return;
    if (typeof value === 'number' && Number.isInteger(value)) return;
    findings.push({
      ruleId: 'schema/type',
      severity: 'error',
      path,
      message: `Expected an integer or a string, but found ${describeValue(value)}.`,
      explanation: 'This field accepts either a number or a named reference.',
      fix: coerceFix(value, 'string'),
    });
    return;
  }

  if (ref === 'io.k8s.apimachinery.pkg.api.resource.Quantity') {
    const quantity = parseQuantity(value);
    if (quantity.ok) {
      if (typeof value === 'number') {
        findings.push({
          ruleId: 'schema/quantity-unquoted',
          severity: 'warning',
          path,
          message: `Quantity ${String(value)} should be quoted.`,
          explanation:
            'Quantities are strings in the API. An unquoted number still works, but YAML may reformat it (for example 1e3), so quoting keeps the intent explicit.',
          fix: {
            title: `Quote as "${String(value)}"`,
            safe: true,
            ops: [{ op: 'set', path, value: String(value) }],
          },
        });
      }
      return;
    }
    findings.push({
      ruleId: 'schema/quantity',
      severity: 'error',
      path,
      message: `Quantity ${describeValue(value)} ${quantity.reason}.`,
      explanation:
        'Valid quantities are a number with an optional suffix: n, u, m, k, M, G, T, P, E (decimal) or Ki, Mi, Gi, Ti, Pi, Ei (binary). Suffixes are case-sensitive and there is no "B" for bytes.',
      fix: quantity.suggestion
        ? {
            title: `Change to "${quantity.suggestion}"`,
            safe: true,
            ops: [{ op: 'set', path, value: quantity.suggestion }],
          }
        : undefined,
    });
    return;
  }

  // Time / MicroTime
  if (typeof value !== 'string') {
    findings.push(typeMismatch(path, 'string', value, undefined));
    return;
  }
  if (Number.isNaN(Date.parse(value))) {
    findings.push({
      ruleId: 'schema/timestamp',
      severity: 'error',
      path,
      message: `"${value}" is not a valid RFC 3339 timestamp.`,
      explanation: 'Kubernetes timestamps look like 2024-01-31T12:00:00Z.',
    });
  }
}

function checkListUniqueness(
  items: unknown[],
  property: SchemaNode,
  path: Path,
  findings: Finding[],
): void {
  const listType = property['x-kubernetes-list-type'];
  if (listType !== 'map' && listType !== 'set') return;

  const keys = property['x-kubernetes-list-map-keys'] ?? [];
  const seen = new Map<string, number>();

  items.forEach((item, index) => {
    let identity: string | undefined;
    if (listType === 'set') {
      identity = typeof item === 'object' ? undefined : JSON.stringify(item);
    } else if (isPlainObject(item) && keys.length > 0) {
      const parts = keys.map((key) => item[key]);
      if (parts.every((part) => part !== undefined && part !== null)) {
        identity = parts.map((part) => String(part)).join(' ');
      }
    }
    if (identity === undefined) return;

    const first = seen.get(identity);
    if (first !== undefined) {
      const label =
        listType === 'set'
          ? `Duplicate entry ${JSON.stringify(item)}`
          : `Duplicate ${keys.join(" + ")} ${keys.map((key) => `"${String((item as Record<string, unknown>)[key])}"`).join(', ')}`;
      findings.push({
        ruleId: 'schema/duplicate-list-entry',
        severity: 'error',
        path: [...path, index],
        message: `${label}; already used by entry ${first + 1}.`,
        explanation:
          'The API treats this list as a map keyed by those fields, so entries must be unique. A duplicate is rejected on submission.',
      });
    } else {
      seen.set(identity, index);
    }
  });
}

function unknownField(key: string, path: Path, candidates: string[]): Finding {
  const suggestion = didYouMean(key, candidates);
  return {
    ruleId: 'schema/unknown-field',
    severity: 'error',
    path: [...path, key],
    anchor: 'key',
    message: suggestion
      ? `Unknown field "${key}". Did you mean "${suggestion}"?`
      : `Unknown field "${key}".`,
    explanation:
      'Kubernetes rejects unrecognised fields when the manifest is applied with validation enabled (the default for kubectl apply). Silently ignored typos are a common cause of "my setting had no effect".',
    fix: suggestion
      ? { title: `Rename to "${suggestion}"`, safe: true, ops: [{ op: 'rename', path: [...path, key], to: suggestion }] }
      : { title: `Remove "${key}"`, safe: false, ops: [{ op: 'delete', path: [...path, key] }] },
  };
}

function typeMismatch(path: Path, expected: string, value: unknown, description?: string): Finding {
  return {
    ruleId: 'schema/type',
    severity: 'error',
    path,
    message: `Expected ${article(expected)} ${expected}, but found ${describeValue(value)}.`,
    explanation: description,
    docsUrl: docsUrlFrom(description),
    fix: coerceFix(value, expected, path),
  };
}

/**
 * Offer the obvious coercion for the mistakes YAML invites: an unquoted value
 * that parsed as the wrong type, or a quoted number where one was expected.
 */
function coerceFix(value: unknown, expected: string, path: Path = []): Finding['fix'] {
  if (path.length === 0) return undefined;

  if (expected === 'string' && (typeof value === 'number' || typeof value === 'boolean')) {
    const asString = String(value);
    return {
      title: `Quote it as "${asString}"`,
      safe: true,
      ops: [{ op: 'set', path, value: asString }],
    };
  }
  if ((expected === 'integer' || expected === 'number') && typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && (expected === 'number' || Number.isInteger(parsed))) {
      return {
        title: `Change to the number ${parsed}`,
        safe: true,
        ops: [{ op: 'set', path, value: parsed }],
      };
    }
  }
  if (expected === 'boolean' && typeof value === 'string') {
    const normalised = value.trim().toLowerCase();
    if (['true', 'yes', 'on', '1'].includes(normalised)) {
      return { title: 'Change to true', safe: true, ops: [{ op: 'set', path, value: true }] };
    }
    if (['false', 'no', 'off', '0'].includes(normalised)) {
      return { title: 'Change to false', safe: true, ops: [{ op: 'set', path, value: false }] };
    }
  }
  return undefined;
}

export interface FieldVisit {
  path: Path;
  value: unknown;
  /** Short name of the definition that owns this field, e.g. "Container". */
  owner: string;
  field: string;
  property: SchemaNode;
}

/**
 * Traverse a document alongside the schema, reporting every field with the
 * definition that owns it. Rules key off `Owner.field` (for example
 * `Container.imagePullPolicy`), which stays correct wherever a type is reused
 * — Container appears under containers, initContainers and ephemeralContainers.
 */
export function walkFields(
  value: unknown,
  schema: Schema,
  visit: (field: FieldVisit) => void,
): void {
  const seen = new Set<unknown>();

  const recurse = (current: unknown, property: SchemaNode, path: Path): void => {
    if (current == null) return;
    const { node, ref } = schema.resolve(property);
    if (!node || (ref && (SCALAR_DEFINITIONS.has(ref) || OPAQUE_DEFINITIONS.has(ref)))) return;

    const type = property.type ?? node.type ?? (node.properties ? 'object' : undefined);

    if (type === 'array') {
      if (!Array.isArray(current)) return;
      const items = property.items ?? node.items;
      if (!items) return;
      current.forEach((item, index) => recurse(item, items, [...path, index]));
      return;
    }

    if (!isPlainObject(current)) return;
    if (seen.has(current)) return;
    seen.add(current);

    const owner = ref ? (ref.split('.').pop() ?? ref) : 'Pod';
    for (const [key, child] of Object.entries(current)) {
      const childSchema = node.properties?.[key] ?? node.additionalProperties;
      if (!childSchema) continue;
      if (node.properties?.[key]) {
        visit({ path: [...path, key], value: child, owner, field: key, property: childSchema });
      }
      recurse(child, childSchema, [...path, key]);
    }
  };

  recurse(value, { $ref: `#/definitions/${schema.rootRef}` }, []);
}

export function describeValue(value: unknown): string {
  if (value === null) return 'an empty value';
  if (Array.isArray(value)) return 'a list';
  switch (typeof value) {
    case 'string':
      return `the string "${value}"`;
    case 'number':
      return `the number ${value}`;
    case 'boolean':
      return `the boolean ${value}`;
    case 'object':
      return 'a mapping';
    default:
      return `a ${typeof value}`;
  }
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
