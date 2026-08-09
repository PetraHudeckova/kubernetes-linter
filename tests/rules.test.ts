import { describe, expect, it } from 'vitest';
import {
  VALID_DAEMONSET,
  VALID_DEPLOYMENT,
  VALID_STATEFULSET,
  daemonSet,
  daemonSetWithPodSpec,
  deployment,
  deploymentWithPodSpec,
  expectNoRule,
  expectRule,
  expectRules,
  pod,
  podWithContainer,
  statefulSet,
  statefulSetWithPodSpec,
} from './helpers.js';

describe('metadata', () => {
  it('requires a name', () => {
    expectRule(
      'apiVersion: v1\nkind: Pod\nmetadata:\n  labels: {}\nspec:\n  containers:\n    - name: web\n      image: a\n',
      'pod/missing-name',
    );
  });

  it('accepts generateName instead of name', () => {
    expectRules(
      'apiVersion: v1\nkind: Pod\nmetadata:\n  generateName: web-\nspec:\n  containers:\n    - name: web\n      image: a\n',
      [],
    );
  });

  it('rejects an uppercase name and suggests a valid one', () => {
    const finding = expectRule(
      pod('  containers:\n    - name: web\n      image: a\n', '  name: Web-Pod\n'),
      'pod/invalid-name',
    );
    expect(finding.fix?.ops).toEqual([{ op: 'set', path: ['metadata', 'name'], value: 'web-pod' }]);
  });

  it('rejects a namespace that is not a DNS label', () => {
    expectRule(
      pod('  containers:\n    - name: web\n      image: a\n', '  name: web\n  namespace: My_Namespace\n'),
      'pod/invalid-namespace',
    );
  });

  it('rejects an over-long label value', () => {
    expectRule(
      pod(
        '  containers:\n    - name: web\n      image: a\n',
        `  name: web\n  labels:\n    app: ${'x'.repeat(64)}\n`,
      ),
      'pod/invalid-label-value',
    );
  });
});

describe('containers', () => {
  it('requires an image', () => {
    expectRule(pod('  containers:\n    - name: web\n'), 'pod/missing-image');
  });

  it('rejects an empty containers list', () => {
    expectRule(pod('  containers: []\n'), 'pod/no-containers');
  });

  it('rejects an invalid container name', () => {
    expectRule(pod('  containers:\n    - name: Web_1\n      image: a\n'), 'pod/invalid-container-name');
  });

  it('detects a name reused across containers and initContainers', () => {
    const finding = expectRule(
      pod('  initContainers:\n    - name: web\n      image: a\n  containers:\n    - name: web\n      image: b\n'),
      'pod/duplicate-container-name',
    );
    expect(finding.message).toContain('already used by container "web"');
    expect(finding.path).toEqual(['spec', 'initContainers', 0, 'name']);
  });

  it('rejects probes on a plain init container', () => {
    const finding = expectRule(
      pod('  initContainers:\n    - name: init\n      image: a\n      readinessProbe:\n        tcpSocket:\n          port: 1\n  containers:\n    - name: web\n      image: b\n'),
      'pod/init-container-probe',
    );
    expect(finding.fix?.title).toContain('sidecar');
  });

  it('allows probes on a sidecar init container', () => {
    expectNoRule(
      pod('  initContainers:\n    - name: init\n      image: a\n      restartPolicy: Always\n      readinessProbe:\n        tcpSocket:\n          port: 1\n  containers:\n    - name: web\n      image: b\n'),
      'pod/init-container-probe',
    );
  });

  it('rejects ports on an ephemeral container', () => {
    expectRule(
      pod('  containers:\n    - name: web\n      image: a\n  ephemeralContainers:\n    - name: debug\n      image: busybox\n      ports:\n        - containerPort: 80\n'),
      'pod/ephemeral-container-field',
    );
  });

  it('requires an absolute workingDir', () => {
    const finding = expectRule(podWithContainer('      workingDir: app\n'), 'pod/relative-working-dir');
    expect(finding.fix?.ops).toEqual([
      { op: 'set', path: ['spec', 'containers', 0, 'workingDir'], value: '/app' },
    ]);
  });
});

describe('enums', () => {
  it('corrects a lowercase enum value', () => {
    const finding = expectRule(podWithContainer('      imagePullPolicy: always\n'), 'pod/invalid-enum-value');
    expect(finding.fix?.ops).toEqual([
      { op: 'set', path: ['spec', 'containers', 0, 'imagePullPolicy'], value: 'Always' },
    ]);
  });

  it('rejects an unrelated value without guessing', () => {
    const finding = expectRule(pod('  restartPolicy: Sometimes\n  containers:\n    - name: web\n      image: a\n'), 'pod/invalid-enum-value');
    expect(finding.fix).toBeUndefined();
    expect(finding.explanation).toContain('"Always", "OnFailure", "Never"');
  });

  it('applies to nested types wherever they are reused', () => {
    expectRule(
      pod('  containers:\n    - name: web\n      image: a\n  tolerations:\n    - key: k\n      operator: exists\n'),
      'pod/invalid-enum-value',
    );
  });

  it('accepts an empty value where the API allows it', () => {
    expectNoRule(
      pod('  containers:\n    - name: web\n      image: a\n  volumes:\n    - name: d\n      emptyDir:\n        medium: ""\n'),
      'pod/invalid-enum-value',
    );
  });
});

describe('ports', () => {
  it('rejects an out-of-range port', () => {
    expectRule(podWithContainer('      ports:\n        - containerPort: 70000\n'), 'pod/port-out-of-range');
  });

  it('rejects an invalid port name', () => {
    const finding = expectRule(
      podWithContainer('      ports:\n        - containerPort: 80\n          name: HTTP-Port\n'),
      'pod/invalid-port-name',
    );
    expect(finding.message).toContain('lowercase');

    expect(
      expectRule(
        podWithContainer('      ports:\n        - containerPort: 80\n          name: a-very-long-port-name\n'),
        'pod/invalid-port-name',
      ).message,
    ).toContain('at most 15 characters');
  });

  it('detects a port name reused across containers', () => {
    expectRule(
      pod(
        '  containers:\n' +
          '    - name: a\n      image: a\n      ports:\n        - name: http\n          containerPort: 80\n' +
          '    - name: b\n      image: b\n      ports:\n        - name: http\n          containerPort: 81\n',
      ),
      'pod/duplicate-port-name',
    );
  });

  it('detects a host port claimed twice', () => {
    expectRule(
      pod(
        '  containers:\n' +
          '    - name: a\n      image: a\n      ports:\n        - containerPort: 80\n          hostPort: 8080\n' +
          '    - name: b\n      image: b\n      ports:\n        - containerPort: 81\n          hostPort: 8080\n',
      ),
      'pod/duplicate-host-port',
    );
  });

  it('requires hostPort to match containerPort on the host network', () => {
    const finding = expectRule(
      pod('  hostNetwork: true\n  dnsPolicy: ClusterFirstWithHostNet\n  containers:\n    - name: a\n      image: a\n      ports:\n        - containerPort: 80\n          hostPort: 8080\n'),
      'pod/host-network-port-mismatch',
    );
    expect(finding.fix?.safe).toBe(true);
    expect(finding.fix?.ops).toEqual([
      { op: 'set', path: ['spec', 'containers', 0, 'ports', 0, 'hostPort'], value: 80 },
    ]);
  });
});

