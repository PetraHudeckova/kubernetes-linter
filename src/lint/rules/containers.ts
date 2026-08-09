import { isDNS1123Label, suggestName } from '../../k8s/names.js';
import { asArray, asObject, asString, type Rule, type RuleContext } from './context.js';

const PROBE_FIELDS = ['livenessProbe', 'readinessProbe', 'startupProbe'] as const;

export const containersRule: Rule = {
  id: 'pod/containers',
  run(ctx: RuleContext) {
    const containers = ctx.spec['containers'];
    if (Array.isArray(containers) && containers.length === 0) {
      ctx.report({
        ruleId: 'pod/no-containers',
        severity: 'error',
        path: ctx.at('containers'),
        message: 'A Pod must define at least one container.',
        explanation: `${ctx.field('containers')} is present but empty. Init containers and ephemeral containers do not count — a Pod needs at least one regular container.`,
      });
    }

    // Names must be unique across containers, initContainers and ephemeralContainers.
    const firstUse = new Map<string, string>();

    for (const ref of ctx.containers) {
      const name = asString(ref.container['name']);

      if (name !== undefined) {
        const check = isDNS1123Label(name);
        if (!check.ok) {
          const suggestion = suggestName(name);
          ctx.report({
            ruleId: 'pod/invalid-container-name',
            severity: 'error',
            path: [...ref.path, 'name'],
            message: `"${name}" is not a valid container name: it ${check.reason}.`,
            explanation:
              'Container names are DNS labels: lowercase letters, digits and "-", starting and ending with an alphanumeric character, at most 63 characters.',
            fix:
              suggestion && isDNS1123Label(suggestion).ok
                ? {
                    title: `Change to "${suggestion}"`,
                    safe: false,
                    ops: [{ op: 'set', path: [...ref.path, 'name'], value: suggestion }],
                  }
                : undefined,
          });
        }

        const previous = firstUse.get(name);
        if (previous) {
          ctx.report({
            ruleId: 'pod/duplicate-container-name',
            severity: 'error',
            path: [...ref.path, 'name'],
            message: `Container name "${name}" is already used by ${previous}.`,
            explanation:
              'Container names must be unique across containers, initContainers and ephemeralContainers, because they identify the container in status, logs and exec.',
          });
        } else {
          firstUse.set(name, ref.label);
        }
      }

      const image = ref.container['image'];
      if (image === undefined || image === null || image === '') {
        // ephemeralContainers share the Container schema but the apiserver
        // requires an image there too.
        ctx.report({
          ruleId: 'pod/missing-image',
          severity: 'error',
          path: image === undefined ? ref.path : [...ref.path, 'image'],
          message: `${capitalise(ref.label)} has no image.`,
          explanation:
            'Every container must specify the image to run, for example "nginx:1.27-alpine".',
          docsUrl: 'https://kubernetes.io/docs/concepts/containers/images/',
        });
      }

      const workingDir = asString(ref.container['workingDir']);
      if (workingDir !== undefined && !workingDir.startsWith('/')) {
        ctx.report({
          ruleId: 'pod/relative-working-dir',
          severity: 'error',
          path: [...ref.path, 'workingDir'],
          message: `workingDir "${workingDir}" must be an absolute path.`,
          explanation: 'The container working directory is resolved inside the image, so it has to start with "/".',
          fix: {
            title: `Change to "/${workingDir.replace(/^\.?\/*/, '')}"`,
            safe: false,
            ops: [{ op: 'set', path: [...ref.path, 'workingDir'], value: `/${workingDir.replace(/^\.?\/*/, '')}` }],
          },
        });
      }

      const messagePath = asString(ref.container['terminationMessagePath']);
      if (messagePath !== undefined && !messagePath.startsWith('/')) {
        ctx.report({
          ruleId: 'pod/relative-termination-message-path',
          severity: 'error',
          path: [...ref.path, 'terminationMessagePath'],
          message: `terminationMessagePath "${messagePath}" must be an absolute path.`,
          explanation: 'Defaults to /dev/termination-log when unset.',
        });
      }

      if (ref.container['stdinOnce'] === true && ref.container['stdin'] !== true) {
        ctx.report({
          ruleId: 'pod/stdin-once-without-stdin',
          severity: 'warning',
          path: [...ref.path, 'stdinOnce'],
          message: 'stdinOnce has no effect unless stdin is also true.',
          explanation: 'stdinOnce closes the stdin channel after the first attach; without stdin there is no channel to close.',
          fix: {
            title: 'Set stdin: true',
            safe: false,
            ops: [{ op: 'set', path: [...ref.path, 'stdin'], value: true }],
          },
        });
      }

      if (ref.list === 'initContainers') checkInitContainer(ctx, ref);
      if (ref.list === 'ephemeralContainers') checkEphemeralContainer(ctx, ref);
    }
  },
};

