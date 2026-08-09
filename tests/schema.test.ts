import { describe, expect, it } from 'vitest';
import { lint, schema } from '../src/lint/index.js';
import { VALID_POD, expectRule, expectRules, findings, pod, podWithContainer } from './helpers.js';

describe('schema conformance', () => {
  it('accepts a valid Pod', () => {
    expectRules(VALID_POD, []);
  });

  it('is pinned to the requested Kubernetes version', () => {
    expect(schema.version).toBe('1.36');
  });

  it('reports an unknown field and suggests the intended one', () => {
    const finding = expectRule(
      pod('  contaienrs:\n    - name: web\n      image: nginx\n'),
      'schema/unknown-field',
    );
    expect(finding.message).toContain('Did you mean "containers"');
    expect(finding.fix).toEqual({
      title: 'Rename to "containers"',
      safe: true,
      ops: [{ op: 'rename', path: ['spec', 'contaienrs'], to: 'containers' }],
    });
  });

  it('offers removal when an unknown field resembles nothing', () => {
    const finding = expectRule(podWithContainer('      zzzqqq: 1\n'), 'schema/unknown-field');
    expect(finding.fix?.safe).toBe(false);
    expect(finding.fix?.ops[0]?.op).toBe('delete');
  });

  it('reports missing required fields', () => {
    const finding = expectRule(pod('  restartPolicy: Always\n'), 'schema/required-field');
    expect(finding.message).toContain('"containers"');
  });

  it('treats a present-but-empty required field as missing', () => {
    const finding = expectRule(pod('  containers:\n'), 'schema/required-field');
    expect(finding.message).toContain('present but empty');
  });

  it('reports a wrong scalar type and offers to quote it', () => {
    const finding = expectRule(podWithContainer('      workingDir: 42\n'), 'schema/type');
    expect(finding.message).toBe('Expected a string, but found the number 42.');
    expect(finding.fix?.ops).toEqual([
      { op: 'set', path: ['spec', 'containers', 0, 'workingDir'], value: '42' },
    ]);
  });

  it('reports a wrong collection type', () => {
    const finding = expectRule(pod('  containers: nginx\n'), 'schema/type');
    expect(finding.message).toContain('Expected an array');
  });

  it('accepts either form of an int-or-string field', () => {
    for (const port of ['8080', 'http']) {
      expectRules(
        podWithContainer(
          '      ports:\n        - name: http\n          containerPort: 8080\n' +
            `      livenessProbe:\n        httpGet:\n          port: ${port}\n`,
        ),
        [],
      );
    }
  });

  it('rejects a malformed int-or-string field', () => {
    const finding = expectRule(
      podWithContainer('      livenessProbe:\n        httpGet:\n          port: [1]\n'),
      'schema/type',
    );
    expect(finding.message).toContain('integer or a string');
  });

  describe('quantities', () => {
    const quantity = (value: string, resource = 'memory') =>
      podWithContainer(`      resources:\n        limits:\n          ${resource}: ${value}\n`);

    it('accepts valid suffixes', () => {
      for (const value of ['128Mi', '"1Gi"', '"1e3"', '"512M"']) {
        expectRules(quantity(value), []);
      }
      expectRules(quantity('"1500m"', 'cpu'), []);
    });

    it('rejects a byte suffix and suggests the binary one', () => {
      const finding = expectRule(quantity('128mb'), 'schema/quantity');
      expect(finding.fix?.ops).toEqual([
        { op: 'set', path: ['spec', 'containers', 0, 'resources', 'limits', 'memory'], value: '128Mi' },
      ]);
    });

    it('asks for an unquoted number to be quoted', () => {
      const finding = expectRule(quantity('128'), 'schema/quantity-unquoted');
      expect(finding.severity).toBe('warning');
    });
  });

  describe('apiVersion and kind', () => {
    it('flags the wrong apiVersion with a fix', () => {
      const finding = expectRule(
        VALID_POD.replace('apiVersion: v1', 'apiVersion: apps/v1'),
        'schema/wrong-api-version',
      );
      expect(finding.fix?.ops).toEqual([{ op: 'set', path: ['apiVersion'], value: 'v1' }]);
    });

    it('flags a missing kind', () => {
      expectRule(VALID_POD.replace('kind: Pod\n', ''), 'schema/missing-kind');
    });

    it('skips Pod rules for another kind, with an explanation', () => {
      const result = findings(VALID_POD.replace('kind: Pod', 'kind: Deployment'));
      expect(result.map((finding) => finding.ruleId)).toEqual(['lint/unsupported-kind']);
      expect(result[0]?.severity).toBe('info');
    });
  });

  describe('list uniqueness from x-kubernetes-list-map-keys', () => {
    it('detects duplicate container entries', () => {
      const finding = expectRule(
        pod('  containers:\n    - name: web\n      image: a\n    - name: web\n      image: b\n'),
        'schema/duplicate-list-entry',
      );
      expect(finding.message).toContain('already used by entry 1');
    });

    it('detects duplicate volumes', () => {
      expectRule(
        pod(
          '  containers:\n    - name: web\n      image: a\n' +
            '  volumes:\n    - name: data\n      emptyDir: {}\n    - name: data\n      emptyDir: {}\n',
        ),
        'schema/duplicate-list-entry',
      );
    });
  });

  it('reports duplicate YAML keys', () => {
    const finding = expectRule(
      pod('  containers:\n    - name: web\n      image: a\n      image: b\n'),
      'yaml/duplicate-key',
    );
    expect(finding.message).toContain('"image"');
  });

  it('reports a YAML syntax error once and stops', () => {
    const result = lint('apiVersion: v1\nkind: Pod\n  bad indentation: [\n');
    expect(result.findings.every((finding) => finding.ruleId === 'yaml/syntax')).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('parses with YAML 1.1 semantics, matching the apiserver', () => {
    // `no` is a boolean in YAML 1.1, so this is a type error rather than a string.
    const finding = expectRule(
      podWithContainer('      env:\n        - name: FEATURE\n          value: no\n'),
      'schema/type',
    );
    expect(finding.message).toContain('boolean false');
    expect(finding.fix?.ops).toEqual([
      { op: 'set', path: ['spec', 'containers', 0, 'env', 0, 'value'], value: 'false' },
    ]);
  });
});

describe('field descriptions', () => {
  it('describes a field from the API spec', () => {
    const described = schema.describe(['spec', 'containers', 0, 'imagePullPolicy']);
    expect(described?.type).toBe('string');
    expect(described?.description).toContain('IfNotPresent');
  });

  it('marks required fields', () => {
    expect(schema.describe(['spec', 'containers'])?.required).toBe(true);
    expect(schema.describe(['spec', 'nodeName'])?.required).toBe(false);
  });

  it('returns nothing for an unknown path', () => {
    expect(schema.describe(['spec', 'nope'])).toBeUndefined();
  });
});
