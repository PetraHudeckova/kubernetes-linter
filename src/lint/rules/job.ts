import {
  isDNS1123Label,
  isDNS1123Subdomain,
  isDomainPrefixedPath,
  isQualifiedName,
} from '../../k8s/names.js';
import { didYouMean } from '../suggest.js';
import type { Path } from '../types.js';
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

const JOB_DOCS = 'https://kubernetes.io/docs/concepts/workloads/controllers/job/';
const SELECTOR_DOCS =
  'https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/#label-selectors';
const INDEXED_DOCS =
  'https://kubernetes.io/docs/tasks/job/indexed-parallel-processing-static/';
const FAILURE_POLICY_DOCS = 'https://kubernetes.io/docs/tasks/job/pod-failure-policy/';
const SUCCESS_POLICY_DOCS =
  'https://kubernetes.io/docs/concepts/workloads/controllers/job/#success-policy';

const INDEXED = 'Indexed';
const NON_INDEXED = 'NonIndexed';

/** maxManagedByLength, from pkg/apis/batch/validation. */
const MANAGED_BY_MAX = 63;

/**
 * The checks the apiserver runs on a Job, from ValidateJob / validateJobSpec in
 * pkg/apis/batch/validation.
 *
 * A Job is the first kind here whose pod template must *not* restart forever,
 * which turns the PodSpec default inside out: `restartPolicy` defaults to
 * "Always" and a Job rejects that value, so omitting the field is an error
 * rather than the usual shorthand. Most of the rest turns on `completionMode`,
 * resolved once the way `service.ts` resolves `spec.type` — defaulting to
 * "NonIndexed", and left `undefined` when the value is not one the API knows,
 * since the enum rule has already reported that and a mode that means nothing
 * says nothing about the fields that depend on it.
 *
 * Deliberately not checked are the size caps that only exist to bound how long
 * `.status` can grow — at most 20 policy rules, 255 exit codes, 20 pod
 * conditions, 100000 completions or parallelism. They are rejections, but no
 * hand-written manifest comes near them, and each would cost a rule that never
 * fires. `maxFailedIndexes` against `completions` is kept, since that pair is a
 * contradiction rather than a limit.
 */
export const jobRule: Rule = {
  id: 'job/spec',
  run(ctx: RuleContext) {
    const spec = asObject(ctx.doc['spec']);
    if (!spec) return;

    // A hand-written Job carries its own selector; the checks that concern it
    // are Job-only, since a CronJob's jobTemplate may not have one at all
    // (cronjob.ts reports that directly).
    checkSelector(ctx, spec);
    const mode = checkJobSpec(ctx, spec, ['spec']);

    // The hostname a completion's Pod gets depends on *this* object's name,
    // which is only meaningful for a Job — a CronJob's Job name is generated
    // by its controller, not written in the manifest, so there is nothing to
    // check up front there.
    if (mode === INDEXED) checkIndexedPodHostname(ctx, asNumber(spec['completions']));
  },
};

/**
 * The checks `validateJobSpec` runs on a JobSpec, wherever one is embedded —
 * at a Job's own `spec`, or nested under a CronJob's `spec.jobTemplate.spec`.
 * Upstream calls the same function in both places, so this does too, rather
 * than duplicating ~500 lines under `cronjob/*` rule IDs: every finding here
 * keeps its `job/*` id and fires at `base`, exactly as the shared PodSpec
 * rules keep their `pod/*` ids wherever the PodSpec itself lives.
 *
 * `checkSelector` and `checkIndexedPodHostname` are deliberately not part of
 * this: both are in `ValidateJob` upstream, not `validateJobSpec`, and both
 * read the *object's* name/selector rather than anything inside the JobSpec —
 * meaningless for a CronJob's generated Job. Returns the effective completion
 * mode, since the Job-only hostname check above needs it too.
 */
export function checkJobSpec(
  ctx: RuleContext,
  spec: Record<string, unknown>,
  base: Path,
): string | undefined {
  const mode = completionMode(spec);

  checkTemplate(ctx, spec);
  checkCounters(ctx, spec, base);
  checkCompletionMode(ctx, spec, mode, base);
  checkPodFailurePolicy(ctx, spec, base);
  checkPodReplacementPolicy(ctx, spec, base);
  checkSuccessPolicy(ctx, spec, mode, base);
  checkManagedBy(ctx, spec, base);

  return mode;
}

/**
 * The mode the controller will actually use, or `undefined` when the manifest
 * names one the API does not know.
 */
