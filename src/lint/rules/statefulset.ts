import { isDNS1123Label, suggestName } from '../../k8s/names.js';
import {
  asArray,
  asNumber,
  asObject,
  asString,
  type Rule,
  type RuleContext,
} from './context.js';
import { checkKeyedMap } from './metadata.js';
import { checkRequirement } from './selector.js';

const STATEFULSET_DOCS = 'https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/';
const SELECTOR_DOCS =
  'https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/#label-selectors';

/**
 * The checks the apiserver runs on a StatefulSet beyond the pod template, from
 * ValidateStatefulSetSpec in pkg/apis/apps.
 *
 * Missing `selector` and `template` are already reported by layer 1 — they are
 * `required` on StatefulSetSpec — as is a missing `serviceName` up to 1.32,
 * where it was required too. Nothing here re-reports them.
 */
export const statefulSetRule: Rule = {
  id: 'statefulset/spec',
  run(ctx: RuleContext) {
    const spec = asObject(ctx.doc['spec']);
    if (!spec) return;

    checkSelector(ctx, spec);
    checkTemplate(ctx, spec);
    checkServiceName(ctx, spec);
    checkCounters(ctx, spec);
    checkUpdateStrategy(ctx, spec);
    checkVolumeClaimTemplates(ctx, spec);
  },
};

/* Selector */

function checkSelector(ctx: RuleContext, spec: Record<string, unknown>): void {
  const selector = asObject(spec['selector']);
  if (!selector) return;

  const matchLabels = asObject(selector['matchLabels']);
  const matchExpressions = asArray(selector['matchExpressions']);
  const size = Object.keys(matchLabels ?? {}).length + (matchExpressions?.length ?? 0);

  if (size === 0) {
    ctx.report({
      ruleId: 'statefulset/empty-selector',
      severity: 'error',
      path: ['spec', 'selector'],
      message: 'A StatefulSet selector must not be empty.',
      explanation:
        'An empty selector matches every Pod in the namespace, so the apiserver rejects it with "empty selector is invalid for statefulset" rather than let one StatefulSet adopt unrelated Pods.',
      docsUrl: STATEFULSET_DOCS,
    });
    return;
  }

  checkKeyedMap(ctx, selector['matchLabels'], ['spec', 'selector', 'matchLabels'], 'label', true);

  matchExpressions?.forEach((entry, index) => {
    checkRequirement(ctx, asObject(entry), ['spec', 'selector', 'matchExpressions', index], {
      allowNumeric: false,
      idPrefix: 'statefulset',
      docsUrl: SELECTOR_DOCS,
    });
  });

  const templateLabels =
    asObject(asObject(asObject(spec['template'])?.['metadata'])?.['labels']) ?? {};
  checkSelectorMatchesTemplate(ctx, templateLabels, matchLabels, matchExpressions);
}

/**
 * The template's labels must satisfy the selector, or the StatefulSet would
 * create Pods it does not itself select. Only matchLabels and the two
 * set-based operators are decided here; anything the selector expresses that
 * we cannot evaluate is left alone rather than guessed at.
 */
function checkSelectorMatchesTemplate(
  ctx: RuleContext,
  labels: Record<string, unknown>,
  matchLabels: Record<string, unknown> | undefined,
  matchExpressions: unknown[] | undefined,
): void {
  const labelsPath = ctx.meta('labels');
  const explanation =
    'A StatefulSet only manages Pods its selector matches. When the template disagrees with the selector the apiserver rejects the object with "`selector` does not match template `labels`".';

  for (const [key, value] of Object.entries(matchLabels ?? {})) {
    if (typeof value !== 'string') continue;
    const actual = labels[key];
    if (actual === value) continue;

    ctx.report({
      ruleId: 'statefulset/selector-mismatch',
      severity: 'error',
      path: actual === undefined ? labelsPath : [...labelsPath, key],
      message:
        actual === undefined
          ? `The selector requires label "${key}: ${value}", which the pod template does not set.`
          : `The selector requires label "${key}: ${value}", but the pod template sets "${String(actual)}".`,
      explanation,
      docsUrl: STATEFULSET_DOCS,
      fix: {
        title: `Set ${key}: ${value} on the pod template`,
        safe: false,
        ops: [{ op: 'set', path: [...labelsPath, key], value }],
      },
    });
  }

  matchExpressions?.forEach((entry, index) => {
    const requirement = asObject(entry);
    const key = asString(requirement?.['key']);
    const operator = asString(requirement?.['operator']);
    if (!requirement || key === undefined || operator === undefined) return;

    const actual = labels[key];
    const values = asArray(requirement['values'])?.map(String) ?? [];
    const present = actual !== undefined;
    const satisfied =
      operator === 'Exists'
        ? present
        : operator === 'DoesNotExist'
          ? !present
          : operator === 'In'
            ? present && values.includes(String(actual))
            : operator === 'NotIn'
              ? !present || !values.includes(String(actual))
              : true;

    if (satisfied) return;

    ctx.report({
      ruleId: 'statefulset/selector-mismatch',
      severity: 'error',
      path: ['spec', 'selector', 'matchExpressions', index],
      message: `The pod template's labels do not satisfy "${key} ${operator}${values.length > 0 ? ` [${values.join(', ')}]` : ''}".`,
      explanation,
      docsUrl: STATEFULSET_DOCS,
    });
  });
}

