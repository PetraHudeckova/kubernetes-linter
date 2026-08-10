import { isDNS1123Label, isDNS1123Subdomain, suggestName } from '../../k8s/names.js';
import { parseQuantity } from '../../k8s/quantity.js';
import { didYouMean } from '../suggest.js';
import type { Path } from '../types.js';
import { asArray, asObject, asString, type Rule, type RuleContext } from './context.js';
import { checkKeyedMap } from './metadata.js';
import { checkRequirement } from './selector.js';

const PVC_DOCS = 'https://kubernetes.io/docs/concepts/storage/persistent-volumes/';
const SELECTOR_DOCS =
  'https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/#label-selectors';

/** supportedAccessModes, from pkg/apis/core/validation. */
const ACCESS_MODES = ['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod'];

/**
 * The checks the apiserver runs on a PersistentVolumeClaim, from
 * ValidatePersistentVolumeClaimSpec in pkg/apis/core/validation. Like a
 * Service, an Ingress and an IngressClass it describes no Pod, so none of the
 * shared PodSpec rules apply to it.
 *
 * The schema layer covers almost nothing here: PersistentVolumeClaimSpec has
 * no `required` list in the OpenAPI document at all, so both `accessModes`
 * and `resources.requests.storage` — which validation does require — are this
 * module's, alongside the quantity's sign (layer 1's Quantity scalar check
 * already covers syntax, so only positivity is checked again here).
 *
 * `checkClaimSpec` is exported because the apiserver validates the very same
 * spec in two other places: a StatefulSet's `volumeClaimTemplates` and a
 * Pod's `ephemeral.volumeClaimTemplate`. `rules/statefulset.ts` and
 * `rules/volumes.ts` call it against those nested specs rather than
 * duplicating these checks under a second set of rule ids — a finding from
 * either keeps its `persistentvolumeclaim/*` id and fires at the deeper path,
 * exactly as a `job/*` finding does under a CronJob's `jobTemplate.spec`.
 */
export const persistentVolumeClaimRule: Rule = {
  id: 'persistentvolumeclaim/spec',
  run(ctx: RuleContext) {
    // An absent spec is a claim with none of its required fields, which is
    // the same rejection as an empty one. A spec of the wrong shape is layer
    // 1's to report.
    const declared = ctx.doc['spec'];
    const spec = declared == null ? {} : asObject(declared);
    if (!spec) return;

    checkClaimSpec(ctx, spec, ['spec']);
  },
};

export function checkClaimSpec(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  checkAccessModes(ctx, spec, base);
  checkSelector(ctx, spec, base);
  checkStorageRequest(ctx, spec, base);
  checkStorageClassName(ctx, spec, base);
  checkVolumeAttributesClassName(ctx, spec, base);
  checkDataSource(ctx, spec, base);
}

/* Access modes */

function checkAccessModes(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const accessModes = asArray(spec['accessModes']);
  const path = [...base, 'accessModes'];

  if (accessModes === undefined || accessModes.length === 0) {
    ctx.report({
      ruleId: 'persistentvolumeclaim/missing-access-modes',
      severity: 'error',
      path: accessModes === undefined ? base : path,
      ...(accessModes === undefined ? { anchor: 'key' as const } : {}),
      message: 'A PersistentVolumeClaim must list at least one access mode.',
      explanation:
        'accessModes says how the volume may be mounted — by one node for read-write, by many for read-only, or by many for read-write. Without one there is nothing for the apiserver to bind against a PersistentVolume, and it is rejected with "Required value".',
      docsUrl: `${PVC_DOCS}#access-modes`,
    });
    return;
  }

  let hasReadWriteOncePod = false;
  let hasOtherMode = false;

  accessModes.forEach((entry, index) => {
    const mode = asString(entry);
    if (mode === undefined) return;

    if (!ACCESS_MODES.includes(mode)) {
      const suggestion = didYouMean(mode, ACCESS_MODES);
      ctx.report({
        ruleId: 'persistentvolumeclaim/invalid-access-mode',
        severity: 'error',
        path: [...path, index],
        message: suggestion
          ? `"${mode}" is not a valid access mode. Did you mean "${suggestion}"?`
          : `"${mode}" is not a valid access mode.`,
        explanation: `Allowed values are ${ACCESS_MODES.map((value) => `"${value}"`).join(', ')}.`,
        docsUrl: `${PVC_DOCS}#access-modes`,
        fix: suggestion
          ? {
              title: `Change to "${suggestion}"`,
              safe: true,
              ops: [{ op: 'set', path: [...path, index], value: suggestion }],
            }
          : undefined,
      });
      return;
    }

    if (mode === 'ReadWriteOncePod') hasReadWriteOncePod = true;
    else hasOtherMode = true;
  });

  if (hasReadWriteOncePod && hasOtherMode) {
    ctx.report({
      ruleId: 'persistentvolumeclaim/read-write-once-pod-exclusive',
      severity: 'error',
      path,
      message: '"ReadWriteOncePod" may not be combined with another access mode.',
      explanation:
        '"ReadWriteOncePod" already guarantees the volume to a single Pod, which is stricter than every other mode, so listing one beside it contradicts that guarantee and the apiserver rejects the pair.',
      docsUrl: `${PVC_DOCS}#access-modes`,
    });
  }
}