function completionMode(spec: Record<string, unknown>): string | undefined {
  if (spec['completionMode'] === undefined) return NON_INDEXED;
  const declared = asString(spec['completionMode']);
  return declared === INDEXED || declared === NON_INDEXED ? declared : undefined;
}

/* Selector */

function checkSelector(ctx: RuleContext, spec: Record<string, unknown>): void {
  const selector = asObject(spec['selector']);
  if (!selector) return;

  // Unlike every other controller here, a Job's selector is not the user's to
  // write: the apiserver generates one from the Job's UID before validating.
  if (asBoolean(spec['manualSelector']) !== true) {
    ctx.report({
      ruleId: 'job/generated-selector',
      severity: 'error',
      path: ['spec', 'selector'],
      anchor: 'key',
      message: 'A Job\'s selector is generated by the apiserver, so writing one needs manualSelector: true.',
      explanation:
        'The generated selector matches on the Job\'s UID, a value no manifest can know in advance, and the apiserver rejects anything else with "`selector` not auto-generated". Leaving the selector out is almost always what you want; manualSelector exists only for adopting Pods that something else created, and two Jobs whose manual selectors overlap will fight over the same Pods.',
      docsUrl: JOB_DOCS,
      fix: {
        title: 'Remove the selector',
        safe: false,
        ops: [{ op: 'delete', path: ['spec', 'selector'] }],
      },
    });
  }

  checkKeyedMap(ctx, selector['matchLabels'], ['spec', 'selector', 'matchLabels'], 'label', true);

  const matchExpressions = asArray(selector['matchExpressions']);
  matchExpressions?.forEach((entry, index) => {
    checkRequirement(ctx, asObject(entry), ['spec', 'selector', 'matchExpressions', index], {
      allowNumeric: false,
      idPrefix: 'job',
      docsUrl: SELECTOR_DOCS,
    });
  });

  const templateLabels =
    asObject(asObject(asObject(spec['template'])?.['metadata'])?.['labels']) ?? {};
  checkSelectorMatchesTemplate(
    ctx,
    templateLabels,
    asObject(selector['matchLabels']),
    matchExpressions,
  );
}

/**
 * Whether the selector was generated or written by hand, it has to match the
 * Pods the Job will produce. Only matchLabels and the two set-based operators
 * are decided here; anything the selector expresses that we cannot evaluate is
 * left alone rather than guessed at.
 */
