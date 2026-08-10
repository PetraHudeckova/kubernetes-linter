import type { Path } from './types.js';
import type { Rule } from './rules/context.js';
import { cronJobRule } from './rules/cronjob.js';
import { daemonSetRule } from './rules/daemonset.js';
import { deploymentRule } from './rules/deployment.js';
import { ingressRule } from './rules/ingress.js';
import { ingressClassRule } from './rules/ingressclass.js';
import { jobRule } from './rules/job.js';
import { persistentVolumeClaimRule } from './rules/persistentvolumeclaim.js';
import { serviceRule } from './rules/service.js';
import { statefulSetRule } from './rules/statefulset.js';

/**
 * Where a kind keeps the Pod it describes. This is the only thing that moves
 * between kinds: a Pod carries its spec at `spec`, a Deployment at
 * `spec.template.spec`. Rules address it through `ctx.at(...)`, so teaching the
 * shared rule set a new workload kind is a matter of naming these paths.
 */
export interface PodTemplate {
  /** Where the PodSpec sits, relative to the document root. */
  specPath: Path;
  /** Where the pod's own metadata sits, relative to the document root. */
  metadataPath: Path;
  /**
   * A list of `{ metadata: { name } }` entries the controller turns into one
   * Pod volume each, named after the entry — a StatefulSet's
   * volumeClaimTemplates. Those names are mountable without appearing in the
   * pod spec's own `volumes`, which is what `ctx.generatedVolumes` carries.
   */
  claimTemplatesPath?: Path;
}

/**
 * What the rule layer needs to know about a kind. Everything else is derived
 * from the schema bundle, which owns the root definition names — a descriptor
 * is keyed by kind name and never repeats a `$ref`.
 */
export interface KindDescriptor {
  kind: string;
  /**
   * Absent for a kind that describes no Pod at all: a Service selects Pods by
   * label, it does not create them. The shared PodSpec rules run only for the
   * kinds that have one, so such a kind is checked by the schema layer, the
   * document-level rules and its own module alone.
   */
  podTemplate?: PodTemplate;
  /**
   * What `metadata.name` has to look like. Most kinds take a DNS subdomain;
   * a StatefulSet takes a label, since its name is the prefix of every Pod
   * name it generates and those are hostnames; a Service takes the stricter
   * RFC 1035 label, since its name is the first component of an SRV record.
   * Defaults to "subdomain".
   */
  nameFormat?: 'subdomain' | 'label' | 'rfc1035';
  /**
   * Set for a kind that lives outside any namespace, so `metadata.namespace`
   * is not merely unusual but forbidden — the apiserver rejects it with "not
   * allowed on this type". `metadata.ts` reads it; everything else about a
   * cluster-scoped kind is the same.
   */
  clusterScoped?: boolean;
  /** Rules that only make sense for this kind, run after the shared ones. */
  rules: Rule[];
}

const POD_TEMPLATE: PodTemplate = {
  specPath: ['spec', 'template', 'spec'],
  metadataPath: ['spec', 'template', 'metadata'],
};

export const KINDS: Record<string, KindDescriptor> = {
  Pod: {
    kind: 'Pod',
    podTemplate: { specPath: ['spec'], metadataPath: ['metadata'] },
    rules: [],
  },
  Deployment: {
    kind: 'Deployment',
    podTemplate: POD_TEMPLATE,
    rules: [deploymentRule],
  },
  StatefulSet: {
    kind: 'StatefulSet',
    podTemplate: { ...POD_TEMPLATE, claimTemplatesPath: ['spec', 'volumeClaimTemplates'] },
    nameFormat: 'label',
    rules: [statefulSetRule],
  },
  DaemonSet: {
    kind: 'DaemonSet',
    podTemplate: POD_TEMPLATE,
    rules: [daemonSetRule],
  },
  Job: {
    kind: 'Job',
    podTemplate: POD_TEMPLATE,
    rules: [jobRule],
  },
  CronJob: {
    kind: 'CronJob',
    // A CronJob's pod template sits one JobTemplateSpec deeper than a Job's:
    // spec.jobTemplate wraps the same JobSpec a Job carries at its own spec,
    // so POD_TEMPLATE's paths do not fit and this kind needs its own literal.
    podTemplate: {
      specPath: ['spec', 'jobTemplate', 'spec', 'template', 'spec'],
      metadataPath: ['spec', 'jobTemplate', 'spec', 'template', 'metadata'],
    },
    rules: [cronJobRule],
  },
  Service: {
    kind: 'Service',
    nameFormat: 'rfc1035',
    rules: [serviceRule],
  },
  Ingress: {
    kind: 'Ingress',
    rules: [ingressRule],
  },
  IngressClass: {
    kind: 'IngressClass',
    clusterScoped: true,
    rules: [ingressClassRule],
  },
  PersistentVolumeClaim: {
    kind: 'PersistentVolumeClaim',
    rules: [persistentVolumeClaimRule],
  },
};