describe('env', () => {
  it('rejects value together with valueFrom', () => {
    expectRule(
      podWithContainer('      env:\n        - name: A\n          value: "1"\n          valueFrom:\n            fieldRef:\n              fieldPath: metadata.name\n'),
      'pod/env-value-and-value-from',
    );
  });

  it('requires exactly one valueFrom source', () => {
    expectRule(
      podWithContainer('      env:\n        - name: A\n          valueFrom:\n            fieldRef:\n              fieldPath: metadata.name\n            secretKeyRef:\n              name: s\n              key: k\n'),
      'pod/multiple-value-from',
    );
  });

  it('warns about a duplicate variable', () => {
    const finding = expectRule(
      podWithContainer('      env:\n        - name: A\n          value: "1"\n        - name: A\n          value: "2"\n'),
      'pod/duplicate-env-name',
    );
    expect(finding.severity).toBe('warning');
  });

  it('requires exactly one envFrom source', () => {
    expectRule(podWithContainer('      envFrom:\n        - prefix: APP_\n'), 'pod/empty-env-from');
  });
});

describe('volumes', () => {
  const withVolume = (volume: string, mount = '      volumeMounts:\n        - name: data\n          mountPath: /data\n') =>
    pod(`  containers:\n    - name: web\n      image: a\n${mount}  volumes:\n${volume}`);

  it('requires exactly one volume source', () => {
    expectRule(withVolume('    - name: data\n'), 'pod/volume-without-source');
    expectRule(
      withVolume('    - name: data\n      emptyDir: {}\n      hostPath:\n        path: /tmp\n'),
      'pod/volume-multiple-sources',
    );
  });

  it('detects a mount pointing at an undeclared volume and suggests the right one', () => {
    const finding = expectRule(
      withVolume(
        '    - name: data\n      emptyDir: {}\n',
        '      volumeMounts:\n        - name: dat\n          mountPath: /data\n',
      ),
      'pod/volume-mount-not-found',
    );
    expect(finding.message).toContain('Did you mean "data"');
    expect(finding.fix?.safe).toBe(true);
  });

  it('offers to declare a volume when nothing is close', () => {
    const finding = expectRule(
      pod('  containers:\n    - name: web\n      image: a\n      volumeMounts:\n        - name: cache\n          mountPath: /c\n'),
      'pod/volume-mount-not-found',
    );
    expect(finding.fix?.ops[0]).toMatchObject({ op: 'insert', path: ['spec', 'volumes'] });
  });

  it('requires an absolute, unique mountPath', () => {
    expectRule(
      withVolume('    - name: data\n      emptyDir: {}\n', '      volumeMounts:\n        - name: data\n          mountPath: data\n'),
      'pod/relative-mount-path',
    );
    expectRule(
      withVolume(
        '    - name: data\n      emptyDir: {}\n    - name: other\n      emptyDir: {}\n',
        '      volumeMounts:\n        - name: data\n          mountPath: /data\n        - name: other\n          mountPath: /data\n',
      ),
      'pod/duplicate-mount-path',
    );
  });

  it('rejects a subPath that escapes the volume', () => {
    expectRule(
      withVolume(
        '    - name: data\n      emptyDir: {}\n',
        '      volumeMounts:\n        - name: data\n          mountPath: /data\n          subPath: ../etc\n',
      ),
      'pod/sub-path-escapes-volume',
    );
  });
});

describe('resources', () => {
  const resources = (block: string) => podWithContainer(`      resources:\n${block}`);

  it('rejects a request larger than its limit', () => {
    const finding = expectRule(
      resources('        requests:\n          cpu: "500m"\n        limits:\n          cpu: "200m"\n'),
      'pod/request-exceeds-limit',
    );
    expect(finding.fix?.safe).toBe(false);
  });

  it('compares across suffixes', () => {
    expectRule(
      resources('        requests:\n          memory: "1Gi"\n        limits:\n          memory: "512Mi"\n'),
      'pod/request-exceeds-limit',
    );
    expectNoRule(
      resources('        requests:\n          memory: "512Mi"\n        limits:\n          memory: "1Gi"\n'),
      'pod/request-exceeds-limit',
    );
  });

  it('warns when memory is given in milli-units', () => {
    const finding = expectRule(resources('        limits:\n          memory: "512m"\n'), 'pod/milli-byte-quantity');
    expect(finding.message).toContain('0.512 bytes');
    expect(finding.fix?.ops).toEqual([
      { op: 'set', path: ['spec', 'containers', 0, 'resources', 'limits', 'memory'], value: '512Mi' },
    ]);
  });

  it('rejects an unqualified non-standard resource', () => {
    const finding = expectRule(resources('        limits:\n          gpu: "1"\n'), 'pod/unknown-resource-name');
    expect(finding.explanation).toContain('nvidia.com/gpu');
  });

  it('accepts a domain-qualified extended resource', () => {
    expectNoRule(resources('        limits:\n          nvidia.com/gpu: "1"\n'), 'pod/unknown-resource-name');
  });

  it('corrects a misspelled standard resource', () => {
    const finding = expectRule(resources('        limits:\n          memroy: "1Gi"\n'), 'pod/unknown-resource-name');
    expect(finding.fix?.ops).toEqual([
      { op: 'rename', path: ['spec', 'containers', 0, 'resources', 'limits', 'memroy'], to: 'memory' },
    ]);
  });
});

