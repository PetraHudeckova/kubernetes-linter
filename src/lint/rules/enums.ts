import { walkFields, docsUrlFrom } from '../schema.js';
import { didYouMean } from '../suggest.js';
import type { RuleContext, Rule } from './context.js';

interface EnumSpec {
  values: string[];
  /** An empty string is meaningful for some fields (e.g. "match all taints"). */
  allowEmpty?: boolean;
  /** Accept anything starting with one of these, for open-ended families. */
  prefixes?: string[];
  note?: string;
}

/**
 * Enum values, keyed by the definition that owns the field. The Kubernetes
 * OpenAPI document does not carry `enum`, so these are transcribed from the
 * v1.36 field descriptions and API types.
 */
const ENUMS: Record<string, EnumSpec> = {
  'PodSpec.restartPolicy': {
    values: ['Always', 'OnFailure', 'Never'],
    note: 'Defaults to Always.',
  },
  'PodSpec.dnsPolicy': {
    values: ['ClusterFirstWithHostNet', 'ClusterFirst', 'Default', 'None'],
    note: 'Defaults to ClusterFirst.',
  },
  'PodSpec.preemptionPolicy': { values: ['PreemptLowerPriority', 'Never'] },

  'Container.imagePullPolicy': { values: ['Always', 'Never', 'IfNotPresent'] },
  'EphemeralContainer.imagePullPolicy': { values: ['Always', 'Never', 'IfNotPresent'] },
  'Container.terminationMessagePolicy': { values: ['File', 'FallbackToLogsOnError'] },
  'EphemeralContainer.terminationMessagePolicy': { values: ['File', 'FallbackToLogsOnError'] },
  'Container.restartPolicy': {
    values: ['Always', 'Never', 'OnFailure'],
    note: 'On an init container, "Always" turns it into a sidecar that keeps running alongside the main containers.',
  },
  'EphemeralContainer.restartPolicy': { values: ['Always', 'Never', 'OnFailure'] },

  'ContainerPort.protocol': { values: ['TCP', 'UDP', 'SCTP'], note: 'Defaults to TCP.' },
  'HTTPGetAction.scheme': { values: ['HTTP', 'HTTPS'], note: 'Defaults to HTTP.' },

  'PodOS.name': { values: ['linux', 'windows'] },

  'SeccompProfile.type': { values: ['RuntimeDefault', 'Localhost', 'Unconfined'] },
  'AppArmorProfile.type': { values: ['RuntimeDefault', 'Localhost', 'Unconfined'] },
  'SecurityContext.procMount': { values: ['Default', 'Unmasked'] },
  'PodSecurityContext.fsGroupChangePolicy': { values: ['OnRootMismatch', 'Always'] },
  'PodSecurityContext.seLinuxChangePolicy': { values: ['MountOption', 'Recursive'] },
  'PodSecurityContext.supplementalGroupsPolicy': { values: ['Merge', 'Strict'] },

  'NodeSelectorRequirement.operator': {
    values: ['In', 'NotIn', 'Exists', 'DoesNotExist', 'Gt', 'Lt'],
  },
  'LabelSelectorRequirement.operator': { values: ['In', 'NotIn', 'Exists', 'DoesNotExist'] },

  'Toleration.operator': { values: ['Equal', 'Exists', 'Gt', 'Lt'], note: 'Defaults to Equal.' },
  'Toleration.effect': {
    values: ['NoSchedule', 'PreferNoSchedule', 'NoExecute'],
    allowEmpty: true,
    note: 'An empty effect matches all taint effects.',
  },

  'TopologySpreadConstraint.whenUnsatisfiable': { values: ['DoNotSchedule', 'ScheduleAnyway'] },
  'TopologySpreadConstraint.nodeAffinityPolicy': { values: ['Honor', 'Ignore'] },
  'TopologySpreadConstraint.nodeTaintsPolicy': { values: ['Honor', 'Ignore'] },

  'EmptyDirVolumeSource.medium': {
    values: ['Memory'],
    allowEmpty: true,
    prefixes: ['HugePages'],
    note: 'An empty value uses the node\'s default medium (disk); "Memory" backs the volume with a tmpfs.',
  },
  'ImageVolumeSource.pullPolicy': { values: ['Always', 'Never', 'IfNotPresent'] },
  'PersistentVolumeClaimSpec.volumeMode': { values: ['Filesystem', 'Block'] },

  'ContainerResizePolicy.resourceName': { values: ['cpu', 'memory'] },
  'ContainerResizePolicy.restartPolicy': { values: ['NotRequired', 'RestartContainer'] },
  'ContainerRestartRule.action': { values: ['Restart'] },
  'ContainerRestartRuleOnExitCodes.operator': { values: ['In', 'NotIn'] },

  'PodCertificateProjection.keyType': {
    values: ['RSA3072', 'RSA4096', 'ECDSAP256', 'ECDSAP384', 'ECDSAP521', 'ED25519'],
  },

  'Lifecycle.stopSignal': {
    values: [
      'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCLD', 'SIGCONT', 'SIGFPE', 'SIGHUP',
      'SIGILL', 'SIGINT', 'SIGIO', 'SIGIOT', 'SIGKILL', 'SIGPIPE', 'SIGPOLL', 'SIGPROF',
      'SIGPWR', 'SIGQUIT', 'SIGSEGV', 'SIGSTKFLT', 'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP',
      'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGWINCH',
      'SIGXCPU', 'SIGXFSZ',
    ],
    prefixes: ['SIGRTMIN', 'SIGRTMAX'],
  },

  'DeploymentStrategy.type': {
    values: ['RollingUpdate', 'Recreate'],
    note: 'Defaults to RollingUpdate.',
  },

  'DaemonSetUpdateStrategy.type': {
    values: ['RollingUpdate', 'OnDelete'],
    note: 'Defaults to RollingUpdate.',
  },

  'ServiceSpec.type': {
    values: ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'],
    note: 'Defaults to ClusterIP. Each type but ExternalName builds on the one before it: a NodePort Service also has a cluster IP, and a LoadBalancer Service also has a node port.',
  },
  'ServiceSpec.sessionAffinity': { values: ['ClientIP', 'None'], note: 'Defaults to None.' },
  'ServiceSpec.externalTrafficPolicy': {
    values: ['Cluster', 'Local'],
    note: 'Defaults to Cluster.',
  },
  'ServiceSpec.internalTrafficPolicy': {
    values: ['Cluster', 'Local'],
    note: 'Defaults to Cluster.',
  },
  'ServiceSpec.ipFamilyPolicy': {
    values: ['SingleStack', 'PreferDualStack', 'RequireDualStack'],
    note: 'Defaults to SingleStack.',
  },
  'ServiceSpec.trafficDistribution': {
    values: ['PreferClose', 'PreferSameZone', 'PreferSameNode'],
    note: 'PreferSameZone and PreferSameNode were added in 1.33; PreferSameZone is the newer spelling of PreferClose.',
  },
  'ServicePort.protocol': { values: ['TCP', 'UDP', 'SCTP'], note: 'Defaults to TCP.' },

  'HTTPIngressPath.pathType': {
    values: ['Exact', 'Prefix', 'ImplementationSpecific'],
    note: 'There is no default: an Ingress path must say how it is matched. "Prefix" splits both the request path and the rule path on "/" and compares them element by element, so it matches whole path segments rather than a string prefix.',
  },

  'IngressClassParametersReference.scope': {
    values: ['Cluster', 'Namespace'],
    note: 'Defaults to Cluster. "Namespace" requires parameters.namespace beside it; "Cluster" forbids it.',
  },

  'StatefulSetSpec.podManagementPolicy': {
    values: ['OrderedReady', 'Parallel'],
    note: 'Defaults to OrderedReady, which starts and replaces Pods one at a time, in ordinal order.',
  },
  'StatefulSetUpdateStrategy.type': {
    values: ['RollingUpdate', 'OnDelete'],
    note: 'Defaults to RollingUpdate.',
  },
  'StatefulSetPersistentVolumeClaimRetentionPolicy.whenDeleted': {
    values: ['Retain', 'Delete'],
    note: 'Defaults to Retain.',
  },
  'StatefulSetPersistentVolumeClaimRetentionPolicy.whenScaled': {
    values: ['Retain', 'Delete'],
    note: 'Defaults to Retain.',
  },

  // Status fields, which show up whenever someone pastes `kubectl get -o yaml`.
  'PodStatus.phase': { values: ['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown'] },
  'PodStatus.qosClass': { values: ['Guaranteed', 'Burstable', 'BestEffort'] },
  'PodCondition.status': { values: ['True', 'False', 'Unknown'] },
  'ResourceHealth.health': { values: ['Healthy', 'Unhealthy', 'Unknown'] },
  'DeploymentCondition.status': { values: ['True', 'False', 'Unknown'] },
  'DaemonSetCondition.status': { values: ['True', 'False', 'Unknown'] },
  'StatefulSetCondition.status': { values: ['True', 'False', 'Unknown'] },
  'PersistentVolumeClaimStatus.phase': { values: ['Pending', 'Bound', 'Lost'] },
  'PersistentVolumeClaimCondition.status': { values: ['True', 'False', 'Unknown'] },
  'PortStatus.protocol': { values: ['TCP', 'UDP', 'SCTP'] },
  'IngressPortStatus.protocol': { values: ['TCP', 'UDP', 'SCTP'] },
  // meta/v1 Condition, which a ServiceStatus carries.
  'Condition.status': { values: ['True', 'False', 'Unknown'] },
};