/* Pod template */

function checkTemplate(ctx: RuleContext, spec: Record<string, unknown>): void {
  const template = asObject(spec['template']);
  if (!template) return;

  const metadata = asObject(template['metadata']);
  if (metadata) {
    checkKeyedMap(ctx, metadata['labels'], ctx.meta('labels'), 'label', true);
    checkKeyedMap(ctx, metadata['annotations'], ctx.meta('annotations'), 'annotation', false);
  }

  const podSpec = ctx.spec;

  const restartPolicy = asString(podSpec['restartPolicy']);
  if (restartPolicy !== undefined && restartPolicy !== 'Always') {
    ctx.report({
      ruleId: 'statefulset/template-restart-policy',
      severity: 'error',
      path: ctx.at('restartPolicy'),
      message: `A StatefulSet's pod template must use restartPolicy: Always, not "${restartPolicy}".`,
      explanation:
        'A StatefulSet keeps one running Pod per ordinal, so a template that lets its Pods finish would fight the controller. "Always" is the only value the apiserver accepts here; use a Job for run-to-completion work.',
      docsUrl: STATEFULSET_DOCS,
      fix: {
        title: 'Change to Always',
        safe: true,
        ops: [{ op: 'set', path: ctx.at('restartPolicy'), value: 'Always' }],
      },
    });
  }

  if (podSpec['activeDeadlineSeconds'] !== undefined) {
    ctx.report({
      ruleId: 'statefulset/template-active-deadline',
      severity: 'error',
      path: ctx.at('activeDeadlineSeconds'),
      message: 'activeDeadlineSeconds is not allowed in a StatefulSet pod template.',
      explanation:
        'It caps how long a Pod may run before being marked failed, which contradicts a controller whose job is to keep Pods running indefinitely. The apiserver rejects it with "activeDeadlineSeconds in StatefulSet is not Supported".',
      docsUrl: STATEFULSET_DOCS,
      fix: {
        title: 'Remove activeDeadlineSeconds',
        safe: true,
        ops: [{ op: 'delete', path: ctx.at('activeDeadlineSeconds') }],
      },
    });
  }

  const ephemeral = asArray(podSpec['ephemeralContainers']);
  if (ephemeral && ephemeral.length > 0) {
    ctx.report({
      ruleId: 'statefulset/template-ephemeral-containers',
      severity: 'error',
      path: ctx.at('ephemeralContainers'),
      message: 'ephemeralContainers are not allowed in a pod template.',
      explanation:
        'Ephemeral containers are added to a running Pod through its "ephemeralcontainers" subresource for debugging. They cannot be declared up front, so the apiserver rejects them in a template.',
      docsUrl: 'https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/',
    });
  }
}

/* Governing service */

function checkServiceName(ctx: RuleContext, spec: Record<string, unknown>): void {
  const serviceName = asString(spec['serviceName']);
  if (serviceName === undefined || serviceName === '') return;

  const check = isDNS1123Label(serviceName);
  if (check.ok) return;

  const suggestion = suggestName(serviceName);
  ctx.report({
    ruleId: 'statefulset/invalid-service-name',
    severity: 'error',
    path: ['spec', 'serviceName'],
    message: `"${serviceName}" is not a valid serviceName: it ${check.reason}.`,
    explanation:
      'serviceName names the headless Service that gives each Pod its stable DNS record, so it is a Service name: a DNS label of lowercase letters, digits and "-", at most 63 characters. The apiserver checks the format itself from 1.33; before that it accepts the StatefulSet and the Pods it creates are rejected instead, since the name is copied into their subdomain.',
    docsUrl: STATEFULSET_DOCS,
    fix:
      suggestion && isDNS1123Label(suggestion).ok
        ? {
            title: `Change to "${suggestion}"`,
            safe: false,
            ops: [{ op: 'set', path: ['spec', 'serviceName'], value: suggestion }],
          }
        : undefined,
  });
}

/* Numeric fields */

