import {
  isDNS1035Label,
  isDNS1123Label,
  isDNS1123Subdomain,
  isLabelValue,
  isQualifiedName,
  suggestName,
} from '../../k8s/names.js';
import { asObject, asString, type Rule, type RuleContext } from './context.js';

const NAME_DOCS =
  'https://kubernetes.io/docs/concepts/overview/working-with-objects/names/#dns-subdomain-names';
const NAMESPACE_DOCS =
  'https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/#not-all-objects-are-in-a-namespace';

/** What `metadata.name` must look like, per the kind's descriptor. */
const NAME_FORMATS = {
  subdomain: {
    check: isDNS1123Subdomain,
    explanation:
      'Object names are DNS subdomain names: lowercase letters, digits, "-" and ".", starting and ending with an alphanumeric character, at most 253 characters.',
  },
  label: {
    check: isDNS1123Label,
    explanation:
      'This kind is named with a DNS label rather than a subdomain: lowercase letters, digits and "-", at most 63 characters, and no dots — the name ends up in a hostname.',
  },
  rfc1035: {
    check: isDNS1035Label,
    explanation:
      'This kind is named with an RFC 1035 label: like a DNS label, but it must also start with a letter rather than a digit. The name becomes a DNS record of its own, and a label starting with a digit cannot be told apart from part of an IP address.',
  },
} as const;

/**
 * Checks on the object's own metadata. Every kind has metadata, including one
 * with no pod template at all, so the rule IDs here are `meta/*` rather than
 * `pod/*`: none of this is a PodSpec problem.
 */
