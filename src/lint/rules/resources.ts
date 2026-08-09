import { isQualifiedName } from '../../k8s/names.js';
import { parseQuantity } from '../../k8s/quantity.js';
import { asArray, asObject, asString, type Rule, type RuleContext } from './context.js';
import { didYouMean } from '../suggest.js';

/** Resources the kubelet knows natively; anything else must be domain-qualified. */
const STANDARD_RESOURCES = ['cpu', 'memory', 'ephemeral-storage'];

const RESOURCE_DOCS =
  'https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/';

export const resourcesRule: Rule = {
  id: 'pod/resources',
  run(ctx: RuleContext) {
    const claimNames = new Set<string>();
    for (const entry of asArray(ctx.spec['resourceClaims']) ?? []) {
      const name = asString(asObject(entry)?.['name']);
      if (name) claimNames.add(name);
    }

    // Pod-level resources sit alongside the per-container ones.
    checkResourceBlock(ctx, asObject(ctx.spec['resources']), ['spec', 'resources'], 'the Pod');

    for (const ref of ctx.containers) {
      const resources = asObject(ref.container['resources']);
      checkResourceBlock(ctx, resources, [...ref.path, 'resources'], ref.label);
      if (!resources) continue;

      asArray(resources['claims'])?.forEach((entry, index) => {
        const claim = asObject(entry);
        const name = asString(claim?.['name']);
        if (name === undefined || claimNames.has(name)) return;

        const suggestion = didYouMean(name, claimNames);
        const path = [...ref.path, 'resources', 'claims', index, 'name'];
        ctx.report({
          ruleId: 'pod/resource-claim-not-found',
          severity: 'error',
          path,
          message: suggestion
            ? `Resource claim "${name}" is not declared. Did you mean "${suggestion}"?`
            : `Resource claim "${name}" is not declared in spec.resourceClaims.`,
          explanation:
            claimNames.size > 0
              ? `The Pod declares: ${[...claimNames].map((entry) => `"${entry}"`).join(', ')}.`
              : 'A container may only consume claims that the Pod declares under spec.resourceClaims.',
          docsUrl: 'https://kubernetes.io/docs/concepts/scheduling-eviction/dynamic-resource-allocation/',
          fix: suggestion
            ? { title: `Change to "${suggestion}"`, safe: true, ops: [{ op: 'set', path, value: suggestion }] }
            : undefined,
        });
      });
    }
  },
};

function checkResourceBlock(
  ctx: RuleContext,
  resources: Record<string, unknown> | undefined,
  basePath: (string | number)[],
  owner: string,
): void {
  if (!resources) return;

  const requests = asObject(resources['requests']);
  const limits = asObject(resources['limits']);

  for (const [field, block] of [
    ['requests', requests],
    ['limits', limits],
  ] as const) {
    if (!block) continue;
    for (const [name, raw] of Object.entries(block)) {
      checkResourceName(ctx, name, [...basePath, field, name]);
      checkSuspiciousMemory(ctx, name, raw, [...basePath, field, name]);
    }
  }

  if (!requests || !limits) return;

  for (const [name, rawRequest] of Object.entries(requests)) {
    const rawLimit = limits[name];
    if (rawLimit === undefined) continue;

    const request = parseQuantity(rawRequest);
    const limit = parseQuantity(rawLimit);
    if (!request.ok || !limit.ok || request.value === undefined || limit.value === undefined) continue;

    if (request.value > limit.value) {
      ctx.report({
        ruleId: 'pod/request-exceeds-limit',
        severity: 'error',
        path: [...basePath, 'requests', name],
        message: `The ${name} request (${format(rawRequest)}) is larger than the ${name} limit (${format(rawLimit)}) for ${owner}.`,
        explanation:
          'A request is the amount guaranteed to the container and a limit is the ceiling it may reach, so the request can never exceed the limit. The apiserver rejects the Pod outright.',
        docsUrl: RESOURCE_DOCS,
        fix: {
          title: `Raise the ${name} limit to ${format(rawRequest)}`,
          safe: false,
          ops: [{ op: 'set', path: [...basePath, 'limits', name], value: rawRequest }],
        },
      });
    }
  }
}

function checkResourceName(ctx: RuleContext, name: string, path: (string | number)[]): void {
  const check = isQualifiedName(name);
  if (!check.ok) {
    ctx.report({
      ruleId: 'pod/invalid-resource-name',
      severity: 'error',
      path,
      anchor: 'key',
      message: `"${name}" is not a valid resource name: it ${check.reason}.`,
      explanation: 'Resource names are qualified names, optionally prefixed with a DNS subdomain and "/".',
      docsUrl: RESOURCE_DOCS,
    });
    return;
  }

  if (STANDARD_RESOURCES.includes(name) || name.startsWith('hugepages-')) return;

  if (!name.includes('/')) {
    const suggestion = didYouMean(name, STANDARD_RESOURCES);
    ctx.report({
      ruleId: 'pod/unknown-resource-name',
      severity: 'error',
      path,
      anchor: 'key',
      message: suggestion
        ? `"${name}" is not a standard resource. Did you mean "${suggestion}"?`
        : `"${name}" is not a standard resource name.`,
      explanation:
        'Unprefixed names are reserved for the resources Kubernetes manages itself: cpu, memory, ephemeral-storage and hugepages-<size>. An extended resource must be domain-qualified, for example "nvidia.com/gpu".',
      docsUrl: RESOURCE_DOCS,
      fix: suggestion
        ? { title: `Rename to "${suggestion}"`, safe: true, ops: [{ op: 'rename', path, to: suggestion }] }
        : undefined,
    });
  }
}

/**
 * `memory: 512m` is valid syntax that means 0.512 bytes — the "m" suffix is
 * milli, not mega. It is one of the most common and most confusing mistakes in
 * a Pod spec, because the manifest is accepted and the container then fails.
 */
function checkSuspiciousMemory(
  ctx: RuleContext,
  name: string,
  raw: unknown,
  path: (string | number)[],
): void {
  const isByteResource = name === 'memory' || name === 'ephemeral-storage' || name.startsWith('hugepages-');
  if (!isByteResource || typeof raw !== 'string') return;

  const quantity = parseQuantity(raw);
  if (!quantity.ok || quantity.suffix !== 'm') return;

  const intended = `${raw.slice(0, -1)}Mi`;
  ctx.report({
    ruleId: 'pod/milli-byte-quantity',
    severity: 'warning',
    path,
    message: `${format(raw)} of ${name} means ${quantity.value} bytes, not megabytes.`,
    explanation:
      'The lowercase "m" suffix is the SI milli prefix, so "512m" is 0.512 bytes. For megabytes use "Mi" (1024-based) or "M" (1000-based). As written, the Pod is accepted but the container will be unable to start.',
    docsUrl: RESOURCE_DOCS,
    fix: {
      title: `Change to "${intended}"`,
      safe: false,
      ops: [{ op: 'set', path, value: intended }],
    },
  });
}

function format(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}
