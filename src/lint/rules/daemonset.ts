import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  type Rule,
  type RuleContext,
} from './context.js';
import { checkKeyedMap } from './metadata.js';
import { checkRequirement } from './selector.js';

const DAEMONSET_DOCS = 'https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/';
const SELECTOR_DOCS =
  'https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/#label-selectors';

/**
 * The checks the apiserver runs on a DaemonSet beyond the pod template, from
 * ValidateDaemonSetSpec / ValidateDaemonSetUpdateStrategy in pkg/apis/apps.
 *
 * Missing `selector` and `template` are already reported by layer 1 — they are
 * `required` on DaemonSetSpec — so nothing here re-reports them. Neither is
 * `replicas`, the mistake a DaemonSet invites most: a DaemonSet's Pod count is
 * the number of matching nodes, so there is no such field and the schema layer
 * reports it as unknown.
 */
export const daemonSetRule: Rule = {
  id: 'daemonset/spec',
  run(ctx: RuleContext) {
    const spec = asObject(ctx.doc['spec']);
    if (!spec) return;

    checkSelector(ctx, spec);
    checkTemplate(ctx, spec);
    checkCounters(ctx, spec);
    checkUpdateStrategy(ctx, spec);
    checkReadOnlyPersistentDisks(ctx);
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
      ruleId: 'daemonset/empty-selector',
      severity: 'error',
      path: ['spec', 'selector'],
      message: 'A DaemonSet selector must not be empty.',
      explanation:
        'An empty selector matches every Pod in the namespace, so the apiserver rejects it with "empty selector is invalid for daemonset" rather than let one DaemonSet adopt unrelated Pods.',
      docsUrl: DAEMONSET_DOCS,
    });
    return;
  }

  checkKeyedMap(ctx, selector['matchLabels'], ['spec', 'selector', 'matchLabels'], 'label', true);

  matchExpressions?.forEach((entry, index) => {
    checkRequirement(ctx, asObject(entry), ['spec', 'selector', 'matchExpressions', index], {
      allowNumeric: false,
      idPrefix: 'daemonset',
      docsUrl: SELECTOR_DOCS,
    });
  });

  const templateLabels =
    asObject(asObject(asObject(spec['template'])?.['metadata'])?.['labels']) ?? {};
  checkSelectorMatchesTemplate(ctx, templateLabels, matchLabels, matchExpressions);
}

/**
 * The template's labels must satisfy the selector, or the DaemonSet would
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
    'A DaemonSet only manages Pods its selector matches. When the template disagrees with the selector the apiserver rejects the object with "`selector` does not match template `labels`".';

  for (const [key, value] of Object.entries(matchLabels ?? {})) {
    if (typeof value !== 'string') continue;
    const actual = labels[key];
    if (actual === value) continue;

    ctx.report({
      ruleId: 'daemonset/selector-mismatch',
      severity: 'error',
      path: actual === undefined ? labelsPath : [...labelsPath, key],
      message:
        actual === undefined
          ? `The selector requires label "${key}: ${value}", which the pod template does not set.`
          : `The selector requires label "${key}: ${value}", but the pod template sets "${String(actual)}".`,
      explanation,
      docsUrl: DAEMONSET_DOCS,
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
      ruleId: 'daemonset/selector-mismatch',
      severity: 'error',
      path: ['spec', 'selector', 'matchExpressions', index],
      message: `The pod template's labels do not satisfy "${key} ${operator}${values.length > 0 ? ` [${values.join(', ')}]` : ''}".`,
      explanation,
      docsUrl: DAEMONSET_DOCS,
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
      ruleId: 'daemonset/template-restart-policy',
      severity: 'error',
      path: ctx.at('restartPolicy'),
      message: `A DaemonSet's pod template must use restartPolicy: Always, not "${restartPolicy}".`,
      explanation:
        'A DaemonSet keeps one running Pod on every matching node, so a template that lets its Pods finish would fight the controller. "Always" is the only value the apiserver accepts here; use a Job for run-to-completion work.',
      docsUrl: DAEMONSET_DOCS,
      fix: {
        title: 'Change to Always',
        safe: true,
        ops: [{ op: 'set', path: ctx.at('restartPolicy'), value: 'Always' }],
      },
    });
  }

  if (podSpec['activeDeadlineSeconds'] !== undefined) {
    ctx.report({
      ruleId: 'daemonset/template-active-deadline',
      severity: 'error',
      path: ctx.at('activeDeadlineSeconds'),
      message: 'activeDeadlineSeconds is not allowed in a DaemonSet pod template.',
      explanation:
        'It caps how long a Pod may run before being marked failed, which contradicts a controller whose job is to keep Pods running indefinitely. The apiserver rejects it with "activeDeadlineSeconds in DaemonSet is not Supported".',
      docsUrl: DAEMONSET_DOCS,
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
      ruleId: 'daemonset/template-ephemeral-containers',
      severity: 'error',
      path: ctx.at('ephemeralContainers'),
      message: 'ephemeralContainers are not allowed in a pod template.',
      explanation:
        'Ephemeral containers are added to a running Pod through its "ephemeralcontainers" subresource for debugging. They cannot be declared up front, so the apiserver rejects them in a template.',
      docsUrl: 'https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/',
    });
  }
}

/* Numeric fields */

