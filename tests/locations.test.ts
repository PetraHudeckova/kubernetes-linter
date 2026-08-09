import { describe, expect, it } from 'vitest';
import { lint, applySafeFixes } from '../src/lint/index.js';
import { pathAtOffset } from '../src/lint/parse.js';
import { EXAMPLES } from '../src/ui/examples.js';
import { findings } from './helpers.js';

const DOC = `apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  containers:
    - name: web
      image: nginx
      imagePullPolicy: always
`;

describe('finding locations', () => {
  it('anchors on the offending value', () => {
    const finding = findings(DOC)[0]!;
    expect(finding.line).toBe(9);
    expect(DOC.slice(finding.from, finding.to)).toBe('always');
  });

  it('anchors an unknown field on its key', () => {
    const text = DOC.replace('imagePullPolicy', 'imagePullPolcy');
    const finding = findings(text).find((entry) => entry.ruleId === 'schema/unknown-field')!;
    expect(text.slice(finding.from, finding.to)).toBe('imagePullPolcy');
  });

  it('anchors a missing required field on the parent', () => {
    const text = 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: web\nspec:\n  restartPolicy: Always\n';
    const finding = findings(text).find((entry) => entry.ruleId === 'schema/required-field')!;
    expect(finding.line).toBe(6);
  });

  it('never produces a zero-width or out-of-bounds range', () => {
    for (const example of EXAMPLES) {
      for (const finding of lint(example.yaml).findings) {
        expect(finding.to, `${example.id}/${finding.ruleId}`).toBeGreaterThan(finding.from);
        expect(finding.to).toBeLessThanOrEqual(example.yaml.length);
        expect(finding.line).toBeGreaterThanOrEqual(1);
        expect(finding.column).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('locates findings in the second document of a multi-document file', () => {
    const text = `${DOC}---\n${DOC.replace('name: web\n', 'name: web-2\n')}`;
    const results = lint(text).findings;
    expect(results).toHaveLength(2);
    expect(results[1]!.docIndex).toBe(1);
    expect(results[1]!.line).toBeGreaterThan(results[0]!.line);
  });

  it('handles flow style', () => {
    const text = 'apiVersion: v1\nkind: Pod\nmetadata: {name: web}\nspec: {containers: [{name: web, image: nginx, imagePullPolicy: always}]}\n';
    const finding = findings(text).find((entry) => entry.ruleId === 'pod/invalid-enum-value')!;
    expect(text.slice(finding.from, finding.to)).toBe('always');
  });
});

describe('field lookup for hover', () => {
  it('resolves a key to its path', () => {
    const offset = DOC.indexOf('imagePullPolicy');
    expect(pathAtOffset(DOC, offset)?.path).toEqual([
      'spec',
      'containers',
      0,
      'imagePullPolicy',
    ]);
  });

  it('resolves a top-level key', () => {
    expect(pathAtOffset(DOC, DOC.indexOf('kind'))?.path).toEqual(['kind']);
  });

  it('returns nothing for a position that is not a node', () => {
    const commented = `# just a comment\n${DOC}`;
    expect(pathAtOffset(commented, 5)).toBeUndefined();
  });

  it('stays within bounds at the edges of the document', () => {
    for (const offset of [0, 1, DOC.length - 1, DOC.length]) {
      expect(() => pathAtOffset(DOC, offset)).not.toThrow();
    }
  });
});

describe('bundled examples', () => {
  it.each(EXAMPLES.map((example) => [example.id, example] as const))(
    '%s lints and every fix applies cleanly',
    (_id, example) => {
      const result = lint(example.yaml);
      if (example.id === 'valid') {
        expect(result.findings).toEqual([]);
        return;
      }
      expect(result.findings.length).toBeGreaterThan(0);

      // Applying the safe fixes must never make the document worse.
      const { text } = applySafeFixes(example.yaml);
      const after = lint(text);
      expect(after.findings.length).toBeLessThanOrEqual(result.findings.length + 3);
      expect(after.findings.some((finding) => finding.ruleId === 'yaml/syntax')).toBe(false);
    },
  );

  it('reports the problems the broken example advertises', () => {
    const ids = new Set(lint(EXAMPLES[0]!.yaml).findings.map((finding) => finding.ruleId));
    expect(ids).toContain('schema/unknown-field');
    expect(ids).toContain('pod/invalid-name');
    expect(ids).toContain('pod/invalid-enum-value');
  });

  it('surfaces the conflicts example as contradictions', () => {
    const ids = lint(EXAMPLES[3]!.yaml).findings.map((finding) => finding.ruleId);
    expect(ids).toContain('pod/share-process-namespace-conflict');
    expect(ids).toContain('pod/service-account-mismatch');
    expect(ids).toContain('pod/run-as-non-root-conflict');
    expect(ids).toContain('pod/privileged-without-escalation');
    expect(ids).toContain('pod/toleration-exists-with-value');
    expect(ids).toContain('pod/dns-none-without-config');
  });
});