describe('probes', () => {
  const probe = (block: string) => podWithContainer(`      livenessProbe:\n${block}`);

  it('requires exactly one handler', () => {
    expectRule(probe('        periodSeconds: 10\n'), 'pod/probe-without-handler');
    expectRule(
      probe('        httpGet:\n          port: 8080\n        exec:\n          command: ["true"]\n'),
      'pod/probe-multiple-handlers',
    );
  });

  it('requires successThreshold 1 for liveness and startup', () => {
    const finding = expectRule(
      probe('        httpGet:\n          port: 8080\n        successThreshold: 3\n'),
      'pod/probe-success-threshold',
    );
    expect(finding.fix?.safe).toBe(true);
  });

  it('allows a higher successThreshold on readiness', () => {
    expectNoRule(
      podWithContainer('      readinessProbe:\n        httpGet:\n          port: 8080\n        successThreshold: 3\n'),
      'pod/probe-success-threshold',
    );
  });

  it('rejects out-of-range timings', () => {
    expectRule(probe('        httpGet:\n          port: 8080\n        timeoutSeconds: 0\n'), 'pod/probe-value-out-of-range');
  });

  it('resolves a named probe port against the container ports', () => {
    expectNoRule(
      podWithContainer(
        '      ports:\n        - name: http\n          containerPort: 8080\n' +
          '      livenessProbe:\n        httpGet:\n          port: http\n',
      ),
      'pod/probe-port-name-not-found',
    );
    const finding = expectRule(
      podWithContainer(
        '      ports:\n        - name: http\n          containerPort: 8080\n' +
          '      livenessProbe:\n        httpGet:\n          port: htpp\n',
      ),
      'pod/probe-port-name-not-found',
    );
    expect(finding.fix?.ops).toEqual([
      { op: 'set', path: ['spec', 'containers', 0, 'livenessProbe', 'httpGet', 'port'], value: 'http' },
    ]);
  });

  it('checks lifecycle hooks the same way', () => {
    expectRule(
      podWithContainer('      lifecycle:\n        preStop:\n          exec:\n            command: ["a"]\n          sleep:\n            seconds: 5\n'),
      'pod/hook-multiple-handlers',
    );
  });
});

describe('pod spec cross-field rules', () => {
  const spec = (fragment: string) => pod(`${fragment}  containers:\n    - name: web\n      image: a\n`);

  it('requires a nameserver when dnsPolicy is None', () => {
    expectRule(spec('  dnsPolicy: None\n'), 'pod/dns-none-without-config');
    expectNoRule(
      spec('  dnsPolicy: None\n  dnsConfig:\n    nameservers:\n      - 1.1.1.1\n'),
      'pod/dns-none-without-config',
    );
  });

  it('warns about cluster DNS on the host network', () => {
    const finding = expectRule(spec('  hostNetwork: true\n'), 'pod/host-network-dns-policy');
    expect(finding.severity).toBe('warning');
    expectNoRule(
      spec('  hostNetwork: true\n  dnsPolicy: ClusterFirstWithHostNet\n'),
      'pod/host-network-dns-policy',
    );
  });

  it('rejects shareProcessNamespace together with hostPID', () => {
    expectRule(spec('  hostPID: true\n  shareProcessNamespace: true\n'), 'pod/share-process-namespace-conflict');
  });

  it('rejects hostUsers: false alongside a host namespace', () => {
    expectRule(spec('  hostUsers: false\n  hostIPC: true\n'), 'pod/host-users-conflict');
  });

  it('renames the deprecated serviceAccount field', () => {
    const finding = expectRule(spec('  serviceAccount: builder\n'), 'pod/deprecated-service-account');
    expect(finding.fix?.ops).toEqual([
      { op: 'rename', path: ['spec', 'serviceAccount'], to: 'serviceAccountName' },
    ]);
  });

  it('rejects a serviceAccount that disagrees with serviceAccountName', () => {
    expectRule(
      spec('  serviceAccount: old\n  serviceAccountName: new\n'),
      'pod/service-account-mismatch',
    );
  });

  it('warns that nodeName bypasses scheduling constraints', () => {
    expectRule(spec('  nodeName: node-1\n  nodeSelector:\n    disk: ssd\n'), 'pod/node-name-bypasses-scheduler');
  });

  it('rejects Linux-only fields on a Windows Pod', () => {
    expectRule(spec('  os:\n    name: windows\n  hostPID: true\n'), 'pod/windows-unsupported-field');
  });
});

describe('scheduling', () => {
  const spec = (fragment: string) => pod(`${fragment}  containers:\n    - name: web\n      image: a\n`);

  it('rejects values on a unary selector operator', () => {
    const finding = expectRule(
      spec(
        '  affinity:\n    nodeAffinity:\n      requiredDuringSchedulingIgnoredDuringExecution:\n        nodeSelectorTerms:\n          - matchExpressions:\n              - key: disk\n                operator: Exists\n                values: ["ssd"]\n',
      ),
      'pod/selector-values-forbidden',
    );
    expect(finding.fix?.safe).toBe(true);
  });

  it('requires values on a set operator', () => {
    expectRule(
      spec(
        '  affinity:\n    nodeAffinity:\n      requiredDuringSchedulingIgnoredDuringExecution:\n        nodeSelectorTerms:\n          - matchExpressions:\n              - key: disk\n                operator: In\n',
      ),
      'pod/selector-values-required',
    );
  });

  it('requires an integer for Gt and Lt', () => {
    expectRule(
      spec(
        '  affinity:\n    nodeAffinity:\n      requiredDuringSchedulingIgnoredDuringExecution:\n        nodeSelectorTerms:\n          - matchExpressions:\n              - key: cores\n                operator: Gt\n                values: ["many"]\n',
      ),
      'pod/selector-value-not-integer',
    );
  });

  it('rejects an out-of-range preference weight', () => {
    expectRule(
      spec(
        '  affinity:\n    nodeAffinity:\n      preferredDuringSchedulingIgnoredDuringExecution:\n        - weight: 500\n          preference:\n            matchExpressions:\n              - key: disk\n                operator: Exists\n',
      ),
      'pod/invalid-weight',
    );
  });

  it('rejects a value on an Exists toleration', () => {
    expectRule(spec('  tolerations:\n    - key: k\n      operator: Exists\n      value: v\n'), 'pod/toleration-exists-with-value');
  });

  it('rejects tolerationSeconds without NoExecute', () => {
    expectRule(
      spec('  tolerations:\n    - key: k\n      operator: Exists\n      effect: NoSchedule\n      tolerationSeconds: 30\n'),
      'pod/toleration-seconds-without-no-execute',
    );
  });

  it('checks topology spread constraints', () => {
    expectRule(
      spec('  topologySpreadConstraints:\n    - maxSkew: 0\n      topologyKey: zone\n      whenUnsatisfiable: DoNotSchedule\n'),
      'pod/invalid-max-skew',
    );
    expectRule(
      spec('  topologySpreadConstraints:\n    - maxSkew: 1\n      topologyKey: zone\n      whenUnsatisfiable: ScheduleAnyway\n      minDomains: 2\n'),
      'pod/min-domains-requires-do-not-schedule',
    );
  });
});