function checkInitContainer(ctx: RuleContext, ref: RuleContext['containers'][number]): void {
  const isSidecar = asString(ref.container['restartPolicy']) === 'Always';
  if (isSidecar) return;

  // Container.restartPolicy — the sidecar mechanism — arrived in 1.28. On an
  // older target the escape hatch does not exist, so pointing at it would
  // produce a manifest the cluster rejects.
  const sidecarsAvailable = ctx.supports([...ref.path, 'restartPolicy']);
  const sidecarFix = sidecarsAvailable
    ? {
        title: 'Make it a sidecar (restartPolicy: Always)',
        safe: false,
        ops: [{ op: 'set' as const, path: [...ref.path, 'restartPolicy'], value: 'Always' }],
      }
    : undefined;
  const sidecarAdvice = sidecarsAvailable
    ? 'Set restartPolicy: Always on this init container to make it a sidecar, which does support them.'
    : `Sidecar init containers, which do support them, need Kubernetes 1.28 or newer — you are linting against ${ctx.schema.version}.`;

  for (const field of ['readinessProbe', 'startupProbe'] as const) {
    if (ref.container[field] !== undefined) {
      ctx.report({
        ruleId: 'pod/init-container-probe',
        severity: 'error',
        path: [...ref.path, field],
        message: `Init containers may not define a ${field}.`,
        explanation: `A regular init container runs to completion before the next one starts, so readiness has no meaning. ${sidecarAdvice}`,
        docsUrl: 'https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/',
        fix: sidecarFix,
      });
    }
  }

  if (ref.container['lifecycle'] !== undefined) {
    ctx.report({
      ruleId: 'pod/init-container-lifecycle',
      severity: 'error',
      path: [...ref.path, 'lifecycle'],
      message: 'Init containers may not define lifecycle hooks.',
      explanation: `Lifecycle hooks are only honoured for containers that run for the lifetime of the Pod. ${sidecarAdvice}`,
      fix: sidecarFix,
    });
  }
}

function checkEphemeralContainer(ctx: RuleContext, ref: RuleContext['containers'][number]): void {
  const forbidden: [string, string][] = [
    ['ports', 'Ephemeral containers are not reachable as endpoints, so they cannot declare ports.'],
    ['resources', 'Ephemeral containers are added to a running Pod, whose resource allocation cannot change.'],
    ['lifecycle', 'Ephemeral containers do not run lifecycle hooks.'],
    ...PROBE_FIELDS.map(
      (field) => [field, 'Ephemeral containers are debugging tools and are never probed.'] as [string, string],
    ),
  ];

  for (const [field, why] of forbidden) {
    const value = ref.container[field];
    if (value === undefined) continue;
    // An empty resources block is what kubectl debug emits; ignore it.
    if (field === 'resources' && Object.keys(asObject(value) ?? {}).length === 0) continue;
    if (field === 'ports' && (asArray(value)?.length ?? 0) === 0) continue;

    ctx.report({
      ruleId: 'pod/ephemeral-container-field',
      severity: 'error',
      path: [...ref.path, field],
      message: `Ephemeral containers may not set "${field}".`,
      explanation: why,
      docsUrl: 'https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/',
      fix: { title: `Remove "${field}"`, safe: false, ops: [{ op: 'delete', path: [...ref.path, field] }] },
    });
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
