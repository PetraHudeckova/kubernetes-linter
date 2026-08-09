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
  /** Kind name -> root definition, e.g. `Pod` -> `io.k8s.api.core.v1.Pod`. */
  roots: Record<string, string>;
  definitions: Record<string, SchemaNode>;
}

/**
 * The kind a document is checked as when it declares none. A manifest with no
 * `kind` is reported either way; this only decides which schema the rest of
 * the walk uses, and a bare `spec.containers` document is a Pod.
 */
export const FALLBACK_KIND = 'Pod';

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

/**
 * One version's bundle. It carries a root per supported kind over a shared
 * definition pool, so switching kinds mid-document costs nothing — `for()`
 * hands back a view rooted at the kind the document declares.
 */
export class Schema {
  private readonly views = new Map<string, KindSchema>();

  constructor(private readonly bundle: SchemaBundle) {}

  get version(): string {
    return this.bundle.k8sVersion;
  }

  /** Kinds this bundle has a root definition for. */
  get kinds(): string[] {
    return Object.keys(this.bundle.roots);
  }

  /** A view rooted at one kind, or undefined if the bundle does not carry it. */
  for(kind: string): KindSchema | undefined {
    const cached = this.views.get(kind);
    if (cached) return cached;

    const ref = this.bundle.roots[kind];
    if (ref === undefined) return undefined;

    const view = new KindSchema(this, kind, ref);
    this.views.set(kind, view);
    return view;
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
}

/** A bundle bound to one root definition. This is what both lint layers see. */
export class KindSchema {
  constructor(
    private readonly schema: Schema,
    readonly kind: string,
    readonly rootRef: string,
  ) {}

  get version(): string {
    return this.schema.version;
  }

  definition(name: string): SchemaNode | undefined {
    return this.schema.definition(name);
  }

  resolve(node: SchemaNode | undefined): { node: SchemaNode | undefined; ref?: string } {
    return this.schema.resolve(node);
  }

  /** The group/version/kind the apiserver serves this root under. */
  get groupVersionKind(): { group: string; version: string; kind: string } {
    const gvk = this.definition(this.rootRef)?.['x-kubernetes-group-version-kind']?.[0];
    return gvk ?? { group: '', version: 'v1', kind: this.kind };
  }

  /** The apiVersion a manifest of this kind must declare. */
  get apiVersion(): string {
    const { group, version } = this.groupVersionKind;
    return group ? `${group}/${version}` : version;
  }

  /** Describe a field for tooltips: type, requiredness and API description. */
  describe(path: Path): { title: string; type: string; required: boolean; description?: string } | undefined {
    let current: SchemaNode | undefined = { $ref: `#/definitions/${this.rootRef}` };
    let required = false;
    let title = this.kind;

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
  /** The kind the document was checked as, so the caller can pick its rules. */
  kind?: string;
  /** Set when the document declares a kind no bundled root covers. */
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

  const kind = value['kind'];
  const apiVersion = value['apiVersion'];

  let kindSchema: KindSchema | undefined;
  if (kind == null) {
    kindSchema = schema.for(FALLBACK_KIND);
    findings.push({
      ruleId: 'schema/missing-kind',
      severity: 'error',
      path: [],
      message: 'Required field "kind" is missing.',
      explanation: `Every Kubernetes object declares its type through "kind". This linter understands ${listKinds(schema.kinds)}; without one the document was checked as ${article(FALLBACK_KIND)} ${FALLBACK_KIND}.`,
      fix: {
        title: `Add kind: ${FALLBACK_KIND}`,
        safe: false,
        ops: [{ op: 'set', path: ['kind'], value: FALLBACK_KIND }],
      },
    });
  } else {
    kindSchema = typeof kind === 'string' ? schema.for(kind) : undefined;
  }

  if (!kindSchema) return { findings, unsupportedKind: String(kind) };

  const expectedApiVersion = kindSchema.apiVersion;
  const group = kindSchema.groupVersionKind.group;
  const groupNote = group
    ? `${kindSchema.kind} is served by the "${group}" API group, so its apiVersion carries that group prefix.`
    : `${kindSchema.kind} is part of the core API group, which uses a bare version with no group prefix.`;

  if (apiVersion == null) {
    findings.push({
      ruleId: 'schema/missing-api-version',
      severity: 'error',
      path: [],
      message: 'Required field "apiVersion" is missing.',
      explanation: `${groupNote} For ${article(kindSchema.kind)} ${kindSchema.kind} it is "${expectedApiVersion}".`,
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
      message: `${kindSchema.kind} is served by apiVersion "${expectedApiVersion}", not "${String(apiVersion)}".`,
      explanation: groupNote,
      fix: {
        title: `Change to ${expectedApiVersion}`,
        safe: true,
        ops: [{ op: 'set', path: ['apiVersion'], value: expectedApiVersion }],
      },
    });
  }

  walk(value, { $ref: `#/definitions/${kindSchema.rootRef}` }, [], kindSchema, findings);
  return { findings, kind: kindSchema.kind };
}

/** "Pod and Deployment", "Pod, Deployment and Job". */
function listKinds(kinds: string[]): string {
  if (kinds.length <= 1) return kinds[0] ?? 'nothing';
  return `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}`;
}

function walk(
  value: unknown,
  property: SchemaNode,
  path: Path,
  schema: KindSchema,
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
  schema: KindSchema,
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

    const owner = ref ? (ref.split('.').pop() ?? ref) : schema.kind;
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