describe('security context consistency', () => {
  it('rejects runAsNonRoot together with UID 0', () => {
    expectRule(
      pod('  securityContext:\n    runAsNonRoot: true\n    runAsUser: 0\n  containers:\n    - name: web\n      image: a\n'),
      'pod/run-as-non-root-conflict',
    );
  });

  it('rejects privileged together with allowPrivilegeEscalation: false', () => {
    expectRule(
      podWithContainer('      securityContext:\n        privileged: true\n        allowPrivilegeEscalation: false\n'),
      'pod/privileged-without-escalation',
    );
  });

  it('requires localhostProfile for a Localhost seccomp profile', () => {
    expectRule(
      podWithContainer('      securityContext:\n        seccompProfile:\n          type: Localhost\n'),
      'pod/localhost-profile-missing',
    );
  });

  it('rejects localhostProfile for a RuntimeDefault profile', () => {
    expectRule(
      podWithContainer('      securityContext:\n        seccompProfile:\n          type: RuntimeDefault\n          localhostProfile: p.json\n'),
      'pod/localhost-profile-unexpected',
    );
  });
});

describe('deployment', () => {
  it('accepts a minimal Deployment', () => {
    expectRules(VALID_DEPLOYMENT, []);
  });

  describe('selector', () => {
    it('rejects an empty selector', () => {
      const finding = expectRule(
        VALID_DEPLOYMENT.replace('    matchLabels:\n      app: web\n', '    matchLabels: {}\n'),
        'deployment/empty-selector',
      );
      expect(finding.path).toEqual(['spec', 'selector']);
    });

    it('reports a template label that contradicts the selector', () => {
      const finding = expectRule(
        VALID_DEPLOYMENT.replace('      app: web\n  template', '      app: frontend\n  template'),
        'deployment/selector-mismatch',
      );
      expect(finding.path).toEqual(['spec', 'template', 'metadata', 'labels', 'app']);
      expect(finding.fix?.ops).toEqual([
        {
          op: 'set',
          path: ['spec', 'template', 'metadata', 'labels', 'app'],
          value: 'frontend',
        },
      ]);
    });

    it('reports a selector label the template omits entirely', () => {
      const finding = expectRule(
        VALID_DEPLOYMENT.replace('      app: web\n  template', '      app: web\n      tier: api\n  template'),
        'deployment/selector-mismatch',
      );
      expect(finding.path).toEqual(['spec', 'template', 'metadata', 'labels']);
      expect(finding.message).toContain('tier: api');
    });

    it('evaluates matchExpressions against the template labels', () => {
      const yaml = VALID_DEPLOYMENT.replace(
        '    matchLabels:\n      app: web\n',
        '    matchExpressions:\n      - key: app\n        operator: In\n        values: [api, worker]\n',
      );
      const finding = expectRule(yaml, 'deployment/selector-mismatch');
      expect(finding.path).toEqual(['spec', 'selector', 'matchExpressions', 0]);
    });

    it('accepts a matchExpressions selector the template satisfies', () => {
      const yaml = VALID_DEPLOYMENT.replace(
        '    matchLabels:\n      app: web\n',
        '    matchExpressions:\n      - key: app\n        operator: Exists\n',
      );
      expectRules(yaml, []);
    });

    it('checks operator and values consistency under the deployment namespace', () => {
      const yaml = VALID_DEPLOYMENT.replace(
        '    matchLabels:\n      app: web\n',
        '    matchExpressions:\n      - key: app\n        operator: Exists\n        values: [web]\n',
      );
      const finding = expectRule(yaml, 'deployment/selector-values-forbidden');
      expect(finding.path).toEqual(['spec', 'selector', 'matchExpressions', 0, 'values']);
    });

    it('validates selector label keys', () => {
      expectRule(
        VALID_DEPLOYMENT.replace('      app: web\n  template', '      not a key: web\n  template'),
        'pod/invalid-label-key',
      );
    });
  });

  describe('pod template', () => {
    it('requires restartPolicy Always, with a safe fix', () => {
      const finding = expectRule(
        deploymentWithPodSpec('      restartPolicy: OnFailure\n'),
        'deployment/template-restart-policy',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'restartPolicy']);
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'template', 'spec', 'restartPolicy'], value: 'Always' },
      ]);
    });

    it('accepts restartPolicy Always', () => {
      expectRules(deploymentWithPodSpec('      restartPolicy: Always\n'), []);
    });

    it('forbids activeDeadlineSeconds', () => {
      const finding = expectRule(
        deploymentWithPodSpec('      activeDeadlineSeconds: 600\n'),
        'deployment/template-active-deadline',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'delete', path: ['spec', 'template', 'spec', 'activeDeadlineSeconds'] },
      ]);
    });

    it('forbids ephemeral containers', () => {
      expectRule(
        deploymentWithPodSpec('      ephemeralContainers:\n        - name: debug\n          image: busybox\n'),
        'deployment/template-ephemeral-containers',
      );
    });

    it('validates template annotation keys', () => {
      expectRule(
        VALID_DEPLOYMENT.replace(
          '      labels:\n        app: web\n',
          '      labels:\n        app: web\n      annotations:\n        "bad key": x\n',
        ),
        'pod/invalid-annotation-key',
      );
    });
  });

  describe('counters', () => {
    it('rejects negative replicas', () => {
      const finding = expectRule(deployment('  replicas: -1\n'), 'deployment/negative-replicas');
      expect(finding.path).toEqual(['spec', 'replicas']);
    });

    it('accepts zero replicas', () => {
      expectRules(deployment('  replicas: 0\n'), []);
    });

    it('rejects a negative minReadySeconds', () => {
      expectRule(deployment('  minReadySeconds: -5\n'), 'deployment/negative-min-ready-seconds');
    });

    it('rejects a negative revisionHistoryLimit', () => {
      expectRule(
        deployment('  revisionHistoryLimit: -1\n'),
        'deployment/negative-revision-history-limit',
      );
    });

    it('requires progressDeadlineSeconds above minReadySeconds', () => {
      const finding = expectRule(
        deployment('  minReadySeconds: 30\n  progressDeadlineSeconds: 30\n'),
        'deployment/invalid-progress-deadline',
      );
      expect(finding.message).toContain('greater than minReadySeconds');
    });

    it('accepts a progressDeadlineSeconds above minReadySeconds', () => {
      expectRules(deployment('  minReadySeconds: 30\n  progressDeadlineSeconds: 60\n'), []);
    });
  });

  describe('strategy', () => {
    it('rejects rollingUpdate under a Recreate strategy', () => {
      const finding = expectRule(
        deployment('  strategy:\n    type: Recreate\n    rollingUpdate:\n      maxSurge: 1\n'),
        'deployment/rolling-update-with-recreate',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'delete', path: ['spec', 'strategy', 'rollingUpdate'] },
      ]);
    });

    it('accepts rollingUpdate under a RollingUpdate strategy', () => {
      expectRules(
        deployment('  strategy:\n    type: RollingUpdate\n    rollingUpdate:\n      maxSurge: 1\n'),
        [],
      );
    });

    it('rejects maxUnavailable and maxSurge both at zero', () => {
      expectRule(
        deployment('  strategy:\n    rollingUpdate:\n      maxUnavailable: 0\n      maxSurge: 0\n'),
        'deployment/max-unavailable-and-surge-zero',
      );
    });

    it('accepts maxUnavailable 0 when maxSurge is not', () => {
      expectRules(
        deployment('  strategy:\n    rollingUpdate:\n      maxUnavailable: 0\n      maxSurge: 1\n'),
        [],
      );
    });

    it('rejects a percentage above 100', () => {
      expectRule(
        deployment('  strategy:\n    rollingUpdate:\n      maxUnavailable: 150%\n'),
        'deployment/percent-over-100',
      );
    });

    it('accepts percentages within range', () => {
      expectRules(
        deployment('  strategy:\n    rollingUpdate:\n      maxUnavailable: 25%\n      maxSurge: 25%\n'),
        [],
      );
    });

    it('rejects a malformed IntOrString', () => {
      expectRule(
        deployment('  strategy:\n    rollingUpdate:\n      maxSurge: two\n'),
        'deployment/invalid-percent',
      );
    });

    it('leaves an unknown strategy type to the enum rule', () => {
      expectRule(deployment('  strategy:\n    type: Rolling\n'), 'pod/invalid-enum-value');
    });
  });

  describe('pod spec rules under the template', () => {
    it('reports container problems at the template path', () => {
      const finding = expectRule(
        deploymentWithPodSpec('      hostNetwork: true\n      hostUsers: false\n'),
        'pod/host-users-conflict',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'hostNetwork']);
    });

    it('names the template path in messages that quote a field', () => {
      const finding = expectRule(
        deploymentWithPodSpec('      dnsPolicy: None\n'),
        'pod/dns-none-without-config',
      );
      expect(finding.message).toContain('spec.template.spec.dnsConfig');
      expect(finding.fix?.ops).toEqual([
        {
          op: 'set',
          path: ['spec', 'template', 'spec', 'dnsConfig', 'nameservers'],
          value: ['1.1.1.1'],
        },
      ]);
    });

    it('reports a bad container image at the template path', () => {
      const finding = expectRule(
        VALID_DEPLOYMENT.replace('          image: nginx:1.27-alpine\n', ''),
        'pod/missing-image',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'containers', 0]);
    });

    it('checks the Deployment\'s own name, not the template\'s', () => {
      const finding = expectRule(
        VALID_DEPLOYMENT.replace('  name: web\n', '  name: Web-App\n'),
        'pod/invalid-name',
      );
      expect(finding.path).toEqual(['metadata', 'name']);
      expect(finding.message).toContain('Deployment name');
    });
  });
});

