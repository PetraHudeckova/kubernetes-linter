import { describe, expect, it } from 'vitest';
import { applyFix, applySafeFixes, lint, loadSchema } from '../src/lint/index.js';
import { applyOps, detectFormat } from '../src/lint/fix.js';
import { expectRule } from './helpers.js';

describe('applying a fix', () => {
  it('preserves comments, blank lines and quoting style', () => {
    const before = `apiVersion: v1
kind: Pod
metadata:
  name: web            # the pod name

spec:
  containers:
    # the only container
    - name: web
      image: 'nginx:1.27'
      imagePullPolicy: always
`;
    const finding = expectRule(before, 'pod/invalid-enum-value');
    const after = applyFix(before, finding.fix!);

    expect(after).toContain('# the pod name');
    expect(after).toContain('# the only container');
    expect(after).toContain("image: 'nginx:1.27'");
    expect(after).toContain('imagePullPolicy: Always');
    // Comment indentation is normalised, but the comment stays on its line and
    // the blank line separating metadata from spec survives.
    expect(after).toMatch(/name: web +# the pod name\n\nspec:/);
  });

  it('keeps the original indentation width', () => {
    const before = `apiVersion: v1
kind: Pod
metadata:
    name: web
spec:
    containers:
        - name: web
          image: nginx
          imagePullPolicy: always
`;
    const after = applyFix(before, expectRule(before, 'pod/invalid-enum-value').fix!);
    expect(after).toContain('    containers:');
    expect(after).toContain('        - name: web');
  });

  it('keeps sequences unindented when the input writes them that way', () => {
    const before = `apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  containers:
  - name: web
    image: nginx
    imagePullPolicy: always
`;
    const after = applyFix(before, expectRule(before, 'pod/invalid-enum-value').fix!);
    expect(after).toContain('  containers:\n  - name: web');
  });

  it('renames a key without disturbing its value', () => {
    const before = `apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  contaienrs:
    - name: web
      image: nginx
`;
    const after = applyFix(before, expectRule(before, 'schema/unknown-field').fix!);
    expect(after).toContain('containers:');
    expect(after).not.toContain('contaienrs');
    expect(lint(after).findings).toHaveLength(0);
  });

  it('drops a misspelled key instead of creating a duplicate', () => {
    const before = `apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  containers:
    - name: web
      image: nginx
  contaienrs: []
`;
    const after = applyOps(before, [{ op: 'rename', path: ['spec', 'contaienrs'], to: 'containers' }]);
    expect(after).not.toContain('contaienrs');
    expect(after.match(/containers:/g)).toHaveLength(1);
  });

  it('creates missing intermediate levels as plain mappings', () => {
    const before = `apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  dnsPolicy: None
  containers:
    - name: web
      image: nginx
`;
    const after = applyFix(before, expectRule(before, 'pod/dns-none-without-config').fix!);

    // Under YAML 1.1 a carelessly built intermediate serialises as !!omap.
    expect(after).not.toContain('omap');
    expect(after).toContain('  dnsConfig:\n    nameservers:\n      - 1.1.1.1');
    expect(lint(after).findings).toHaveLength(0);
  });

  it('inserts into a sequence, creating it when absent', () => {
    const before = `apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  containers:
    - name: web
      image: nginx
      volumeMounts:
        - name: cache
          mountPath: /cache
`;
    const finding = expectRule(before, 'pod/volume-mount-not-found');
    const after = applyFix(before, finding.fix!);
    expect(after).toContain('volumes:');
    expect(after).toContain('- name: cache');
    expect(after).toContain('emptyDir: {}');
    expect(lint(after).findings).toHaveLength(0);
  });

  it('only rewrites the document that the finding belongs to', () => {
    const before = `apiVersion: v1
kind: Pod
metadata:
  name: first
spec:
  containers:
    - name: web
      image: nginx
---
apiVersion: v1
kind: Pod
metadata:
  name: second
spec:
  containers:
    - name: web
      image: nginx
      imagePullPolicy: always
`;
    const finding = expectRule(before, 'pod/invalid-enum-value');
    expect(finding.docIndex).toBe(1);

    const after = applyFix(before, finding.fix!, finding.docIndex);
    expect(after).toContain('imagePullPolicy: Always');
    expect(after).toContain('name: first');
    expect(after.match(/^---$/gm)).toHaveLength(1);
    expect(lint(after).findings).toHaveLength(0);
  });
});

describe('applying all safe fixes', () => {
  it('cascades: fixing a key reveals the problems underneath it', () => {
    const before = `apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  # everything below is invisible to the API until this is spelled right
  contaienrs:
    - name: web
      image: nginx
      imagePullPolicy: always
      ports:
        - name: http
          containerPort: 8080
      livenessProbe:
        httpGet:
          port: htpp
        successThreshold: 3
`;
    // Nothing under the misspelled key is visible to the linter yet.
    expect(lint(before).findings.map((finding) => finding.ruleId)).toEqual([
      'schema/required-field',
      'schema/unknown-field',
    ]);

    const { text, applied } = applySafeFixes(before);
    expect(applied).toBe(4);
    expect(text).toContain('# everything below is invisible');
    expect(text).toContain('containers:');
    expect(text).toContain('imagePullPolicy: Always');
    expect(text).toContain('port: http');
    expect(text).toContain('successThreshold: 1');
    expect(lint(text).findings).toHaveLength(0);
  });

  it('leaves fixes that need a human decision alone', () => {
    const before = `apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  containers:
    - name: web
      image: nginx
      resources:
        requests:
          cpu: "500m"
        limits:
          cpu: "200m"
`;
    const { text, applied } = applySafeFixes(before);
    expect(applied).toBe(0);
    expect(text).toBe(before);
    expect(lint(text).findings.map((finding) => finding.ruleId)).toEqual(['pod/request-exceeds-limit']);
  });

  it('terminates on a document that cannot be fully fixed', () => {
    const before = `apiVersion: v1
kind: Pod
metadata:
  name: Bad-Name
spec:
  containers:
    - name: web
      image: nginx
      imagePullPolicy: always
`;
    const { text, applied } = applySafeFixes(before);
    expect(applied).toBe(1);
    expect(text).toContain('name: Bad-Name');
    expect(lint(text).findings.map((finding) => finding.ruleId)).toEqual(['pod/invalid-name']);
  });

  it('fixes against the version it is given, not the default', async () => {
    // hostnameOverride arrived in 1.34, so the "did you mean" rename exists
    // only from then on. Fixing a 1.33 document against the default schema
    // would write a field that cluster rejects.
    const before = `apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  hostnameOverrid: web
  containers:
    - name: web
      image: nginx
`;
    const onNew = applySafeFixes(before, await loadSchema('1.36'));
    expect(onNew.applied).toBe(1);
    expect(onNew.text).toContain('hostnameOverride: web');

    const onOld = applySafeFixes(before, await loadSchema('1.33'));
    expect(onOld.applied).toBe(0);
    expect(onOld.text).toBe(before);
  });
});

describe('format detection', () => {
  it('reads the indentation width from the document', () => {
    expect(detectFormat('a:\n    b: 1\n').indent).toBe(4);
    expect(detectFormat('a:\n  b: 1\n').indent).toBe(2);
  });

  it('notices unindented sequences', () => {
    expect(detectFormat('a:\n- 1\n').indentSeq).toBe(false);
    expect(detectFormat('a:\n  - 1\n').indentSeq).toBe(true);
  });

  it('notices flow collection padding', () => {
    expect(detectFormat('a: [1, 2]\n').flowCollectionPadding).toBe(false);
    expect(detectFormat('a: [ 1, 2 ]\n').flowCollectionPadding).toBe(true);
  });
});