/* Selector */

function checkSelector(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const selector = asObject(spec['selector']);
  if (!selector) return;

  checkKeyedMap(ctx, selector['matchLabels'], [...base, 'selector', 'matchLabels'], 'label', true);

  asArray(selector['matchExpressions'])?.forEach((entry, index) => {
    checkRequirement(ctx, asObject(entry), [...base, 'selector', 'matchExpressions', index], {
      allowNumeric: false,
      idPrefix: 'persistentvolumeclaim',
      docsUrl: SELECTOR_DOCS,
    });
  });
}

/* Storage request */

function checkStorageRequest(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const resources = asObject(spec['resources']);
  const requests = asObject(resources?.['requests']);
  const raw = requests?.['storage'];

  if (raw === undefined) {
    ctx.report({
      ruleId: 'persistentvolumeclaim/missing-storage-request',
      severity: 'error',
      path: requests ? [...base, 'resources', 'requests'] : [...base, 'resources'],
      anchor: 'key',
      message: 'A PersistentVolumeClaim must request a storage size.',
      explanation:
        'resources.requests.storage is how much space the claim asks for; without it the apiserver has nothing to bind against a PersistentVolume and rejects the claim with "Required value".',
      docsUrl: `${PVC_DOCS}#resources`,
    });
    return;
  }

  const quantity = parseQuantity(raw);
  // A syntax error here is layer 1's, through the Quantity scalar check.
  if (!quantity.ok || quantity.value === undefined) return;

  if (quantity.value <= 0) {
    ctx.report({
      ruleId: 'persistentvolumeclaim/non-positive-storage-request',
      severity: 'error',
      path: [...base, 'resources', 'requests', 'storage'],
      message: `The storage request must be greater than zero, but is ${format(raw)}.`,
      explanation: 'A claim for no storage, or for a negative amount, describes no usable volume.',
      docsUrl: `${PVC_DOCS}#resources`,
    });
  }
}

