import { isDNS1123Label, isDNS1123Subdomain } from '../../k8s/names.js';
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  type Rule,
  type RuleContext,
} from './context.js';

const MAX_NAMESERVERS = 3;
const MAX_SEARCHES = 32;

const DNS_DOCS = 'https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/';

export const podSpecRule: Rule = {
  id: 'pod/spec',
  run(ctx: RuleContext) {
    const spec = ctx.spec;
    const hostNetwork = spec['hostNetwork'] === true;
    const dnsPolicy = asString(spec['dnsPolicy']);
    const dnsConfig = asObject(spec['dnsConfig']);

    /* DNS */

    if (dnsPolicy === 'None') {
      const nameservers = asArray(dnsConfig?.['nameservers']);
      if (!nameservers || nameservers.length === 0) {
        ctx.report({
          ruleId: 'pod/dns-none-without-config',
          severity: 'error',
          path: ['spec', 'dnsPolicy'],
          message: 'dnsPolicy: None requires at least one nameserver in spec.dnsConfig.',
          explanation:
            '"None" tells the kubelet to ignore the cluster DNS settings entirely, so the Pod would be left with no resolver at all unless dnsConfig supplies one.',
          docsUrl: DNS_DOCS,
          fix: {
            title: 'Add a dnsConfig with a nameserver',
            safe: false,
            ops: [{ op: 'set', path: ['spec', 'dnsConfig', 'nameservers'], value: ['1.1.1.1'] }],
          },
        });
      }
    }

    if (hostNetwork && (dnsPolicy === undefined || dnsPolicy === 'ClusterFirst')) {
      ctx.report({
        ruleId: 'pod/host-network-dns-policy',
        severity: 'warning',
        path: ['spec', dnsPolicy === undefined ? 'hostNetwork' : 'dnsPolicy'],
        message: `With hostNetwork: true, dnsPolicy ${dnsPolicy === undefined ? 'defaults to ClusterFirst, which' : 'is ClusterFirst, which'} falls back to the node's resolver.`,
        explanation:
          'A Pod on the host network uses the node\'s DNS configuration under ClusterFirst, so in-cluster names such as my-service.my-namespace.svc will not resolve. Use ClusterFirstWithHostNet to keep cluster DNS.',
        docsUrl: DNS_DOCS,
        fix: {
          title: 'Set dnsPolicy: ClusterFirstWithHostNet',
          safe: false,
          ops: [{ op: 'set', path: ['spec', 'dnsPolicy'], value: 'ClusterFirstWithHostNet' }],
        },
      });
    }

    if (dnsConfig) {
      const nameservers = asArray(dnsConfig['nameservers']);
      if (nameservers && nameservers.length > MAX_NAMESERVERS) {
        ctx.report({
          ruleId: 'pod/too-many-nameservers',
          severity: 'error',
          path: ['spec', 'dnsConfig', 'nameservers'],
          message: `At most ${MAX_NAMESERVERS} nameservers are allowed, but ${nameservers.length} are listed.`,
          explanation: 'This mirrors the resolv.conf limit that the kubelet writes into the Pod.',
          docsUrl: DNS_DOCS,
        });
      }

      const searches = asArray(dnsConfig['searches']);
      if (searches && searches.length > MAX_SEARCHES) {
        ctx.report({
          ruleId: 'pod/too-many-dns-searches',
          severity: 'error',
          path: ['spec', 'dnsConfig', 'searches'],
          message: `At most ${MAX_SEARCHES} search domains are allowed, but ${searches.length} are listed.`,
          explanation: 'This mirrors the resolv.conf limit that the kubelet writes into the Pod.',
          docsUrl: DNS_DOCS,
        });
      }

      asArray(dnsConfig['options'])?.forEach((entry, index) => {
        const option = asObject(entry);
        if (option && option['name'] === undefined) {
          ctx.report({
            ruleId: 'pod/dns-option-without-name',
            severity: 'error',
            path: ['spec', 'dnsConfig', 'options', index],
            message: 'Each dnsConfig option must have a name.',
            explanation: 'Options map to resolv.conf entries such as "ndots" or "timeout".',
            docsUrl: DNS_DOCS,
          });
        }
      });
    }

    /* Namespace sharing */

    if (spec['hostUsers'] === false) {
      for (const field of ['hostNetwork', 'hostPID', 'hostIPC'] as const) {
        if (spec[field] === true) {
          ctx.report({
            ruleId: 'pod/host-users-conflict',
            severity: 'error',
            path: ['spec', field],
            message: `hostUsers: false cannot be combined with ${field}: true.`,
            explanation:
              'A user namespace isolates the Pod from the host\'s UID range, which is incompatible with sharing any other host namespace.',
            docsUrl: 'https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/',
          });
        }
      }
    }

    if (spec['shareProcessNamespace'] === true && spec['hostPID'] === true) {
      ctx.report({
        ruleId: 'pod/share-process-namespace-conflict',
        severity: 'error',
        path: ['spec', 'shareProcessNamespace'],
        message: 'shareProcessNamespace and hostPID cannot both be true.',
        explanation:
          'shareProcessNamespace creates one PID namespace shared by the containers in the Pod; hostPID puts them in the node\'s PID namespace instead. They are mutually exclusive.',
        docsUrl:
          'https://kubernetes.io/docs/tasks/configure-pod-container/share-process-namespace/',
      });
    }

    /* Service account */

    const serviceAccount = asString(spec['serviceAccount']);
    const serviceAccountName = asString(spec['serviceAccountName']);
    if (serviceAccount !== undefined) {
      if (serviceAccountName === undefined) {
        ctx.report({
          ruleId: 'pod/deprecated-service-account',
          severity: 'warning',
          path: ['spec', 'serviceAccount'],
          anchor: 'key',
          message: '"serviceAccount" is deprecated; use "serviceAccountName".',
          explanation: 'The two fields are kept in sync by the apiserver, but only serviceAccountName is maintained.',
          fix: {
            title: 'Rename to serviceAccountName',
            safe: true,
            ops: [{ op: 'rename', path: ['spec', 'serviceAccount'], to: 'serviceAccountName' }],
          },
        });
      } else if (serviceAccount !== serviceAccountName) {
        ctx.report({
          ruleId: 'pod/service-account-mismatch',
          severity: 'error',
          path: ['spec', 'serviceAccount'],
          message: `"serviceAccount" (${serviceAccount}) and "serviceAccountName" (${serviceAccountName}) must match.`,
          explanation:
            'serviceAccount is a deprecated alias of serviceAccountName, so the apiserver rejects conflicting values. Delete the deprecated field.',
          fix: {
            title: 'Remove the deprecated "serviceAccount"',
            safe: true,
            ops: [{ op: 'delete', path: ['spec', 'serviceAccount'] }],
          },
        });
      }
    }

    asArray(spec['imagePullSecrets'])?.forEach((entry, index) => {
      const secret = asObject(entry);
      if (!secret) return;
      const name = asString(secret['name']);
      if (name === undefined || name === '') {
        ctx.report({
          ruleId: 'pod/image-pull-secret-without-name',
          severity: 'error',
          path: ['spec', 'imagePullSecrets', index],
          message: 'Each imagePullSecrets entry must name a Secret.',
          explanation: 'The referenced Secret must exist in the same namespace as the Pod.',
          docsUrl:
            'https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/',
        });
      }
    });

    /* Numeric fields */

    const activeDeadline = asNumber(spec['activeDeadlineSeconds']);
    if (activeDeadline !== undefined && activeDeadline < 1) {
      ctx.report({
        ruleId: 'pod/invalid-active-deadline',
        severity: 'error',
        path: ['spec', 'activeDeadlineSeconds'],
        message: `activeDeadlineSeconds must be at least 1, but is ${activeDeadline}.`,
        explanation: 'It is the number of seconds the Pod may run before being marked failed.',
      });
    }

    const grace = asNumber(spec['terminationGracePeriodSeconds']);
    if (grace !== undefined && grace < 0) {
      ctx.report({
        ruleId: 'pod/invalid-grace-period',
        severity: 'error',
        path: ['spec', 'terminationGracePeriodSeconds'],
        message: `terminationGracePeriodSeconds must not be negative, but is ${grace}.`,
        explanation:
          'It is how long the kubelet waits after SIGTERM before sending SIGKILL. Zero means immediate deletion.',
      });
    }

    /* Hostname */

    for (const [field, check] of [
      ['hostname', isDNS1123Label],
      ['subdomain', isDNS1123Label],
      ['hostnameOverride', isDNS1123Subdomain],
      ['priorityClassName', isDNS1123Subdomain],
      ['runtimeClassName', isDNS1123Subdomain],
      ['schedulerName', isDNS1123Subdomain],
    ] as const) {
      const value = asString(spec[field]);
      if (value === undefined) continue;
      // Some of these arrived late (hostnameOverride in 1.34). On an older
      // target the schema layer already reports the field as unknown; adding a
      // format complaint on top would just be noise.
      if (!ctx.supports(['spec', field])) continue;
      const result = check(value);
      if (!result.ok) {
        ctx.report({
          ruleId: 'pod/invalid-spec-name',
          severity: 'error',
          path: ['spec', field],
          message: `"${value}" is not a valid ${field}: it ${result.reason}.`,
          explanation: 'This field must be a valid DNS name.',
        });
      }
    }

    /* Scheduling shortcuts */

    if (asString(spec['nodeName']) !== undefined) {
      const overridden = ['affinity', 'nodeSelector', 'topologySpreadConstraints'].filter(
        (field) => spec[field] !== undefined,
      );
      if (overridden.length > 0) {
        ctx.report({
          ruleId: 'pod/node-name-bypasses-scheduler',
          severity: 'warning',
          path: ['spec', 'nodeName'],
          message: `nodeName is set, so ${overridden.join(', ')} ${overridden.length === 1 ? 'is' : 'are'} ignored.`,
          explanation:
            'Setting nodeName binds the Pod to a node directly and skips the scheduler entirely, so no scheduling constraint is evaluated. Remove nodeName if you want these honoured.',
          docsUrl: 'https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/',
        });
      }
    }

    /* Windows Pods */

    const osName = asString(asObject(spec['os'])?.['name']);
    if (osName === 'windows') {
      const forbidden = ['hostPID', 'hostIPC', 'shareProcessNamespace'];
      for (const field of forbidden) {
        if (asBoolean(spec[field]) === true) {
          ctx.report({
            ruleId: 'pod/windows-unsupported-field',
            severity: 'error',
            path: ['spec', field],
            message: `${field} cannot be set when spec.os.name is "windows".`,
            explanation: 'Windows nodes have no equivalent of Linux namespaces, so these fields are rejected.',
            docsUrl: 'https://kubernetes.io/docs/concepts/windows/intro/',
          });
        }
      }

      const podSecurityContext = asObject(spec['securityContext']);
      for (const field of ['seLinuxOptions', 'seccompProfile', 'appArmorProfile', 'fsGroup', 'fsGroupChangePolicy', 'sysctls', 'supplementalGroups']) {
        if (podSecurityContext?.[field] !== undefined) {
          ctx.report({
            ruleId: 'pod/windows-unsupported-field',
            severity: 'error',
            path: ['spec', 'securityContext', field],
            message: `securityContext.${field} cannot be set when spec.os.name is "windows".`,
            explanation: 'This is a Linux-only security control.',
            docsUrl: 'https://kubernetes.io/docs/concepts/windows/intro/',
          });
        }
      }
    }

    if (osName === 'linux') {
      const podSecurityContext = asObject(spec['securityContext']);
      if (podSecurityContext?.['windowsOptions'] !== undefined) {
        ctx.report({
          ruleId: 'pod/linux-unsupported-field',
          severity: 'error',
          path: ['spec', 'securityContext', 'windowsOptions'],
          message: 'securityContext.windowsOptions cannot be set when spec.os.name is "linux".',
          explanation: 'Windows-specific options are rejected for Linux Pods.',
        });
      }
    }
  },
};
