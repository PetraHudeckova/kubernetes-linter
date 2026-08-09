import { didYouMean } from '../suggest.js';
import {
  asArray,
  asNumber,
  asObject,
  asString,
  type ContainerRef,
  type Rule,
  type RuleContext,
} from './context.js';

const PROBE_TIMING_FIELDS = new Set([
  'initialDelaySeconds',
  'timeoutSeconds',
  'periodSeconds',
  'successThreshold',
  'failureThreshold',
  'terminationGracePeriodSeconds',
]);

const PROBES = ['livenessProbe', 'readinessProbe', 'startupProbe'] as const;
type ProbeKind = (typeof PROBES)[number];

/** Minimum accepted value for each numeric probe field. */
const MINIMUMS: Record<string, number> = {
  initialDelaySeconds: 0,
  timeoutSeconds: 1,
  periodSeconds: 1,
  failureThreshold: 1,
  successThreshold: 1,
  terminationGracePeriodSeconds: 1,
};

const PROBE_DOCS =
  'https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/';

export const probesRule: Rule = {
  id: 'pod/probes',
  run(ctx: RuleContext) {
    const probeHandlers = handlerFields(ctx, 'io.k8s.api.core.v1.Probe', PROBE_TIMING_FIELDS);
    const lifecycleHandlers = handlerFields(ctx, 'io.k8s.api.core.v1.LifecycleHandler', new Set());

    for (const ref of ctx.containers) {
      const portNames = new Set(
        (asArray(ref.container['ports']) ?? [])
          .map((entry) => asString(asObject(entry)?.['name']))
          .filter((name): name is string => name !== undefined),
      );

      for (const kind of PROBES) {
        const probe = asObject(ref.container[kind]);
        if (!probe) continue;
        const path = [...ref.path, kind];

        checkHandlerCount(ctx, probe, path, probeHandlers, `${kind} on ${ref.label}`, 'probe');
        checkProbeTiming(ctx, probe, path, kind);

        for (const handler of ['httpGet', 'tcpSocket', 'grpc'] as const) {
          const action = asObject(probe[handler]);
          if (action) checkPort(ctx, action, [...path, handler], handler, portNames, ref);
        }
      }

      const lifecycle = asObject(ref.container['lifecycle']);
      if (!lifecycle) continue;

      for (const hook of ['postStart', 'preStop'] as const) {
        const handler = asObject(lifecycle[hook]);
        if (!handler) continue;
        const path = [...ref.path, 'lifecycle', hook];
        checkHandlerCount(ctx, handler, path, lifecycleHandlers, `${hook} hook on ${ref.label}`, 'hook');

        for (const action of ['httpGet', 'tcpSocket'] as const) {
          const target = asObject(handler[action]);
          if (target) checkPort(ctx, target, [...path, action], action, portNames, ref);
        }
      }
    }
  },
};

function handlerFields(ctx: RuleContext, definition: string, exclude: Set<string>): string[] {
  const properties = ctx.schema.definition(definition)?.properties ?? {};
  return Object.keys(properties).filter((field) => !exclude.has(field));
}

function checkHandlerCount(
  ctx: RuleContext,
  node: Record<string, unknown>,
  path: (string | number)[],
  handlers: string[],
  subject: string,
  noun: string,
): void {
  const present = handlers.filter((handler) => node[handler] !== undefined);

  if (present.length === 0) {
    ctx.report({
      ruleId: `pod/${noun}-without-handler`,
      severity: 'error',
      path,
      message: `The ${subject} does not say how to check the container.`,
      explanation: `Set exactly one of ${handlers.join(', ')}.`,
      docsUrl: PROBE_DOCS,
    });
    return;
  }

  if (present.length > 1) {
    ctx.report({
      ruleId: `pod/${noun}-multiple-handlers`,
      severity: 'error',
      path,
      message: `The ${subject} defines ${present.length} handlers (${present.join(', ')}); exactly one is allowed.`,
      explanation:
        'A single check has a single mechanism. Keep the one you want and remove the others, or split the work across different probes.',
      docsUrl: PROBE_DOCS,
    });
  }
}

