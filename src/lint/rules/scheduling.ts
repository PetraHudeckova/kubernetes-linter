import { isQualifiedName } from '../../k8s/names.js';
import {
  asArray,
  asNumber,
  asObject,
  asString,
  type Rule,
  type RuleContext,
} from './context.js';
import { checkRequirement } from './selector.js';

const AFFINITY_DOCS = 'https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/';
const TAINT_DOCS = 'https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/';
const SPREAD_DOCS =
  'https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/';

export const schedulingRule: Rule = {
  id: 'pod/scheduling',
  run(ctx: RuleContext) {
    checkAffinity(ctx);
    checkTolerations(ctx);
    checkTopologySpread(ctx);
  },
};

function checkAffinity(ctx: RuleContext): void {
  const affinity = asObject(ctx.spec['affinity']);
  if (!affinity) return;

  const nodeAffinity = asObject(affinity['nodeAffinity']);
  if (nodeAffinity) {
    const required = asObject(nodeAffinity['requiredDuringSchedulingIgnoredDuringExecution']);
    const terms = asArray(required?.['nodeSelectorTerms']);
    if (required && (!terms || terms.length === 0)) {
      ctx.report({
        ruleId: 'pod/empty-node-selector-terms',
        severity: 'error',
        path: ctx.at('affinity', 'nodeAffinity', 'requiredDuringSchedulingIgnoredDuringExecution'),
        message: 'nodeSelectorTerms must not be empty.',
        explanation:
          'An empty list matches nothing, so the Pod could never be scheduled. Remove the required affinity instead.',
        docsUrl: AFFINITY_DOCS,
      });
    }

    terms?.forEach((term, termIndex) => {
      const basePath = ctx.at(
        'affinity',
        'nodeAffinity',
        'requiredDuringSchedulingIgnoredDuringExecution',
        'nodeSelectorTerms',
        termIndex,
      );
      checkRequirements(ctx, asObject(term), basePath, true);
    });

    asArray(nodeAffinity['preferredDuringSchedulingIgnoredDuringExecution'])?.forEach((entry, index) => {
      const preference = asObject(entry);
      if (!preference) return;
      const basePath = ctx.at(
        'affinity',
        'nodeAffinity',
        'preferredDuringSchedulingIgnoredDuringExecution',
        index,
      );
      checkWeight(ctx, preference['weight'], [...basePath, 'weight']);
      checkRequirements(ctx, asObject(preference['preference']), [...basePath, 'preference'], true);
    });
  }

  for (const affinityKind of ['podAffinity', 'podAntiAffinity'] as const) {
    const podAffinity = asObject(affinity[affinityKind]);
    if (!podAffinity) continue;

    asArray(podAffinity['requiredDuringSchedulingIgnoredDuringExecution'])?.forEach((entry, index) => {
      checkPodAffinityTerm(
        ctx,
        asObject(entry),
        ctx.at('affinity', affinityKind, 'requiredDuringSchedulingIgnoredDuringExecution', index),
      );
    });

    asArray(podAffinity['preferredDuringSchedulingIgnoredDuringExecution'])?.forEach((entry, index) => {
      const weighted = asObject(entry);
      if (!weighted) return;
      const basePath = ctx.at('affinity', affinityKind, 'preferredDuringSchedulingIgnoredDuringExecution', index);
      checkWeight(ctx, weighted['weight'], [...basePath, 'weight']);
      checkPodAffinityTerm(ctx, asObject(weighted['podAffinityTerm']), [...basePath, 'podAffinityTerm']);
    });
  }
}