describe('statefulset', () => {
  it('accepts a minimal StatefulSet', () => {
    expectRules(VALID_STATEFULSET, []);
  });

  describe('selector', () => {
    it('rejects an empty selector', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace('    matchLabels:\n      app: db\n', '    matchLabels: {}\n'),
        'statefulset/empty-selector',
      );
      expect(finding.path).toEqual(['spec', 'selector']);
    });

    it('reports a template label that contradicts the selector', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace('      app: db\n  template', '      app: postgres\n  template'),
        'statefulset/selector-mismatch',
      );
      expect(finding.path).toEqual(['spec', 'template', 'metadata', 'labels', 'app']);
      expect(finding.fix?.ops).toEqual([
        {
          op: 'set',
          path: ['spec', 'template', 'metadata', 'labels', 'app'],
          value: 'postgres',
        },
      ]);
    });

    it('evaluates matchExpressions against the template labels', () => {
      const yaml = VALID_STATEFULSET.replace(
        '    matchLabels:\n      app: db\n',
        '    matchExpressions:\n      - key: app\n        operator: In\n        values: [api, worker]\n',
      );
      const finding = expectRule(yaml, 'statefulset/selector-mismatch');
      expect(finding.path).toEqual(['spec', 'selector', 'matchExpressions', 0]);
    });

    it('checks operator and values consistency under the statefulset namespace', () => {
      const yaml = VALID_STATEFULSET.replace(
        '    matchLabels:\n      app: db\n',
        '    matchExpressions:\n      - key: app\n        operator: Exists\n        values: [db]\n',
      );
      const finding = expectRule(yaml, 'statefulset/selector-values-forbidden');
      expect(finding.path).toEqual(['spec', 'selector', 'matchExpressions', 0, 'values']);
    });
  });

  describe('pod template', () => {
    it('requires restartPolicy Always, with a safe fix', () => {
      const finding = expectRule(
        statefulSetWithPodSpec('      restartPolicy: OnFailure\n'),
        'statefulset/template-restart-policy',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'restartPolicy']);
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'template', 'spec', 'restartPolicy'], value: 'Always' },
      ]);
    });

    it('forbids activeDeadlineSeconds', () => {
      const finding = expectRule(
        statefulSetWithPodSpec('      activeDeadlineSeconds: 600\n'),
        'statefulset/template-active-deadline',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'delete', path: ['spec', 'template', 'spec', 'activeDeadlineSeconds'] },
      ]);
    });

    it('forbids ephemeral containers', () => {
      expectRule(
        statefulSetWithPodSpec('      ephemeralContainers:\n        - name: debug\n          image: busybox\n'),
        'statefulset/template-ephemeral-containers',
      );
    });

    it('validates template annotation keys', () => {
      expectRule(
        VALID_STATEFULSET.replace(
          '      labels:\n        app: db\n',
          '      labels:\n        app: db\n      annotations:\n        "bad key": x\n',
        ),
        'pod/invalid-annotation-key',
      );
    });
  });

  describe('serviceName', () => {
    it('requires a DNS label, with a fix when one can be spelled', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace('  serviceName: db\n', '  serviceName: DB-Headless\n'),
        'statefulset/invalid-service-name',
      );
      expect(finding.path).toEqual(['spec', 'serviceName']);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'serviceName'], value: 'db-headless' },
      ]);
    });

    it('withholds the fix when the obvious rewrite is still not a label', () => {
      // Lowercasing "DB.headless" leaves the dot, which a Service name may not
      // carry — a name that is a subdomain but not a label.
      const finding = expectRule(
        VALID_STATEFULSET.replace('  serviceName: db\n', '  serviceName: DB.headless\n'),
        'statefulset/invalid-service-name',
      );
      expect(finding.fix).toBeUndefined();
    });

    it('accepts an empty serviceName, which asks for no governing Service', () => {
      expectRules(VALID_STATEFULSET.replace('  serviceName: db\n', '  serviceName: ""\n'), []);
    });
  });

  describe('counters', () => {
    it('rejects negative replicas', () => {
      const finding = expectRule(statefulSet('  replicas: -1\n'), 'statefulset/negative-replicas');
      expect(finding.path).toEqual(['spec', 'replicas']);
    });

    it('accepts zero replicas', () => {
      expectRules(statefulSet('  replicas: 0\n'), []);
    });

    it('rejects a negative minReadySeconds', () => {
      expectRule(statefulSet('  minReadySeconds: -5\n'), 'statefulset/negative-min-ready-seconds');
    });

    it('rejects a negative revisionHistoryLimit', () => {
      expectRule(
        statefulSet('  revisionHistoryLimit: -1\n'),
        'statefulset/negative-revision-history-limit',
      );
    });

    it('rejects a negative ordinals.start', () => {
      const finding = expectRule(
        statefulSet('  ordinals:\n    start: -1\n'),
        'statefulset/negative-ordinal-start',
      );
      expect(finding.path).toEqual(['spec', 'ordinals', 'start']);
    });

    it('accepts an ordinals.start above zero', () => {
      expectRules(statefulSet('  ordinals:\n    start: 5\n'), []);
    });
  });

  describe('update strategy', () => {
    it('rejects rollingUpdate under an OnDelete strategy', () => {
      const finding = expectRule(
        statefulSet('  updateStrategy:\n    type: OnDelete\n    rollingUpdate:\n      partition: 1\n'),
        'statefulset/rolling-update-with-on-delete',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'delete', path: ['spec', 'updateStrategy', 'rollingUpdate'] },
      ]);
    });

    it('accepts rollingUpdate under a RollingUpdate strategy', () => {
      expectRules(
        statefulSet('  updateStrategy:\n    type: RollingUpdate\n    rollingUpdate:\n      partition: 2\n'),
        [],
      );
    });

    it('rejects a negative partition', () => {
      const finding = expectRule(
        statefulSet('  updateStrategy:\n    rollingUpdate:\n      partition: -1\n'),
        'statefulset/negative-partition',
      );
      expect(finding.path).toEqual(['spec', 'updateStrategy', 'rollingUpdate', 'partition']);
    });

    it('rejects maxUnavailable at zero', () => {
      const finding = expectRule(
        statefulSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: 0\n'),
        'statefulset/invalid-max-unavailable',
      );
      expect(finding.message).toContain('greater than 0');
    });

    it('rejects a percentage above 100', () => {
      expectRule(
        statefulSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: 150%\n'),
        'statefulset/percent-over-100',
      );
    });

    it('accepts a percentage within range', () => {
      expectRules(statefulSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: 50%\n'), []);
    });

    it('rejects a malformed IntOrString', () => {
      expectRule(
        statefulSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: two\n'),
        'statefulset/invalid-max-unavailable',
      );
    });

    it('leaves an unknown strategy type to the enum rule', () => {
      expectRule(statefulSet('  updateStrategy:\n    type: Rolling\n'), 'pod/invalid-enum-value');
    });

    it('checks podManagementPolicy through the enum table', () => {
      expectRule(statefulSet('  podManagementPolicy: Ordered\n'), 'pod/invalid-enum-value');
    });

    it('checks the claim retention policy through the enum table', () => {
      expectRule(
        statefulSet('  persistentVolumeClaimRetentionPolicy:\n    whenDeleted: delete\n'),
        'pod/invalid-enum-value',
      );
    });
  });

  describe('volume claim templates', () => {
    it('lets a mount reference a claim template', () => {
      // The volume is generated by the controller, so it is nowhere in the
      // pod spec's own volumes list.
      expectNoRule(VALID_STATEFULSET, 'pod/volume-mount-not-found');
    });

    it('still reports a mount that matches neither a volume nor a claim template', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace('            - name: data\n', '            - name: date\n'),
        'pod/volume-mount-not-found',
      );
      expect(finding.message).toContain('Did you mean "data"');
    });

    it('requires a name', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace('    - metadata:\n        name: data\n', '    - metadata: {}\n'),
        'statefulset/claim-template-without-name',
      );
      expect(finding.path).toEqual(['spec', 'volumeClaimTemplates', 0]);
    });

    it('requires the name to be a DNS label', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace('        name: data\n', '        name: Data_Volume\n'),
        'statefulset/invalid-claim-template-name',
      );
      expect(finding.path).toEqual(['spec', 'volumeClaimTemplates', 0, 'metadata', 'name']);
    });

    it('rejects two claim templates with the same name', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace(
          '    - metadata:\n        name: data\n',
          '    - metadata:\n        name: data\n      spec:\n        accessModes: ["ReadWriteOnce"]\n        resources:\n          requests:\n            storage: 1Gi\n    - metadata:\n        name: data\n',
        ),
        'statefulset/duplicate-claim-template',
      );
      expect(finding.message).toContain('entry 1');
    });

    it('warns when a claim template shadows a volume in the pod template', () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace(
          '  volumeClaimTemplates:\n',
          '      volumes:\n        - name: data\n          emptyDir: {}\n  volumeClaimTemplates:\n',
        ),
        'statefulset/claim-template-shadows-volume',
      );
      expect(finding.severity).toBe('warning');
      expect(finding.message).toContain('"data"');
    });

    it('validates the claim spec through the schema layer', () => {
      expectRule(
        VALID_STATEFULSET.replace('            storage: 1Gi\n', '            storage: 1 Gi\n'),
        'schema/quantity',
      );
    });
  });

  describe('pod spec rules under the template', () => {
    it('reports container problems at the template path', () => {
      const finding = expectRule(
        statefulSetWithPodSpec('      hostNetwork: true\n      hostUsers: false\n'),
        'pod/host-users-conflict',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'hostNetwork']);
    });

    it('names the template path in messages that quote a field', () => {
      const finding = expectRule(
        statefulSetWithPodSpec('      dnsPolicy: None\n'),
        'pod/dns-none-without-config',
      );
      expect(finding.message).toContain('spec.template.spec.dnsConfig');
    });

    it("checks the StatefulSet's own name, not the template's", () => {
      const finding = expectRule(
        VALID_STATEFULSET.replace('  name: db\n', '  name: DB-Primary\n'),
        'pod/invalid-name',
      );
      expect(finding.path).toEqual(['metadata', 'name']);
      expect(finding.message).toContain('StatefulSet name');
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['metadata', 'name'], value: 'db-primary' },
      ]);
    });

    it('names a StatefulSet with a DNS label, where other kinds take a subdomain', () => {
      // The name is the prefix of every Pod name the set generates, and those
      // are hostnames — so a dot is fine on a Deployment and not here.
      expectRules(VALID_DEPLOYMENT.replace('  name: web\n', '  name: web.api\n'), []);
      expectRule(
        VALID_STATEFULSET.replace('  name: db\n', '  name: db.primary\n'),
        'pod/invalid-name',
      );
    });
  });
});