function checkCounters(ctx: RuleContext, spec: Record<string, unknown>): void {
  const nonNegative = [
    ['replicas', 'statefulset/negative-replicas', 'the number of Pods the controller keeps running'],
    [
      'minReadySeconds',
      'statefulset/negative-min-ready-seconds',
      'how long a new Pod must stay ready before it counts as available',
    ],
    [
      'revisionHistoryLimit',
      'statefulset/negative-revision-history-limit',
      'how many old ControllerRevisions are kept for rollback',
    ],
  ] as const;

  for (const [field, ruleId, meaning] of nonNegative) {
    const value = asNumber(spec[field]);
    if (value === undefined || value >= 0) continue;
    ctx.report({
      ruleId,
      severity: 'error',
      path: ['spec', field],
      message: `${field} must not be negative, but is ${value}.`,
      explanation: `It is ${meaning}.`,
      docsUrl: STATEFULSET_DOCS,
    });
  }

  // `ordinals` arrived in 1.26; on an older target the schema layer has already
  // reported the field as unknown, so there is nothing to add.
  if (!ctx.supports(['spec', 'ordinals', 'start'])) return;

  const start = asNumber(asObject(spec['ordinals'])?.['start']);
  if (start !== undefined && start < 0) {
    ctx.report({
      ruleId: 'statefulset/negative-ordinal-start',
      severity: 'error',
      path: ['spec', 'ordinals', 'start'],
      message: `ordinals.start must not be negative, but is ${start}.`,
      explanation:
        'It is the ordinal the first Pod is numbered from, so the set covers start through start + replicas - 1. Pod names are built from it and cannot carry a negative suffix.',
      docsUrl: STATEFULSET_DOCS,
    });
  }
}

/* Update strategy */

function checkUpdateStrategy(ctx: RuleContext, spec: Record<string, unknown>): void {
  const strategy = asObject(spec['updateStrategy']);
  if (!strategy) return;

  // The type itself is in the enum table; only the combination is checked here.
  const type = asString(strategy['type']);
  const rollingUpdate = asObject(strategy['rollingUpdate']);

  if (type === 'OnDelete' && strategy['rollingUpdate'] !== undefined) {
    ctx.report({
      ruleId: 'statefulset/rolling-update-with-on-delete',
      severity: 'error',
      path: ['spec', 'updateStrategy', 'rollingUpdate'],
      anchor: 'key',
      message: 'rollingUpdate cannot be set when updateStrategy type is "OnDelete".',
      explanation:
        '"OnDelete" leaves the controller out of it entirely: Pods are replaced with the new template only as you delete them by hand, so there is no automated rollout for partition and maxUnavailable to describe.',
      docsUrl: STATEFULSET_DOCS,
      fix: {
        title: 'Remove rollingUpdate',
        safe: true,
        ops: [{ op: 'delete', path: ['spec', 'updateStrategy', 'rollingUpdate'] }],
      },
    });
  }

  if (!rollingUpdate) return;

  const basePath = ['spec', 'updateStrategy', 'rollingUpdate'];

  const partition = asNumber(rollingUpdate['partition']);
  if (partition !== undefined && partition < 0) {
    ctx.report({
      ruleId: 'statefulset/negative-partition',
      severity: 'error',
      path: [...basePath, 'partition'],
      message: `partition must not be negative, but is ${partition}.`,
      explanation:
        'It is the ordinal below which Pods are left alone: only Pods with an ordinal at or above it are updated, which is how a staged rollout is held back.',
      docsUrl: STATEFULSET_DOCS,
    });
  }

  if (rollingUpdate['maxUnavailable'] === undefined) return;

  const maxUnavailable = parseIntOrPercent(rollingUpdate['maxUnavailable']);
  const maxUnavailablePath = [...basePath, 'maxUnavailable'];

  if (maxUnavailable === undefined) {
    ctx.report({
      ruleId: 'statefulset/invalid-max-unavailable',
      severity: 'error',
      path: maxUnavailablePath,
      message: 'maxUnavailable must be a positive count or a percentage such as "25%".',
      explanation:
        'The field is an IntOrString: a bare integer counts Pods, a quoted string ending in "%" is read relative to the desired replica count.',
      docsUrl: STATEFULSET_DOCS,
    });
    return;
  }

  // A percentage is rounded down, so anything under 1% of the replica count
  // also lands on zero — but only a literal zero is certain without knowing
  // how the cluster rounds, and that is what the apiserver rejects.
  if (maxUnavailable.value <= 0) {
    ctx.report({
      ruleId: 'statefulset/invalid-max-unavailable',
      severity: 'error',
      path: maxUnavailablePath,
      message: `maxUnavailable must be greater than 0, but is ${maxUnavailable.percent ? `${maxUnavailable.value}%` : maxUnavailable.value}.`,
      explanation:
        'It is how many Pods the rollout may take down at once. At zero the update could never take a single step, so the apiserver rejects it; omit the field to get the default of 1. Note that it is only honoured when the cluster runs with the MaxUnavailableStatefulSet feature gate enabled.',
      docsUrl: STATEFULSET_DOCS,
    });
  } else if (maxUnavailable.percent && maxUnavailable.value > 100) {
    ctx.report({
      ruleId: 'statefulset/percent-over-100',
      severity: 'error',
      path: maxUnavailablePath,
      message: `maxUnavailable must not exceed 100%, but is ${maxUnavailable.value}%.`,
      explanation:
        'It is a fraction of the desired replica count, so more than all of them is meaningless.',
      docsUrl: STATEFULSET_DOCS,
    });
  }
}

