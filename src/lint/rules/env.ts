import { isCIdentifier, isEnvVarName } from '../../k8s/names.js';
import { asObject, asString, type Rule, type RuleContext } from './context.js';

const ENV_SOURCES = ['fieldRef', 'resourceFieldRef', 'configMapKeyRef', 'secretKeyRef', 'fileKeyRef'];
const ENV_FROM_SOURCES = ['configMapRef', 'secretRef'];

export const envRule: Rule = {
  id: 'pod/env',
  run(ctx: RuleContext) {
    for (const ref of ctx.containers) {
      const env = ref.container['env'];
      if (Array.isArray(env)) {
        const seen = new Map<string, number>();

        env.forEach((entry, index) => {
          const variable = asObject(entry);
          if (!variable) return;
          const path = [...ref.path, 'env', index];
          const name = asString(variable['name']);

          if (name !== undefined) {
            const check = isEnvVarName(name);
            if (!check.ok) {
              ctx.report({
                ruleId: 'pod/invalid-env-name',
                severity: 'error',
                path: [...path, 'name'],
                message: `"${name}" is not a valid environment variable name: it ${check.reason}.`,
                explanation:
                  'Names may contain letters, digits, "_", "-" and ".", and must not start with a digit.',
              });
            }

            const previous = seen.get(name);
            if (previous !== undefined) {
              ctx.report({
                ruleId: 'pod/duplicate-env-name',
                severity: 'warning',
                path: [...path, 'name'],
                message: `Environment variable "${name}" is defined more than once; entry ${index + 1} wins.`,
                explanation:
                  'Kubernetes accepts duplicates and keeps the last definition, which makes the earlier one dead configuration. Remove whichever is stale.',
              });
            } else {
              seen.set(name, index);
            }
          }

          const hasValue = variable['value'] !== undefined;
          const valueFrom = variable['valueFrom'];

          if (hasValue && valueFrom !== undefined) {
            ctx.report({
              ruleId: 'pod/env-value-and-value-from',
              severity: 'error',
              path,
              message: `Environment variable ${name ? `"${name}"` : `#${index + 1}`} sets both "value" and "valueFrom".`,
              explanation:
                'A variable takes its value either literally or from a reference, never both. Remove the one you do not want.',
              fix: {
                title: 'Remove "value" and keep the reference',
                safe: false,
                ops: [{ op: 'delete', path: [...path, 'value'] }],
              },
            });
          }

          const source = asObject(valueFrom);
          if (source) {
            const present = ENV_SOURCES.filter((key) => source[key] !== undefined);
            if (present.length === 0) {
              ctx.report({
                ruleId: 'pod/empty-value-from',
                severity: 'error',
                path: [...path, 'valueFrom'],
                message: 'valueFrom does not name a source.',
                explanation: `Set exactly one of ${ENV_SOURCES.join(', ')}.`,
              });
            } else if (present.length > 1) {
              ctx.report({
                ruleId: 'pod/multiple-value-from',
                severity: 'error',
                path: [...path, 'valueFrom'],
                message: `valueFrom sets ${present.length} sources (${present.join(', ')}); exactly one is allowed.`,
                explanation: 'A single variable can only be resolved from one place.',
              });
            }
          }
        });
      }

      const envFrom = ref.container['envFrom'];
      if (!Array.isArray(envFrom)) continue;

      envFrom.forEach((entry, index) => {
        const source = asObject(entry);
        if (!source) return;
        const path = [...ref.path, 'envFrom', index];

        const prefix = asString(source['prefix']);
        if (prefix !== undefined && prefix !== '') {
          const check = isCIdentifier(prefix);
          if (!check.ok) {
            ctx.report({
              ruleId: 'pod/invalid-env-from-prefix',
              severity: 'error',
              path: [...path, 'prefix'],
              message: `"${prefix}" is not a valid envFrom prefix: it ${check.reason}.`,
              explanation:
                'The prefix is prepended to every key from the ConfigMap or Secret, so it must itself be a legal identifier.',
            });
          }
        }

        const present = ENV_FROM_SOURCES.filter((key) => source[key] !== undefined);
        if (present.length === 0) {
          ctx.report({
            ruleId: 'pod/empty-env-from',
            severity: 'error',
            path,
            message: 'envFrom entry does not reference a ConfigMap or a Secret.',
            explanation: `Set exactly one of ${ENV_FROM_SOURCES.join(' or ')}.`,
          });
        } else if (present.length > 1) {
          ctx.report({
            ruleId: 'pod/multiple-env-from',
            severity: 'error',
            path,
            message: `envFrom entry sets both ${present.join(' and ')}; exactly one is allowed.`,
            explanation: 'Use a separate envFrom entry for each ConfigMap or Secret.',
          });
        }
      });
    }
  },
};
