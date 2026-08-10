import { describe, expect, it } from 'vitest';
import {
  lint,
  loadSchema,
  isKnownVersion,
  AVAILABLE_VERSIONS,
  DEFAULT_VERSION,
} from '../src/lint/index.js';
import { EXAMPLES } from '../src/ui/examples.js';
import {
  VALID_CRONJOB,
  VALID_DAEMONSET,
  VALID_DEPLOYMENT,
  VALID_INGRESS,
  VALID_INGRESS_CLASS,
  VALID_JOB,
  VALID_PERSISTENTVOLUMECLAIM,
  VALID_SERVICE,
  VALID_STATEFULSET,
  cronJobWithPodSpec,
  daemonSetWithPodSpec,
  deploymentWithPodSpec,
  ingressClassParameters,
  ingressPath,
  ingressWithPaths,
  job,
  jobWithPodSpec,
  persistentVolumeClaim,
  pod,
  podWithContainer,
  service,
  statefulSet,
  statefulSetWithPodSpec,
} from './helpers.js';

const schemaFor = (version: string) => loadSchema(version);

async function ruleIdsAt(version: string, yaml: string): Promise<string[]> {
  return lint(yaml, await schemaFor(version)).findings.map((finding) => finding.ruleId);
}

describe('bundled versions', () => {
  it('covers 1.25 through 1.36, newest first', () => {
    expect(AVAILABLE_VERSIONS[0]).toBe('1.36');
    expect(AVAILABLE_VERSIONS.at(-1)).toBe('1.25');
    expect(AVAILABLE_VERSIONS).toHaveLength(12);
    expect(DEFAULT_VERSION).toBe('1.36');
  });

  it('recognises only the versions it ships', () => {
    expect(isKnownVersion('1.30')).toBe(true);
    expect(isKnownVersion('1.24')).toBe(false);
    expect(isKnownVersion('nonsense')).toBe(false);
  });

  it('rejects a request for a version it does not have', async () => {
    await expect(loadSchema('1.24')).rejects.toThrow(/No schema bundled/);
  });

  it('reports its own version', async () => {
    for (const version of AVAILABLE_VERSIONS) {
      expect((await schemaFor(version)).version).toBe(version);
    }
  });

  it('lints the valid example cleanly on every version', async () => {
    // Catches a botched regeneration: a truncated or mis-scoped schema file
    // would light this manifest up with spurious findings.
    const valid = EXAMPLES.find((example) => example.id === 'valid')!;
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(valid.yaml, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('carries a root for every kind on every version', async () => {
    for (const version of AVAILABLE_VERSIONS) {
      const schema = await schemaFor(version);
      expect(schema.kinds, version).toEqual([
        'Pod',
        'Deployment',
        'StatefulSet',
        'DaemonSet',
        'Job',
        'CronJob',
        'Service',
        'Ingress',
        'IngressClass',
        'PersistentVolumeClaim',
      ]);
      expect(schema.for('Deployment')?.apiVersion, version).toBe('apps/v1');
      expect(schema.for('StatefulSet')?.apiVersion, version).toBe('apps/v1');
      expect(schema.for('DaemonSet')?.apiVersion, version).toBe('apps/v1');
      expect(schema.for('Job')?.apiVersion, version).toBe('batch/v1');
      expect(schema.for('CronJob')?.apiVersion, version).toBe('batch/v1');
      expect(schema.for('Pod')?.apiVersion, version).toBe('v1');
      expect(schema.for('Service')?.apiVersion, version).toBe('v1');
      expect(schema.for('Ingress')?.apiVersion, version).toBe('networking.k8s.io/v1');
      expect(schema.for('IngressClass')?.apiVersion, version).toBe('networking.k8s.io/v1');
      expect(schema.for('PersistentVolumeClaim')?.apiVersion, version).toBe('v1');
    }
  });

  it('lints a valid Deployment cleanly on every version', async () => {
    // The Deployment closure is generated alongside the Pod one, so the same
    // regeneration tripwire has to cover the second root.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_DEPLOYMENT, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid StatefulSet cleanly on every version', async () => {
    // Covers the third root, and with it PersistentVolumeClaim, which only the
    // StatefulSet closure pulls in.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_STATEFULSET, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid DaemonSet cleanly on every version', async () => {
    // The fourth root, and the tripwire for the closure it adds.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_DAEMONSET, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid Job cleanly on every version', async () => {
    // The fifth root, and the only one in the batch group — it reaches PodSpec
    // through the same PodTemplateSpec the apps kinds do, but its own spec and
    // the two policies hanging off it are its alone.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_JOB, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid CronJob cleanly on every version', async () => {
    // The sixth root, nested one level deeper than the other five: its
    // JobTemplateSpec wraps the same JobSpec the Job root already reaches, so
    // this is the tripwire for CronJob, CronJobSpec, CronJobStatus and
    // JobTemplateSpec specifically.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_CRONJOB, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid Service cleanly on every version', async () => {
    // The seventh root, and the only one that shares nothing with the pod
    // closure — a truncated Service bundle would show up here alone.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_SERVICE, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid Ingress cleanly on every version', async () => {
    // The eighth root, and the only one outside the core and apps groups — a
    // regeneration that dropped the networking closure would show up here.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_INGRESS, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid IngressClass cleanly on every version', async () => {
    // The ninth root. It reaches only two definitions of its own, so a
    // regeneration that dropped them would be invisible everywhere but here.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_INGRESS_CLASS, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('lints a valid PersistentVolumeClaim cleanly on every version', async () => {
    // The tenth root. Its closure was already pulled in by StatefulSet's
    // volumeClaimTemplates, so this is the tripwire for the roots map alone.
    for (const version of AVAILABLE_VERSIONS) {
      const { findings } = lint(VALID_PERSISTENTVOLUMECLAIM, await schemaFor(version));
      expect(findings, `${version}: ${findings.map((f) => f.message).join('; ')}`).toEqual([]);
    }
  });

  it('checks an IngressClass the same way on every version', async () => {
    // IngressClass reached v1 in 1.19 and its parameters reference has carried
    // scope and namespace since before the 1.25 floor, so nothing in its rule
    // module is version-gated.
    const yaml = ingressClassParameters('    kind: IngressParameters\n    name: p\n    namespace: ns\n');
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual([
        'ingressclass/parameters-namespace-not-allowed',
      ]);
    }
  });

  it('checks an Ingress the same way on every version', async () => {
    // networking/v1 Ingress has been served unchanged since 1.19, so nothing in
    // its rule module is version-gated and the same manifest has to produce the
    // same findings across the whole range.
    const yaml = ingressWithPaths(ingressPath('/a', 'Exact') + ingressPath('/a', 'Exact'));
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual(['ingress/duplicate-path']);
    }
  });

  it('checks a Service the same way on every version', async () => {
    // Nothing this rule module reads arrived after 1.25, so the same manifest
    // has to produce the same findings across the whole range.
    const yaml = service('  type: LoadBalancer\n  clusterIP: None\n  ports:\n    - port: 80\n');
    for (const version of AVAILABLE_VERSIONS) {
      expect(await ruleIdsAt(version, yaml), version).toEqual(['service/headless-with-external-type']);
    }
  });

  it('applies version-gated pod spec rules under a DaemonSet template', async () => {
    const yaml = daemonSetWithPodSpec('      hostnameOverride: Not_A_Name\n');
    expect(await ruleIdsAt('1.36', yaml)).toContain('pod/invalid-spec-name');
    expect(await ruleIdsAt('1.33', yaml)).toEqual(['schema/unknown-field']);
  });

  it('applies version-gated pod spec rules under a Deployment template', async () => {
    // hostnameOverride arrived in 1.34. The gate resolves the field through
    // the kind's own spec path, so it must still close on an older target
    // rather than silently passing everything.
    const yaml = deploymentWithPodSpec('      hostnameOverride: Not_A_Name\n');
    expect(await ruleIdsAt('1.36', yaml)).toContain('pod/invalid-spec-name');
    expect(await ruleIdsAt('1.33', yaml)).toEqual(['schema/unknown-field']);
  });

  it('applies version-gated pod spec rules under a StatefulSet template', async () => {
    const yaml = statefulSetWithPodSpec('      hostnameOverride: Not_A_Name\n');
    expect(await ruleIdsAt('1.36', yaml)).toContain('pod/invalid-spec-name');
    expect(await ruleIdsAt('1.33', yaml)).toEqual(['schema/unknown-field']);
  });

  it('applies version-gated pod spec rules under a Job template', async () => {
    const yaml = jobWithPodSpec('      hostnameOverride: Not_A_Name\n');
    expect(await ruleIdsAt('1.36', yaml)).toContain('pod/invalid-spec-name');
    expect(await ruleIdsAt('1.33', yaml)).toEqual(['schema/unknown-field']);
  });

  it('applies version-gated pod spec rules under a CronJob template', async () => {
    // The sharpest test that the gate resolves through the deepest spec path
    // in the bundle: spec.jobTemplate.spec.template.spec, four segments below
    // the document root rather than the usual one or two.
    const yaml = cronJobWithPodSpec('          hostnameOverride: Not_A_Name\n');
    expect(await ruleIdsAt('1.36', yaml)).toContain('pod/invalid-spec-name');
    expect(await ruleIdsAt('1.33', yaml)).toEqual(['schema/unknown-field']);
  });
});

describe('Job fields that came and went', () => {
  it('accepts the per-index fields from 1.28', async () => {
    const yaml = job('  completionMode: Indexed\n  completions: 4\n  backoffLimitPerIndex: 1\n');

    expect(await ruleIdsAt('1.27', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.28', yaml)).toEqual([]);
  });

  it('does not double-report a per-index rule on a version without the field', async () => {
    // backoffLimitPerIndex needs Indexed completion, but on 1.27 the field does
    // not exist at all and only the schema layer should speak.
    const yaml = job('  backoffLimitPerIndex: 1\n');

    expect(await ruleIdsAt('1.27', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.28', yaml)).toEqual(['job/requires-indexed-completion']);
  });

  it('accepts successPolicy and managedBy from 1.30', async () => {
    const yaml = job(
      '  completionMode: Indexed\n  completions: 4\n  managedBy: kueue.x-k8s.io/multikueue\n' +
        '  successPolicy:\n    rules:\n      - succeededIndexes: "0-2"\n',
    );

    expect(await ruleIdsAt('1.29', yaml)).toEqual(['schema/unknown-field', 'schema/unknown-field']);
    expect(await ruleIdsAt('1.30', yaml)).toEqual([]);
  });

  it('requires a pod condition status up to 1.34 in the schema and in the rule after', async () => {
    // 1.35 dropped `status` from the required list in the OpenAPI definition,
    // but validation still rejects a pattern without one — so the report has to
    // move from layer 1 to the rule module rather than disappear.
    const yaml = job(
      '  podFailurePolicy:\n    rules:\n      - action: Ignore\n' +
        '        onPodConditions:\n          - type: DisruptionTarget\n',
    );

    expect(await ruleIdsAt('1.34', yaml)).toEqual(['schema/required-field']);
    expect(await ruleIdsAt('1.35', yaml)).toEqual(['job/missing-pod-condition-status']);
    expect(await ruleIdsAt('1.36', yaml)).toEqual(['job/missing-pod-condition-status']);
  });
});

describe('Service fields that came and went', () => {
  it('accepts spec.trafficDistribution from 1.30', async () => {
    const yaml = service('  trafficDistribution: PreferClose\n  ports:\n    - port: 80\n');

    expect(await ruleIdsAt('1.29', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.30', yaml)).toEqual([]);
  });

  it('does not double-report a bad value on a version without the field', async () => {
    const yaml = service('  trafficDistribution: PreferNear\n  ports:\n    - port: 80\n');

    expect(await ruleIdsAt('1.29', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.30', yaml)).toContain('enum/invalid-value');
  });
});

describe('StatefulSet fields that came and went', () => {
  it('accepts spec.ordinals from 1.26', async () => {
    const yaml = statefulSet('  ordinals:\n    start: 1\n');

    expect(await ruleIdsAt('1.25', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.26', yaml)).toEqual([]);
  });

  it('does not double-report a negative ordinal on a version without the field', async () => {
    const yaml = statefulSet('  ordinals:\n    start: -1\n');

    expect(await ruleIdsAt('1.25', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.26', yaml)).toContain('statefulset/negative-ordinal-start');
  });

  it('requires serviceName up to 1.32 and leaves it optional from 1.33', async () => {
    // The headless Service stopped being mandatory in 1.33; the requirement
    // itself lives in the generated schema, so this pins the regeneration.
    const yaml = VALID_STATEFULSET.replace('  serviceName: db\n', '');

    expect(await ruleIdsAt('1.32', yaml)).toEqual(['schema/required-field']);
    expect(await ruleIdsAt('1.33', yaml)).toEqual([]);
  });
});

describe('PersistentVolumeClaim fields that came and went', () => {
  it('accepts spec.volumeAttributesClassName from 1.29', async () => {
    const yaml = persistentVolumeClaim(
      '  accessModes:\n    - ReadWriteOnce\n  resources:\n    requests:\n      storage: 10Gi\n' +
        '  volumeAttributesClassName: silver\n',
    );

    expect(await ruleIdsAt('1.28', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.29', yaml)).toEqual([]);
  });

  it('does not double-report an invalid name on a version without the field', async () => {
    const yaml = persistentVolumeClaim(
      '  accessModes:\n    - ReadWriteOnce\n  resources:\n    requests:\n      storage: 10Gi\n' +
        '  volumeAttributesClassName: Not_Valid\n',
    );

    expect(await ruleIdsAt('1.28', yaml)).toEqual(['schema/unknown-field']);
    expect(await ruleIdsAt('1.29', yaml)).toContain(
      'persistentvolumeclaim/invalid-volume-attributes-class-name',
    );
  });
});

describe('fields that came and went', () => {
  it('accepts spec.workloadRef on 1.35 only', async () => {
    // The sharpest check that per-version schemas are really applied:
    // workloadRef was added in 1.35 and removed again in 1.36.
    const yaml = pod('  workloadRef:\n    name: job-1\n  containers:\n    - name: web\n      image: a\n');

    expect(await ruleIdsAt('1.35', yaml)).not.toContain('schema/unknown-field');
    expect(await ruleIdsAt('1.34', yaml)).toContain('schema/unknown-field');
    expect(await ruleIdsAt('1.36', yaml)).toContain('schema/unknown-field');
  });

  it('accepts the image volume source from 1.31', async () => {
    const yaml = pod(
      '  containers:\n    - name: web\n      image: a\n' +
        '      volumeMounts:\n        - name: art\n          mountPath: /art\n' +
        '  volumes:\n    - name: art\n      image:\n        reference: registry.example/art:v1\n',
    );

    expect(await ruleIdsAt('1.30', yaml)).toContain('schema/unknown-field');
    expect(await ruleIdsAt('1.31', yaml)).not.toContain('schema/unknown-field');
    expect(await ruleIdsAt('1.36', yaml)).not.toContain('schema/unknown-field');
  });

  it('accepts pod-level resources from 1.32', async () => {
    const yaml = pod(
      '  resources:\n    limits:\n      cpu: "1"\n  containers:\n    - name: web\n      image: a\n',
    );

    expect(await ruleIdsAt('1.31', yaml)).toContain('schema/unknown-field');
    expect(await ruleIdsAt('1.32', yaml)).not.toContain('schema/unknown-field');
  });

  it('accepts lifecycle stopSignal from 1.33', async () => {
    const yaml = podWithContainer('      lifecycle:\n        stopSignal: SIGUSR1\n');

    expect(await ruleIdsAt('1.32', yaml)).toContain('schema/unknown-field');
    expect(await ruleIdsAt('1.33', yaml)).not.toContain('schema/unknown-field');
  });

  it('still validates enum values on the versions that have the field', async () => {
    // enums.ts self-gates through walkFields, so a bad value must be caught
    // where the field exists and reported as unknown where it does not.
    const yaml = podWithContainer('      lifecycle:\n        stopSignal: SIGNOPE\n');

    expect(await ruleIdsAt('1.33', yaml)).toContain('enum/invalid-value');
    expect(await ruleIdsAt('1.32', yaml)).toContain('schema/unknown-field');
    expect(await ruleIdsAt('1.32', yaml)).not.toContain('enum/invalid-value');
  });
});

describe('version-sensitive rules', () => {
  const initWithProbe = pod(
    '  initContainers:\n    - name: init\n      image: a\n' +
      '      readinessProbe:\n        tcpSocket:\n          port: 1\n' +
      '  containers:\n    - name: web\n      image: b\n',
  );

  it('offers the sidecar fix from 1.28, when Container.restartPolicy exists', async () => {
    for (const version of ['1.28', '1.31', '1.36']) {
      const finding = lint(initWithProbe, await schemaFor(version)).findings.find(
        (entry) => entry.ruleId === 'pod/init-container-probe',
      );
      expect(finding?.fix?.ops, version).toEqual([
        { op: 'set', path: ['spec', 'initContainers', 0, 'restartPolicy'], value: 'Always' },
      ]);
    }
  });

  it('withholds the sidecar fix before 1.28 and says why', async () => {
    for (const version of ['1.25', '1.26', '1.27']) {
      const finding = lint(initWithProbe, await schemaFor(version)).findings.find(
        (entry) => entry.ruleId === 'pod/init-container-probe',
      );
      // The problem is still reported — only the fix that the target cluster
      // could not honour is withheld.
      expect(finding, version).toBeDefined();
      expect(finding?.fix, version).toBeUndefined();
      expect(finding?.explanation, version).toContain('1.28 or newer');
      expect(finding?.explanation, version).toContain(version);
    }
  });

  it('does not double-report a field the target version has never heard of', async () => {
    // hostnameOverride arrived in 1.34; on 1.33 the schema layer alone should
    // speak, not the name-format rule as well.
    const yaml = pod('  hostnameOverride: Not_A_DNS_Name\n  containers:\n    - name: web\n      image: a\n');

    const older = await ruleIdsAt('1.33', yaml);
    expect(older).toContain('schema/unknown-field');
    expect(older).not.toContain('pod/invalid-spec-name');

    expect(await ruleIdsAt('1.34', yaml)).toContain('pod/invalid-spec-name');
  });
});
