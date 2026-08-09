import { asArray, asBoolean, asNumber, asObject, asString, type Rule, type RuleContext } from './context.js';

const SECURITY_DOCS =
  'https://kubernetes.io/docs/tasks/configure-pod-container/security-context/';

/**
 * Consistency checks on securityContext — contradictions the apiserver or the
 * kubelet rejects, not policy opinions about how a Pod ought to be hardened.
 */
export const securityContextRule: Rule = {
  id: 'pod/security-context',
  run(ctx: RuleContext) {
    const podContext = asObject(ctx.spec['securityContext']);
    checkProfiles(ctx, podContext, ['spec', 'securityContext']);
    checkRunAs(ctx, podContext, ['spec', 'securityContext'], 'the Pod');

    asArray(podContext?.['sysctls'])?.forEach((entry, index) => {
      const sysctl = asObject(entry);
      if (sysctl && (sysctl['name'] === undefined || sysctl['name'] === '')) {
        ctx.report({
          ruleId: 'pod/sysctl-without-name',
          severity: 'error',
          path: ['spec', 'securityContext', 'sysctls', index],
          message: 'Each sysctl must have a name.',
          explanation: 'For example: { name: net.core.somaxconn, value: "1024" }.',
          docsUrl: 'https://kubernetes.io/docs/tasks/administer-cluster/sysctl-cluster/',
        });
      }
    });

    for (const ref of ctx.containers) {
      const container = asObject(ref.container['securityContext']);
      const path = [...ref.path, 'securityContext'];
      checkProfiles(ctx, container, path);
      checkRunAs(ctx, container, path, ref.label);

      if (!container) continue;

      const privileged = asBoolean(container['privileged']);
      const allowEscalation = asBoolean(container['allowPrivilegeEscalation']);

      if (privileged === true && allowEscalation === false) {
        ctx.report({
          ruleId: 'pod/privileged-without-escalation',
          severity: 'error',
          path: [...path, 'allowPrivilegeEscalation'],
          message: 'allowPrivilegeEscalation: false cannot be combined with privileged: true.',
          explanation:
            'A privileged container already has full host capabilities, so the kubelet rejects the contradictory request to forbid escalation. Decide which of the two you actually want.',
          docsUrl: SECURITY_DOCS,
        });
      }

      const capabilities = asObject(container['capabilities']);
      if (capabilities && allowEscalation === false) {
        const added = (asArray(capabilities['add']) ?? []).map((entry) => asString(entry)?.toUpperCase());
        if (added.includes('CAP_SYS_ADMIN') || added.includes('SYS_ADMIN')) {
          ctx.report({
            ruleId: 'pod/sys-admin-without-escalation',
            severity: 'error',
            path: [...path, 'allowPrivilegeEscalation'],
            message: 'allowPrivilegeEscalation: false cannot be combined with the SYS_ADMIN capability.',
            explanation:
              'Adding CAP_SYS_ADMIN is itself a privilege escalation, so the two settings contradict each other.',
            docsUrl: SECURITY_DOCS,
          });
        }
      }
    }
  },
};

function checkRunAs(
  ctx: RuleContext,
  context: Record<string, unknown> | undefined,
  path: (string | number)[],
  owner: string,
): void {
  if (!context) return;

  const runAsNonRoot = asBoolean(context['runAsNonRoot']);
  const runAsUser = asNumber(context['runAsUser']);

  if (runAsNonRoot === true && runAsUser === 0) {
    ctx.report({
      ruleId: 'pod/run-as-non-root-conflict',
      severity: 'error',
      path: [...path, 'runAsUser'],
      message: `runAsNonRoot: true contradicts runAsUser: 0 for ${owner}.`,
      explanation:
        'UID 0 is root. The kubelet validates this at startup and refuses to run the container. Either drop runAsUser or set it to a non-zero UID.',
      docsUrl: SECURITY_DOCS,
      fix: {
        title: 'Run as UID 1000',
        safe: false,
        ops: [{ op: 'set', path: [...path, 'runAsUser'], value: 1000 }],
      },
    });
  }

  if (runAsUser !== undefined && runAsUser < 0) {
    ctx.report({
      ruleId: 'pod/negative-uid',
      severity: 'error',
      path: [...path, 'runAsUser'],
      message: `runAsUser must not be negative, but is ${runAsUser}.`,
      explanation: 'UIDs are non-negative integers.',
      docsUrl: SECURITY_DOCS,
    });
  }

  for (const field of ['runAsGroup', 'fsGroup'] as const) {
    const value = asNumber(context[field]);
    if (value !== undefined && value < 0) {
      ctx.report({
        ruleId: 'pod/negative-gid',
        severity: 'error',
        path: [...path, field],
        message: `${field} must not be negative, but is ${value}.`,
        explanation: 'GIDs are non-negative integers.',
        docsUrl: SECURITY_DOCS,
      });
    }
  }
}

/** seccomp and AppArmor both use a type/localhostProfile pair that must agree. */
function checkProfiles(
  ctx: RuleContext,
  context: Record<string, unknown> | undefined,
  path: (string | number)[],
): void {
  if (!context) return;

  for (const field of ['seccompProfile', 'appArmorProfile'] as const) {
    const profile = asObject(context[field]);
    if (!profile) continue;
    const type = asString(profile['type']);
    const localhostProfile = profile['localhostProfile'];

    if (type === 'Localhost' && localhostProfile === undefined) {
      ctx.report({
        ruleId: 'pod/localhost-profile-missing',
        severity: 'error',
        path: [...path, field],
        message: `${field} type "Localhost" requires localhostProfile.`,
        explanation:
          '"Localhost" means the profile is a file on the node, so its path — relative to the kubelet\'s configured profile root — has to be given.',
        docsUrl: SECURITY_DOCS,
      });
    }

    if (type !== undefined && type !== 'Localhost' && localhostProfile !== undefined) {
      ctx.report({
        ruleId: 'pod/localhost-profile-unexpected',
        severity: 'error',
        path: [...path, field, 'localhostProfile'],
        message: `localhostProfile may only be set when ${field} type is "Localhost", not "${type}".`,
        explanation: 'The field would be ignored, so the apiserver rejects it to avoid a silent misconfiguration.',
        docsUrl: SECURITY_DOCS,
        fix: {
          title: 'Remove localhostProfile',
          safe: false,
          ops: [{ op: 'delete', path: [...path, field, 'localhostProfile'] }],
        },
      });
    }
  }
}