function checkPodAffinityTerm(
  ctx: RuleContext,
  term: Record<string, unknown> | undefined,
  basePath: (string | number)[],
): void {
  if (!term) return;

  if (term['topologyKey'] === undefined || term['topologyKey'] === '') {
    ctx.report({
      ruleId: 'pod/missing-topology-key',
      severity: 'error',
      path: basePath,
      message: 'topologyKey is required on a pod affinity term.',
      explanation:
        'The topology key names the node label that defines a domain, such as kubernetes.io/hostname or topology.kubernetes.io/zone.',
      docsUrl: AFFINITY_DOCS,
      fix: {
        title: 'Use kubernetes.io/hostname',
        safe: false,
        ops: [{ op: 'set', path: [...basePath, 'topologyKey'], value: 'kubernetes.io/hostname' }],
      },
    });
  }

  for (const field of ['labelSelector', 'namespaceSelector'] as const) {
    const selector = asObject(term[field]);
    if (!selector) continue;
    asArray(selector['matchExpressions'])?.forEach((entry, index) => {
      checkRequirement(ctx, asObject(entry), [...basePath, field, 'matchExpressions', index], {
        allowNumeric: false,
        idPrefix: 'pod',
        docsUrl: AFFINITY_DOCS,
      });
    });
  }
}

function checkRequirements(
  ctx: RuleContext,
  term: Record<string, unknown> | undefined,
  basePath: (string | number)[],
  allowNumeric: boolean,
): void {
  if (!term) return;
  for (const field of ['matchExpressions', 'matchFields'] as const) {
    asArray(term[field])?.forEach((entry, index) => {
      checkRequirement(ctx, asObject(entry), [...basePath, field, index], {
        allowNumeric,
        idPrefix: 'pod',
        docsUrl: AFFINITY_DOCS,
      });
    });
  }
}

function checkWeight(ctx: RuleContext, value: unknown, path: (string | number)[]): void {
  const weight = asNumber(value);
  if (weight === undefined) return;
  if (weight < 1 || weight > 100) {
    ctx.report({
      ruleId: 'pod/invalid-weight',
      severity: 'error',
      path,
      message: `weight must be between 1 and 100, but is ${weight}.`,
      explanation: 'Preferred scheduling rules are scored on a 1-100 scale.',
      docsUrl: AFFINITY_DOCS,
    });
  }
}

function checkTolerations(ctx: RuleContext): void {
  asArray(ctx.spec['tolerations'])?.forEach((entry, index) => {
    const toleration = asObject(entry);
    if (!toleration) return;
    const path = ctx.at('tolerations', index);

    const operator = asString(toleration['operator']) ?? 'Equal';
    const key = asString(toleration['key']);
    const value = toleration['value'];
    const effect = asString(toleration['effect']);

    if (operator === 'Exists' && value !== undefined && value !== '') {
      ctx.report({
        ruleId: 'pod/toleration-exists-with-value',
        severity: 'error',
        path: [...path, 'value'],
        message: 'A toleration with operator "Exists" must not set a value.',
        explanation:
          '"Exists" matches any value of the taint key, so a value would be contradictory. Use operator "Equal" to match a specific value.',
        docsUrl: TAINT_DOCS,
        fix: {
          title: 'Change the operator to "Equal"',
          safe: false,
          ops: [{ op: 'set', path: [...path, 'operator'], value: 'Equal' }],
        },
      });
    }

    if (operator === 'Equal' && (key === undefined || key === '')) {
      ctx.report({
        ruleId: 'pod/toleration-empty-key',
        severity: 'error',
        path,
        message: 'A toleration with an empty key must use operator "Exists".',
        explanation:
          'An empty key means "match every taint", which only makes sense with "Exists". As written this tolerates nothing.',
        docsUrl: TAINT_DOCS,
        fix: {
          title: 'Change the operator to "Exists"',
          safe: true,
          ops: [{ op: 'set', path: [...path, 'operator'], value: 'Exists' }],
        },
      });
    }

    if (key !== undefined && key !== '') {
      const check = isQualifiedName(key);
      if (!check.ok) {
        ctx.report({
          ruleId: 'pod/invalid-toleration-key',
          severity: 'error',
          path: [...path, 'key'],
          message: `"${key}" is not a valid taint key: it ${check.reason}.`,
          explanation: 'Taint keys are qualified names, like node.kubernetes.io/unreachable.',
          docsUrl: TAINT_DOCS,
        });
      }
    }

    if (toleration['tolerationSeconds'] !== undefined && effect !== 'NoExecute') {
      ctx.report({
        ruleId: 'pod/toleration-seconds-without-no-execute',
        severity: 'error',
        path: [...path, 'tolerationSeconds'],
        message: 'tolerationSeconds is only allowed when effect is "NoExecute".',
        explanation:
          'It says how long the Pod may stay on a node after a matching NoExecute taint appears. Other effects never evict, so the field has no meaning.',
        docsUrl: TAINT_DOCS,
      });
    }
  });
}

