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

const DEPLOYMENT_DOCS = 'https://kubernetes.io/docs/concepts/workloads/controllers/deployment/';
const SELECTOR_DOCS =
  'https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/#label-selectors';

/**
 * The checks the apiserver runs on a Deployment beyond the pod template, from
 * ValidateDeploymentSpec / ValidateDeploymentStrategy in pkg/apis/apps.
 *
 * Missing `selector` and `template` are already reported by layer 1 — they are
 * `required` on DeploymentSpec — so nothing here re-reports them.
 */
export const deploymentRule: Rule = {
  id: 'deployment/spec',
  run(ctx: RuleContext) {
    const spec = asObject(ctx.doc['spec']);
    if (!spec) return;

    checkSelector(ctx, spec);
    checkTemplate(ctx, spec);
    checkCounters(ctx, spec);
    checkStrategy(ctx, spec);
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
      ruleId: 'deployment/empty-selector',
      severity: 'error',
      path: ['spec', 'selector'],
      message: 'A Deployment selector must not be empty.',
      explanation:
        'An empty selector matches every Pod in the namespace, so the apiserver rejects it outright rather than let one Deployment adopt unrelated Pods.',
      docsUrl: DEPLOYMENT_DOCS,
    });
    return;
  }

  checkKeyedMap(ctx, selector['matchLabels'], ['spec', 'selector', 'matchLabels'], 'label', true);

  matchExpressions?.forEach((entry, index) => {
    checkRequirement(ctx, asObject(entry), ['spec', 'selector', 'matchExpressions', index], {
      allowNumeric: false,
      idPrefix: 'deployment',
      docsUrl: SELECTOR_DOCS,
    });
  });

  const templateLabels =
    asObject(asObject(asObject(spec['template'])?.['metadata'])?.['labels']) ?? {};
  checkSelectorMatchesTemplate(ctx, templateLabels, matchLabels, matchExpressions);
}

/**
 * The template's labels must satisfy the selector, or the Deployment would
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

  for (const [key, value] of Object.entries(matchLabels ?? {})) {
    if (typeof value !== 'string') continue;
    const actual = labels[key];
    if (actual === value) continue;

    ctx.report({
      ruleId: 'deployment/selector-mismatch',
      severity: 'error',
      path: actual === undefined ? labelsPath : [...labelsPath, key],
      message:
        actual === undefined
          ? `The selector requires label "${key}: ${value}", which the pod template does not set.`
          : `The selector requires label "${key}: ${value}", but the pod template sets "${String(actual)}".`,
      explanation:
        'A Deployment only manages Pods its selector matches. When the template disagrees with the selector the apiserver rejects the object with "`selector` does not match template `labels`".',
      docsUrl: DEPLOYMENT_DOCS,
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
      ruleId: 'deployment/selector-mismatch',
      severity: 'error',
      path: ['spec', 'selector', 'matchExpressions', index],
      message: `The pod template's labels do not satisfy "${key} ${operator}${values.length > 0 ? ` [${values.join(', ')}]` : ''}".`,
      explanation:
        'A Deployment only manages Pods its selector matches. When the template disagrees with the selector the apiserver rejects the object with "`selector` does not match template `labels`".',
      docsUrl: DEPLOYMENT_DOCS,
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
      ruleId: 'deployment/template-restart-policy',
      severity: 'error',
      path: ctx.at('restartPolicy'),
      message: `A Deployment's pod template must use restartPolicy: Always, not "${restartPolicy}".`,
      explanation:
        'A Deployment keeps a fixed number of Pods running, so a template that lets its Pods finish would fight the controller. "Always" is the only value the apiserver accepts here; use a Job for run-to-completion work.',
      docsUrl: DEPLOYMENT_DOCS,
      fix: {
        title: 'Change to Always',
        safe: true,
        ops: [{ op: 'set', path: ctx.at('restartPolicy'), value: 'Always' }],
      },
    });
  }

  if (podSpec['activeDeadlineSeconds'] !== undefined) {
    ctx.report({
      ruleId: 'deployment/template-active-deadline',
      severity: 'error',
      path: ctx.at('activeDeadlineSeconds'),
      message: 'activeDeadlineSeconds is not allowed in a Deployment pod template.',
      explanation:
        'It caps how long a Pod may run before being marked failed, which contradicts a controller whose job is to keep Pods running indefinitely.',
      docsUrl: DEPLOYMENT_DOCS,
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
      ruleId: 'deployment/template-ephemeral-containers',
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
    ['replicas', 'deployment/negative-replicas', 'the number of Pods the controller keeps running'],
    [
      'minReadySeconds',
      'deployment/negative-min-ready-seconds',
      'how long a new Pod must stay ready before it counts as available',
    ],
    [
      'revisionHistoryLimit',
      'deployment/negative-revision-history-limit',
      'how many old ReplicaSets are kept for rollback',
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
      docsUrl: DEPLOYMENT_DOCS,
    });
  }

  const progressDeadline = asNumber(spec['progressDeadlineSeconds']);
  if (progressDeadline === undefined) return;

  const minReady = asNumber(spec['minReadySeconds']) ?? 0;
  if (progressDeadline < 0) {
    ctx.report({
      ruleId: 'deployment/invalid-progress-deadline',
      severity: 'error',
      path: ['spec', 'progressDeadlineSeconds'],
      message: `progressDeadlineSeconds must not be negative, but is ${progressDeadline}.`,
      explanation:
        'It is how long a rollout may make no progress before the controller marks it failed.',
      docsUrl: DEPLOYMENT_DOCS,
    });
  } else if (progressDeadline <= minReady) {
    ctx.report({
      ruleId: 'deployment/invalid-progress-deadline',
      severity: 'error',
      path: ['spec', 'progressDeadlineSeconds'],
      message: `progressDeadlineSeconds (${progressDeadline}) must be greater than minReadySeconds (${minReady}).`,
      explanation:
        'A new Pod is not counted as available until it has been ready for minReadySeconds, so a deadline at or below that would expire before the rollout could ever report progress.',
      docsUrl: DEPLOYMENT_DOCS,
    });
  }
}

/* Strategy */