describe('daemonset', () => {
  it('accepts a minimal DaemonSet', () => {
    expectRules(VALID_DAEMONSET, []);
  });

  it('has no replica count, so the schema layer reports one', () => {
    // The mistake a DaemonSet invites most: its Pod count is the number of
    // matching nodes, so DaemonSetSpec has no such field.
    const finding = expectRule(daemonSet('  replicas: 3\n'), 'schema/unknown-field');
    expect(finding.path).toEqual(['spec', 'replicas']);
  });

  describe('selector', () => {
    it('rejects an empty selector', () => {
      const finding = expectRule(
        VALID_DAEMONSET.replace(
          '    matchLabels:\n      app: node-exporter\n',
          '    matchLabels: {}\n',
        ),
        'daemonset/empty-selector',
      );
      expect(finding.path).toEqual(['spec', 'selector']);
    });

    it('reports a template label that contradicts the selector', () => {
      const finding = expectRule(
        VALID_DAEMONSET.replace('      app: node-exporter\n  template', '      app: metrics\n  template'),
        'daemonset/selector-mismatch',
      );
      expect(finding.path).toEqual(['spec', 'template', 'metadata', 'labels', 'app']);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'template', 'metadata', 'labels', 'app'], value: 'metrics' },
      ]);
    });

    it('evaluates matchExpressions against the template labels', () => {
      const yaml = VALID_DAEMONSET.replace(
        '    matchLabels:\n      app: node-exporter\n',
        '    matchExpressions:\n      - key: app\n        operator: In\n        values: [api, worker]\n',
      );
      const finding = expectRule(yaml, 'daemonset/selector-mismatch');
      expect(finding.path).toEqual(['spec', 'selector', 'matchExpressions', 0]);
    });

    it('checks operator and values consistency under the daemonset namespace', () => {
      const yaml = VALID_DAEMONSET.replace(
        '    matchLabels:\n      app: node-exporter\n',
        '    matchExpressions:\n      - key: app\n        operator: Exists\n        values: [node-exporter]\n',
      );
      const finding = expectRule(yaml, 'daemonset/selector-values-forbidden');
      expect(finding.path).toEqual(['spec', 'selector', 'matchExpressions', 0, 'values']);
    });
  });

  describe('pod template', () => {
    it('requires restartPolicy Always, with a safe fix', () => {
      const finding = expectRule(
        daemonSetWithPodSpec('      restartPolicy: OnFailure\n'),
        'daemonset/template-restart-policy',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'restartPolicy']);
      expect(finding.fix?.safe).toBe(true);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'template', 'spec', 'restartPolicy'], value: 'Always' },
      ]);
    });

    it('forbids activeDeadlineSeconds', () => {
      const finding = expectRule(
        daemonSetWithPodSpec('      activeDeadlineSeconds: 600\n'),
        'daemonset/template-active-deadline',
      );
      expect(finding.fix?.ops).toEqual([
        { op: 'delete', path: ['spec', 'template', 'spec', 'activeDeadlineSeconds'] },
      ]);
    });

    it('forbids ephemeral containers', () => {
      expectRule(
        daemonSetWithPodSpec('      ephemeralContainers:\n        - name: debug\n          image: busybox\n'),
        'daemonset/template-ephemeral-containers',
      );
    });

    it('validates template annotation keys', () => {
      expectRule(
        VALID_DAEMONSET.replace(
          '      labels:\n        app: node-exporter\n',
          '      labels:\n        app: node-exporter\n      annotations:\n        "bad key": x\n',
        ),
        'pod/invalid-annotation-key',
      );
    });
  });

  describe('counters', () => {
    it('rejects a negative minReadySeconds', () => {
      const finding = expectRule(
        daemonSet('  minReadySeconds: -5\n'),
        'daemonset/negative-min-ready-seconds',
      );
      expect(finding.path).toEqual(['spec', 'minReadySeconds']);
    });

    it('rejects a negative revisionHistoryLimit', () => {
      expectRule(
        daemonSet('  revisionHistoryLimit: -1\n'),
        'daemonset/negative-revision-history-limit',
      );
    });
  });

  describe('update strategy', () => {
    it('warns that rollingUpdate is ignored under an OnDelete strategy', () => {
      const finding = expectRule(
        daemonSet('  updateStrategy:\n    type: OnDelete\n    rollingUpdate:\n      maxUnavailable: 1\n'),
        'daemonset/rolling-update-with-on-delete',
      );
      // Unlike a Deployment or a StatefulSet the apiserver accepts this, so it
      // is a warning and the removal is not offered as a safe fix.
      expect(finding.severity).toBe('warning');
      expect(finding.fix?.safe).toBe(false);
      expect(finding.fix?.ops).toEqual([
        { op: 'delete', path: ['spec', 'updateStrategy', 'rollingUpdate'] },
      ]);
    });

    it('says nothing about the contents of a block the controller ignores', () => {
      // The apiserver stops validating the strategy at type: OnDelete, so a
      // rollout that would be rejected under RollingUpdate is only reported as
      // dead configuration.
      expectRules(
        daemonSet(
          '  updateStrategy:\n    type: OnDelete\n    rollingUpdate:\n      maxUnavailable: 1\n      maxSurge: 1\n',
        ),
        ['daemonset/rolling-update-with-on-delete'],
      );
    });

    it('accepts maxUnavailable on its own', () => {
      expectRules(
        daemonSet('  updateStrategy:\n    type: RollingUpdate\n    rollingUpdate:\n      maxUnavailable: 2\n'),
        [],
      );
    });

    it('accepts maxSurge on its own', () => {
      expectRules(daemonSet('  updateStrategy:\n    rollingUpdate:\n      maxSurge: 1\n'), []);
    });

    it('accepts an empty rollingUpdate, which the API defaults', () => {
      expectRules(daemonSet('  updateStrategy:\n    rollingUpdate: {}\n'), []);
    });

    it('rejects maxSurge alongside a non-zero maxUnavailable', () => {
      const finding = expectRule(
        daemonSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: 1\n      maxSurge: 1\n'),
        'daemonset/max-surge-with-max-unavailable',
      );
      expect(finding.path).toEqual(['spec', 'updateStrategy', 'rollingUpdate', 'maxSurge']);
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'updateStrategy', 'rollingUpdate', 'maxUnavailable'], value: 0 },
      ]);
    });

    it('rejects both at zero', () => {
      const finding = expectRule(
        daemonSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: 0\n      maxSurge: 0\n'),
        'daemonset/max-unavailable-and-surge-zero',
      );
      expect(finding.path).toEqual(['spec', 'updateStrategy', 'rollingUpdate', 'maxUnavailable']);
    });

    it('accepts maxUnavailable at zero when maxSurge takes over', () => {
      expectRules(
        daemonSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: 0\n      maxSurge: 30%\n'),
        [],
      );
    });

    it('rejects a negative count', () => {
      const finding = expectRule(
        daemonSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: -1\n'),
        'daemonset/invalid-percent',
      );
      expect(finding.message).toContain('must not be negative');
    });

    it('rejects a percentage above 100', () => {
      expectRule(
        daemonSet('  updateStrategy:\n    rollingUpdate:\n      maxSurge: 150%\n'),
        'daemonset/percent-over-100',
      );
    });

    it('rejects a malformed IntOrString', () => {
      expectRule(
        daemonSet('  updateStrategy:\n    rollingUpdate:\n      maxUnavailable: two\n'),
        'daemonset/invalid-percent',
      );
    });

    it('leaves an unknown strategy type to the enum rule', () => {
      expectRule(daemonSet('  updateStrategy:\n    type: Rolling\n'), 'pod/invalid-enum-value');
    });
  });

  describe('volumes', () => {
    const withDisk = (readOnly: string) =>
      daemonSetWithPodSpec(
        `      volumes:\n        - name: disk\n          gcePersistentDisk:\n            pdName: data\n${readOnly}`,
      );

    it('rejects a read-write GCE persistent disk', () => {
      const finding = expectRule(
        withDisk('            readOnly: false\n'),
        'daemonset/read-write-persistent-disk',
      );
      expect(finding.path).toEqual([
        'spec', 'template', 'spec', 'volumes', 0, 'gcePersistentDisk', 'readOnly',
      ]);
      expect(finding.fix?.ops).toEqual([
        {
          op: 'set',
          path: ['spec', 'template', 'spec', 'volumes', 0, 'gcePersistentDisk', 'readOnly'],
          value: true,
        },
      ]);
    });

    it('reports an omitted readOnly on the volume source, since it defaults to false', () => {
      const finding = expectRule(withDisk(''), 'daemonset/read-write-persistent-disk');
      expect(finding.path).toEqual([
        'spec', 'template', 'spec', 'volumes', 0, 'gcePersistentDisk',
      ]);
      expect(finding.message).toContain('"disk"');
    });

    it('accepts a read-only one', () => {
      expectNoRule(withDisk('            readOnly: true\n'), 'daemonset/read-write-persistent-disk');
    });

    it('leaves the same volume alone on a Deployment', () => {
      // ValidateReadOnlyPersistentDisks is the DaemonSet's own check; a
      // Deployment can perfectly well run a single Pod with a writable disk.
      expectNoRule(
        deploymentWithPodSpec(
          '      volumes:\n        - name: disk\n          gcePersistentDisk:\n            pdName: data\n',
        ),
        'daemonset/read-write-persistent-disk',
      );
    });
  });

  describe('pod spec rules under the template', () => {
    it('reports container problems at the template path', () => {
      const finding = expectRule(
        daemonSetWithPodSpec('      hostNetwork: true\n      hostUsers: false\n'),
        'pod/host-users-conflict',
      );
      expect(finding.path).toEqual(['spec', 'template', 'spec', 'hostNetwork']);
    });

    it('names the template path in messages that quote a field', () => {
      const finding = expectRule(
        daemonSetWithPodSpec('      dnsPolicy: None\n'),
        'pod/dns-none-without-config',
      );
      expect(finding.message).toContain('spec.template.spec.dnsConfig');
    });

    it("checks the DaemonSet's own name, not the template's", () => {
      const finding = expectRule(
        VALID_DAEMONSET.replace('  name: node-exporter\n', '  name: Node_Exporter\n'),
        'pod/invalid-name',
      );
      expect(finding.path).toEqual(['metadata', 'name']);
      expect(finding.message).toContain('DaemonSet name');
    });
  });
});