function checkCounters(ctx: RuleContext, spec: Record<string, unknown>): void {
  const nonNegative = [
    [
      'minReadySeconds',
      'daemonset/negative-min-ready-seconds',
      'how long a new Pod must stay ready before it counts as available',
    ],
    [
      'revisionHistoryLimit',
      'daemonset/negative-revision-history-limit',
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
      docsUrl: DAEMONSET_DOCS,
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

  // Unlike a Deployment or a StatefulSet, a DaemonSet does not have the
  // apiserver reject this combination — the validator stops looking at the
  // strategy once the type is OnDelete, and so does everything below: nothing
  // inside a block the controller ignores can be rejected on its own.
  if (type === 'OnDelete') {
    if (strategy['rollingUpdate'] === undefined) return;
    ctx.report({
      ruleId: 'daemonset/rolling-update-with-on-delete',
      severity: 'warning',
      path: ['spec', 'updateStrategy', 'rollingUpdate'],
      anchor: 'key',
      message: 'rollingUpdate has no effect when updateStrategy type is "OnDelete".',
      explanation:
        '"OnDelete" leaves the controller out of it entirely: Pods are replaced with the new template only as you delete them by hand, so there is no automated rollout for maxUnavailable and maxSurge to describe. The apiserver accepts the object and ignores this block, which is why a stale "OnDelete" over a rollout you meant to keep is easy to miss.',
      docsUrl: DAEMONSET_DOCS,
      fix: {
        title: 'Remove rollingUpdate',
        safe: false,
        ops: [{ op: 'delete', path: ['spec', 'updateStrategy', 'rollingUpdate'] }],
      },
    });
    return;
  }

  if (!rollingUpdate) return;

  const basePath = ['spec', 'updateStrategy', 'rollingUpdate'];
  const maxUnavailable = parseIntOrPercent(rollingUpdate['maxUnavailable']);
  const maxSurge = parseIntOrPercent(rollingUpdate['maxSurge']);

  for (const [field, parsed] of [
    ['maxUnavailable', maxUnavailable],
    ['maxSurge', maxSurge],
  ] as const) {
    if (rollingUpdate[field] === undefined) continue;
    if (parsed === undefined) {
      ctx.report({
        ruleId: 'daemonset/invalid-percent',
        severity: 'error',
        path: [...basePath, field],
        message: `${field} must be a non-negative count or a percentage such as "25%".`,
        explanation:
          'The field is an IntOrString: a bare integer counts nodes, a quoted string ending in "%" is read relative to the number of nodes the DaemonSet should be running on.',
        docsUrl: DAEMONSET_DOCS,
      });
      continue;
    }
    if (parsed.value < 0) {
      ctx.report({
        ruleId: 'daemonset/invalid-percent',
        severity: 'error',
        path: [...basePath, field],
        message: `${field} must not be negative, but is ${parsed.percent ? `${parsed.value}%` : parsed.value}.`,
        explanation:
          'It caps how far the rollout may deviate from one Pod per matching node.',
        docsUrl: DAEMONSET_DOCS,
      });
    } else if (parsed.percent && parsed.value > 100) {
      ctx.report({
        ruleId: 'daemonset/percent-over-100',
        severity: 'error',
        path: [...basePath, field],
        message: `${field} must not exceed 100%, but is ${parsed.value}%.`,
        explanation:
          'It is a fraction of the nodes the DaemonSet runs on, so more than all of them is meaningless.',
        docsUrl: DAEMONSET_DOCS,
      });
    }
  }

  // With neither field set the API fills in maxUnavailable: 1, maxSurge: 0, so
  // an empty rollingUpdate block is not the "both zero" case below.
  if (rollingUpdate['maxUnavailable'] === undefined && rollingUpdate['maxSurge'] === undefined) {
    return;
  }
  if (maxUnavailable === undefined || maxSurge === undefined) return;

  // The two are alternatives, not a range: a DaemonSet either takes the old Pod
  // down first or brings a second one up alongside it.
  if (maxUnavailable.value === 0 && maxSurge.value === 0) {
    ctx.report({
      ruleId: 'daemonset/max-unavailable-and-surge-zero',
      severity: 'error',
      path: [...basePath, 'maxUnavailable'],
      message: 'maxUnavailable and maxSurge cannot both be 0.',
      explanation:
        'maxSurge: 0 forbids starting a second Pod on a node and maxUnavailable: 0 forbids stopping the one already there, so the rollout could never take a single step. The apiserver rejects it with "may not be 0 when `maxSurge` is 0".',
      docsUrl: DAEMONSET_DOCS,
    });
  } else if (maxUnavailable.value !== 0 && maxSurge.value !== 0) {
    ctx.report({
      ruleId: 'daemonset/max-surge-with-max-unavailable',
      severity: 'error',
      path: [...basePath, 'maxSurge'],
      message: 'maxSurge cannot be set when maxUnavailable is non-zero.',
      explanation:
        'A DaemonSet updates a node one of two ways: it deletes the old Pod first (maxUnavailable) or it starts the new one alongside it (maxSurge). The apiserver only accepts one of them at a time, rejecting the pair with "may not be set when `maxUnavailable` is non-zero"; set the other to 0 to pick a mode.',
      docsUrl: DAEMONSET_DOCS,
      fix: {
        title: 'Set maxUnavailable to 0',
        safe: false,
        ops: [{ op: 'set', path: [...basePath, 'maxUnavailable'], value: 0 }],
      },
    });
  }
}

/**
 * An IntOrString as the apiserver reads it: a number, or a string that is
 * either a bare integer or an integer followed by "%".
 */
function parseIntOrPercent(value: unknown): { value: number; percent: boolean } | undefined {
  // Both fields are optional pointers that convert to a plain zero before
  // validation sees them, so an unset one really does compare as 0.
  if (value === undefined) return { value: 0, percent: false };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { value, percent: false } : undefined;
  }
  if (typeof value !== 'string') return undefined;

  const percent = value.endsWith('%');
  const digits = percent ? value.slice(0, -1) : value;
  if (!/^-?\d+$/.test(digits)) return undefined;
  return { value: Number(digits), percent };
}

/* Volumes */

/**
 * A DaemonSet runs a Pod on every matching node, which is what makes a
 * read-write GCE persistent disk impossible: the disk can only be attached to
 * more than one node read-only, so every Pod but the first would be stuck
 * waiting for it. ValidateReadOnlyPersistentDisks is the DaemonSet's own check
 * for this — no other workload kind here runs it.
 */
function checkReadOnlyPersistentDisks(ctx: RuleContext): void {
  const volumes = asArray(ctx.spec['volumes']);
  if (!volumes) return;

  volumes.forEach((entry, index) => {
    const volume = asObject(entry);
    const disk = asObject(volume?.['gcePersistentDisk']);
    if (!disk || asBoolean(disk['readOnly']) === true) return;

    const readOnlyPath = ctx.at('volumes', index, 'gcePersistentDisk', 'readOnly');
    // gcePersistentDisk is deprecated and on its way out of the API.
    if (!ctx.supports(readOnlyPath)) return;

    const declared = disk['readOnly'] !== undefined;
    const name = asString(volume?.['name']);
    ctx.report({
      ruleId: 'daemonset/read-write-persistent-disk',
      severity: 'error',
      // Without the field there is nothing to underline but the volume source.
      path: declared ? readOnlyPath : ctx.at('volumes', index, 'gcePersistentDisk'),
      ...(declared ? {} : { anchor: 'key' as const }),
      message: `Volume ${name ? `"${name}"` : `#${index + 1}`} mounts a GCE persistent disk read-write, which a DaemonSet cannot do.`,
      explanation:
        'A GCE persistent disk can only be attached to more than one node read-only, and a DaemonSet places a Pod on every matching node, so the apiserver requires readOnly: true here — it rejects the object with "GCE PD can only be mounted on multiple machines". For per-node writable storage use a hostPath or a local volume instead.',
      docsUrl: DAEMONSET_DOCS,
      fix: {
        title: 'Set readOnly: true',
        safe: false,
        ops: [{ op: 'set', path: readOnlyPath, value: true }],
      },
    });
  });
}