export const enumRule: Rule = {
  id: 'enum/values',
  run(ctx: RuleContext) {
    walkFields(ctx.doc, ctx.schema, ({ path, value, owner, field, property }) => {
      const spec = ENUMS[`${owner}.${field}`];
      if (!spec || typeof value !== 'string') return;

      if (value === '' && spec.allowEmpty) return;
      if (spec.values.includes(value)) return;
      if (spec.prefixes?.some((prefix) => value.startsWith(prefix))) return;

      const suggestion = didYouMean(value, spec.values);
      const allowed = spec.values.map((v) => `"${v}"`).join(', ');

      ctx.report({
        ruleId: 'enum/invalid-value',
        severity: 'error',
        path,
        message: suggestion
          ? `"${value}" is not a valid ${field}. Did you mean "${suggestion}"?`
          : `"${value}" is not a valid ${field}.`,
        explanation: [
          `Allowed values are ${allowed}${spec.allowEmpty ? ' (or an empty string)' : ''}. Values are case-sensitive.`,
          spec.note,
          property.description,
        ]
          .filter(Boolean)
          .join('\n\n'),
        docsUrl: docsUrlFrom(property.description),
        fix: suggestion
          ? { title: `Change to "${suggestion}"`, safe: true, ops: [{ op: 'set', path, value: suggestion }] }
          : undefined,
      });
    });
  },
};
