import type { Path } from '../types.js';
import { asArray, asString, type RuleContext } from './context.js';

/**
 * Label selector requirements, shared by everything that embeds one: node and
 * pod affinity terms on a pod spec, and `spec.selector` on a Deployment. The
 * operator/values consistency the apiserver enforces is identical in both, but
 * the finding needs the caller's rule-id prefix and docs link, since a
 * Deployment selector is not a scheduling concern.
 *
 * The operator *value* itself is not checked here — `LabelSelectorRequirement.operator`
 * and `NodeSelectorRequirement.operator` are both in the enum table.
 */
const SET_OPERATORS = ['In', 'NotIn'];
const UNARY_OPERATORS = ['Exists', 'DoesNotExist'];
/** Gt/Lt exist only in node selector terms, not in a LabelSelector. */
const NUMERIC_OPERATORS = ['Gt', 'Lt'];

export interface RequirementOptions {
  /** Node selector terms accept Gt/Lt; a LabelSelector does not. */
  allowNumeric: boolean;
  /** Rule id namespace, e.g. "pod" or "deployment". */
  idPrefix: string;
  docsUrl: string;
}

export function checkRequirement(
  ctx: RuleContext,
  requirement: Record<string, unknown> | undefined,
  path: Path,
  options: RequirementOptions,
): void {
  if (!requirement) return;
  const operator = asString(requirement['operator']);
  if (operator === undefined) return;

  const { allowNumeric, idPrefix, docsUrl } = options;
  const values = asArray(requirement['values']);
  const count = values?.length ?? 0;

  if (SET_OPERATORS.includes(operator) && count === 0) {
    ctx.report({
      ruleId: `${idPrefix}/selector-values-required`,
      severity: 'error',
      path,
      message: `Operator "${operator}" requires at least one value.`,
      explanation: `"${operator}" compares the label against a set, so the set cannot be empty.`,
      docsUrl,
    });
  }

  if (UNARY_OPERATORS.includes(operator) && count > 0) {
    ctx.report({
      ruleId: `${idPrefix}/selector-values-forbidden`,
      severity: 'error',
      path: [...path, 'values'],
      message: `Operator "${operator}" must not have values.`,
      explanation: `"${operator}" only tests whether the label is present, so any values are rejected.`,
      docsUrl,
      fix: { title: 'Remove values', safe: true, ops: [{ op: 'delete', path: [...path, 'values'] }] },
    });
  }

  if (allowNumeric && NUMERIC_OPERATORS.includes(operator)) {
    if (count !== 1) {
      ctx.report({
        ruleId: `${idPrefix}/selector-values-single`,
        severity: 'error',
        path,
        message: `Operator "${operator}" requires exactly one value, but ${count} were given.`,
        explanation: `"${operator}" performs a numeric comparison against a single value.`,
        docsUrl,
      });
    } else if (!/^-?\d+$/.test(String(values?.[0]))) {
      ctx.report({
        ruleId: `${idPrefix}/selector-value-not-integer`,
        severity: 'error',
        path: [...path, 'values', 0],
        message: `Operator "${operator}" requires an integer value, but got "${String(values?.[0])}".`,
        explanation: 'Numeric comparisons parse the label value as a base-10 integer.',
        docsUrl,
      });
    }
  }
}