function checkSelectorMatchesTemplate(
  ctx: RuleContext,
  labels: Record<string, unknown>,
  matchLabels: Record<string, unknown> | undefined,
  matchExpressions: unknown[] | undefined,
): void {
  const labelsPath = ctx.meta('labels');
  const explanation =
    'A Job only counts Pods its selector matches. When the template disagrees with the selector the apiserver rejects the object with "`selector` does not match template `labels`".';

  for (const [key, value] of Object.entries(matchLabels ?? {})) {
    if (typeof value !== 'string') continue;
    const actual = labels[key];
    if (actual === value) continue;

    ctx.report({
      ruleId: 'job/selector-mismatch',
      severity: 'error',
      path: actual === undefined ? labelsPath : [...labelsPath, key],
      message:
        actual === undefined
          ? `The selector requires label "${key}: ${value}", which the pod template does not set.`
          : `The selector requires label "${key}: ${value}", but the pod template sets "${String(actual)}".`,
      explanation,
      docsUrl: JOB_DOCS,
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
      ruleId: 'job/selector-mismatch',
      severity: 'error',
      path: ['spec', 'selector', 'matchExpressions', index],
      message: `The pod template's labels do not satisfy "${key} ${operator}${values.length > 0 ? ` [${values.join(', ')}]` : ''}".`,
      explanation,
      docsUrl: JOB_DOCS,
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

  if (asObject(template['spec'])) checkRestartPolicy(ctx, spec);

  const ephemeral = asArray(ctx.spec['ephemeralContainers']);
  if (ephemeral && ephemeral.length > 0) {
    ctx.report({
      ruleId: 'job/template-ephemeral-containers',
      severity: 'error',
      path: ctx.at('ephemeralContainers'),
      message: 'ephemeralContainers are not allowed in a pod template.',
      explanation:
        'Ephemeral containers are added to a running Pod through its "ephemeralcontainers" subresource for debugging. They cannot be declared up front, so the apiserver rejects them in a template.',
      docsUrl: 'https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/',
    });
  }
}

/**
 * The one place a Job inverts a PodSpec default. `restartPolicy` defaults to
 * "Always" and a Job accepts only "OnFailure" or "Never", so the apiserver
 * rejects an absent field exactly as it rejects an explicit "Always" — the
 * default is filled in before validation runs.
 */
function checkRestartPolicy(ctx: RuleContext, spec: Record<string, unknown>): void {
  const declared = ctx.spec['restartPolicy'];
  const restartPolicy = asString(declared);

  const toNever = {
    title: 'Set restartPolicy: Never',
    // Which of the two is right is the Job's business: "Never" replaces a
    // failed Pod, "OnFailure" restarts the container inside the one that is
    // already there.
    safe: false,
    ops: [{ op: 'set' as const, path: ctx.at('restartPolicy'), value: 'Never' }],
  };

  // A key written with no value decodes to the empty string, which the
  // apiserver defaults to "Always" exactly as it defaults an absent one.
  if (declared == null) {
    const present = 'restartPolicy' in ctx.spec;
    ctx.report({
      ruleId: 'job/template-restart-policy',
      severity: 'error',
      path: present ? ctx.at('restartPolicy') : ctx.at(),
      ...(present ? {} : { anchor: 'key' as const }),
      message: 'A Job\'s pod template must set restartPolicy to "OnFailure" or "Never".',
      explanation:
        'restartPolicy defaults to "Always", and a Pod that always restarts never finishes — so a Job cannot use it. The apiserver applies the default before it validates, which is why leaving the field out is rejected in the same words as writing "Always".',
      docsUrl: JOB_DOCS,
      fix: toNever,
    });
    return;
  }

  if (restartPolicy === 'Always') {
    ctx.report({
      ruleId: 'job/template-restart-policy',
      severity: 'error',
      path: ctx.at('restartPolicy'),
      message: 'A Job\'s pod template must use restartPolicy "OnFailure" or "Never", not "Always".',
      explanation:
        'A Job runs its Pods to completion and decides itself whether a failed one is retried, so a Pod the kubelet keeps restarting would never let the Job finish. Use a Deployment for work that is meant to run indefinitely.',
      docsUrl: JOB_DOCS,
      fix: toNever,
    });
    return;
  }

  // Any other value is not a restart policy at all, and the enum table has
  // already said so.
  if (restartPolicy !== 'OnFailure') return;
  if (spec['podFailurePolicy'] === undefined) return;

  ctx.report({
    ruleId: 'job/restart-policy-with-pod-failure-policy',
    severity: 'error',
    path: ctx.at('restartPolicy'),
    message: 'restartPolicy must be "Never" when a podFailurePolicy is set, not "OnFailure".',
    explanation:
      'A pod failure policy matches on how a Pod failed, and "OnFailure" restarts the container inside the Pod instead of letting the Pod fail — so the failure the policy is written for never reaches it. The apiserver rejects the pair with "only \'Never\' is supported when podFailurePolicy is specified".',
    docsUrl: FAILURE_POLICY_DOCS,
    fix: {
      title: 'Change to Never',
      safe: false,
      ops: [{ op: 'set', path: ctx.at('restartPolicy'), value: 'Never' }],
    },
  });
}

/* Numeric fields */

function checkCounters(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const nonNegative = [
    ['parallelism', 'job/negative-parallelism', 'how many Pods may run at the same time'],
    [
      'completions',
      'job/negative-completions',
      'how many Pods must succeed before the Job is complete',
    ],
    [
      'backoffLimit',
      'job/negative-backoff-limit',
      'how many times a failed Pod is retried before the whole Job is marked failed',
    ],
    [
      'activeDeadlineSeconds',
      'job/negative-active-deadline',
      'how long the Job may run before its Pods are terminated and it is marked failed',
    ],
    [
      'ttlSecondsAfterFinished',
      'job/negative-ttl',
      'how long a finished Job is kept before it is cleaned up',
    ],
    [
      'backoffLimitPerIndex',
      'job/negative-backoff-limit-per-index',
      'how many times a single index is retried before it counts as failed',
    ],
    [
      'maxFailedIndexes',
      'job/negative-max-failed-indexes',
      'how many indexes may fail before the Job is marked failed',
    ],
  ] as const;

  for (const [field, ruleId, meaning] of nonNegative) {
    // The last two arrived in 1.28; on an older target the schema layer has
    // already reported them as unknown.
    if (!ctx.supports([...base, field])) continue;
    const value = asNumber(spec[field]);
    if (value === undefined || value >= 0) continue;
    ctx.report({
      ruleId,
      severity: 'error',
      path: [...base, field],
      message: `${field} must not be negative, but is ${value}.`,
      explanation: `It is ${meaning}.`,
      docsUrl: JOB_DOCS,
    });
  }
}

/* Completion mode */

/**
 * An Indexed Job gives each Pod a fixed index in [0, completions), which is
 * what the per-index fields address and what a Pod's hostname is built from.
 * Everything here is a consequence of that: without a completion count there
 * are no indexes to hand out, and without indexes the per-index fields have
 * nothing to apply to.
 */
function checkCompletionMode(
  ctx: RuleContext,
  spec: Record<string, unknown>,
  mode: string | undefined,
  base: Path,
): void {
  if (mode === undefined) return;

  const completions = asNumber(spec['completions']);
  const maxFailedIndexes = asNumber(spec['maxFailedIndexes']);

  if (mode === INDEXED) {
    if (spec['completions'] === undefined) {
      ctx.report({
        ruleId: 'job/indexed-without-completions',
        severity: 'error',
        path: base,
        anchor: 'key',
        message: 'An Indexed Job must say how many completions it has.',
        explanation:
          'The indexes an Indexed Job hands out run from 0 to completions - 1, so without completions there is no index range to assign. A Job that leaves it out is the "run one Pod until it succeeds" case, which is what NonIndexed already means.',
        docsUrl: INDEXED_DOCS,
      });
    }

    if (completions !== undefined && maxFailedIndexes !== undefined && maxFailedIndexes > completions) {
      ctx.report({
        ruleId: 'job/max-failed-indexes-over-completions',
        severity: 'error',
        path: [...base, 'maxFailedIndexes'],
        message: `maxFailedIndexes (${maxFailedIndexes}) must not exceed completions (${completions}).`,
        explanation:
          'There are only as many indexes as there are completions, so a threshold above that count could never be reached and the Job would run to the end of its backoff budget instead.',
        docsUrl: INDEXED_DOCS,
      });
    }
  } else {
    for (const field of ['backoffLimitPerIndex', 'maxFailedIndexes'] as const) {
      if (spec[field] === undefined || !ctx.supports([...base, field])) continue;
      reportRequiresIndexed(ctx, [...base, field], field, base);
    }
  }

  if (
    maxFailedIndexes !== undefined &&
    spec['backoffLimitPerIndex'] === undefined &&
    ctx.supports([...base, 'maxFailedIndexes']) &&
    ctx.supports([...base, 'backoffLimitPerIndex'])
  ) {
    ctx.report({
      ruleId: 'job/max-failed-indexes-without-backoff-limit-per-index',
      severity: 'error',
      path: [...base, 'maxFailedIndexes'],
      message: 'maxFailedIndexes needs backoffLimitPerIndex beside it.',
      explanation:
        'An index only counts as failed once it has exhausted its own retry budget, and backoffLimitPerIndex is that budget. Without it the Job retries as a whole against backoffLimit and no index ever reaches the state maxFailedIndexes counts.',
      docsUrl: INDEXED_DOCS,
    });
  }
}

/** One report for every field that only means something in Indexed mode. */
function reportRequiresIndexed(ctx: RuleContext, path: Path, field: string, base: Path): void {
  ctx.report({
    ruleId: 'job/requires-indexed-completion',
    severity: 'error',
    path,
    anchor: 'key',
    message: `${field} requires completionMode: Indexed.`,
    explanation:
      'A NonIndexed Job\'s Pods are interchangeable — any completions of them succeeding will do — so there is no index for this field to address. completionMode defaults to "NonIndexed", which is why leaving it out is the same as writing it.',
    docsUrl: INDEXED_DOCS,
    fix: {
      title: 'Set completionMode: Indexed',
      safe: false,
      ops: [{ op: 'set', path: [...base, 'completionMode'], value: INDEXED }],
    },
  });
}

/**
 * An Indexed Job appends "-<index>" to the Job's name to make each Pod's
 * hostname, so a name that is a perfectly good object name on its own can still
 * fail there: a Job name may be a DNS subdomain, but a hostname has to be a DNS
 * label, and the index on the end costs characters. The apiserver checks this up
 * front rather than let the Job fail later, one Pod at a time.
 */
function checkIndexedPodHostname(ctx: RuleContext, completions: number | undefined): void {
  if (completions === undefined || completions <= 0) return;
  const name = asString(asObject(ctx.doc['metadata'])?.['name']);
  // A name that is not even a valid object name is metadata.ts's to report.
  if (name === undefined || !isDNS1123Subdomain(name).ok) return;

  const hostname = `${name}-${completions - 1}`;
  const check = isDNS1123Label(hostname);
  if (check.ok) return;

  ctx.report({
    ruleId: 'job/invalid-indexed-pod-hostname',
    severity: 'error',
    path: ['metadata', 'name'],
    message: `With ${completions} indexed completions the last Pod's hostname would be "${hostname}", which ${check.reason}.`,
    explanation:
      'Every Pod of an Indexed Job is given the hostname "<job>-<index>", which has to be a DNS label: lowercase letters, digits and "-", at most 63 characters. A Job name may be a DNS subdomain and so is allowed to be longer than that, or to carry a dot — which is why this only shows up once the indexes are on the end.',
    docsUrl: INDEXED_DOCS,
  });
}

/* Pod failure policy */

/**
 * A pod failure policy decides, per failed Pod, whether the failure counts
 * against the backoff limit, is ignored, fails the index or fails the whole
 * Job. Each rule matches on exactly one of the two things it can look at: the
 * exit code of a container, or a condition on the Pod.
 */
function checkPodFailurePolicy(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  const policy = asObject(spec['podFailurePolicy']);
  const rules = asArray(policy?.['rules']);
  if (!rules) return;

  // Ephemeral containers are not part of a template, so a policy cannot name
  // one — the list is what a Pod is actually created with.
  const containerNames = new Set(
    ctx.containers
      .filter((entry) => entry.list !== 'ephemeralContainers')
      .map((entry) => asString(entry.container['name']))
      .filter((name): name is string => name !== undefined),
  );

  rules.forEach((entry, index) => {
    const rule = asObject(entry);
    if (!rule) return;
    const path: Path = [...base, 'podFailurePolicy', 'rules', index];

    const hasExitCodes = rule['onExitCodes'] !== undefined;
    const conditions = asArray(rule['onPodConditions']) ?? [];

    if (hasExitCodes && conditions.length > 0) {
      ctx.report({
        ruleId: 'job/pod-failure-policy-rule-target',
        severity: 'error',
        path,
        anchor: 'key',
        message: `Pod failure policy rule #${index + 1} matches on both onExitCodes and onPodConditions.`,
        explanation:
          'A rule looks at one thing: either the exit code a container terminated with, or a condition the Pod carries. Matching on both at once is rejected rather than read as "and" or as "or" — write two rules if you mean two cases.',
        docsUrl: FAILURE_POLICY_DOCS,
      });
    } else if (!hasExitCodes && conditions.length === 0) {
      ctx.report({
        ruleId: 'job/pod-failure-policy-rule-target',
        severity: 'error',
        path,
        anchor: 'key',
        message: `Pod failure policy rule #${index + 1} matches on nothing.`,
        explanation:
          'A rule must say which failures it applies to, through onExitCodes or onPodConditions. Without either it would match every failed Pod, so the apiserver rejects it instead of guessing.',
        docsUrl: FAILURE_POLICY_DOCS,
      });
    }

    if (
      asString(rule['action']) === 'FailIndex' &&
      spec['backoffLimitPerIndex'] === undefined &&
      ctx.supports([...base, 'backoffLimitPerIndex'])
    ) {
      ctx.report({
        ruleId: 'job/fail-index-without-backoff-limit-per-index',
        severity: 'error',
        path: [...path, 'action'],
        message: `Action "FailIndex" requires ${[...base, 'backoffLimitPerIndex'].join('.')}.`,
        explanation:
          'FailIndex marks the failed Pod\'s index as failed without retrying it, which only means something in a Job that tracks failures per index. Setting backoffLimitPerIndex is what turns that tracking on.',
        docsUrl: INDEXED_DOCS,
      });
    }

    checkOnExitCodes(ctx, asObject(rule['onExitCodes']), [...path, 'onExitCodes'], containerNames);
    checkOnPodConditions(ctx, conditions, [...path, 'onPodConditions']);
  });
}

function checkOnExitCodes(
  ctx: RuleContext,
  onExitCodes: Record<string, unknown> | undefined,
  path: Path,
  containerNames: Set<string>,
): void {
  if (!onExitCodes) return;

  const containerName = asString(onExitCodes['containerName']);
  if (containerName !== undefined && !containerNames.has(containerName)) {
    const suggestion = didYouMean(containerName, [...containerNames]);
    ctx.report({
      ruleId: 'job/unknown-exit-code-container',
      severity: 'error',
      path: [...path, 'containerName'],
      message: suggestion
        ? `The pod template has no container named "${containerName}". Did you mean "${suggestion}"?`
        : `The pod template has no container named "${containerName}".`,
      explanation:
        'containerName narrows the rule to one container\'s exit code, so it has to name a container or an init container of this template. Leave it out to match whichever container failed.',
      docsUrl: FAILURE_POLICY_DOCS,
      fix: suggestion
        ? {
            title: `Change to "${suggestion}"`,
            safe: true,
            ops: [{ op: 'set', path: [...path, 'containerName'], value: suggestion }],
          }
        : undefined,
    });
  }

  const values = asArray(onExitCodes['values']);
  if (!values) return;

  const valuesPath = [...path, 'values'];
  if (values.length === 0) {
    ctx.report({
      ruleId: 'job/empty-exit-codes',
      severity: 'error',
      path: valuesPath,
      message: 'onExitCodes must list at least one exit code.',
      explanation:
        'The list is the set the operator compares against, so an empty one describes no failure at all.',
      docsUrl: FAILURE_POLICY_DOCS,
    });
    return;
  }

  const operator = asString(onExitCodes['operator']);
  const seen = new Set<number>();
  let ordered = true;

  values.forEach((entry, index) => {
    const code = asNumber(entry);
    if (code === undefined) return;

    // 0 is what a container exits with when it succeeds, so "In [0]" would ask
    // the policy to match a failure that never happens.
    if (code === 0 && operator === 'In') {
      ctx.report({
        ruleId: 'job/zero-exit-code',
        severity: 'error',
        path: [...valuesPath, index],
        message: 'Exit code 0 cannot be matched with the "In" operator.',
        explanation:
          'A container that exits 0 succeeded, so it never reaches a pod failure policy. Use "NotIn" if you meant "any failure other than these".',
        docsUrl: FAILURE_POLICY_DOCS,
      });
    }

    if (seen.has(code)) {
      ctx.report({
        ruleId: 'job/duplicate-exit-code',
        severity: 'error',
        path: [...valuesPath, index],
        message: `Exit code ${code} is listed twice.`,
        explanation: 'The list is a set, so the apiserver rejects a repeated value.',
        docsUrl: FAILURE_POLICY_DOCS,
      });
    } else {
      seen.add(code);
    }

    const previous = index > 0 ? asNumber(values[index - 1]) : undefined;
    if (previous !== undefined && previous > code) ordered = false;
  });

  if (!ordered) {
    ctx.report({
      ruleId: 'job/unordered-exit-codes',
      severity: 'error',
      path: valuesPath,
      message: 'Exit codes must be listed in increasing order.',
      explanation:
        'The apiserver requires the list to be sorted so that two policies that mean the same thing are written the same way. Reordering the values changes nothing else.',
      docsUrl: FAILURE_POLICY_DOCS,
    });
  }
}

function checkOnPodConditions(ctx: RuleContext, conditions: unknown[], path: Path): void {
  conditions.forEach((entry, index) => {
    const pattern = asObject(entry);
    if (!pattern) return;
    const patternPath = [...path, index];

    const type = asString(pattern['type']);
    if (type !== undefined) {
      const check = isQualifiedName(type);
      if (!check.ok) {
        ctx.report({
          ruleId: 'job/invalid-pod-condition-type',
          severity: 'error',
          path: [...patternPath, 'type'],
          message: `"${type}" is not a valid Pod condition type: it ${check.reason}.`,
          explanation:
            'A condition type is a qualified name — "DisruptionTarget", or a domain-prefixed one for a condition some other component adds.',
          docsUrl: FAILURE_POLICY_DOCS,
        });
      }
    }

    // `status` was required by the schema until 1.35 dropped it from the
    // definition; validation still requires it, so it is only ours to report on
    // the versions where layer 1 has stopped doing it.
    if (
      pattern['status'] === undefined &&
      ctx.schema.describe([...patternPath, 'status'])?.required === false
    ) {
      ctx.report({
        ruleId: 'job/missing-pod-condition-status',
        severity: 'error',
        path: patternPath,
        anchor: 'key',
        message: 'A pod condition pattern must say which status it matches.',
        explanation:
          'A pattern matches a condition of the given type only when its status matches too, so the apiserver requires both. "True" is what a condition that has been reached carries.',
        docsUrl: FAILURE_POLICY_DOCS,
        fix: {
          title: 'Add status: "True"',
          safe: false,
          ops: [{ op: 'set', path: [...patternPath, 'status'], value: 'True' }],
        },
      });
    }
  });
}

/* Pod replacement policy */

/**
 * When to create the replacement for a Pod that is going away: as soon as it
 * starts terminating, or only once it is gone. A pod failure policy has to see
 * the terminated Pod's exit code before it can decide anything, so the two
 * together leave only one of the values available.
 */
function checkPodReplacementPolicy(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  if (!ctx.supports([...base, 'podReplacementPolicy'])) return;
  const policy = asString(spec['podReplacementPolicy']);
  // An unrecognised value is the enum table's report.
  if (policy !== 'TerminatingOrFailed') return;
  if (spec['podFailurePolicy'] === undefined) return;

  ctx.report({
    ruleId: 'job/pod-replacement-policy-with-failure-policy',
    severity: 'error',
    path: [...base, 'podReplacementPolicy'],
    message: 'podReplacementPolicy must be "Failed" when a podFailurePolicy is set.',
    explanation:
      'A pod failure policy reads the exit code of the terminated Pod, which is not known until the Pod has actually finished terminating. "TerminatingOrFailed" would start the replacement before then, so the apiserver allows only "Failed" here.',
    docsUrl: FAILURE_POLICY_DOCS,
    fix: {
      title: 'Change to Failed',
      safe: false,
      ops: [{ op: 'set', path: [...base, 'podReplacementPolicy'], value: 'Failed' }],
    },
  });
}

/* Success policy */

/**
 * A success policy declares the Job complete before every index has succeeded —
 * a leader index finishing, say, or enough of them. It is meaningful only for
 * an Indexed Job, since that is the only kind whose Pods can be told apart.
 */
function checkSuccessPolicy(
  ctx: RuleContext,
  spec: Record<string, unknown>,
  mode: string | undefined,
  base: Path,
): void {
  if (!ctx.supports([...base, 'successPolicy'])) return;
  const policy = asObject(spec['successPolicy']);
  if (!policy) return;

  if (mode !== INDEXED) {
    if (mode === NON_INDEXED) {
      reportRequiresIndexed(ctx, [...base, 'successPolicy'], 'successPolicy', base);
    }
    return;
  }

  const rules = asArray(policy['rules']);
  if (!rules) return;

  if (rules.length === 0) {
    ctx.report({
      ruleId: 'job/empty-success-policy',
      severity: 'error',
      path: [...base, 'successPolicy', 'rules'],
      message: 'A success policy must have at least one rule.',
      explanation:
        'The rules are the policy: without one the Job has no early success criterion and behaves as though the field were absent, so the apiserver rejects it rather than accept a policy that says nothing.',
      docsUrl: SUCCESS_POLICY_DOCS,
    });
    return;
  }

  const completions = asNumber(spec['completions']);

  rules.forEach((entry, index) => {
    const rule = asObject(entry);
    if (!rule) return;
    const path: Path = [...base, 'successPolicy', 'rules', index];

    if (rule['succeededCount'] === undefined && rule['succeededIndexes'] === undefined) {
      ctx.report({
        ruleId: 'job/success-policy-rule-empty',
        severity: 'error',
        path,
        anchor: 'key',
        message: `Success policy rule #${index + 1} sets neither succeededCount nor succeededIndexes.`,
        explanation:
          'A rule declares success either by naming the indexes that must succeed, by counting how many must succeed, or by both. One of the two is required.',
        docsUrl: SUCCESS_POLICY_DOCS,
      });
      return;
    }

    let total: number | undefined;
    const indexes = asString(rule['succeededIndexes']);
    // Every index is checked against the completion count, so without one there
    // is nothing to check the expression against.
    if (indexes !== undefined && completions !== undefined) {
      const parsed = parseIndexes(indexes, completions);
      if (parsed.ok) {
        total = parsed.total;
      } else {
        ctx.report({
          ruleId: 'job/invalid-succeeded-indexes',
          severity: 'error',
          path: [...path, 'succeededIndexes'],
          message: `"${indexes}" is not a valid index list: ${parsed.reason}.`,
          explanation:
            'The format is the one .status.completedIndexes uses: comma-separated indexes and "first-last" intervals, in increasing order, each below the completion count — "0,2,5-8".',
          docsUrl: SUCCESS_POLICY_DOCS,
        });
      }
    }

    const count = asNumber(rule['succeededCount']);
    if (count === undefined) return;
    const countPath = [...path, 'succeededCount'];

    if (count < 0) {
      ctx.report({
        ruleId: 'job/invalid-succeeded-count',
        severity: 'error',
        path: countPath,
        message: `succeededCount must not be negative, but is ${count}.`,
        explanation: 'It is how many of the rule\'s indexes have to succeed.',
        docsUrl: SUCCESS_POLICY_DOCS,
      });
    } else if (completions !== undefined && count > completions) {
      ctx.report({
        ruleId: 'job/invalid-succeeded-count',
        severity: 'error',
        path: countPath,
        message: `succeededCount (${count}) must not exceed completions (${completions}).`,
        explanation:
          'The Job only ever has that many indexes to succeed, so a higher threshold could never be met and the rule would never fire.',
        docsUrl: SUCCESS_POLICY_DOCS,
      });
    } else if (total !== undefined && count > total) {
      ctx.report({
        ruleId: 'job/invalid-succeeded-count',
        severity: 'error',
        path: countPath,
        message: `succeededCount (${count}) must not exceed the ${total} index${total === 1 ? '' : 'es'} succeededIndexes names.`,
        explanation:
          'When a rule carries both, the count is read against the indexes the rule itself lists rather than against the whole Job, so it cannot ask for more of them than there are.',
        docsUrl: SUCCESS_POLICY_DOCS,
      });
    }
  });
}

/**
 * The index-list format, from validateIndexesFormat in pkg/apis/batch: intervals
 * separated by ",", each either a single index or "first-last", strictly
 * increasing and entirely below the completion count. Returns how many indexes
 * the expression covers, which is what a succeededCount beside it is measured
 * against.
 */
function parseIndexes(
  text: string,
  completions: number,
): { ok: true; total: number } | { ok: false; reason: string } {
  if (text === '') return { ok: true, total: 0 };

  let previous: number | undefined;
  let total = 0;

  for (const interval of text.split(',')) {
    const parts = interval.split('-');
    if (parts.length > 2) {
      return { ok: false, reason: `"${interval}" has more than two parts separated by "-"` };
    }

    const first = parseIndex(parts[0]);
    if (first === undefined) return { ok: false, reason: `"${parts[0]}" is not a number` };
    if (first >= completions) {
      return { ok: false, reason: `index ${first} is not below completions (${completions})` };
    }

    let last = first;
    if (parts.length === 2) {
      const end = parseIndex(parts[1]);
      if (end === undefined) return { ok: false, reason: `"${parts[1]}" is not a number` };
      if (end >= completions) {
        return { ok: false, reason: `index ${end} is not below completions (${completions})` };
      }
      if (first >= end) {
        return { ok: false, reason: `"${interval}" does not run from a lower index to a higher one` };
      }
      last = end;
    }

    if (previous !== undefined && previous >= first) {
      return { ok: false, reason: `${first} does not come after ${previous}` };
    }
    total += last - first + 1;
    previous = last;
  }

  return { ok: true, total };
}

function parseIndex(text: string | undefined): number | undefined {
  if (text === undefined || !/^[+-]?\d+$/.test(text)) return undefined;
  return Number(text);
}

/* Managed by */

/**
 * The name of the controller that reconciles this Job instead of the built-in
 * one — a queueing system such as Kueue. It is a domain-prefixed path so that
 * two implementations cannot claim the same string, and it is what stops the
 * built-in controller from touching the Job at all, which is why a typo here is
 * a Job that nothing ever runs.
 */
function checkManagedBy(ctx: RuleContext, spec: Record<string, unknown>, base: Path): void {
  if (!ctx.supports([...base, 'managedBy'])) return;
  const managedBy = asString(spec['managedBy']);
  if (managedBy === undefined) return;

  const path: Path = [...base, 'managedBy'];

  if (managedBy.length > MANAGED_BY_MAX) {
    ctx.report({
      ruleId: 'job/managed-by-too-long',
      severity: 'error',
      path,
      message: `managedBy must be at most ${MANAGED_BY_MAX} characters, but is ${managedBy.length}.`,
      explanation:
        'The value is an identifier a controller compares itself against, not a description.',
      docsUrl: JOB_DOCS,
    });
    return;
  }

  const check = isDomainPrefixedPath(managedBy);
  if (check.ok) return;

  ctx.report({
    ruleId: 'job/invalid-managed-by',
    severity: 'error',
    path,
    message: `"${managedBy}" is not a valid managedBy value: it ${check.reason}.`,
    explanation:
      'It names the controller that owns this Job — "kueue.x-k8s.io/multikueue", say — as a domain the implementation owns, a "/", and a name below it. The built-in controller answers to "kubernetes.io/job-controller", which is the value a Job gets when the field is left out.',
    docsUrl: JOB_DOCS,
  });
}