function format(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

/* Storage class and volume attributes class */

function checkStorageClassName(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const name = asString(spec['storageClassName']);
  if (name === undefined || name === '') return;

  const check = isDNS1123Subdomain(name);
  if (check.ok) return;

  const suggestion = suggestName(name);
  ctx.report({
    ruleId: 'persistentvolumeclaim/invalid-storage-class-name',
    severity: 'error',
    path: [...base, 'storageClassName'],
    message: `"${name}" is not a valid storageClassName: it ${check.reason}.`,
    explanation:
      'storageClassName names a StorageClass object, so it is a DNS subdomain: lowercase letters, digits, "-" and ".", starting and ending with an alphanumeric character.',
    docsUrl: 'https://kubernetes.io/docs/concepts/storage/storage-classes/',
    fix:
      suggestion && isDNS1123Subdomain(suggestion).ok
        ? {
            title: `Change to "${suggestion}"`,
            safe: false,
            ops: [{ op: 'set', path: [...base, 'storageClassName'], value: suggestion }],
          }
        : undefined,
  });
}

/**
 * volumeAttributesClassName arrived in 1.29, on the same field as
 * storageClassName's DNS subdomain format — `ctx.supports` closes the gate on
 * an older target, where the schema layer has already reported the field as
 * unknown.
 */
function checkVolumeAttributesClassName(
  ctx: RuleContext,
  spec: Record<string, unknown>,
  base: Path,
): void {
  const path = [...base, 'volumeAttributesClassName'];
  if (!ctx.supports(path)) return;

  const name = asString(spec['volumeAttributesClassName']);
  if (name === undefined || name === '') return;

  const check = isDNS1123Subdomain(name);
  if (check.ok) return;

  ctx.report({
    ruleId: 'persistentvolumeclaim/invalid-volume-attributes-class-name',
    severity: 'error',
    path,
    message: `"${name}" is not a valid volumeAttributesClassName: it ${check.reason}.`,
    explanation:
      'volumeAttributesClassName names a VolumeAttributesClass object, so it follows the same DNS subdomain format as storageClassName.',
    docsUrl: 'https://kubernetes.io/docs/concepts/storage/volume-attributes-classes/',
  });
}

/* Data source */

/**
 * dataSource and dataSourceRef both point at the object to populate the
 * volume from; dataSourceRef is the newer, more general form and the two are
 * kept in sync automatically when only one is written. `namespace` only
 * exists on dataSourceRef, and only from 1.26 — before that the field is
 * unknown to the schema, so nothing here needs to gate on it explicitly.
 */
function checkDataSource(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const dataSource = asObject(spec['dataSource']);
  const dataSourceRef = asObject(spec['dataSourceRef']);

  checkTypedReference(ctx, dataSource, [...base, 'dataSource'], 'dataSource');
  checkTypedReference(ctx, dataSourceRef, [...base, 'dataSourceRef'], 'dataSourceRef');

  if (!dataSource || !dataSourceRef) return;

  const namespace = asString(dataSourceRef['namespace']);
  if (namespace !== undefined && namespace !== '') {
    ctx.report({
      ruleId: 'persistentvolumeclaim/data-source-with-cross-namespace-ref',
      severity: 'error',
      path: [...base, 'dataSource'],
      message: 'dataSource may not be set when dataSourceRef.namespace is set.',
      explanation:
        'A dataSourceRef naming another namespace has no local object for dataSource, the older field, to mirror, so the apiserver rejects the pair rather than guess which one is meant.',
      docsUrl: `${PVC_DOCS}#dataSource`,
      fix: {
        title: 'Remove dataSource',
        safe: false,
        ops: [{ op: 'delete', path: [...base, 'dataSource'] }],
      },
    });
    return;
  }

  if (!referencesMatch(dataSource, dataSourceRef)) {
    ctx.report({
      ruleId: 'persistentvolumeclaim/data-source-mismatch',
      severity: 'error',
      path: [...base, 'dataSource'],
      message: 'dataSource must match dataSourceRef.',
      explanation:
        'The two fields are kept in sync automatically when only one is written, so the apiserver rejects them naming different objects rather than picking one.',
      docsUrl: `${PVC_DOCS}#dataSource`,
    });
  }
}

function referencesMatch(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return (
    asString(a['apiGroup']) === asString(b['apiGroup']) &&
    asString(a['kind']) === asString(b['kind']) &&
    asString(a['name']) === asString(b['name'])
  );
}

function checkTypedReference(
  ctx: RuleContext,
  ref: Record<string, unknown> | undefined,
  path: Path,
  field: 'dataSource' | 'dataSourceRef',
): void {
  if (!ref) return;

  const name = asString(ref['name']);
  if (name === undefined || name === '') {
    ctx.report({
      ruleId: 'persistentvolumeclaim/missing-data-source-name',
      severity: 'error',
      path: name === undefined ? path : [...path, 'name'],
      ...(name === undefined ? { anchor: 'key' as const } : {}),
      message: `${field}.name is required.`,
      explanation: 'The reference names the object to populate the volume from; without one there is nothing to bind.',
      docsUrl: `${PVC_DOCS}#dataSource`,
    });
  }

  const kind = asString(ref['kind']);
  if (kind === undefined || kind === '') {
    ctx.report({
      ruleId: 'persistentvolumeclaim/missing-data-source-kind',
      severity: 'error',
      path: kind === undefined ? path : [...path, 'kind'],
      ...(kind === undefined ? { anchor: 'key' as const } : {}),
      message: `${field}.kind is required.`,
      explanation: 'The reference has to say what kind of object it names; apiGroup alone does not.',
      docsUrl: `${PVC_DOCS}#dataSource`,
    });
  }

  const apiGroup = asString(ref['apiGroup']);
  if (apiGroup !== undefined && apiGroup !== '') {
    const check = isDNS1123Subdomain(apiGroup);
    if (!check.ok) {
      ctx.report({
        ruleId: 'persistentvolumeclaim/invalid-data-source-api-group',
        severity: 'error',
        path: [...path, 'apiGroup'],
        message: `"${apiGroup}" is not a valid API group: it ${check.reason}.`,
        explanation:
          'The group is the one the referenced object is served under. Leave it out to mean the core API group.',
        docsUrl: `${PVC_DOCS}#dataSource`,
      });
    }
  } else if (kind !== undefined && kind !== '' && kind !== 'PersistentVolumeClaim') {
    ctx.report({
      ruleId: 'persistentvolumeclaim/data-source-kind-requires-api-group',
      severity: 'error',
      path: [...path, 'kind'],
      message: `"${kind}" needs an apiGroup: the core API group only has "PersistentVolumeClaim" to reference.`,
      explanation:
        'With no apiGroup the reference resolves in the core API group, where a VolumeSnapshot and most other data sources do not live — only a PersistentVolumeClaim does.',
      docsUrl: `${PVC_DOCS}#dataSource`,
    });
  }

  const namespace = asString(ref['namespace']);
  if (namespace !== undefined && namespace !== '') {
    const check = isDNS1123Label(namespace);
    if (!check.ok) {
      ctx.report({
        ruleId: 'persistentvolumeclaim/invalid-data-source-namespace',
        severity: 'error',
        path: [...path, 'namespace'],
        message: `"${namespace}" is not a valid namespace: it ${check.reason}.`,
        explanation: 'Namespace names are DNS labels: lowercase letters, digits and "-", at most 63 characters.',
        docsUrl: `${PVC_DOCS}#dataSource`,
      });
    }
  }
}