function checkProbeTiming(
  ctx: RuleContext,
  probe: Record<string, unknown>,
  path: (string | number)[],
  kind: ProbeKind,
): void {
  for (const [field, minimum] of Object.entries(MINIMUMS)) {
    const value = asNumber(probe[field]);
    if (value === undefined) continue;
    if (value < minimum) {
      ctx.report({
        ruleId: 'pod/probe-value-out-of-range',
        severity: 'error',
        path: [...path, field],
        message: `${field} must be at least ${minimum}, but is ${value}.`,
        explanation: 'Probe timings are measured in seconds and counts, so they cannot be zero or negative.',
        docsUrl: PROBE_DOCS,
        fix: {
          title: `Change to ${minimum}`,
          safe: false,
          ops: [{ op: 'set', path: [...path, field], value: minimum }],
        },
      });
    }
  }

  const successThreshold = asNumber(probe['successThreshold']);
  if (successThreshold !== undefined && successThreshold !== 1 && kind !== 'readinessProbe') {
    ctx.report({
      ruleId: 'pod/probe-success-threshold',
      severity: 'error',
      path: [...path, 'successThreshold'],
      message: `successThreshold must be 1 for a ${kind}, but is ${successThreshold}.`,
      explanation:
        'Liveness and startup probes act on the first success, so any other value is meaningless. Only readiness probes may require several consecutive successes.',
      docsUrl: PROBE_DOCS,
      fix: {
        title: 'Change to 1',
        safe: true,
        ops: [{ op: 'set', path: [...path, 'successThreshold'], value: 1 }],
      },
    });
  }
}

function checkPort(
  ctx: RuleContext,
  action: Record<string, unknown>,
  path: (string | number)[],
  handler: string,
  portNames: Set<string>,
  ref: ContainerRef,
): void {
  const port = action['port'];

  if (port === undefined) {
    // grpc.port is required by the schema; the other two are required here.
    ctx.report({
      ruleId: 'pod/probe-missing-port',
      severity: 'error',
      path,
      message: `The ${handler} check does not specify a port.`,
      explanation: 'Give a port number, or the name of a port declared under this container\'s ports.',
      docsUrl: PROBE_DOCS,
    });
    return;
  }

  if (typeof port === 'number') {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      ctx.report({
        ruleId: 'pod/probe-port-out-of-range',
        severity: 'error',
        path: [...path, 'port'],
        message: `Port ${port} is out of range; it must be between 1 and 65535.`,
        explanation: 'Probe ports are ordinary TCP port numbers.',
      });
    }
    return;
  }

  if (typeof port !== 'string') return;

  // A numeric string is accepted by the API but is really a number.
  if (/^\d+$/.test(port)) return;

  if (portNames.has(port)) return;

  const suggestion = didYouMean(port, portNames);
  ctx.report({
    ruleId: 'pod/probe-port-name-not-found',
    severity: 'error',
    path: [...path, 'port'],
    message: suggestion
      ? `The ${handler} check targets port "${port}", which ${ref.label} does not declare. Did you mean "${suggestion}"?`
      : `The ${handler} check targets port "${port}", which ${ref.label} does not declare.`,
    explanation:
      portNames.size > 0
        ? `Named ports on this container: ${[...portNames].map((name) => `"${name}"`).join(', ')}. A named probe port must refer to a port on the same container.`
        : 'This container declares no named ports. Use a port number, or add a named port under this container\'s ports.',
    docsUrl: PROBE_DOCS,
    fix: suggestion
      ? { title: `Change to "${suggestion}"`, safe: true, ops: [{ op: 'set', path: [...path, 'port'], value: suggestion }] }
      : undefined,
  });
}