export const metadataRule: Rule = {
  id: 'meta/metadata',
  run(ctx: RuleContext) {
    const metadata = asObject(ctx.doc['metadata']);

    if (!metadata) {
      if (ctx.doc['metadata'] === undefined) {
        ctx.report({
          ruleId: 'meta/missing-metadata',
          severity: 'error',
          path: [],
          message: 'Required field "metadata" is missing.',
          explanation:
            'Every object needs metadata carrying at least a name, which is how the object is addressed in its namespace.',
          docsUrl: NAME_DOCS,
        });
      }
      return;
    }

    const name = asString(metadata['name']);
    const generateName = asString(metadata['generateName']);
    const format = NAME_FORMATS[ctx.kind.nameFormat ?? 'subdomain'];

    if (metadata['name'] === undefined && metadata['generateName'] === undefined) {
      ctx.report({
        ruleId: 'meta/missing-name',
        severity: 'error',
        path: ['metadata'],
        message: 'Required field "metadata.name" is missing.',
        explanation:
          `A ${ctx.kind.kind} must be named. Use "name" for a fixed name, or "generateName" to have the apiserver append a random suffix.`,
        docsUrl: NAME_DOCS,
      });
    }

    if (name !== undefined) {
      const check = format.check(name);
      if (!check.ok) {
        const suggestion = suggestName(name);
        ctx.report({
          ruleId: 'meta/invalid-name',
          severity: 'error',
          path: ['metadata', 'name'],
          message: `"${name}" is not a valid ${ctx.kind.kind} name: it ${check.reason}.`,
          explanation: format.explanation,
          docsUrl: NAME_DOCS,
          fix:
            suggestion && format.check(suggestion).ok
              ? {
                  title: `Change to "${suggestion}"`,
                  safe: false,
                  ops: [{ op: 'set', path: ['metadata', 'name'], value: suggestion }],
                }
              : undefined,
        });
      }
    }

    if (generateName !== undefined) {
      // The apiserver appends a 5-character suffix, so the prefix must leave room.
      const check = format.check(generateName.replace(/-$/, ''));
      if (!check.ok) {
        ctx.report({
          ruleId: 'meta/invalid-generate-name',
          severity: 'error',
          path: ['metadata', 'generateName'],
          message: `"${generateName}" is not a valid name prefix: it ${check.reason}.`,
          explanation: `generateName is used as a prefix for a server-generated name, so it must itself be a valid name. ${format.explanation}`,
          docsUrl: NAME_DOCS,
        });
      }
      if (name !== undefined) {
        ctx.report({
          ruleId: 'meta/name-and-generate-name',
          severity: 'warning',
          path: ['metadata', 'generateName'],
          message: 'Both "name" and "generateName" are set; generateName is ignored.',
          explanation:
            'The apiserver only generates a name when "name" is absent. Remove one of the two so the intent is unambiguous.',
          fix: {
            title: 'Remove generateName',
            safe: false,
            ops: [{ op: 'delete', path: ['metadata', 'generateName'] }],
          },
        });
      }
    }

    const namespace = asString(metadata['namespace']);
    if (namespace !== undefined && ctx.kind.clusterScoped) {
      // A cluster-scoped kind has no namespace to be invalid in, so the format
      // check below has nothing to say — the field itself is the problem.
      ctx.report({
        ruleId: 'meta/namespace-not-allowed',
        severity: 'error',
        path: ['metadata', 'namespace'],
        message: `${ctx.kind.kind} is cluster-scoped, so it cannot be given a namespace.`,
        explanation:
          'The apiserver rejects the field with "not allowed on this type": the object is addressed by name alone and is visible from every namespace at once. Deleting it deletes it for the whole cluster.',
        docsUrl: NAMESPACE_DOCS,
        fix: {
          title: 'Remove the namespace',
          safe: false,
          ops: [{ op: 'delete', path: ['metadata', 'namespace'] }],
        },
      });
    } else if (namespace !== undefined) {
      const check = isDNS1123Label(namespace);
      if (!check.ok) {
        const suggestion = suggestName(namespace);
        ctx.report({
          ruleId: 'meta/invalid-namespace',
          severity: 'error',
          path: ['metadata', 'namespace'],
          message: `"${namespace}" is not a valid namespace: it ${check.reason}.`,
          explanation:
            'Namespace names are DNS labels: lowercase letters, digits and "-", at most 63 characters.',
          docsUrl: NAME_DOCS,
          fix:
            suggestion && isDNS1123Label(suggestion).ok
              ? {
                  title: `Change to "${suggestion}"`,
                  safe: false,
                  ops: [{ op: 'set', path: ['metadata', 'namespace'], value: suggestion }],
                }
              : undefined,
        });
      }
    }

    checkKeyedMap(ctx, metadata['labels'], ['metadata', 'labels'], 'label', true);
    checkKeyedMap(ctx, metadata['annotations'], ['metadata', 'annotations'], 'annotation', false);
  },
};

export function checkKeyedMap(
  ctx: RuleContext,
  value: unknown,
  basePath: (string | number)[],
  noun: 'label' | 'annotation',
  checkValues: boolean,
): void {
  const map = asObject(value);
  if (!map) return;

  for (const [key, entry] of Object.entries(map)) {
    const keyCheck = isQualifiedName(key);
    if (!keyCheck.ok) {
      ctx.report({
        ruleId: `meta/invalid-${noun}-key`,
        severity: 'error',
        path: [...basePath, key],
        anchor: 'key',
        message: `"${key}" is not a valid ${noun} key: it ${keyCheck.reason}.`,
        explanation:
          'Keys are qualified names: an optional DNS subdomain prefix and a "/", then up to 63 characters of alphanumerics, "-", "_" or ".".',
      });
    }

    if (checkValues && typeof entry === 'string') {
      const valueCheck = isLabelValue(entry);
      if (!valueCheck.ok) {
        ctx.report({
          ruleId: 'meta/invalid-label-value',
          severity: 'error',
          path: [...basePath, key],
          message: `"${entry}" is not a valid label value: it ${valueCheck.reason}.`,
          explanation:
            'Label values are at most 63 characters of alphanumerics, "-", "_" or ".", starting and ending with an alphanumeric character. Annotations have no such restriction if you need a longer value.',
        });
      }
    }
  }
}
