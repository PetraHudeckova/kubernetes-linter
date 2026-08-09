import { describe, expect, it } from 'vitest';
import {
  lint,
  loadSchema,
  isKnownVersion,
  AVAILABLE_VERSIONS,
  DEFAULT_VERSION,
} from '../src/lint/index.js';
import { EXAMPLES } from '../src/ui/examples.js';
import { pod, podWithContainer } from './helpers.js';

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

    expect(await ruleIdsAt('1.33', yaml)).toContain('pod/invalid-enum-value');
    expect(await ruleIdsAt('1.32', yaml)).toContain('schema/unknown-field');
    expect(await ruleIdsAt('1.32', yaml)).not.toContain('pod/invalid-enum-value');
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