function checkStrategy(ctx: RuleContext, spec: Record<string, unknown>): void {
  const strategy = asObject(spec['strategy']);
  if (!strategy) return;

  // The type itself is in the enum table; only the combination is checked here.
  const type = asString(strategy['type']);
  const rollingUpdate = asObject(strategy['rollingUpdate']);

  if (type === 'Recreate' && strategy['rollingUpdate'] !== undefined) {
    ctx.report({
      ruleId: 'deployment/rolling-update-with-recreate',
      severity: 'error',
      path: ['spec', 'strategy', 'rollingUpdate'],
      anchor: 'key',
      message: 'rollingUpdate cannot be set when strategy type is "Recreate".',
      explanation:
        '"Recreate" deletes every existing Pod before creating new ones, so there is no rolling window for maxSurge and maxUnavailable to describe.',
      docsUrl: DEPLOYMENT_DOCS,
      fix: {
        title: 'Remove rollingUpdate',
        safe: true,
        ops: [{ op: 'delete', path: ['spec', 'strategy', 'rollingUpdate'] }],
      },
    });
  }

  if (!rollingUpdate) return;

  const basePath = ['spec', 'strategy', 'rollingUpdate'];
  const maxUnavailable = parseIntOrPercent(rollingUpdate['maxUnavailable']);
  const maxSurge = parseIntOrPercent(rollingUpdate['maxSurge']);

  for (const [field, parsed] of [
    ['maxUnavailable', maxUnavailable],
    ['maxSurge', maxSurge],
  ] as const) {
    if (rollingUpdate[field] === undefined) continue;
    if (parsed === undefined) {
      ctx.report({
        ruleId: 'deployment/invalid-percent',
        severity: 'error',
        path: [...basePath, field],
        message: `${field} must be a non-negative count or a percentage such as "25%".`,
        explanation:
          'The field is an IntOrString: a bare integer counts Pods, a quoted string ending in "%" is read relative to the desired replica count.',
        docsUrl: DEPLOYMENT_DOCS,
      });
      continue;
    }
    if (parsed.value < 0) {
      ctx.report({
        ruleId: 'deployment/invalid-percent',
        severity: 'error',
        path: [...basePath, field],
        message: `${field} must not be negative, but is ${parsed.percent ? `${parsed.value}%` : parsed.value}.`,
        explanation: 'It caps how far the rollout may deviate from the desired replica count.',
        docsUrl: DEPLOYMENT_DOCS,
      });
    }
  }

  if (maxUnavailable?.percent && maxUnavailable.value > 100) {
    ctx.report({
      ruleId: 'deployment/percent-over-100',
      severity: 'error',
      path: [...basePath, 'maxUnavailable'],
      message: `maxUnavailable must not exceed 100%, but is ${maxUnavailable.value}%.`,
      explanation: 'It is a fraction of the desired replica count, so more than all of them is meaningless.',
      docsUrl: DEPLOYMENT_DOCS,
    });
  }

  // Both at zero means the rollout can neither add a Pod nor take one away.
  if (maxUnavailable?.value === 0 && maxSurge?.value === 0) {
    ctx.report({
      ruleId: 'deployment/max-unavailable-and-surge-zero',
      severity: 'error',
      path: [...basePath, 'maxUnavailable'],
      message: 'maxUnavailable and maxSurge cannot both be 0.',
      explanation:
        'maxSurge: 0 forbids creating a Pod above the desired count and maxUnavailable: 0 forbids removing one below it, so the rollout could never take a single step.',
      docsUrl: DEPLOYMENT_DOCS,
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