function checkTopologySpread(ctx: RuleContext): void {
  asArray(ctx.spec['topologySpreadConstraints'])?.forEach((entry, index) => {
    const constraint = asObject(entry);
    if (!constraint) return;
    const path = ctx.at('topologySpreadConstraints', index);

    const maxSkew = asNumber(constraint['maxSkew']);
    if (maxSkew !== undefined && maxSkew < 1) {
      ctx.report({
        ruleId: 'pod/invalid-max-skew',
        severity: 'error',
        path: [...path, 'maxSkew'],
        message: `maxSkew must be greater than 0, but is ${maxSkew}.`,
        explanation:
          'maxSkew is the largest permitted difference in matching Pods between any two topology domains.',
        docsUrl: SPREAD_DOCS,
        fix: { title: 'Change to 1', safe: false, ops: [{ op: 'set', path: [...path, 'maxSkew'], value: 1 }] },
      });
    }

    if (constraint['topologyKey'] === undefined || constraint['topologyKey'] === '') {
      ctx.report({
        ruleId: 'pod/missing-topology-key',
        severity: 'error',
        path,
        message: 'topologyKey is required on a topology spread constraint.',
        explanation:
          'It names the node label that groups nodes into domains, such as topology.kubernetes.io/zone.',
        docsUrl: SPREAD_DOCS,
        fix: {
          title: 'Use topology.kubernetes.io/zone',
          safe: false,
          ops: [{ op: 'set', path: [...path, 'topologyKey'], value: 'topology.kubernetes.io/zone' }],
        },
      });
    }

    if (constraint['whenUnsatisfiable'] === undefined) {
      ctx.report({
        ruleId: 'pod/missing-when-unsatisfiable',
        severity: 'error',
        path,
        message: 'whenUnsatisfiable is required on a topology spread constraint.',
        explanation:
          'It decides what happens when the constraint cannot be met: "DoNotSchedule" keeps the Pod pending, "ScheduleAnyway" places it anyway with a scoring penalty.',
        docsUrl: SPREAD_DOCS,
        fix: {
          title: 'Set whenUnsatisfiable: DoNotSchedule',
          safe: false,
          ops: [{ op: 'set', path: [...path, 'whenUnsatisfiable'], value: 'DoNotSchedule' }],
        },
      });
    }

    const minDomains = asNumber(constraint['minDomains']);
    if (minDomains !== undefined) {
      if (minDomains < 1) {
        ctx.report({
          ruleId: 'pod/invalid-min-domains',
          severity: 'error',
          path: [...path, 'minDomains'],
          message: `minDomains must be greater than 0, but is ${minDomains}.`,
          explanation: 'It is the minimum number of eligible domains the spread must cover.',
          docsUrl: SPREAD_DOCS,
        });
      }
      if (asString(constraint['whenUnsatisfiable']) !== 'DoNotSchedule') {
        ctx.report({
          ruleId: 'pod/min-domains-requires-do-not-schedule',
          severity: 'error',
          path: [...path, 'minDomains'],
          message: 'minDomains is only allowed when whenUnsatisfiable is "DoNotSchedule".',
          explanation:
            'With "ScheduleAnyway" the scheduler never blocks placement, so a minimum domain count could not be enforced.',
          docsUrl: SPREAD_DOCS,
        });
      }
    }
  });
}