/**
 * An IntOrString as the apiserver reads it: a number, or a string that is
 * either a bare integer or an integer followed by "%".
 */
function parseIntOrPercent(value: unknown): { value: number; percent: boolean } | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { value, percent: false } : undefined;
  }
  if (typeof value !== 'string') return undefined;

  const percent = value.endsWith('%');
  const digits = percent ? value.slice(0, -1) : value;
  if (!/^-?\d+$/.test(digits)) return undefined;
  return { value: Number(digits), percent };
}

/* Volume claim templates */

/**
 * Each claim template becomes one volume on every Pod the set creates, named
 * after the template — which is what makes a mount referring to a claim
 * template valid even though the pod spec declares no such volume (see
 * `volumes.ts`). That naming is also where the checks come from: the generated
 * volume has to survive pod validation.
 */
function checkVolumeClaimTemplates(ctx: RuleContext, spec: Record<string, unknown>): void {
  const templates = asArray(spec['volumeClaimTemplates']);
  if (!templates) return;

  const declaredVolumes = new Set(
    (asArray(ctx.spec['volumes']) ?? [])
      .map((entry) => asString(asObject(entry)?.['name']))
      .filter((name): name is string => name !== undefined),
  );
  const seen = new Map<string, number>();

  templates.forEach((entry, index) => {
    const template = asObject(entry);
    if (!template) return;
    const path = ['spec', 'volumeClaimTemplates', index];
    const name = asString(asObject(template['metadata'])?.['name']);

    if (name === undefined) {
      ctx.report({
        ruleId: 'statefulset/claim-template-without-name',
        severity: 'error',
        path,
        anchor: 'key',
        message: `Volume claim template #${index + 1} has no metadata.name.`,
        explanation:
          'The name is how a container mounts the claim: the controller adds a volume of that name to every Pod, and names the PersistentVolumeClaim it creates "<name>-<statefulset>-<ordinal>".',
        docsUrl: STATEFULSET_DOCS,
        fix: {
          title: 'Add a name',
          safe: false,
          ops: [{ op: 'set', path: [...path, 'metadata', 'name'], value: 'data' }],
        },
      });
      return;
    }

    const check = isDNS1123Label(name);
    if (!check.ok) {
      ctx.report({
        ruleId: 'statefulset/invalid-claim-template-name',
        severity: 'error',
        path: [...path, 'metadata', 'name'],
        message: `"${name}" is not a valid volume claim template name: it ${check.reason}.`,
        explanation:
          'The name is used verbatim as a volume name on every Pod the set creates, so it must be a DNS label: lowercase letters, digits and "-", at most 63 characters.',
        docsUrl: STATEFULSET_DOCS,
        fix: (() => {
          const suggestion = suggestName(name);
          return suggestion && isDNS1123Label(suggestion).ok
            ? {
                title: `Change to "${suggestion}"`,
                safe: false,
                ops: [{ op: 'set', path: [...path, 'metadata', 'name'], value: suggestion }],
              }
            : undefined;
        })(),
      });
    }

    const first = seen.get(name);
    if (first !== undefined) {
      ctx.report({
        ruleId: 'statefulset/duplicate-claim-template',
        severity: 'error',
        path: [...path, 'metadata', 'name'],
        message: `Volume claim template "${name}" is already declared by entry ${first + 1}.`,
        explanation:
          'Both would generate a Pod volume of the same name, and two volumes cannot share a name within one Pod.',
        docsUrl: STATEFULSET_DOCS,
      });
    } else {
      seen.set(name, index);
    }

    if (declaredVolumes.has(name)) {
      ctx.report({
        ruleId: 'statefulset/claim-template-shadows-volume',
        severity: 'warning',
        path: [...path, 'metadata', 'name'],
        message: `Volume claim template "${name}" has the same name as a volume in the pod template.`,
        explanation: `The controller adds its claim templates first and skips any volume of ${ctx.field('volumes')} whose name it has already used, so the volume declared there is silently dropped and every Pod gets the persistent volume claim instead. Rename one of the two so the intent is unambiguous.`,
        docsUrl: STATEFULSET_DOCS,
      });
    }
  });
}
